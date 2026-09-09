# SQL-on-FHIR FAQ

Practical Q&A for users and contributors driving the `/sql` workspace.

## Q: How do I run the demo?

1. `npm install && npm run start`
2. Open <http://localhost:4200/sql>
3. Click **Load CMS125 demo**
4. Step through the five panels via the left rail (FHIR Library → Decoded CQL → ELM Translation → Generated SQL → Execute SQL).
5. On the Execute step, click **Execute SQL**, then **Generate FHIR MeasureReport**.

The whole pipeline runs in your browser. PGlite (Postgres in WASM) is downloaded the first time you click Execute — ~3 MB.

## Q: Do I need a FHIR server?

**No.** Demo runs entirely in-browser.

If you *do* have a FHIR server (point CQL Studio's "FHIR Base URL" at it in Settings):

- **Save MeasureReport** button appears, POSTing the generated `MeasureReport` to `<server>/MeasureReport`.
- The standard "Server libraries" picker on `/sql` works too, letting you pick any Library resource with embedded CQL.

## Q: How does this compare to running CQL through the standard ELM interpreter?

| | SQL-on-FHIR (this PR) | Standard ELM interpreter |
|---|---|---|
| Authoring language | CQL | CQL |
| Intermediate representation | ELM JSON (from `@cqframework/cql`) | ELM JSON (from `@cqframework/cql`) |
| Execution | SQL against flat views | Per-patient iteration over FHIR resources |
| Runtime | PGlite (browser) or any Postgres / DuckDB / BigQuery | JVM (or `cql-execution` Node port) |
| Set-based | ✅ — one query plan over all patients | ❌ — patient-by-patient |
| Install | None (browser) or any SQL engine | JVM + jars, or Node + deps |
| Performance on 100k patients | Seconds | Minutes to hours |
| ELM coverage | Common eCQM subset (see [roadmap.md](./roadmap.md)) | Full ELM |
| Production maturity | Experimental (Connectathon 2026) | Mature, decade of investment |

They are complementary — see [vision.md](./vision.md). Sites with tuned ELM interpreters keep using them. Sites that want SQL-on-FHIR as their execution layer can now use that too.

## Q: How does CQL Studio translate CQL → ELM?

CQL Studio loads `@cqframework/cql` in the browser and calls `CqlTranslator.fromText(cql, libraryManager)`. The translator runs entirely client-side; ELM is produced as both XML (for the existing ELM viewer) and JSON (for the SQL pipeline). See [src/app/services/translation.service.ts](../../src/app/services/translation.service.ts).

## Q: How does ELM → SQL work?

A walking dispatch in [transpiler/elm-to-sql.ts](../../src/app/components/sql-on-fhir/elm-to-sql/transpiler/elm-to-sql.ts) emits one CTE per `define`. CTE names are SQL-safe versions of the CQL define names. The final `SELECT` aggregates `COUNT(*)` over the population CTEs.

Example (CMS125, abbreviated):

```sql
WITH
Patient AS ( SELECT * FROM patient_view ),
Qualifying_Encounters AS (
  SELECT * FROM (SELECT * FROM encounter_view
    WHERE type_code IN (SELECT code FROM value_set_expansion WHERE value_set_id = 'urn:oid:...Office Visit')) E
    WHERE tstzrange(E.period_start, E.period_end, '[)') <@ tstzrange('2024-01-01', '2024-12-31', '[)')
),
Initial_Population AS (
  SELECT Patient.* FROM Patient WHERE (
    Patient.gender = 'female'
    AND DATE_PART('year', AGE(lower(tstzrange('2024-01-01', '2024-12-31', '[)'))::date, Patient.birthdate)) >= 51
    AND DATE_PART('year', AGE(lower(tstzrange('2024-01-01', '2024-12-31', '[)'))::date, Patient.birthdate)) <= 74
    AND EXISTS (SELECT 1 FROM Qualifying_Encounters)
  )
),
-- ... Denominator, Denominator_Exclusion, Numerator
SELECT
  (SELECT COUNT(*) FROM Initial_Population) AS Initial_Population_count,
  (SELECT COUNT(*) FROM Denominator) AS Denominator_count,
  (SELECT COUNT(*) FROM Denominator_Exclusion) AS Denominator_Exclusion_count,
  (SELECT COUNT(*) FROM Numerator) AS Numerator_count;
```

## Q: How is the demo data shaped?

[public/fhir/sql-on-fhir/cms125-bundle.json](../../public/fhir/sql-on-fhir/cms125-bundle.json) is a five-patient FHIR Bundle designed to produce specific population assignments:

| Patient | Gender | Age (2024) | Office visit | Mammography | Bilateral mastectomy | Expected populations |
|---|---|---|---|---|---|---|
| Jane Doe | F | 60 | ✓ | ✓ (2024) | — | IP, Denom, Numer |
| Mary Smith | F | 56 | ✓ | — | — | IP, Denom |
| Linda Garcia | F | 64 | ✓ | — | ✓ | IP, Denom, **Denom Exclusion** |
| Bob Johnson | M | 62 | ✓ | — | — | — (male) |
| Amy Patel | F | 30 | ✓ | — | — | — (too young) |

Expected MeasureReport from the bundled data:

```
Initial Population      3
Denominator             3
Denominator Exclusion   1
Numerator               1
Measure Score           0.5   (= 1 / (3 - 1))
```

## Q: How do I add a new demo measure?

1. Drop the CQL source file in `public/fhir/sql-on-fhir/<name>.cql`.
2. Wrap it in a FHIR Library resource: `cms<id>-library.json` with `content[0].data` set to the base64-encoded CQL.
3. Add a small patient bundle: `<name>-bundle.json`. Five patients is enough to exercise populations.
4. Pre-expand any value sets you reference: `valuesets/<name>.json`. Even 3–5 codes per value set is fine for demos.
5. Add a method to [sql-on-fhir-demo.service.ts](../../src/app/services/sql-on-fhir/sql-on-fhir-demo.service.ts) that fetches them in parallel.
6. Add a button to [sql-on-fhir.component.html](../../src/app/components/sql-on-fhir/sql-on-fhir.component.html).

You do not need to write a Vitest spec for the new demo unless you want regression coverage on its specific population counts — the pipeline-level tests cover the moving parts.

## Q: What ELM operators does the transpiler support today?

See [src/app/components/sql-on-fhir/elm-to-sql/FAQ.md](../../src/app/components/sql-on-fhir/elm-to-sql/FAQ.md) for the canonical list. Highlights:

- **Tabular**: `Retrieve`, `Query` with `with`/`without` semi-joins, `Union`, `Intersect`, `Except`, `Distinct`.
- **References**: `ExpressionRef` (→ CTE reference), `FunctionRef` (limited set), `ParameterRef`, `ValueSetRef`.
- **Comparisons**: `Equal`, `NotEqual`, `Less`, `Greater`, `LessOrEqual`, `GreaterOrEqual`.
- **Boolean**: `And`, `Or`, `Xor`, `Not`, `IsNull`, `IsTrue`, `IsFalse`.
- **Type guards**: `Is`, `As` (collapses for FHIR choice elements like `Observation.effective`).
- **Intervals**: `In`, `IncludedIn`, `During` (with point or interval LHS), `Interval`, `Start`, `End`, `Contains`.
- **Aggregation**: `Exists`, `Count`, `Sum`, `Min`, `Max`, `Avg`, `AnyTrue`, `AllTrue`.
- **Dates**: `Today`, `Now`, `Date`, `DateTime`, `DurationBetween`, `AgeInYearsAt`, `AgeInMonthsAt`, `AgeInDaysAt`, `CalculateAgeAt`, `CalculateAgeInYearsAt`.
- **Coercion**: `ToDate`, `ToDateTime`, `ToInterval`, `ToString`, `ToInteger`, `ToDecimal`, `Coalesce`.
- **Conditionals**: `If`, `Case`.

If you hit an unsupported operator, the transpiler emits `NULL /* unsupported: <Operator> */` and surfaces a warning in the result. The SQL stays valid — that branch evaluates to NULL (i.e. false in a boolean context).

## Q: What if the SQL execution fails?

Common errors:

- `column ... does not exist` — the transpiler emitted a column name that doesn't exist in the flat schema. File an issue with the SQL output and the source CQL; usually a missing entry in `normalizePath`.
- `operator does not exist: ...` — a type mismatch between the LHS and RHS of a comparison. Check whether you're comparing an interval to a point or vice versa.
- `syntax error at or near "..."` — a transpiler bug. The Generated SQL panel shows the full emitted SQL; share that.

## Q: Can I run this against my own FHIR server?

Yes — point CQL Studio's **FHIR Base URL** in Settings at your server. The Library picker on `/sql` populates from `GET /fhir/Library` against that URL. Any Library resource with embedded CQL works.

On the Execute step, search and select any number of Patients. Checked flattenable resource types (Patient, Encounter, Observation, Procedure, Condition, MedicationRequest, DiagnosticReport, Coverage, AllergyIntolerance, Immunization, ServiceRequest — all selected by default) are loaded with ordinary paginated FHIR searches (`GET {Type}?patient=…`, Coverage uses `beneficiary`). A progress bar shows work units and a live resource tally while fetching. Estimated payload size is shown; at ≥ 32 MiB the UI warns you to select less data or clear clinical data.

SQL still runs in-browser via PGlite against the flattened rows. Server-side Postgres execution remains Issue #20.

## Q: How do I run the HAPI FHIR JPA views?

See [scripts/hapi-fhir-sql-on-fhir/README.md](../../scripts/hapi-fhir-sql-on-fhir/README.md). Short version:

```bash
psql "$DATABASE_URL" -f scripts/hapi-fhir-sql-on-fhir/install.sql
```

`DATABASE_URL` points at the Postgres database backing your HAPI FHIR JPA server. The script is idempotent (`CREATE OR REPLACE VIEW`) and transactional.

Once views exist, the same SQL the in-browser demo emits can run against the HAPI database — that's the bridge to production. Preston's Issue #20 is the missing piece on the server-side wiring.

## Q: I want to contribute. Where do I start?

Read [vision.md](./vision.md) for the why, [roadmap.md](./roadmap.md) for what's next, and [architecture.md](./architecture.md) for the code map. Good starter issues:

- Add a CMS130 demo button (fixtures already shipped under `elm-to-sql/fixtures/`).
- Add DuckDB dialect support behind a `TranspilerOptions.dialect` flag.
- Extend `normalizePath` for FHIR properties not yet covered.
- Write a Playwright spec for the happy-path demo (see existing specs in `tests/`).

Pull requests against `feature/sql-on-fhir` are welcome until the branch merges, then against `master`.

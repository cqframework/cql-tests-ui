# SQL-on-FHIR roadmap

Status of the SQL-on-FHIR initiative in CQL Studio. Tracks the work that lands in PR #25 and the work that follows. Issues are filed in [cqframework/cql-studio](https://github.com/cqframework/cql-studio/issues).

## Status legend

| | |
|---|---|
| ✅ | Shipped on `feature/sql-on-fhir` (this PR). |
| 🟡 | In-progress, partially shipped. |
| ⏳ | Planned, not started. |
| 🤝 | Owned by Preston (CQL Studio Server / IDE). |

## Milestones

### ✅ M1 — In-browser end-to-end demo (shipped in PR #25)

Click "Load CMS125 demo" on `/sql`, see a real FHIR R4 MeasureReport with correct populations.

- ✅ `@cqframework/elm-to-sql` library, baked into the app at `src/app/components/sql-on-fhir/elm-to-sql/` per Preston's #16 review.
- ✅ Bundle flattener (`sql-on-fhir/sql-on-fhir-bundle-flattener.lib.ts`) — pure functions, Vitest-tested.
- ✅ PGlite execution service — lazy WASM boot, flat-table schema, idempotent seeding.
- ✅ TranslationService exposes `elmJson` (calls `CqlTranslator.toJson()`).
- ✅ Pipeline service wires real library + PGlite (replaces the prior stub).
- ✅ "Load CMS125 demo" button on `/sql`.
- ✅ HAPI FHIR JPA view scripts (`scripts/hapi-fhir-sql-on-fhir/`) for the server-side path.
- ✅ Vision document and roadmap (this directory).

### ✅ M2 — eCQM core coverage in the transpiler (shipped in PR #25)

Enough ELM coverage for CMS125 to compute the correct measure score in PGlite.

- ✅ `Retrieve`, `Query`, `ExpressionRef`, `FunctionRef`, `ParameterRef`, `ValueSetRef`.
- ✅ Boolean operators (`And`/`Or`/`Not`), comparisons (`Equal`/`Less`/`Greater`/etc.).
- ✅ Set membership / intervals (`In`/`During`/`IncludedIn`, including interval-in-interval via Postgres `<@`).
- ✅ `Exists`, `Count` / `Sum` / `Min` / `Max` / `Avg` aggregates.
- ✅ `AgeInYearsAt` / `CalculateAgeAt` / `CalculateAgeInYearsAt` (top-level and FunctionRef forms).
- ✅ `Start` / `End` of intervals via `lower()` / `upper()` on Postgres `tstzrange`.
- ✅ `ToDate` / `ToDateTime` / `ToInterval` coercions, including interval-to-point extraction.
- ✅ `Is` / `As` type guards for FHIR choice elements (e.g. `Observation.effective` being `DateTime` vs `Period`).
- ✅ Resource-aware code column lookup (Encounter uses `type_code`, Immunization uses `vaccine_code`, others use `code`).
- ✅ Per-patient evaluation: Patient context CTE is not LIMIT 1; per-patient CTEs filter via `WHERE` over `Patient` so `COUNT(*)` is meaningful.
- ✅ `tstzrange` consistently (matching `::timestamptz` cast partners).
- ✅ Block-comment style (`/* ... */`) for inline notes so single-line expressions parse cleanly.

### ⏳ M3 — Production-shape FHIR data

The demo works against a hand-crafted bundle in PGlite. The connectathon demo also needs to run against real synthetic data in HAPI FHIR JPA Postgres.

- ⏳ Run `scripts/hapi-fhir-sql-on-fhir/test/run_tests.sql` against a real HAPI FHIR JPA instance.
- ⏳ Run the CMS125 demo SQL against a HAPI instance seeded with the synthetic patient bundle.
- 🤝 **Issue #20**: Preston — wire `CQL_STUDIO_DB_URL` in CQL Studio Server, invoke `install.sql` on boot, expose a `/$execute-sql` operation that the pipeline service can POST SQL to.
- 🤝 **Issue #23**: Preston — embed the `SqlOnFhirComponent` (or a thin wrapper) into the IDE alongside the existing CQL editor as a "SQL view" pane.

### ⏳ M4 — Broader measure coverage

The transpiler covers CMS125's logic shapes. Two further measures bracket what production looks like.

- ✅ In-browser flattenable types expanded to Tier 1 (MedicationRequest, DiagnosticReport, Coverage, AllergyIntolerance, Immunization, ServiceRequest) with matching PGlite DDL / flattener / patient-key SQL.
- ✅ Live patient multi-select uses per-type FHIR search (not `$everything` / bulk export), with fetch progress + 32 MiB memory warning.
- ⏳ CMS130 (Colorectal Cancer Screening) ELM fixture already shipped under `elm-to-sql/fixtures/`. Wire as a second demo button; tests pass against it.
- ⏳ A ratio-of-counts measure (e.g. CMS122 Diabetes HbA1c Poor Control) — exercises `If`, `Case`, and observation value-quantity comparisons.
- ⏳ A measure with a stratifier — exercises grouping logic in the final SELECT.

### ⏳ M5 — Multi-dialect support

Today's transpiler targets PostgreSQL. The same ELM should produce DuckDB-compatible SQL with one option flag.

- ⏳ Dialect option on `TranspilerOptions` (`'postgres' | 'duckdb' | 'bigquery'`).
- ⏳ Per-dialect interval handling (DuckDB has `interval`, not `tstzrange`).
- ⏳ Per-dialect date arithmetic.
- ⏳ A DuckDB-WASM execution service alongside `sql-on-fhir/sql-on-fhir-pglite.service.ts` for users who want it.

### ⏳ M6 — Save MeasureReport flow

The pipeline already produces a valid FHIR R4 `MeasureReport`. Saving it should be friction-free.

- ✅ "Save MeasureReport" button rendered when a FHIR base URL is configured.
- ✅ POST to `{fhirBaseUrl}/MeasureReport`.
- ⏳ Verify against HAPI and Foundry distributions during connectathon prep.
- ⏳ Per-evaluator (`MeasureReport.evaluatedResource`) references back to the contributing Bundle.

### ⏳ M7 — Educational content

The CQL Studio website and docs should make the SQL-on-FHIR path discoverable.

- ⏳ Add a "SQL-on-FHIR" feature page to the CQL Studio website.
- ⏳ Embed a video walkthrough of the `/sql` flow (closes #24).
- ⏳ Cross-link to the SQL-on-FHIR working group's spec and the December 2025 conference talk.

## Cross-cutting concerns

### Performance

PGlite in-browser is ~3 MB WASM + ~5 MB FS bundle. Lazy-loaded only when the user clicks Execute. The CMS125 query runs in 2–4 ms against the 5-patient demo bundle. For larger populations the cost will be in data loading, not query execution.

### Security

PGlite runs in the browser's WebAssembly sandbox. There is no exposed network surface. All FHIR data the user loads stays in their browser unless they explicitly POST a `MeasureReport` to a configured FHIR base URL.

### Compatibility with existing CQL infrastructure

This effort **adds** an execution path, it does not remove the existing CQL Tests Runner integration (`/runner`) or the AI-assisted IDE workflows. Sites that have invested in the standard ELM interpreters keep using them; sites that want SQL-on-FHIR as their execution layer can now use that too.

## Tracking

The conversation around this work is in:

- [#15](https://github.com/cqframework/cql-studio/issues/15) — End-to-end SQL-on-FHIR (epic).
- [#16](https://github.com/cqframework/cql-studio/issues/16) — Standalone ELM→SQL library. **Closed by this PR** with Preston's recommended in-app layout.
- [#18](https://github.com/cqframework/cql-studio/issues/18) — CMS demo content. **Partial: CMS125 demo shipped.**
- [#20](https://github.com/cqframework/cql-studio/issues/20) — Server-side DB hookup (Preston).
- [#21](https://github.com/cqframework/cql-studio/issues/21) — HAPI FHIR JPA view scripts. **Closed by this PR.**
- [#23](https://github.com/cqframework/cql-studio/issues/23) — SQL tab in the IDE (Preston).
- [#24](https://github.com/cqframework/cql-studio/issues/24) — Demo video.

# SQL-on-FHIR architecture

How the CQL → ELM → SQL → execute → MeasureReport pipeline is built inside CQL Studio.

## Component diagram

```
                                 ┌────────────────────────────────────────────────┐
                                 │  SqlOnFhirComponent  (Angular, /sql route)     │
                                 │  - five-step UI: Library, CQL, ELM, SQL, Exec  │
                                 │  - optional CMS125 preset (same pipeline)      │
                                 └───────┬────────────────────────────┬───────────┘
                                         │                            │
                                         │ ELM JSON + parameterValues   │ counts → MeasureReport
                                         ▼                            ▼
┌────────────────────┐         ┌────────────────────────────┐    ┌─────────────────────────┐
│ TranslationService │────────▶│ SqlOnFhirPipelineService   │───▶│ generateMeasureReport() │
│ (@cqframework/cql) │         │  - generateSql()           │    │ (elm-to-sql lib)        │
│  toXml(), toJson() │         │  - executeSql()            │    └─────────────────────────┘
└────────────────────┘         │  - generateMeasureReport() │
                               │  - saveMeasureReport()     │
                               └────┬────────────────┬──────┘
                                    │                │
                                    │ SQL            │ ExecutionSeedData
                                    ▼                ▼
                ┌────────────────────────┐    ┌──────────────────────────────────┐
                │ ElmToSqlTranspiler     │    │ SqlOnFhirExecutionDataService    │
                │ (in-app library)       │    │  - ELM-driven type fetch         │
                │  - parameterValues     │    │  - per-type FHIR search + progress │
                │  → { sql, populations} │    │  - value-set expansion at exec   │
                └────────────────────────┘    └──────────────┬───────────────────┘
                                                             │ FlatTables
                                                             ▼
                                              ┌──────────────────────────────────┐
                                              │ SqlOnFhirPgliteService           │
                                              │  - lazy WASM boot                │
                                              │  - schema (STANDARD_VIEW_DEFS)   │
                                              │  - .seed(dataKey, FlatTables)    │
                                              │  - .execute(sql) → rows          │
                                              └──────────────┬───────────────────┘
                                                             │
                                                             ▼
                                              ┌──────────────────────────────────┐
                                              │ @electric-sql/pglite             │
                                              │  ~3 MB WASM + 5 MB FS bundle     │
                                              │  served from /pglite/ at build   │
                                              └──────────────────────────────────┘

                                ┌──────────────────────────────────────────────────┐
                                │ SqlOnFhirBundleFlattener (pure functions, .lib) │
                                │  flattenBundle(Bundle) → FlatTables             │
                                │  flattenValueSets(VS[]) → expansion rows        │
                                └──────────────────────────────────────────────────┘

                                ┌──────────────────────────────────────────────────┐
                                │ SqlOnFhirDemoService (CMS125 preset only)       │
                                │  loadCms125() fetches bundled Library, Bundle,  │
                                │  and pre-expanded ValueSets — same execute path │
                                └──────────────────────────────────────────────────┘
```

## Key files

| Path | Role |
|------|------|
| [src/app/components/sql-on-fhir/sql-on-fhir.component.ts](../../src/app/components/sql-on-fhir/sql-on-fhir.component.ts) | UI orchestrator, signal-based state for all five pipeline steps, parameter values, patient selection, compatibility assessment. |
| [src/app/components/sql-on-fhir/library-parameters.lib.ts](../../src/app/components/sql-on-fhir/library-parameters.lib.ts) | Merges FHIR `Library.parameter` + ELM parameter defs; defaults and SQL literal helpers. |
| [src/app/components/sql-on-fhir/measure-resource-types.lib.ts](../../src/app/components/sql-on-fhir/measure-resource-types.lib.ts) | Derives flattenable FHIR resource types from ELM `Retrieve` nodes and `Library.dataRequirement`. |
| [src/app/components/sql-on-fhir/measure-library-compatibility.lib.ts](../../src/app/components/sql-on-fhir/measure-library-compatibility.lib.ts) | Structured measure-readiness checks shown on the Execute tab. |
| [src/app/components/sql-on-fhir/elm-to-sql/](../../src/app/components/sql-on-fhir/elm-to-sql/) | In-app `elm-to-sql` library. Pure TypeScript, no Node deps. |
| [src/app/components/sql-on-fhir/elm-to-sql/transpiler/elm-to-sql.ts](../../src/app/components/sql-on-fhir/elm-to-sql/transpiler/elm-to-sql.ts) | The transpiler proper: ELM JSON in, Postgres SQL out; accepts user `parameterValues`. |
| [src/app/components/sql-on-fhir/elm-to-sql/measure/measure-report.ts](../../src/app/components/sql-on-fhir/elm-to-sql/measure/measure-report.ts) | `generateMeasureReport(counts, options)` and `sqlRowToPopulationCounts(row)`. |
| [src/app/services/sql-on-fhir/sql-on-fhir-pipeline.service.ts](../../src/app/services/sql-on-fhir/sql-on-fhir-pipeline.service.ts) | The orchestrator service the UI calls. |
| [src/app/services/sql-on-fhir/sql-on-fhir-execution-data.service.ts](../../src/app/services/sql-on-fhir/sql-on-fhir-execution-data.service.ts) | Builds `ExecutionSeedData`: ELM-driven patient compartment fetch, merged bundles, value-set rows at execute time. |
| [src/app/services/fhir-bundle-fetch.lib.ts](../../src/app/services/fhir-bundle-fetch.lib.ts) | Paginates FHIR search bundles via `Bundle.link` `next` and merges with deduplication. |
| [src/app/services/sql-on-fhir/sql-on-fhir-pglite.service.ts](../../src/app/services/sql-on-fhir/sql-on-fhir-pglite.service.ts) | In-browser Postgres via PGlite. Lazy boot, schema, seed, execute. |
| [src/app/services/sql-on-fhir/sql-on-fhir-bundle-flattener.lib.ts](../../src/app/services/sql-on-fhir/sql-on-fhir-bundle-flattener.lib.ts) | FHIR Bundle → flat rows, matching `STANDARD_VIEW_DEFINITIONS`. |
| [src/app/services/sql-on-fhir/sql-on-fhir-demo.service.ts](../../src/app/services/sql-on-fhir/sql-on-fhir-demo.service.ts) | Fetches shipped CMS125 preset content (optional shortcut, not a separate execution path). |
| [src/app/services/patient.service.ts](../../src/app/services/patient.service.ts) | FHIR Patient CRUD/search. (`$everything` remains available but SQL-on-FHIR seed uses per-type search.) |
| [src/app/services/translation.service.ts](../../src/app/services/translation.service.ts) | `@cqframework/cql` wrapper. Exposes both ELM XML and ELM JSON. |
| [public/fhir/sql-on-fhir/](../../public/fhir/sql-on-fhir/) | Static CMS125 preset Library, Bundle, and ValueSets. |
| [scripts/hapi-fhir-sql-on-fhir/](../../scripts/hapi-fhir-sql-on-fhir/) | PostgreSQL view scripts for HAPI FHIR JPA — the server-side counterpart. |

## Flat-table schema

The transpiler targets a schema whose tables are *named like* the SQL-on-FHIR view names (`patient_view`, `observation_view`, etc.) but are concrete tables in PGlite, not views over a normalized FHIR store.

- This sidesteps the need for a Postgres `jsonb_*` extraction layer in-browser.
- It keeps the SQL emitted by the transpiler **identical** to what would run against real HAPI FHIR JPA views — those views *do* extract from the normalized `HFJ_RESOURCE` / `HFJ_RES_VER` tables, but they project to the same column shape.
- The `STANDARD_VIEW_DEFINITIONS` in the library is the single source of truth for the column shape. Both the bundle flattener and the PGlite DDL derive from it.

## Data flow (general library execution)

1. User selects a measure **Library** from the FHIR server (or loads the CMS125 preset, which pre-fills the same state).
2. Component populates `selectedLibrary`, `selectedLibraryJson`, and `cqlPreview` (base64-decoded CQL).
3. Effect chain: `cqlPreview` changes → `TranslationService.translateCqlToElm(cql)` → `elmXmlRaw` and `elmJsonRaw` signals fire.
4. `library-parameters.lib` merges FHIR + ELM parameters into specs; defaults populate `executionParameters` (Measurement Period, etc.).
5. Effect: `elmJsonRaw` or `executionParameters` change → `SqlOnFhirPipelineService.generateSql(elmJson, library, parameterValues)` → `sqlText` signal.
6. `assessMeasureLibraryCompatibility()` runs continuously; blocking issues disable **Execute SQL** and list reasons on the Execute tab.
7. `measure-resource-types.lib` lists flattenable types (Tier 1 clinical set). The Execute tab shows checkboxes for **all** flattenable types (defaults = all selected; **Patient** cannot be unchecked; measure-derived types are badged). When patients are selected, an effect prefetches clinical data with ordinary paginated searches: `GET Patient/{id}` plus `GET {Type}?patient=Patient/{id}` (Coverage uses `beneficiary`). Progress callbacks drive a determinate progress bar and live resource tally. CMS125 preset skips this UI and uses the bundled patient bundle. Estimated JSON payload size is tracked; ≥ 32 MiB triggers a warning with a clear-data action.
8. Prefetched bundles are stored in `executionBundle`; `dataKey` is `patients:{sortedIds}|types:{sortedTypes}` so PGlite re-seeds when patient selection or resource-type selection changes. User clicks **Execute SQL** → `prepareExecutionSeedData()` builds `ExecutionSeedData`:
   - `dataKey` from patient IDs + selected types (or preset key for CMS125)
   - `bundle` from prefetched compartment data or preset bundle
   - `valueSetRows` from bundled ValueSets plus terminology-server expansions for ELM-referenced sets
9. `SqlOnFhirPipelineService.executeSql(sql, seedData)` flattens bundle + value-set rows, seeds PGlite, runs SQL, returns `{ raw, counts, durationMs }`.
10. User clicks **Generate FHIR MeasureReport** → `SqlOnFhirPipelineService.generateMeasureReport(counts, library, parameterValues)` → MeasureReport JSON.
11. **Optional** "Save to FHIR server" → POST to `{fhirBaseUrl}/MeasureReport`.

CMS125 preset steps 7–9 use bundled JSON instead of live patient search, but call the same services and PGlite path.

## Why an Angular signal-based component?

CQL Studio's broader IDE is signal-based (see `IdeStateService`, `SettingsService`). The pipeline component sticks to that convention: each step is a signal, effects chain, and there is no observable streaming-pipeline framework imposed on top.

## Server-side execution (future)

The same `ElmToSqlTranspiler` output runs unchanged against:

- **PGlite** (in-browser, today).
- **HAPI FHIR JPA on Postgres** (via Preston's Issue #20) — the `scripts/hapi-fhir-sql-on-fhir/` views project the HAPI normalized schema into the same flat-view shape, so the transpiled SQL is portable.
- **Any other SQL-on-FHIR-compliant runtime** with a Postgres-compatible dialect.

The pipeline service has a `canSaveMeasureReport()` toggle today; a parallel `useServerSqlExecutor()` toggle is a small follow-up once Preston's `/$execute-sql` endpoint lands.

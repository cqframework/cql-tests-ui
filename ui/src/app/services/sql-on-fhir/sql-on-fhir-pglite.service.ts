// Author: Eugene Vestel
//
// Lazy-booted in-browser Postgres (pglite) for executing SQL emitted by the
// elm-to-sql library against FHIR data flattened by sql-on-fhir-bundle-flattener.
//
// One DB instance per session, kept in memory. Schema is created once on first
// boot; data is re-seeded whenever the demo content changes (keyed by `dataKey`).

import { Injectable, signal } from '@angular/core';
import type { PGlite } from '@electric-sql/pglite';
import type { FlatRow, FlatTables } from './sql-on-fhir-bundle-flattener.lib';

export interface ExecuteResult {
  /** Rows returned by the query, raw column values. Empty array for non-SELECT statements. */
  rows: Record<string, unknown>[];
  /** Number of rows affected (for non-SELECT). */
  affectedRows: number;
  /** SQL actually executed (may differ from the input if normalized). */
  sql: string;
  /** Wall-clock execution time in milliseconds (does not include first-call boot). */
  durationMs: number;
}

const FLAT_TABLE_DDL = `
CREATE TABLE IF NOT EXISTS patient_view (
  id TEXT PRIMARY KEY,
  gender TEXT,
  birthdate DATE,
  active BOOLEAN,
  name_family TEXT,
  name_given TEXT,
  deceased BOOLEAN,
  deceased_datetime TIMESTAMPTZ,
  race_code TEXT,
  ethnicity_code TEXT
);

CREATE TABLE IF NOT EXISTS encounter_view (
  id TEXT PRIMARY KEY,
  subject_id TEXT,
  status TEXT,
  class_code TEXT,
  type_code TEXT,
  type_system TEXT,
  type_display TEXT,
  period_start TIMESTAMPTZ,
  period_end TIMESTAMPTZ,
  service_provider_id TEXT
);

CREATE TABLE IF NOT EXISTS observation_view (
  id TEXT PRIMARY KEY,
  subject_id TEXT,
  status TEXT,
  code TEXT,
  code_system TEXT,
  code_display TEXT,
  code_text TEXT,
  effective_datetime TIMESTAMPTZ,
  effective_start TIMESTAMPTZ,
  effective_end TIMESTAMPTZ,
  value_quantity NUMERIC,
  value_unit TEXT,
  value_code TEXT,
  value_string TEXT,
  encounter_id TEXT,
  category_code TEXT
);

CREATE TABLE IF NOT EXISTS procedure_view (
  id TEXT PRIMARY KEY,
  subject_id TEXT,
  status TEXT,
  code TEXT,
  code_system TEXT,
  code_display TEXT,
  code_text TEXT,
  performed_datetime TIMESTAMPTZ,
  performed_start TIMESTAMPTZ,
  performed_end TIMESTAMPTZ,
  encounter_id TEXT,
  category_code TEXT
);

CREATE TABLE IF NOT EXISTS condition_view (
  id TEXT PRIMARY KEY,
  subject_id TEXT,
  code TEXT,
  code_system TEXT,
  code_display TEXT,
  code_text TEXT,
  clinical_status TEXT,
  verification_status TEXT,
  onset_datetime TIMESTAMPTZ,
  onset_start TIMESTAMPTZ,
  abatement_datetime TIMESTAMPTZ,
  recorded_date TIMESTAMPTZ,
  encounter_id TEXT,
  category_code TEXT
);

CREATE TABLE IF NOT EXISTS medication_request_view (
  id TEXT PRIMARY KEY,
  subject_id TEXT,
  status TEXT,
  intent TEXT,
  medication_code TEXT,
  medication_system TEXT,
  medication_display TEXT,
  authored_on TIMESTAMPTZ,
  encounter_id TEXT,
  requester_id TEXT
);

CREATE TABLE IF NOT EXISTS diagnostic_report_view (
  id TEXT PRIMARY KEY,
  subject_id TEXT,
  status TEXT,
  code TEXT,
  code_system TEXT,
  effective_datetime TIMESTAMPTZ,
  issued TIMESTAMPTZ,
  encounter_id TEXT,
  category_code TEXT
);

CREATE TABLE IF NOT EXISTS coverage_view (
  id TEXT PRIMARY KEY,
  beneficiary_id TEXT,
  status TEXT,
  type_code TEXT,
  payer_id TEXT,
  period_start TIMESTAMPTZ,
  period_end TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS allergy_intolerance_view (
  id TEXT PRIMARY KEY,
  patient_id TEXT,
  clinical_status TEXT,
  verification_status TEXT,
  code TEXT,
  code_system TEXT,
  onset_datetime TIMESTAMPTZ,
  recorded_date TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS immunization_view (
  id TEXT PRIMARY KEY,
  patient_id TEXT,
  status TEXT,
  vaccine_code TEXT,
  vaccine_system TEXT,
  occurrence_datetime TIMESTAMPTZ,
  primary_source BOOLEAN,
  encounter_id TEXT
);

CREATE TABLE IF NOT EXISTS service_request_view (
  id TEXT PRIMARY KEY,
  subject_id TEXT,
  status TEXT,
  intent TEXT,
  category_code TEXT,
  category_system TEXT,
  code TEXT,
  code_system TEXT,
  code_display TEXT,
  code_text TEXT,
  occurrence_datetime TIMESTAMPTZ,
  occurrence_start TIMESTAMPTZ,
  occurrence_end TIMESTAMPTZ,
  authored_on TIMESTAMPTZ,
  requester_id TEXT,
  performer_id TEXT,
  reason_code TEXT,
  do_not_perform BOOLEAN,
  priority TEXT,
  encounter_id TEXT,
  insurance_id TEXT
);

CREATE TABLE IF NOT EXISTS value_set_expansion (
  value_set_id TEXT,
  code TEXT,
  system TEXT,
  display TEXT,
  version TEXT,
  PRIMARY KEY (value_set_id, code)
);
`;

const FLAT_TABLE_NAMES = [
  'patient_view',
  'encounter_view',
  'observation_view',
  'procedure_view',
  'condition_view',
  'medication_request_view',
  'diagnostic_report_view',
  'coverage_view',
  'allergy_intolerance_view',
  'immunization_view',
  'service_request_view',
  'value_set_expansion',
] as const;

type FlatTableName = (typeof FLAT_TABLE_NAMES)[number];

@Injectable({ providedIn: 'root' })
export class SqlOnFhirPgliteService {
  /** Resolves to the running PGlite instance once boot has completed. */
  private pgPromise: Promise<PGlite> | null = null;
  /** Key identifying the most recently seeded data set; used to short-circuit re-seeding. */
  private seededKey: string | null = null;

  readonly isReady = signal(false);
  readonly lastBootError = signal<string | null>(null);

  /**
   * Boot pglite (dynamic import — keeps the WASM out of the main app chunk)
   * and create the flat-table schema. Idempotent; returns the same Promise across
   * concurrent callers.
   */
  ensureBooted(): Promise<PGlite> {
    if (this.pgPromise) return this.pgPromise;
    this.pgPromise = (async () => {
      try {
        const { PGlite } = await import('@electric-sql/pglite');
        // In Node/jsdom (Vitest), pglite resolves its WASM via its own packaging.
        // In the browser, the WASM is copied to /pglite/ via angular.json assets so
        // we fetch + compile here and hand the WebAssembly.Module to the constructor.
        const options = await loadBrowserWasmOptions();
        const pg = new PGlite(options);
        await pg.exec(FLAT_TABLE_DDL);
        await pg.exec('ALTER TABLE value_set_expansion ADD COLUMN IF NOT EXISTS version TEXT');
        this.isReady.set(true);
        return pg;
      } catch (err) {
        this.lastBootError.set(err instanceof Error ? err.message : String(err));
        this.pgPromise = null;
        throw err;
      }
    })();
    return this.pgPromise;
  }

  /**
   * Replace the contents of all flat tables with the provided rows.
   * Idempotent for the same `dataKey` — no-ops if the data hasn't changed.
   */
  async seed(dataKey: string, tables: FlatTables): Promise<void> {
    if (this.seededKey === dataKey) return;
    const pg = await this.ensureBooted();
    await pg.transaction(async tx => {
      for (const name of FLAT_TABLE_NAMES) {
        await tx.exec(`TRUNCATE ${name}`);
        const rows = tables[name] ?? [];
        if (rows.length === 0) continue;
        const columns = Object.keys(rows[0]);
        const placeholders = columns.map((_, i) => `$${i + 1}`).join(', ');
        const insertSql = `INSERT INTO ${name} (${columns.join(', ')}) VALUES (${placeholders})`;
        for (const row of rows) {
          const values = columns.map(c => normalizeValue(row[c]));
          await tx.query(insertSql, values);
        }
      }
    });
    this.seededKey = dataKey;
  }

  /**
   * Run a SQL statement and return the rows. Multi-statement SQL is split on
   * `;` boundaries and only the LAST result is returned — the elm-to-sql library
   * emits a single `WITH … SELECT` so this is the expected shape.
   */
  async execute(sql: string): Promise<ExecuteResult> {
    const pg = await this.ensureBooted();
    const start = performance.now();
    const trimmed = sql.trim().replace(/;\s*$/, '');
    const result = await pg.query<Record<string, unknown>>(trimmed);
    const durationMs = performance.now() - start;
    return {
      rows: result.rows,
      affectedRows: result.affectedRows ?? 0,
      sql: trimmed,
      durationMs,
    };
  }

  /** Test/utility: reset state so a fresh boot happens on the next call. */
  reset(): void {
    this.pgPromise = null;
    this.seededKey = null;
    this.isReady.set(false);
    this.lastBootError.set(null);
  }

  /** Drop seeded rows and forget the data key so the next seed reloads. */
  async clearSeededData(): Promise<void> {
    if (!this.pgPromise) {
      this.seededKey = null;
      return;
    }
    const pg = await this.pgPromise;
    await pg.transaction(async tx => {
      for (const name of FLAT_TABLE_NAMES) {
        await tx.exec(`TRUNCATE ${name}`);
      }
    });
    this.seededKey = null;
  }
}

function normalizeValue(v: FlatRow[string]): unknown {
  // pglite accepts JS primitives directly; null/undefined become SQL NULL.
  if (v === undefined) return null;
  return v;
}

/**
 * Browser-only: fetch the pglite WASM artifacts copied to /pglite/ via angular.json
 * and compile them. In Node/jsdom (Vitest), `fetch` may not be configured for that
 * path — we fall through to pglite's built-in loader.
 */
async function loadBrowserWasmOptions(): Promise<{
  pgliteWasmModule?: WebAssembly.Module;
  initdbWasmModule?: WebAssembly.Module;
  fsBundle?: Blob;
}> {
  if (typeof window === 'undefined' || typeof fetch === 'undefined') {
    return {};
  }
  try {
    const [pgliteWasm, initdbWasm, fsBundle] = await Promise.all([
      fetchAndCompile('/pglite/pglite.wasm'),
      fetchAndCompile('/pglite/initdb.wasm'),
      fetchAsBlob('/pglite/pglite.data'),
    ]);
    return { pgliteWasmModule: pgliteWasm, initdbWasmModule: initdbWasm, fsBundle };
  } catch (err) {
    console.warn('PGlite WASM custom loader failed; falling back to default. Reason:', err);
    return {};
  }
}

async function fetchAsBlob(url: string): Promise<Blob> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Failed to fetch ${url}: ${response.status}`);
  const contentType = response.headers.get('content-type') ?? '';
  if (contentType.includes('text/html')) {
    throw new Error(
      `Expected binary asset at ${url}, got HTML (asset missing from Angular serve/build). ` +
        `Check angular.json pglite asset paths against the hoisted workspace node_modules.`,
    );
  }
  const blob = await response.blob();
  // pglite.data is multi-MB; SPA index fallbacks are ~1KB.
  if (blob.size < 100_000) {
    throw new Error(
      `PGlite FS bundle at ${url} is only ${blob.size} bytes (expected several MB). ` +
        `The /pglite/ assets are not being copied into the app.`,
    );
  }
  return blob;
}

async function fetchAndCompile(url: string): Promise<WebAssembly.Module> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Failed to fetch ${url}: ${response.status}`);
  const contentType = response.headers.get('content-type') ?? '';
  if (contentType.includes('text/html')) {
    throw new Error(`Expected WASM at ${url}, got HTML — /pglite/ assets are not being served`);
  }
  // compileStreaming gives the best performance in browsers that support it
  if (typeof WebAssembly.compileStreaming === 'function') {
    return WebAssembly.compileStreaming(response);
  }
  const bytes = await response.arrayBuffer();
  return WebAssembly.compile(bytes);
}

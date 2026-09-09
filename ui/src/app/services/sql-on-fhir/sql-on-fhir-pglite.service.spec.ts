// Author: Eugene Vestel

import { describe, it, expect, beforeEach } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { SqlOnFhirPgliteService } from './sql-on-fhir-pglite.service';
import { emptyFlatTables } from './sql-on-fhir-bundle-flattener.lib';

describe('SqlOnFhirPgliteService', () => {
  let service: SqlOnFhirPgliteService;

  beforeEach(() => {
    TestBed.configureTestingModule({ providers: [SqlOnFhirPgliteService] });
    service = TestBed.inject(SqlOnFhirPgliteService);
    service.reset();
  });

  it('boots once and exposes a ready signal', async () => {
    expect(service.isReady()).toBe(false);
    await service.ensureBooted();
    expect(service.isReady()).toBe(true);
  });

  it('reuses the same instance across concurrent boot calls', async () => {
    const [a, b] = await Promise.all([service.ensureBooted(), service.ensureBooted()]);
    expect(a).toBe(b);
  });

  it('creates the flat-table schema with the expected tables', async () => {
    const pg = await service.ensureBooted();
    const result = await pg.query<{ table_name: string }>(`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name LIKE '%_view'
      ORDER BY table_name
    `);
    const names = result.rows.map(r => r.table_name);
    expect(names).toEqual([
      'allergy_intolerance_view',
      'condition_view',
      'coverage_view',
      'diagnostic_report_view',
      'encounter_view',
      'immunization_view',
      'medication_request_view',
      'observation_view',
      'patient_view',
      'procedure_view',
      'service_request_view',
    ]);
  });

  it('seeds a patient and queries it back', async () => {
    const tables = emptyFlatTables();
    tables.patient_view.push({
      id: 'pat-1',
      gender: 'female',
      birthdate: '1965-04-15',
      active: true,
      name_family: 'Doe',
      name_given: 'Jane',
      deceased: null,
      deceased_datetime: null,
      race_code: null,
      ethnicity_code: null,
    });

    await service.seed('test-1', tables);
    const result = await service.execute('SELECT id, gender, name_family FROM patient_view');
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toMatchObject({ id: 'pat-1', gender: 'female', name_family: 'Doe' });
  });

  it('seeds value_set_expansion rows with optional version column', async () => {
    const tables = emptyFlatTables();
    tables.value_set_expansion.push(
      {
        value_set_id: 'http://example.org/vs/Mammography',
        code: '24605-8',
        system: 'http://loinc.org',
        display: 'MG',
        version: '2024-01',
      },
    );
    await service.seed('test-vs-version', tables);
    const result = await service.execute(`
      SELECT code, version FROM value_set_expansion
      WHERE value_set_id = 'http://example.org/vs/Mammography'
    `);
    expect(result.rows).toEqual([{ code: '24605-8', version: '2024-01' }]);
  });

  it('seeds value_set_expansion rows and supports a value-set IN-style join', async () => {
    const tables = emptyFlatTables();
    tables.observation_view.push({
      id: 'obs-1', subject_id: 'pat-1', status: 'final',
      code: '24605-8', code_system: 'http://loinc.org', code_display: 'MG',
      code_text: null, effective_datetime: '2024-04-20T10:00:00Z',
      effective_start: null, effective_end: null,
      value_quantity: null, value_unit: null, value_code: null, value_string: null,
      encounter_id: null, category_code: null,
    });
    tables.value_set_expansion.push(
      { value_set_id: 'http://example.org/vs/Mammography', code: '24605-8', system: 'http://loinc.org', display: 'MG' },
      { value_set_id: 'http://example.org/vs/Mammography', code: '26346-7', system: 'http://loinc.org', display: 'MG2' },
    );

    await service.seed('test-vs', tables);
    const result = await service.execute(`
      SELECT o.id FROM observation_view o
      WHERE o.code IN (SELECT code FROM value_set_expansion WHERE value_set_id = 'http://example.org/vs/Mammography')
    `);
    expect(result.rows).toEqual([{ id: 'obs-1' }]);
  });

  it('is idempotent on identical dataKey (no double-insert)', async () => {
    const tables = emptyFlatTables();
    tables.patient_view.push({
      id: 'pat-x', gender: 'male', birthdate: '1970-01-01', active: true,
      name_family: 'X', name_given: 'X', deceased: null, deceased_datetime: null,
      race_code: null, ethnicity_code: null,
    });
    await service.seed('same-key', tables);
    await service.seed('same-key', tables);
    const result = await service.execute('SELECT COUNT(*)::int AS n FROM patient_view');
    expect(result.rows[0]).toEqual({ n: 1 });
  });

  it('supports Postgres-specific syntax used by the elm-to-sql library', async () => {
    const pg = await service.ensureBooted();
    const dateExpr = await pg.query<{ years: number }>(
      `SELECT DATE_PART('year', AGE(TIMESTAMP '2024-01-01', TIMESTAMP '1965-04-15'))::int AS years`,
    );
    expect(dateExpr.rows[0].years).toBe(58);

    const tsrangeExpr = await pg.query<{ contained: boolean }>(
      `SELECT (tsrange('2024-01-01', '2024-12-31', '[)') @> TIMESTAMP '2024-06-15') AS contained`,
    );
    expect(tsrangeExpr.rows[0].contained).toBe(true);
  });
});

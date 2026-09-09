/**
 * Tests for ElmToSqlTranspiler and MeasureReport generator.
 *
 * These test against ELM JSON that mirrors the shape produced by @cqframework/cql.
 * The CMS125 fixture covers the most common eCQM patterns:
 *   Retrieve, Query, ExpressionRef, FunctionRef (AgeInYearsAt),
 *   ParameterRef (Measurement Period), ValueSetRef, And/Or, During, Equal
 */

import { ElmToSqlTranspiler } from './transpiler/elm-to-sql';
import { generateMeasureReport, sqlRowToPopulationCounts } from './measure/measure-report';
import {
  inferMeasureUrlFromLibrary,
  normalizeMeasureReportForServer,
} from './measure/measure-report-normalize.lib';
import { STANDARD_VIEW_DEFINITIONS, viewDefinitionToSql, generateAllViewsSql } from './views/view-definitions';
import { extractValueSets, extractUsedValueSets } from './valueset/value-set-extractor';
import { loadValueSetExpansions } from './valueset/value-set-loader';
import { generateValueSetTableDdl, generateValueSetInsertSql, generateValueSetUpsertSql, generateValueSetSeedScript } from './valueset/value-set-sql';
import type { ElmLibraryWrapper } from './types/elm';
import type { ValueSetExpansionRow } from './valueset/value-set-loader';
import cms125Fixture from './fixtures/cms125-breast-cancer-screening.elm.json';
import cms130Fixture from './fixtures/cms130-colorectal-cancer-screening.elm.json';

const FIXTURES: Record<string, ElmLibraryWrapper> = {
  'cms125-breast-cancer-screening.elm.json': cms125Fixture as unknown as ElmLibraryWrapper,
  'cms130-colorectal-cancer-screening.elm.json': cms130Fixture as unknown as ElmLibraryWrapper,
};

function loadFixture(name: string): ElmLibraryWrapper {
  const fixture = FIXTURES[name];
  if (!fixture) throw new Error(`Unknown fixture: ${name}`);
  return fixture;
}

// ─── ElmToSqlTranspiler ───────────────────────────────────────────────────────

describe('ElmToSqlTranspiler', () => {
  const fixture = loadFixture('cms125-breast-cancer-screening.elm.json');

  test('transpiles CMS125 without throwing', () => {
    const t = new ElmToSqlTranspiler();
    expect(() => t.transpile(fixture)).not.toThrow();
  });

  test('produces a SQL string', () => {
    const t = new ElmToSqlTranspiler();
    const { sql } = t.transpile(fixture);
    expect(typeof sql).toBe('string');
    expect(sql.length).toBeGreaterThan(100);
  });

  test('SQL contains WITH clause', () => {
    const t = new ElmToSqlTranspiler();
    const { sql } = t.transpile(fixture);
    expect(sql.toUpperCase()).toContain('WITH');
  });

  test('SQL contains expected population CTEs', () => {
    const t = new ElmToSqlTranspiler();
    const { sql, populations } = t.transpile(fixture);
    expect(populations).toContain('Initial Population');
    expect(populations).toContain('Denominator');
    expect(populations).toContain('Numerator');
    expect(sql).toContain('Initial_Population');
    expect(sql).toContain('Denominator');
    expect(sql).toContain('Numerator');
  });

  test('SQL contains final SELECT with _count columns', () => {
    const t = new ElmToSqlTranspiler();
    const { sql } = t.transpile(fixture);
    expect(sql).toContain('_count');
  });

  test('respects measurementPeriodStart/End options', () => {
    const t = new ElmToSqlTranspiler({
      measurementPeriodStart: '2023-01-01T00:00:00Z',
      measurementPeriodEnd: '2023-12-31T23:59:59Z',
    });
    const { sql } = t.transpile(fixture);
    expect(sql).toContain('2023-01-01');
    expect(sql).toContain('2023-12-31');
  });

  test('parameterValues override Measurement Period in generated SQL', () => {
    const t = new ElmToSqlTranspiler({
      parameterValues: {
        'Measurement Period': {
          kind: 'period',
          start: '2020-06-01T00:00:00Z',
          end: '2020-12-31T23:59:59Z',
        },
      },
    });
    const { sql } = t.transpile(fixture);
    expect(sql).toContain('2020-06-01');
    expect(sql).toContain('2020-12-31');
  });

  test('parameterValues emit SQL literal for non-Measurement Period string parameter', () => {
    const elm: ElmLibraryWrapper = {
      library: {
        identifier: { id: 'ParamTest', version: '1.0.0' },
        schemaIdentifier: { id: 'urn:hl7-org:elm', version: 'r1' },
        usings: {
          def: [{ localIdentifier: 'System', uri: 'urn:hl7-org:elm-types:r1' }],
        },
        parameters: {
          def: [{ name: 'Reporting Year', parameterTypeSpecifier: { type: 'NamedTypeSpecifier', name: '{urn:hl7-org:elm-types:r1}String' } }],
        },
        statements: {
          def: [
            {
              name: 'Initial Population',
              context: 'Patient',
              expression: {
                type: 'Equal',
                operand: [{ type: 'ParameterRef', name: 'Reporting Year' }, { type: 'Literal', valueType: '{urn:hl7-org:elm-types:r1}String', value: '2024' }],
              },
            },
          ],
        },
      },
    };
    const t = new ElmToSqlTranspiler({
      parameterValues: {
        'Reporting Year': { kind: 'string', value: '2025' },
      },
    });
    const { sql } = t.transpile(elm);
    expect(sql).toContain("'2025'");
  });

  test('can disable comments', () => {
    const t = new ElmToSqlTranspiler({ includeComments: false });
    const { sql } = t.transpile(fixture);
    expect(sql).not.toContain('--');
  });

  test('returns warnings array (may be empty)', () => {
    const t = new ElmToSqlTranspiler();
    const { warnings } = t.transpile(fixture);
    expect(Array.isArray(warnings)).toBe(true);
  });

  test('accepts ElmLibrary directly (without wrapper)', () => {
    const t = new ElmToSqlTranspiler();
    expect(() => t.transpile(fixture.library)).not.toThrow();
  });

  test('handles ExpressionRef (Denominator = Initial Population)', () => {
    const t = new ElmToSqlTranspiler();
    const { sql } = t.transpile(fixture);
    // Denominator should SELECT from Initial_Population CTE
    expect(sql).toContain('Initial_Population');
  });

  test('generates ValueSetRef as value_set_expansion lookup', () => {
    const t = new ElmToSqlTranspiler();
    const { sql } = t.transpile(fixture);
    expect(sql).toContain('value_set_expansion');
  });

  test('generates AgeInYearsAt as DATE_PART', () => {
    const t = new ElmToSqlTranspiler();
    const { sql } = t.transpile(fixture);
    expect(sql).toContain("DATE_PART");
  });

  test('CMS125 correlates Exists Qualifying Encounters to the patient alias', () => {
    const t = new ElmToSqlTranspiler();
    const { sql } = t.transpile(fixture);
    expect(sql).toContain('_e.subject_id = p.id');
  });

  test('CMS125 resource populations count patients via subject_id', () => {
    const t = new ElmToSqlTranspiler();
    const { sql } = t.transpile(fixture);
    expect(sql).toContain('Numerator AS (');
    expect(sql).toContain('Denominator_Exclusion AS (');
    expect(sql).toContain('proc.subject_id = Patient.id');
    expect(sql).toContain('obs.subject_id = Patient.id');
    expect(sql).not.toContain('_pop.subject_id');
  });
});

// ─── MeasureReport generator ──────────────────────────────────────────────────

describe('generateMeasureReport', () => {
  const counts = {
    'Initial Population': 150,
    'Denominator': 120,
    'Denominator Exclusion': 5,
    'Numerator': 80,
  };

  const opts = {
    measureUrl: 'http://ecqi.healthit.gov/ecqms/Measure/BreastCancerScreening',
    periodStart: '2024-01-01',
    periodEnd: '2024-12-31',
  };

  test('returns a valid MeasureReport resource', () => {
    const report = generateMeasureReport(counts, opts);
    expect(report.resourceType).toBe('MeasureReport');
    expect(report.status).toBe('complete');
    expect(report.type).toBe('summary');
  });

  test('includes measure URL', () => {
    const report = generateMeasureReport(counts, opts);
    expect(report.measure).toBe(opts.measureUrl);
  });

  test('includes period', () => {
    const report = generateMeasureReport(counts, opts);
    expect(report.period.start).toBe(opts.periodStart);
    expect(report.period.end).toBe(opts.periodEnd);
  });

  test('includes all population groups', () => {
    const report = generateMeasureReport(counts, opts);
    const group = report.group?.[0];
    expect(group).toBeDefined();
    const pops = group?.population?.map(p => p.code?.text).filter((text): text is string => !!text) ?? [];
    expect(pops).toContain('Initial Population');
    expect(pops).toContain('Denominator');
    expect(pops).toContain('Numerator');
  });

  test('calculates measure score', () => {
    const report = generateMeasureReport(counts, opts);
    const score = report.group?.[0]?.measureScore?.value;
    // 80 / (120 - 5) = 0.6957...
    expect(score).toBeCloseTo(0.6957, 2);
  });

  test('measure score is null when denominator is 0', () => {
    const report = generateMeasureReport({ 'Numerator': 5, 'Denominator': 0 }, opts);
    expect(report.group?.[0]?.measureScore).toBeUndefined();
  });

  test('population counts are integers', () => {
    const report = generateMeasureReport({ 'Numerator': 80.9, 'Denominator': 120.1 }, opts);
    expect(report.group?.[0]?.population?.[0]?.count).toBe(80);
    expect(report.group?.[0]?.population?.[1]?.count).toBe(120);
  });

  test('create normalization strips client id', () => {
    const report = generateMeasureReport(counts, opts);
    const normalized = normalizeMeasureReportForServer(report, 'create');
    expect(normalized.id).toBeUndefined();
    expect(normalized.meta).toBeUndefined();
    expect(normalized.group?.[0]?.id).toBe('group-1');
  });

  test('update normalization preserves server id and meta', () => {
    const report = generateMeasureReport(counts, opts);
    const meta = { versionId: '3', lastUpdated: '2024-06-01T00:00:00Z' };
    const normalized = normalizeMeasureReportForServer(report, 'update', 'server-123', meta);
    expect(normalized.id).toBe('server-123');
    expect(normalized.meta).toEqual(meta);
  });
});

describe('inferMeasureUrlFromLibrary', () => {
  test('maps CMS125 demo library name to eCQM Measure URL', () => {
    expect(inferMeasureUrlFromLibrary({ resourceType: 'Library', name: 'BreastCancerScreening', status: 'active', type: {} })).toBe(
      'http://ecqi.healthit.gov/ecqms/Measure/BreastCancerScreening',
    );
  });
});

// ─── sqlRowToPopulationCounts ─────────────────────────────────────────────────

describe('sqlRowToPopulationCounts', () => {
  test('converts SQL result row to PopulationCounts', () => {
    const row = {
      Initial_Population_count: 150,
      Denominator_count: 120,
      Numerator_count: 80,
    };
    const counts = sqlRowToPopulationCounts(row);
    expect(counts['Initial Population']).toBe(150);
    expect(counts['Denominator']).toBe(120);
    expect(counts['Numerator']).toBe(80);
  });

  test('ignores non-count columns', () => {
    const row = { Initial_Population_count: 10, some_other_col: 'foo' };
    const counts = sqlRowToPopulationCounts(row);
    expect(Object.keys(counts)).toHaveLength(1);
  });
});

// ─── CMS130 ColorectalCancerScreening ────────────────────────────────────────

describe('CMS130 ColorectalCancerScreening', () => {
  const fixture = loadFixture('cms130-colorectal-cancer-screening.elm.json');
  let sql: string;
  let populations: string[];
  let warnings: string[];

  beforeAll(() => {
    const t = new ElmToSqlTranspiler({
      measurementPeriodStart: '2024-01-01T00:00:00Z',
      measurementPeriodEnd: '2024-12-31T23:59:59Z',
    });
    ({ sql, populations, warnings } = t.transpile(fixture));
  });

  test('transpiles CMS130 without throwing', () => {
    const t = new ElmToSqlTranspiler();
    expect(() => t.transpile(fixture)).not.toThrow();
  });

  test('produces a non-empty SQL string', () => {
    expect(typeof sql).toBe('string');
    expect(sql.length).toBeGreaterThan(200);
  });

  test('SQL contains WITH clause', () => {
    expect(sql.toUpperCase()).toContain('WITH');
  });

  test('identifies all CMS130 populations', () => {
    expect(populations).toContain('Initial Population');
    expect(populations).toContain('Denominator');
    expect(populations).toContain('Denominator Exclusion');
    expect(populations).toContain('Numerator');
  });

  test('SQL contains all population CTE identifiers', () => {
    expect(sql).toContain('Initial_Population');
    expect(sql).toContain('Denominator_Exclusion');
    expect(sql).toContain('Numerator');
  });

  test('SQL contains final SELECT with _count columns', () => {
    expect(sql).toContain('_count');
  });

  test('Union of Denominator Exclusion produces UNION in SQL', () => {
    // Denominator Exclusion is a Union of Condition (colon cancer) + Procedure (total colectomy)
    expect(sql.toUpperCase()).toContain('UNION');
  });

  test('Numerator union references all three screening CTEs', () => {
    // Numerator = Colonoscopy Within 10 Years UNION FOBT Within 1 Year UNION Flexible Sigmoidoscopy Within 5 Years
    expect(sql).toContain('Colonoscopy_Within_10_Years');
    expect(sql).toContain('FOBT_Within_1_Year');
    expect(sql).toContain('Flexible_Sigmoidoscopy_Within_5_Years');
  });

  test('SQL references condition_view for colon cancer exclusion', () => {
    expect(sql).toContain('condition_view');
  });

  test('SQL references procedure_view for colonoscopy and colectomy', () => {
    expect(sql).toContain('procedure_view');
  });

  test('SQL references observation_view for FOBT', () => {
    expect(sql).toContain('observation_view');
  });

  test('SQL references value_set_expansion for all value sets', () => {
    expect(sql).toContain('value_set_expansion');
  });

  test('SQL contains AgeInYearsAt expression for ages 45-75', () => {
    expect(sql).toContain('DATE_PART');
  });

  test('returns warnings array', () => {
    expect(Array.isArray(warnings)).toBe(true);
  });

  test('accepts ElmLibrary directly (without wrapper)', () => {
    const t = new ElmToSqlTranspiler();
    expect(() => t.transpile(fixture.library)).not.toThrow();
  });
});

// ─── Value Set Extractor ──────────────────────────────────────────────────────

describe('extractValueSets', () => {
  const cms125 = loadFixture('cms125-breast-cancer-screening.elm.json');
  const cms130 = loadFixture('cms130-colorectal-cancer-screening.elm.json');

  test('extracts all declared value sets from CMS125', () => {
    const refs = extractValueSets(cms125);
    expect(refs.length).toBe(3);
    const names = refs.map(r => r.name);
    expect(names).toContain('Mammography');
    expect(names).toContain('Bilateral Mastectomy');
    expect(names).toContain('Office Visit');
  });

  test('each CMS125 ref has a non-empty url', () => {
    const refs = extractValueSets(cms125);
    for (const ref of refs) {
      expect(ref.url).toBeTruthy();
      expect(ref.url).toMatch(/^http/);
    }
  });

  test('extracts all declared value sets from CMS130', () => {
    const refs = extractValueSets(cms130);
    expect(refs.length).toBe(7);
    const names = refs.map(r => r.name);
    expect(names).toContain('Colonoscopy');
    expect(names).toContain('Fecal Occult Blood Test (FOBT)');
    expect(names).toContain('Flexible Sigmoidoscopy');
    expect(names).toContain('Malignant Neoplasm of Colon');
    expect(names).toContain('Total Colectomy');
  });

  test('accepts ElmLibrary directly (without wrapper)', () => {
    const refs = extractValueSets(cms125.library);
    expect(refs.length).toBe(3);
  });

  test('returns empty array when library has no value sets', () => {
    const refs = extractValueSets({ library: { valueSets: { def: [] } } });
    expect(refs).toEqual([]);
  });
});

describe('extractUsedValueSets', () => {
  const cms130 = loadFixture('cms130-colorectal-cancer-screening.elm.json');

  test('returns only value sets referenced in statements', () => {
    const used = extractUsedValueSets(cms130);
    // All 7 CMS130 value sets are referenced in its statements
    expect(used.length).toBeGreaterThanOrEqual(1);
  });

  test('used subset is not larger than full set', () => {
    const all = extractValueSets(cms130);
    const used = extractUsedValueSets(cms130);
    expect(used.length).toBeLessThanOrEqual(all.length);
  });

  test('each used ref exists in the full declared set', () => {
    const all = extractValueSets(cms130);
    const used = extractUsedValueSets(cms130);
    const allUrls = new Set(all.map(r => r.url));
    for (const ref of used) {
      expect(allUrls.has(ref.url)).toBe(true);
    }
  });
});

// ─── Value Set Loader (with mock fetch) ──────────────────────────────────────

describe('loadValueSetExpansions', () => {
  const sampleExpansion = {
    resourceType: 'ValueSet',
    url: 'http://cts.nlm.nih.gov/fhir/ValueSet/test-vs',
    expansion: {
      contains: [
        { system: 'http://snomed.info/sct', code: '12345678', display: 'Test procedure' },
        { system: 'http://snomed.info/sct', code: '87654321', display: 'Another procedure' },
      ],
    },
  };

  function makeFetch(responses: Record<string, unknown>): typeof fetch {
    return async (input: Parameters<typeof fetch>[0]) => {
      const url = typeof input === 'string' ? input : input.toString();
      for (const [pattern, body] of Object.entries(responses)) {
        if (url.includes(pattern)) {
          return { ok: true, json: async () => body } as Response;
        }
      }
      return { ok: false, status: 404, json: async () => ({}) } as Response;
    };
  }

  test('flattens expansion.contains into rows', async () => {
    const mockFetch = makeFetch({ '$expand': sampleExpansion });
    const refs = [{ name: 'Test VS', url: 'http://cts.nlm.nih.gov/fhir/ValueSet/test-vs' }];
    const results = await loadValueSetExpansions('http://fhir.example.com', refs, mockFetch);
    expect(results).toHaveLength(1);
    expect(results[0].rows).toHaveLength(2);
    expect(results[0].error).toBeUndefined();
  });

  test('row has correct value_set_id, code, and system', async () => {
    const mockFetch = makeFetch({ '$expand': sampleExpansion });
    const refs = [{ name: 'Test VS', url: 'http://cts.nlm.nih.gov/fhir/ValueSet/test-vs' }];
    const [result] = await loadValueSetExpansions('http://fhir.example.com', refs, mockFetch);
    const row = result.rows[0];
    expect(row.value_set_id).toBe('http://cts.nlm.nih.gov/fhir/ValueSet/test-vs');
    expect(row.code).toBe('12345678');
    expect(row.system).toBe('http://snomed.info/sct');
    expect(row.display).toBe('Test procedure');
  });

  test('falls back to Bundle search when $expand returns 404', async () => {
    const bundleResponse = {
      resourceType: 'Bundle',
      entry: [{ resource: sampleExpansion }],
    };
    const mockFetch = makeFetch({ 'ValueSet?url': bundleResponse });
    const refs = [{ name: 'Test VS', url: 'http://cts.nlm.nih.gov/fhir/ValueSet/test-vs' }];
    const [result] = await loadValueSetExpansions('http://fhir.example.com', refs, mockFetch);
    expect(result.rows).toHaveLength(2);
  });

  test('falls back to stored ValueSet when $expand returns empty expansion', async () => {
    const emptyExpand = {
      resourceType: 'ValueSet',
      url: 'http://cts.nlm.nih.gov/fhir/ValueSet/test-vs',
      expansion: { timestamp: '2024-01-01T00:00:00Z' },
    };
    const bundleResponse = {
      resourceType: 'Bundle',
      entry: [{ resource: sampleExpansion }],
    };
    const mockFetch = makeFetch({
      '$expand': emptyExpand,
      'ValueSet?url': bundleResponse,
    });
    const refs = [{ name: 'Test VS', url: 'http://cts.nlm.nih.gov/fhir/ValueSet/test-vs' }];
    const [result] = await loadValueSetExpansions('http://fhir.example.com', refs, mockFetch);
    expect(result.rows).toHaveLength(2);
    expect(result.error).toBeUndefined();
  });

  test('returns error (not throw) for not-found value sets', async () => {
    const mockFetch = makeFetch({});  // always 404
    const refs = [{ name: 'Missing VS', url: 'http://example.com/missing' }];
    const [result] = await loadValueSetExpansions('http://fhir.example.com', refs, mockFetch);
    expect(result.rows).toHaveLength(0);
    expect(result.error).toBeTruthy();
  });

  test('returns error when ValueSet has no expansion', async () => {
    const noExpansion = { resourceType: 'ValueSet', url: 'http://example.com/vs' };
    const mockFetch = makeFetch({ '$expand': noExpansion });
    const refs = [{ name: 'No Expansion', url: 'http://example.com/vs' }];
    const [result] = await loadValueSetExpansions('http://fhir.example.com', refs, mockFetch);
    expect(result.rows).toHaveLength(0);
    expect(result.error).toMatch(/pre-expanded/i);
  });

  test('loads multiple value sets in parallel', async () => {
    const vs1 = { ...sampleExpansion, url: 'http://example.com/vs1' };
    const vs2 = { ...sampleExpansion, url: 'http://example.com/vs2' };
    let callCount = 0;
    const mockFetch: typeof fetch = async (input) => {
      callCount++;
      const url = input.toString();
      const body = url.includes('vs1') ? vs1 : url.includes('vs2') ? vs2 : null;
      if (!body) return { ok: false, status: 404, json: async () => ({}) } as Response;
      return { ok: true, json: async () => body } as Response;
    };
    const refs = [
      { name: 'VS1', url: 'http://example.com/vs1' },
      { name: 'VS2', url: 'http://example.com/vs2' },
    ];
    const results = await loadValueSetExpansions('http://fhir.example.com', refs, mockFetch);
    expect(results).toHaveLength(2);
    expect(results[0].rows).toHaveLength(2);
    expect(results[1].rows).toHaveLength(2);
  });

  test('flattens nested expansion hierarchy', async () => {
    const nestedExpansion = {
      resourceType: 'ValueSet',
      url: 'http://example.com/nested',
      expansion: {
        contains: [
          {
            system: 'http://snomed.info/sct',
            code: 'parent',
            display: 'Parent',
            contains: [
              { system: 'http://snomed.info/sct', code: 'child1', display: 'Child 1' },
              { system: 'http://snomed.info/sct', code: 'child2', display: 'Child 2' },
            ],
          },
        ],
      },
    };
    const mockFetch = makeFetch({ '$expand': nestedExpansion });
    const refs = [{ name: 'Nested', url: 'http://example.com/nested' }];
    const [result] = await loadValueSetExpansions('http://fhir.example.com', refs, mockFetch);
    expect(result.rows).toHaveLength(3);  // parent + 2 children
    const codes = result.rows.map(r => r.code);
    expect(codes).toContain('parent');
    expect(codes).toContain('child1');
    expect(codes).toContain('child2');
  });
});

// ─── Value Set SQL generators ─────────────────────────────────────────────────

describe('generateValueSetTableDdl', () => {
  test('generates CREATE TABLE IF NOT EXISTS', () => {
    const ddl = generateValueSetTableDdl();
    expect(ddl).toContain('CREATE TABLE IF NOT EXISTS value_set_expansion');
  });

  test('includes all required columns', () => {
    const ddl = generateValueSetTableDdl();
    expect(ddl).toContain('value_set_id');
    expect(ddl).toContain('code');
    expect(ddl).toContain('system');
    expect(ddl).toContain('display');
    expect(ddl).toContain('version');
  });

  test('includes PRIMARY KEY on (value_set_id, system, code)', () => {
    const ddl = generateValueSetTableDdl();
    expect(ddl).toContain('PRIMARY KEY');
  });

  test('accepts custom table name', () => {
    const ddl = generateValueSetTableDdl('my_vs_table');
    expect(ddl).toContain('CREATE TABLE IF NOT EXISTS my_vs_table');
    expect(ddl).toContain('idx_my_vs_table_vs_id');
  });
});

describe('generateValueSetInsertSql / generateValueSetUpsertSql', () => {
  const rows: ValueSetExpansionRow[] = [
    { value_set_id: 'http://example.com/vs', code: 'A001', system: 'http://snomed.info/sct', display: 'Code A' },
    { value_set_id: 'http://example.com/vs', code: 'B002', system: 'http://snomed.info/sct' },
  ];

  test('INSERT includes all column names', () => {
    const sql = generateValueSetInsertSql(rows);
    expect(sql).toContain('INSERT INTO value_set_expansion');
    expect(sql).toContain('value_set_id, code, system, display, version');
  });

  test('INSERT contains the row values', () => {
    const sql = generateValueSetInsertSql(rows);
    expect(sql).toContain('A001');
    expect(sql).toContain('B002');
    expect(sql).toContain('Code A');
  });

  test('NULL is emitted for undefined optional fields', () => {
    const sql = generateValueSetInsertSql(rows);
    expect(sql).toContain('NULL');
  });

  test('UPSERT appends ON CONFLICT DO NOTHING', () => {
    const sql = generateValueSetUpsertSql(rows);
    expect(sql).toContain('ON CONFLICT DO NOTHING');
  });

  test('returns placeholder comment for empty rows', () => {
    const sql = generateValueSetInsertSql([]);
    expect(sql).toContain('No rows');
  });

  test('single quotes in values are escaped', () => {
    const tricky: ValueSetExpansionRow[] = [
      { value_set_id: "it's/vs", code: 'X', system: 'http://sys', display: "Colon's" },
    ];
    const sql = generateValueSetInsertSql(tricky);
    expect(sql).toContain("it''s/vs");
    expect(sql).toContain("Colon''s");
  });
});

describe('generateValueSetSeedScript', () => {
  const rows: ValueSetExpansionRow[] = [
    { value_set_id: 'http://example.com/vs', code: 'A001', system: 'http://snomed.info/sct' },
  ];

  test('seed script includes DDL + DML wrapped in transaction', () => {
    const script = generateValueSetSeedScript(rows);
    expect(script).toContain('CREATE TABLE IF NOT EXISTS');
    expect(script).toContain('INSERT INTO');
    expect(script).toContain('BEGIN;');
    expect(script).toContain('COMMIT;');
  });

  test('seed script reports value set and code counts', () => {
    const script = generateValueSetSeedScript(rows);
    expect(script).toContain('Total codes: 1');
    expect(script).toContain('Value sets: 1');
  });
});

// ─── ViewDefinitions ─────────────────────────────────────────────────────────

describe('STANDARD_VIEW_DEFINITIONS', () => {
  test('contains at least 5 resource views', () => {
    expect(STANDARD_VIEW_DEFINITIONS.length).toBeGreaterThanOrEqual(5);
  });

  test('every definition has a name and resource', () => {
    for (const vd of STANDARD_VIEW_DEFINITIONS) {
      expect(vd.name).toBeTruthy();
      expect(vd.resource).toBeTruthy();
      expect(vd.resourceType).toBe('ViewDefinition');
    }
  });

  test('viewDefinitionToSql produces CREATE OR REPLACE VIEW', () => {
    const vd = STANDARD_VIEW_DEFINITIONS[0];
    const { sql } = viewDefinitionToSql(vd);
    expect(sql).toContain('CREATE OR REPLACE VIEW');
    expect(sql).toContain(vd.name);
  });

  test('generateAllViewsSql is a non-empty string', () => {
    const sql = generateAllViewsSql();
    expect(typeof sql).toBe('string');
    expect(sql.length).toBeGreaterThan(500);
  });
});

// ─── US Core 6.1 ViewDefinition column contracts ─────────────────────────────
// These tests lock down the column set that the CQL-to-SQL transpiler and
// the HAPI FHIR JPA SQL views both depend on. A column removal or rename here
// is a breaking change for every generated measure query.

describe('US Core 6.1 ViewDefinition column contracts', () => {
  /** Helper: returns the flat column list for the named view. */
  function cols(viewName: string): string[] {
    const vd = STANDARD_VIEW_DEFINITIONS.find(v => v.name === viewName);
    if (!vd) return [];
    const result: string[] = [];
    function walk(selects: import('./views/view-definitions').ViewDefinitionSelect[]) {
      for (const s of selects) {
        if (s.column) result.push(...s.column.map(c => c.name));
        if (s.select) walk(s.select);
      }
    }
    walk(vd.select);
    return result;
  }

  // ── Inventory ──────────────────────────────────────────────────────────────

  test('STANDARD_VIEW_DEFINITIONS has exactly 11 views (US Core 6.1 + base set)', () => {
    expect(STANDARD_VIEW_DEFINITIONS).toHaveLength(11);
  });

  test('all expected view names are present', () => {
    const names = STANDARD_VIEW_DEFINITIONS.map(v => v.name);
    const expected = [
      'patient_view',
      'observation_view',
      'condition_view',
      'procedure_view',
      'encounter_view',
      'medication_request_view',
      'diagnostic_report_view',
      'coverage_view',
      'allergy_intolerance_view',
      'immunization_view',
      'service_request_view',
    ];
    for (const name of expected) {
      expect(names).toContain(name);
    }
  });

  test('no duplicate view names', () => {
    const names = STANDARD_VIEW_DEFINITIONS.map(v => v.name);
    expect(new Set(names).size).toBe(names.length);
  });

  test('all views have status active', () => {
    for (const vd of STANDARD_VIEW_DEFINITIONS) {
      expect(vd.status).toBe('active');
    }
  });

  test('every view has at least one column', () => {
    for (const vd of STANDARD_VIEW_DEFINITIONS) {
      expect(cols(vd.name).length).toBeGreaterThan(0);
    }
  });

  // ── patient_view ───────────────────────────────────────────────────────────

  test('patient_view: has birthdate for AgeInYearsAt calculations', () => {
    expect(cols('patient_view')).toContain('birthdate');
  });

  test('patient_view: has gender, active, deceased_datetime', () => {
    const c = cols('patient_view');
    expect(c).toContain('gender');
    expect(c).toContain('active');
    expect(c).toContain('deceased_datetime');
  });

  test('patient_view: has US Core race/ethnicity extension columns', () => {
    const c = cols('patient_view');
    expect(c).toContain('race_code');
    expect(c).toContain('ethnicity_code');
  });

  // ── encounter_view ─────────────────────────────────────────────────────────

  test('encounter_view: has period_start / period_end for During interval logic', () => {
    const c = cols('encounter_view');
    expect(c).toContain('period_start');
    expect(c).toContain('period_end');
  });

  test('encounter_view: has type_code and class_code for encounter classification', () => {
    const c = cols('encounter_view');
    expect(c).toContain('type_code');
    expect(c).toContain('class_code');
  });

  // ── condition_view ─────────────────────────────────────────────────────────

  test('condition_view: has clinical_status for active-diagnosis filters', () => {
    expect(cols('condition_view')).toContain('clinical_status');
  });

  test('condition_view: has onset_datetime and abatement_datetime for prevalence periods', () => {
    const c = cols('condition_view');
    expect(c).toContain('onset_datetime');
    expect(c).toContain('abatement_datetime');
  });

  test('condition_view: has code, code_system, category_code', () => {
    const c = cols('condition_view');
    expect(c).toContain('code');
    expect(c).toContain('code_system');
    expect(c).toContain('category_code');
  });

  // ── observation_view ───────────────────────────────────────────────────────

  test('observation_view: has effective_datetime for temporal interval joins', () => {
    expect(cols('observation_view')).toContain('effective_datetime');
  });

  test('observation_view: has value_code and value_quantity for result evaluation', () => {
    const c = cols('observation_view');
    expect(c).toContain('value_code');
    expect(c).toContain('value_quantity');
  });

  test('observation_view: has category_code for lab/vital-sign partitioning', () => {
    expect(cols('observation_view')).toContain('category_code');
  });

  // ── procedure_view ─────────────────────────────────────────────────────────

  test('procedure_view: has performed_datetime and performed_start for period logic', () => {
    const c = cols('procedure_view');
    expect(c).toContain('performed_datetime');
    expect(c).toContain('performed_start');
  });

  test('procedure_view: has status for completed-procedure filters', () => {
    expect(cols('procedure_view')).toContain('status');
  });

  // ── medication_request_view ────────────────────────────────────────────────

  test('medication_request_view: has medication_code for formulary lookups', () => {
    expect(cols('medication_request_view')).toContain('medication_code');
  });

  test('medication_request_view: has authored_on for timing logic', () => {
    expect(cols('medication_request_view')).toContain('authored_on');
  });

  // ── diagnostic_report_view ─────────────────────────────────────────────────

  test('diagnostic_report_view: has effective_datetime and category_code', () => {
    const c = cols('diagnostic_report_view');
    expect(c).toContain('effective_datetime');
    expect(c).toContain('category_code');
  });

  // ── coverage_view (US Core 6.1) ────────────────────────────────────────────

  test('coverage_view: has beneficiary_id for patient linkage', () => {
    expect(cols('coverage_view')).toContain('beneficiary_id');
  });

  test('coverage_view: has payer_id, period_start, period_end', () => {
    const c = cols('coverage_view');
    expect(c).toContain('payer_id');
    expect(c).toContain('period_start');
    expect(c).toContain('period_end');
  });

  // ── allergy_intolerance_view (US Core 6.1) ─────────────────────────────────

  test('allergy_intolerance_view: has clinical_status and verification_status', () => {
    const c = cols('allergy_intolerance_view');
    expect(c).toContain('clinical_status');
    expect(c).toContain('verification_status');
  });

  test('allergy_intolerance_view: has code and code_system', () => {
    const c = cols('allergy_intolerance_view');
    expect(c).toContain('code');
    expect(c).toContain('code_system');
  });

  // ── immunization_view (US Core 6.1) ───────────────────────────────────────

  test('immunization_view: has vaccine_code for CVX/NDC lookups', () => {
    const c = cols('immunization_view');
    expect(c).toContain('vaccine_code');
    expect(c).toContain('vaccine_system');
  });

  test('immunization_view: has occurrence_datetime for timing joins', () => {
    expect(cols('immunization_view')).toContain('occurrence_datetime');
  });

  test('immunization_view: has primary_source boolean', () => {
    expect(cols('immunization_view')).toContain('primary_source');
  });

  // ── service_request_view (US Core 6.1) ────────────────────────────────────

  test('service_request_view: has id, subject_id, status, intent', () => {
    const c = cols('service_request_view');
    expect(c).toContain('id');
    expect(c).toContain('subject_id');
    expect(c).toContain('status');
    expect(c).toContain('intent');
  });

  test('service_request_view: has code and code_system for value set joins', () => {
    const c = cols('service_request_view');
    expect(c).toContain('code');
    expect(c).toContain('code_system');
  });

  test('service_request_view: has authored_on for temporal ordering', () => {
    expect(cols('service_request_view')).toContain('authored_on');
  });

  test('service_request_view: has do_not_perform for exclusion logic', () => {
    expect(cols('service_request_view')).toContain('do_not_perform');
  });

  test('service_request_view: has occurrence_datetime and occurrence_start/end', () => {
    const c = cols('service_request_view');
    expect(c).toContain('occurrence_datetime');
    expect(c).toContain('occurrence_start');
    expect(c).toContain('occurrence_end');
  });

  test('service_request_view: has encounter_id and insurance_id', () => {
    const c = cols('service_request_view');
    expect(c).toContain('encounter_id');
    expect(c).toContain('insurance_id');
  });

  test('service_request_view: has 21 columns', () => {
    expect(cols('service_request_view')).toHaveLength(21);
  });

  // ── generateAllViewsSql coverage ──────────────────────────────────────────

  test('generateAllViewsSql includes all 11 view names', () => {
    const sql = generateAllViewsSql();
    const expected = [
      'patient_view', 'observation_view', 'condition_view', 'procedure_view',
      'encounter_view', 'medication_request_view', 'diagnostic_report_view',
      'coverage_view', 'allergy_intolerance_view', 'immunization_view',
      'service_request_view',
    ];
    for (const name of expected) {
      expect(sql).toContain(name);
    }
  });
});

// ─── Authoring operators (Quantity, date arithmetic, Before/After, Overlaps) ──
//
// Added for user-authored basic measures (#35): quantity comparisons on
// observation values, "N years before end of Measurement Period" lookbacks,
// and interval overlap checks.

describe('authoring operators', () => {
  const wrap = (expression: unknown): ElmLibraryWrapper => ({
    library: {
      identifier: { id: 'AuthoringTest', version: '0.0.1' },
      schemaIdentifier: { id: 'urn:hl7-org:elm', version: 'r1' },
      statements: {
        def: [
          { name: 'Initial Population', context: 'Patient', expression },
        ],
      },
    },
  } as unknown as ElmLibraryWrapper);

  const sqlFor = (expression: unknown): string => {
    const t = new ElmToSqlTranspiler({
      measurementPeriodStart: '2024-01-01T00:00:00Z',
      measurementPeriodEnd: '2024-12-31T23:59:59Z',
    });
    return t.transpile(wrap(expression)).sql;
  };

  test('Quantity with UCUM unit renders as bare numeric (value comparison)', () => {
    const sql = sqlFor({
      type: 'Greater',
      operand: [
        { type: 'Property', path: 'value_quantity', scope: 'O' },
        { type: 'Quantity', value: 9, unit: '%' },
      ],
    });
    expect(sql).toContain('O.value_quantity > 9');
    expect(sql).not.toContain("INTERVAL '9");
  });

  test('Quantity with temporal unit renders as INTERVAL', () => {
    const sql = sqlFor({
      type: 'Subtract',
      operand: [
        { type: 'End', operand: { type: 'ParameterRef', name: 'Measurement Period' } },
        { type: 'Quantity', value: 10, unit: 'years' },
      ],
    });
    expect(sql).toContain("INTERVAL '10 years'");
    expect(sql).toContain('upper(tstzrange(');
  });

  test('UCUM temporal abbreviations map to Postgres units', () => {
    const sql = sqlFor({
      type: 'Subtract',
      operand: [
        { type: 'Property', path: 'effective_datetime', scope: 'O' },
        { type: 'Quantity', value: 6, unit: 'mo' },
      ],
    });
    expect(sql).toContain("INTERVAL '6 months'");
  });

  test('Before with interval RHS compares against lower()', () => {
    const sql = sqlFor({
      type: 'Before',
      operand: [
        { type: 'Property', path: 'performed_datetime', scope: 'P' },
        { type: 'ParameterRef', name: 'Measurement Period' },
      ],
    });
    expect(sql).toContain('P.performed_datetime < lower(tstzrange(');
  });

  test('After with interval RHS compares against upper()', () => {
    const sql = sqlFor({
      type: 'After',
      operand: [
        { type: 'Property', path: 'performed_datetime', scope: 'P' },
        { type: 'ParameterRef', name: 'Measurement Period' },
      ],
    });
    expect(sql).toContain('P.performed_datetime > upper(tstzrange(');
  });

  test('SameOrBefore point-vs-point renders <=', () => {
    const sql = sqlFor({
      type: 'SameOrBefore',
      operand: [
        { type: 'Property', path: 'period_start', scope: 'E' },
        { type: 'Property', path: 'period_end', scope: 'E' },
      ],
    });
    expect(sql).toContain('E.period_start <= E.period_end');
  });

  test('Overlaps renders the && range operator', () => {
    const sql = sqlFor({
      type: 'Overlaps',
      operand: [
        { type: 'ParameterRef', name: 'Measurement Period' },
        { type: 'ParameterRef', name: 'Measurement Period' },
      ],
    });
    expect(sql).toContain(') && tstzrange(');
  });

  test('Greatest/Least render GREATEST/LEAST', () => {
    const sql = sqlFor({
      type: 'Greatest',
      operand: [
        { type: 'Literal', valueType: '{urn:hl7-org:elm-types:r1}Integer', value: '1' },
        { type: 'Literal', valueType: '{urn:hl7-org:elm-types:r1}Integer', value: '2' },
      ],
    });
    expect(sql).toContain('GREATEST(1, 2)');
  });
});

describe('Tier 1 resource FK and code columns', () => {
  test('MedicationRequest Retrieve filters on medication_code', () => {
    const t = new ElmToSqlTranspiler({ includeComments: false });
    const { sql } = t.transpile({
      library: {
        identifier: { id: 'MedTest', version: '1.0.0' },
        schemaIdentifier: { id: 'urn:hl7-org:elm', version: 'r1' },
        usings: { def: [{ localIdentifier: 'FHIR', uri: 'http://hl7.org/fhir', version: '4.0.1' }] },
        valueSets: {
          def: [{ name: 'Diabetes Meds', id: 'urn:oid:2.16.840.1.113883.3.464.1003.196.12.1001', accessLevel: 'Public' }],
        },
        statements: {
          def: [
            {
              name: 'Diabetes Meds',
              context: 'Patient',
              accessLevel: 'Public',
              expression: {
                type: 'Retrieve',
                dataType: '{http://hl7.org/fhir}MedicationRequest',
                codes: { type: 'ValueSetRef', name: 'Diabetes Meds' },
              },
            },
          ],
        },
      },
    } as ElmLibraryWrapper);
    expect(sql).toContain('medication_request_view');
    expect(sql).toContain('medication_code');
    expect(sql).not.toMatch(/medication_request_view[\s\S]*?\bWHERE code IN/);
  });

  test('Immunization relationship correlates on patient_id', () => {
    const t = new ElmToSqlTranspiler({ includeComments: false });
    const { sql } = t.transpile({
      library: {
        identifier: { id: 'ImmTest', version: '1.0.0' },
        schemaIdentifier: { id: 'urn:hl7-org:elm', version: 'r1' },
        usings: { def: [{ localIdentifier: 'FHIR', uri: 'http://hl7.org/fhir', version: '4.0.1' }] },
        statements: {
          def: [
            {
              name: 'Patient',
              context: 'Patient',
              accessLevel: 'Public',
              expression: {
                type: 'SingletonFrom',
                operand: { type: 'Retrieve', dataType: '{http://hl7.org/fhir}Patient' },
              },
            },
            {
              name: 'Has Immunization',
              context: 'Patient',
              accessLevel: 'Public',
              expression: {
                type: 'Query',
                source: [
                  {
                    alias: 'P',
                    expression: { type: 'Retrieve', dataType: '{http://hl7.org/fhir}Patient' },
                  },
                ],
                relationship: [
                  {
                    type: 'With',
                    alias: 'I',
                    expression: { type: 'Retrieve', dataType: '{http://hl7.org/fhir}Immunization' },
                  },
                ],
              },
            },
          ],
        },
      },
    } as ElmLibraryWrapper);
    expect(sql).toContain('immunization_view');
    expect(sql).toContain('I.patient_id = P.id');
  });

  test('Coverage Retrieve keys on beneficiary_id for EXISTS correlation', () => {
    const t = new ElmToSqlTranspiler({ includeComments: false });
    const { sql } = t.transpile({
      library: {
        identifier: { id: 'CovTest', version: '1.0.0' },
        schemaIdentifier: { id: 'urn:hl7-org:elm', version: 'r1' },
        usings: { def: [{ localIdentifier: 'FHIR', uri: 'http://hl7.org/fhir', version: '4.0.1' }] },
        statements: {
          def: [
            {
              name: 'Patient',
              context: 'Patient',
              accessLevel: 'Public',
              expression: {
                type: 'SingletonFrom',
                operand: { type: 'Retrieve', dataType: '{http://hl7.org/fhir}Patient' },
              },
            },
            {
              name: 'Has Coverage',
              context: 'Patient',
              accessLevel: 'Public',
              expression: {
                type: 'Exists',
                operand: { type: 'Retrieve', dataType: '{http://hl7.org/fhir}Coverage' },
              },
            },
          ],
        },
      },
    } as ElmLibraryWrapper);
    expect(sql).toContain('coverage_view');
    expect(sql).toMatch(/_e\.beneficiary_id\s*=\s*Patient\.id/);
  });
});

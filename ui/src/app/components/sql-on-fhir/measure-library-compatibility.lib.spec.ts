// Author: Preston Lee

import { describe, expect, test } from 'vitest';
import cms125 from './elm-to-sql/fixtures/cms125-breast-cancer-screening.elm.json';
import { minimalLibrary } from '../../../testing/spec-helpers';
import { buildLibraryParameterSpecs, buildDefaultParameterValues } from './library-parameters.lib';
import { assessMeasureLibraryCompatibility } from './measure-library-compatibility.lib';

describe('measure-library-compatibility.lib', () => {
  test('CMS125 fixture passes with generated SQL result', () => {
    const library = minimalLibrary({ name: 'BreastCancerScreening' });
    const elmJson = JSON.stringify(cms125);
    const specs = buildLibraryParameterSpecs(library, elmJson);
    const values = buildDefaultParameterValues(specs, library, elmJson);
    expect(values['Measurement Period']?.kind).toBe('period');
    const issues = assessMeasureLibraryCompatibility({
      library,
      cqlTranslationErrors: [],
      elmJson,
      generateSqlResult: {
        populations: ['Initial Population', 'Denominator', 'Numerator'],
        warnings: [],
      },
      generateSqlError: null,
      parameterSpecs: specs,
      parameterValues: values,
      hasExecutionBundle: true,
    });
    expect(issues.filter(i => i.severity === 'blocking')).toEqual([]);
  });

  test('reports missing populations for incompatible library', () => {
    const issues = assessMeasureLibraryCompatibility({
      library: null,
      cqlTranslationErrors: [],
      elmJson: JSON.stringify({ library: { statements: { def: [] } } }),
      generateSqlResult: { populations: [], warnings: [] },
      generateSqlError: null,
      parameterSpecs: [],
      parameterValues: {},
      hasExecutionBundle: false,
    });
    expect(issues.some(i => i.code === 'no-populations')).toBe(true);
    expect(issues.some(i => i.code === 'no-execution-data')).toBe(true);
  });

  test('reports CQL translation errors', () => {
    const issues = assessMeasureLibraryCompatibility({
      library: null,
      cqlTranslationErrors: ['Syntax error at line 1'],
      elmJson: null,
      generateSqlResult: null,
      generateSqlError: null,
      parameterSpecs: [],
      parameterValues: {},
      hasExecutionBundle: false,
    });
    expect(issues.some(i => i.code === 'cql-translation-error')).toBe(true);
  });

  test('warns for unsupported resource types', () => {
    const issues = assessMeasureLibraryCompatibility({
      library: null,
      cqlTranslationErrors: [],
      elmJson: null,
      generateSqlResult: { populations: ['Initial Population'], warnings: [] },
      generateSqlError: null,
      parameterSpecs: [],
      parameterValues: {},
      hasExecutionBundle: true,
      unsupportedResourceTypes: ['Claim'],
    });
    expect(issues.some(i => i.code === 'unsupported-resource-type')).toBe(true);
  });

  test('blocks when required derived type is unchecked during FHIR patient fetch', () => {
    const issues = assessMeasureLibraryCompatibility({
      library: null,
      cqlTranslationErrors: [],
      elmJson: null,
      generateSqlResult: { populations: ['Initial Population'], warnings: [] },
      generateSqlError: null,
      parameterSpecs: [],
      parameterValues: {},
      hasExecutionBundle: false,
      derivedResourceTypes: ['Patient', 'Encounter'],
      selectedResourceTypes: ['Patient'],
      usesFhirPatientFetch: true,
    });
    expect(issues.some(i => i.code === 'missing-resource-type' && i.message.includes('Encounter'))).toBe(
      true,
    );
  });
});

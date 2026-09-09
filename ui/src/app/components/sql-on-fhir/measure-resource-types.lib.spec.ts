// Author: Preston Lee

import { describe, expect, test } from 'vitest';
import cms125Elm from './elm-to-sql/fixtures/cms125-breast-cancer-screening.elm.json';
import cms130Elm from './elm-to-sql/fixtures/cms130-colorectal-cancer-screening.elm.json';
import cms125Library from '../../../../public/fhir/sql-on-fhir/cms125-library.json';
import type { Library } from 'fhir/r4';
import { minimalLibrary } from '../../../testing/spec-helpers';
import {
  extractRetrieveTypesFromElm,
  extractTypesFromLibrary,
  resolveExecutionResourceTypes,
} from './measure-resource-types.lib';

describe('measure-resource-types.lib', () => {
  test('CMS125 ELM retrieves flattenable types', () => {
    const types = extractRetrieveTypesFromElm(JSON.stringify(cms125Elm));
    expect(types).toEqual(['Encounter', 'Observation', 'Patient', 'Procedure']);
  });

  test('CMS130 ELM includes Condition', () => {
    const types = extractRetrieveTypesFromElm(JSON.stringify(cms130Elm));
    expect(types).toContain('Condition');
  });

  test('CMS125 library dataRequirement types', () => {
    const types = extractTypesFromLibrary(cms125Library as Library);
    expect(types).toEqual(['Encounter', 'Observation', 'Patient', 'Procedure']);
  });

  test('resolveExecutionResourceTypes merges ELM and Library', () => {
    const result = resolveExecutionResourceTypes({
      elmJson: JSON.stringify(cms125Elm),
      library: cms125Library as Library,
    });
    expect(result.derivedTypes).toEqual(['Encounter', 'Observation', 'Patient', 'Procedure']);
    expect(result.unsupportedTypes).toEqual([]);
  });

  test('resolveExecutionResourceTypes ELM-only when Library has no dataRequirement', () => {
    const result = resolveExecutionResourceTypes({
      elmJson: JSON.stringify(cms125Elm),
      library: minimalLibrary({ name: 'Test' }),
    });
    expect(result.derivedTypes).toEqual(['Encounter', 'Observation', 'Patient', 'Procedure']);
  });

  test('unsupported types reported separately', () => {
    const elm = {
      library: {
        statements: {
          def: [
            {
              name: 'Test',
              expression: {
                type: 'Retrieve',
                dataType: '{http://hl7.org/fhir}Claim',
              },
            },
          ],
        },
      },
    };
    const result = resolveExecutionResourceTypes({
      elmJson: JSON.stringify(elm),
      library: null,
    });
    expect(result.unsupportedTypes).toEqual(['Claim']);
    expect(result.derivedTypes).toEqual(['Patient']);
  });

  test('MedicationRequest is flattenable', () => {
    const elm = {
      library: {
        statements: {
          def: [
            {
              name: 'Test',
              expression: {
                type: 'Retrieve',
                dataType: '{http://hl7.org/fhir}MedicationRequest',
              },
            },
          ],
        },
      },
    };
    const result = resolveExecutionResourceTypes({
      elmJson: JSON.stringify(elm),
      library: null,
    });
    expect(result.unsupportedTypes).toEqual([]);
    expect(result.derivedTypes).toEqual(['MedicationRequest', 'Patient']);
  });
});

// Author: Eugene Vestel

import { describe, it, expect } from 'vitest';
import type {
  Bundle,
  ValueSet,
  Patient,
  Encounter,
  Observation,
  Procedure,
  Condition,
} from 'fhir/r4';
import {
  flattenBundle,
  flattenValueSetExpansion,
  emptyFlatTables,
} from './sql-on-fhir-bundle-flattener.lib';

describe('flattenBundle', () => {
  it('returns empty tables for an empty bundle', () => {
    const result = flattenBundle({ resourceType: 'Bundle', type: 'collection' });
    expect(result).toEqual(emptyFlatTables());
  });

  it('flattens a Patient with the columns the elm-to-sql library expects', () => {
    const bundle: Bundle = {
      resourceType: 'Bundle',
      type: 'collection',
      entry: [
        {
          resource: {
            resourceType: 'Patient',
            id: 'pat-1',
            active: true,
            gender: 'female',
            birthDate: '1965-04-15',
            name: [
              { use: 'usual', family: 'Nickname', given: ['Janie'] },
              { use: 'official', family: 'Doe', given: ['Jane'] },
            ],
          } as Patient,
        },
      ],
    };
    const result = flattenBundle(bundle);
    expect(result.patient_view).toHaveLength(1);
    expect(result.patient_view[0]).toMatchObject({
      id: 'pat-1',
      gender: 'female',
      birthdate: '1965-04-15',
      active: true,
      name_family: 'Doe',
      name_given: 'Jane',
    });
  });

  it('falls back to first name when no official name is present', () => {
    const bundle: Bundle = {
      resourceType: 'Bundle',
      type: 'collection',
      entry: [
        {
          resource: {
            resourceType: 'Patient',
            id: 'pat-2',
            name: [{ use: 'usual', family: 'OnlyName', given: ['Solo'] }],
          } as Patient,
        },
      ],
    };
    const result = flattenBundle(bundle);
    expect(result.patient_view[0]['name_family']).toBe('OnlyName');
    expect(result.patient_view[0]['name_given']).toBe('Solo');
  });

  it('extracts US Core race and ethnicity from extensions', () => {
    const bundle: Bundle = {
      resourceType: 'Bundle',
      type: 'collection',
      entry: [
        {
          resource: {
            resourceType: 'Patient',
            id: 'pat-3',
            extension: [
              {
                url: 'http://hl7.org/fhir/us/core/StructureDefinition/us-core-race',
                extension: [
                  { url: 'ombCategory', valueCoding: { system: 'urn:oid:2.16.840.1.113883.6.238', code: '2106-3', display: 'White' } },
                ],
              },
              {
                url: 'http://hl7.org/fhir/us/core/StructureDefinition/us-core-ethnicity',
                extension: [
                  { url: 'ombCategory', valueCoding: { system: 'urn:oid:2.16.840.1.113883.6.238', code: '2186-5', display: 'Not Hispanic or Latino' } },
                ],
              },
            ],
          } as Patient,
        },
      ],
    };
    const result = flattenBundle(bundle);
    expect(result.patient_view[0]['race_code']).toBe('2106-3');
    expect(result.patient_view[0]['ethnicity_code']).toBe('2186-5');
  });

  it('flattens Encounter type code, subject_id, period_start/end', () => {
    const bundle: Bundle = {
      resourceType: 'Bundle',
      type: 'collection',
      entry: [
        {
          resource: {
            resourceType: 'Encounter',
            id: 'enc-1',
            status: 'finished',
            class: { system: 'http://terminology.hl7.org/CodeSystem/v3-ActCode', code: 'AMB' },
            type: [{ coding: [{ system: 'http://www.ama-assn.org/go/cpt', code: '99213', display: 'Office visit' }] }],
            subject: { reference: 'Patient/pat-1' },
            period: { start: '2024-03-12T09:00:00Z', end: '2024-03-12T09:30:00Z' },
          } as Encounter,
        },
      ],
    };
    const result = flattenBundle(bundle);
    expect(result.encounter_view[0]).toMatchObject({
      id: 'enc-1',
      subject_id: 'pat-1',
      status: 'finished',
      class_code: 'AMB',
      type_code: '99213',
      type_system: 'http://www.ama-assn.org/go/cpt',
      period_start: '2024-03-12T09:00:00Z',
      period_end: '2024-03-12T09:30:00Z',
    });
  });

  it('flattens Observation effective_datetime and code', () => {
    const bundle: Bundle = {
      resourceType: 'Bundle',
      type: 'collection',
      entry: [
        {
          resource: {
            resourceType: 'Observation',
            id: 'obs-1',
            status: 'final',
            code: { coding: [{ system: 'http://loinc.org', code: '24605-8', display: 'MG Breast Screening' }] },
            subject: { reference: 'Patient/pat-1' },
            effectiveDateTime: '2024-04-20T10:15:00Z',
          } as Observation,
        },
      ],
    };
    const result = flattenBundle(bundle);
    expect(result.observation_view[0]).toMatchObject({
      id: 'obs-1',
      subject_id: 'pat-1',
      code: '24605-8',
      code_system: 'http://loinc.org',
      effective_datetime: '2024-04-20T10:15:00Z',
    });
  });

  it('flattens Procedure performed_datetime and subject_id', () => {
    const bundle: Bundle = {
      resourceType: 'Bundle',
      type: 'collection',
      entry: [
        {
          resource: {
            resourceType: 'Procedure',
            id: 'proc-1',
            status: 'completed',
            code: { coding: [{ system: 'http://snomed.info/sct', code: '173425001', display: 'Bilateral mastectomy' }] },
            subject: { reference: 'Patient/pat-1' },
            performedDateTime: '2018-08-14T08:00:00Z',
          } as Procedure,
        },
      ],
    };
    const result = flattenBundle(bundle);
    expect(result.procedure_view[0]).toMatchObject({
      id: 'proc-1',
      subject_id: 'pat-1',
      code: '173425001',
      performed_datetime: '2018-08-14T08:00:00Z',
    });
  });

  it('flattens Condition clinical_status and onset_datetime', () => {
    const bundle: Bundle = {
      resourceType: 'Bundle',
      type: 'collection',
      entry: [
        {
          resource: {
            resourceType: 'Condition',
            id: 'cond-1',
            code: { coding: [{ system: 'http://snomed.info/sct', code: '38341003', display: 'Hypertension' }] },
            clinicalStatus: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/condition-clinical', code: 'active' }] },
            subject: { reference: 'Patient/pat-1' },
            onsetDateTime: '2020-01-01',
          } as Condition,
        },
      ],
    };
    const result = flattenBundle(bundle);
    expect(result.condition_view[0]).toMatchObject({
      id: 'cond-1',
      subject_id: 'pat-1',
      code: '38341003',
      clinical_status: 'active',
      onset_datetime: '2020-01-01',
    });
  });

  it('flattens compose.include when expansion is absent', () => {
    const vs: ValueSet = {
      resourceType: 'ValueSet',
      id: 'vs-compose',
      url: 'http://example.org/ValueSet/compose-only',
      status: 'active',
      compose: {
        include: [
          {
            system: 'http://loinc.org',
            concept: [
              { code: '24605-8', display: 'A' },
              { code: '26346-7', display: 'B' },
            ],
          },
        ],
      },
    };
    const rows = flattenValueSetExpansion(vs);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({
      value_set_id: 'http://example.org/ValueSet/compose-only',
      code: '24605-8',
      system: 'http://loinc.org',
      display: 'A',
      version: null,
    });
  });

  it('expands a ValueSet to value_set_expansion rows keyed by canonical URL', () => {
    const vs: ValueSet = {
      resourceType: 'ValueSet',
      id: 'vs-1',
      url: 'http://example.org/ValueSet/test',
      status: 'active',
      expansion: {
        identifier: 'urn:uuid:test',
        timestamp: '2024-01-01T00:00:00Z',
        contains: [
          { system: 'http://loinc.org', code: '24605-8', display: 'A' },
          { system: 'http://loinc.org', code: '26346-7', display: 'B' },
        ],
      },
    };
    const rows = flattenValueSetExpansion(vs);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({
      value_set_id: 'http://example.org/ValueSet/test',
      code: '24605-8',
      system: 'http://loinc.org',
      display: 'A',
      version: null,
    });
  });

  it('skips expansion entries without a code', () => {
    const vs: ValueSet = {
      resourceType: 'ValueSet',
      id: 'vs-2',
      url: 'http://example.org/ValueSet/test',
      status: 'active',
      expansion: {
        identifier: 'urn:uuid:test',
        timestamp: '2024-01-01T00:00:00Z',
        contains: [
          { system: 'http://loinc.org' },
          { system: 'http://loinc.org', code: '24605-8', display: 'A' },
        ],
      },
    };
    expect(flattenValueSetExpansion(vs)).toHaveLength(1);
  });

  it('strips Resource/ prefix from references when extracting subject_id', () => {
    const bundle: Bundle = {
      resourceType: 'Bundle',
      type: 'collection',
      entry: [
        {
          resource: {
            resourceType: 'Observation',
            id: 'obs-x',
            status: 'final',
            code: { coding: [{ code: 'c1' }] },
            subject: { reference: 'Patient/foo-123' },
          } as Observation,
        },
      ],
    };
    expect(flattenBundle(bundle).observation_view[0]['subject_id']).toBe('foo-123');
  });

  it('flattens Tier 1 MedicationRequest, Immunization, and Coverage', () => {
    const bundle: Bundle = {
      resourceType: 'Bundle',
      type: 'collection',
      entry: [
        {
          resource: {
            resourceType: 'MedicationRequest',
            id: 'mr-1',
            status: 'active',
            intent: 'order',
            subject: { reference: 'Patient/p1' },
            medicationCodeableConcept: {
              coding: [{ system: 'http://www.nlm.nih.gov/research/umls/rxnorm', code: '860975' }],
            },
            authoredOn: '2024-03-01',
          },
        },
        {
          resource: {
            resourceType: 'Immunization',
            id: 'imm-1',
            status: 'completed',
            patient: { reference: 'Patient/p1' },
            vaccineCode: { coding: [{ system: 'http://hl7.org/fhir/sid/cvx', code: '141' }] },
            occurrenceDateTime: '2024-01-15',
            primarySource: true,
          },
        },
        {
          resource: {
            resourceType: 'Coverage',
            id: 'cov-1',
            status: 'active',
            beneficiary: { reference: 'Patient/p1' },
            payor: [{ reference: 'Organization/org-1' }],
            type: { coding: [{ code: 'EHCPOL' }] },
            period: { start: '2024-01-01', end: '2024-12-31' },
          },
        },
      ],
    };
    const tables = flattenBundle(bundle);
    expect(tables.medication_request_view[0]).toMatchObject({
      id: 'mr-1',
      subject_id: 'p1',
      medication_code: '860975',
    });
    expect(tables.immunization_view[0]).toMatchObject({
      id: 'imm-1',
      patient_id: 'p1',
      vaccine_code: '141',
    });
    expect(tables.coverage_view[0]).toMatchObject({
      id: 'cov-1',
      beneficiary_id: 'p1',
      type_code: 'EHCPOL',
      payer_id: 'org-1',
    });
  });
});

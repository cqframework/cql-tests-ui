// Author: Preston Lee

import { describe, expect, test, beforeEach, vi } from 'vitest';
import { of } from 'rxjs';
import type { Bundle, Patient } from 'fhir/r4';
import { SqlOnFhirExecutionDataService } from './sql-on-fhir-execution-data.service';
import { mergeBundles, bundleHasClinicalResources, summarizeBundleResources } from './sql-on-fhir-execution-data.lib';
import cms125Bundle from '../../../../public/fhir/sql-on-fhir/cms125-bundle.json';
import type { PatientFetchProgress } from './sql-on-fhir-patient-fetch.lib';

describe('sql-on-fhir-execution-data.service', () => {
  describe('mergeBundles and bundleHasClinicalResources', () => {
    test('mergeBundles deduplicates resources by type and id', () => {
      const a: Bundle = {
        resourceType: 'Bundle',
        type: 'searchset',
        entry: [{ resource: { resourceType: 'Patient', id: 'p1' } }],
      };
      const b: Bundle = {
        resourceType: 'Bundle',
        type: 'searchset',
        entry: [
          { resource: { resourceType: 'Patient', id: 'p1' } },
          { resource: { resourceType: 'Observation', id: 'o1' } },
        ],
      };
      const merged = mergeBundles([a, b]);
      expect(merged.entry?.length).toBe(2);
    });

    test('bundleHasClinicalResources detects patient data', () => {
      const bundle: Bundle = {
        resourceType: 'Bundle',
        type: 'collection',
        entry: [{ resource: { resourceType: 'Patient', id: 'p1' } }],
      };
      expect(bundleHasClinicalResources(bundle)).toBe(true);
    });

    test('summarizeBundleResources counts patients and clinical types', () => {
      const merged = mergeBundles([
        {
          resourceType: 'Bundle',
          type: 'collection',
          entry: [
            { resource: { resourceType: 'Patient', id: 'p1' } },
            { resource: { resourceType: 'Encounter', id: 'e1' } },
          ],
        },
        {
          resourceType: 'Bundle',
          type: 'collection',
          entry: [
            { resource: { resourceType: 'Patient', id: 'p2' } },
            { resource: { resourceType: 'Observation', id: 'o1' } },
          ],
        },
      ]);
      const summary = summarizeBundleResources(merged);
      expect(summary.patientIds).toEqual(['p1', 'p2']);
      expect(summary.countsByType['Patient']).toBe(2);
      expect(summary.countsByType['Encounter']).toBe(1);
      expect(summary.countsByType['Observation']).toBe(1);
      expect(summary.totalResources).toBe(4);
    });
  });

  describe('buildBundleFromPatients', () => {
    let service: SqlOnFhirExecutionDataService;
    const patientService = {
      get: vi.fn(),
      getEverything: vi.fn(),
    };
    const fhirSearch = {
      search: vi.fn(),
      fetchFromUrl: vi.fn(),
    };

    function createService(): SqlOnFhirExecutionDataService {
      const instance = Object.create(SqlOnFhirExecutionDataService.prototype) as SqlOnFhirExecutionDataService;
      Object.assign(instance as object, { patientService, fhirSearch });
      return instance;
    }

    beforeEach(() => {
      vi.clearAllMocks();
      service = createService();
    });

    test('Patient-only fetch uses GET Patient and skips type search', async () => {
      patientService.get.mockReturnValue(of({ resourceType: 'Patient', id: 'p1' }));
      const bundle = await service.buildBundleFromPatients([{ resourceType: 'Patient', id: 'p1' }], {
        resourceTypes: ['Patient'],
      });
      expect(patientService.getEverything).not.toHaveBeenCalled();
      expect(fhirSearch.search).not.toHaveBeenCalled();
      expect(bundle.entry?.length).toBe(1);
      expect(bundle.entry?.[0]?.resource?.resourceType).toBe('Patient');
    });

    test('uses per-type search and never calls $everything', async () => {
      patientService.get.mockReturnValue(of({ resourceType: 'Patient', id: 'p1' }));
      fhirSearch.search.mockImplementation((resourceType: string) =>
        of({
          resourceType: 'Bundle',
          type: 'searchset',
          entry: [{ resource: { resourceType, id: `${resourceType}-1` } }],
        }),
      );
      await service.buildBundleFromPatients([{ resourceType: 'Patient', id: 'p1' }], {
        resourceTypes: ['Patient', 'Encounter', 'Observation'],
      });
      expect(patientService.getEverything).not.toHaveBeenCalled();
      expect(fhirSearch.search).toHaveBeenCalledWith(
        'Encounter',
        { patient: 'Patient/p1' },
        expect.objectContaining({ count: 200 }),
      );
      expect(fhirSearch.search).toHaveBeenCalledWith(
        'Observation',
        { patient: 'Patient/p1' },
        expect.objectContaining({ count: 200 }),
      );
    });

    test('Coverage search uses beneficiary parameter', async () => {
      patientService.get.mockReturnValue(of({ resourceType: 'Patient', id: 'p1' }));
      fhirSearch.search.mockReturnValue(
        of({
          resourceType: 'Bundle',
          type: 'searchset',
          entry: [{ resource: { resourceType: 'Coverage', id: 'c1' } }],
        }),
      );
      await service.buildBundleFromPatients([{ resourceType: 'Patient', id: 'p1' }], {
        resourceTypes: ['Patient', 'Coverage'],
      });
      expect(fhirSearch.search).toHaveBeenCalledWith(
        'Coverage',
        { beneficiary: 'Patient/p1' },
        expect.objectContaining({ count: 200 }),
      );
    });

    test('onProgress reports increasing resource tallies', async () => {
      patientService.get.mockReturnValue(
        of({ resourceType: 'Patient', id: 'p1', name: [{ family: 'Doe', given: ['Jane'] }] }),
      );
      fhirSearch.search.mockReturnValue(
        of({
          resourceType: 'Bundle',
          type: 'searchset',
          entry: [
            { resource: { resourceType: 'Observation', id: 'o1' } },
            { resource: { resourceType: 'Observation', id: 'o2' } },
          ],
        }),
      );
      const snapshots: PatientFetchProgress[] = [];
      await service.buildBundleFromPatients([{ resourceType: 'Patient', id: 'p1' }], {
        resourceTypes: ['Patient', 'Observation'],
        onProgress: p => snapshots.push(structuredClone(p)),
      });
      expect(snapshots.length).toBeGreaterThan(1);
      const last = snapshots[snapshots.length - 1];
      expect(last.totalResources).toBe(3);
      expect(last.resourcesByType['Patient']).toBe(1);
      expect(last.resourcesByType['Observation']).toBe(2);
      expect(last.workUnitsCompleted).toBe(last.workUnitsTotal);
      expect(last.patientsCompleted).toBe(1);
    });

    test('buildDataKeyFromPatients includes sorted patient ids and resource types', () => {
      expect(
        service.buildDataKeyFromPatients(
          [{ resourceType: 'Patient', id: 'b' }, { resourceType: 'Patient', id: 'a' }],
          ['Observation', 'Patient'],
        ),
      ).toBe('patients:a,b|types:Observation,Patient');
    });
  });

  describe('publishBundleToServer', () => {
    test('posts a transaction bundle to the FHIR server', async () => {
      const fhirClient = {
        getBaseUrl: vi.fn(() => 'http://localhost:8080/fhir'),
        postBundle: vi.fn(() => of({ resourceType: 'Bundle', type: 'transaction-response' })),
      };
      const instance = Object.create(SqlOnFhirExecutionDataService.prototype) as SqlOnFhirExecutionDataService;
      Object.assign(instance as object, { fhirClient });

      await instance.publishBundleToServer(cms125Bundle as Bundle);

      expect(fhirClient.postBundle).toHaveBeenCalledTimes(1);
      const posted = (fhirClient.postBundle as ReturnType<typeof vi.fn>).mock.calls[0][0] as Bundle;
      expect(posted.type).toBe('transaction');
      expect(posted.entry?.length).toBe(12);
    });

    test('throws when FHIR base URL is not configured', async () => {
      const fhirClient = {
        getBaseUrl: vi.fn(() => ''),
        postBundle: vi.fn(),
      };
      const instance = Object.create(SqlOnFhirExecutionDataService.prototype) as SqlOnFhirExecutionDataService;
      Object.assign(instance as object, { fhirClient });

      await expect(instance.publishBundleToServer(cms125Bundle as Bundle)).rejects.toThrow(
        /FHIR base URL is not configured/,
      );
      expect(fhirClient.postBundle).not.toHaveBeenCalled();
    });
  });
});

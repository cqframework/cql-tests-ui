// Author: Preston Lee

import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpErrorResponse, HttpHeaders } from '@angular/common/http';
import { firstValueFrom, forkJoin } from 'rxjs';
import type { Bundle, Patient, Resource, ValueSet } from 'fhir/r4';
import { PatientService } from '../patient.service';
import { FhirSearchService } from '../fhir-search.service';
import { FhirClientService } from '../fhir-client.service';
import { SettingsService } from '../settings.service';
import { buildHttpHeaders } from '../endpoint-config.lib';
import { fetchAllBundlePages } from '../fhir-bundle-fetch.lib';
import { loadValueSetExpansions } from '../../components/sql-on-fhir/elm-to-sql';
import type { FlatRow } from './sql-on-fhir-bundle-flattener.lib';
import { flattenValueSets } from './sql-on-fhir-bundle-flattener.lib';
import {
  mergeBundles,
  prepareValueSetRowsForExecution,
} from './sql-on-fhir-execution-data.lib';
import { valueSetForServerPut } from './sql-on-fhir-value-set-publish.lib';
import {
  buildTransactionBundleForServerPublish,
  resourcesFromExecutionBundle,
} from './sql-on-fhir-bundle-publish.lib';
import {
  computeFetchWorkUnits,
  emptyPatientFetchProgress,
  mapWithConcurrency,
  nonPatientResourceTypes,
  PATIENT_COMPARTMENT_FETCH_CONCURRENCY,
  PATIENT_COMPARTMENT_SEARCH_PAGE_SIZE,
  patientReference,
  patientSearchParamForResourceType,
  type PatientFetchProgress,
} from './sql-on-fhir-patient-fetch.lib';

export type { ExecutionSeedData } from './sql-on-fhir-execution-data.types';
export type { PatientFetchProgress } from './sql-on-fhir-patient-fetch.lib';
export {
  bundleHasClinicalResources,
  mergeBundles,
  resourceTypesInBundle,
  summarizeBundleResources,
  validateCms125DemoBundle,
} from './sql-on-fhir-execution-data.lib';
export type { BundleResourceSummary } from './sql-on-fhir-execution-data.lib';

export interface BuildBundleFromPatientsOptions {
  resourceTypes: string[];
  onProgress?: (progress: PatientFetchProgress) => void;
}

@Injectable({ providedIn: 'root' })
export class SqlOnFhirExecutionDataService {
  private readonly http = inject(HttpClient);
  private readonly patientService = inject(PatientService);
  private readonly fhirSearch = inject(FhirSearchService);
  private readonly fhirClient = inject(FhirClientService);
  private readonly settingsService = inject(SettingsService);

  async buildBundleFromPatients(
    patients: Patient[],
    options: BuildBundleFromPatientsOptions,
  ): Promise<Bundle> {
    const withIds = patients.filter(p => p.id?.trim());
    if (withIds.length === 0) {
      return { resourceType: 'Bundle', type: 'collection', entry: [] };
    }
    const resourceTypes = [...new Set(options.resourceTypes.filter(t => t.trim()))].sort();
    const nonPatientTypes = nonPatientResourceTypes(resourceTypes);
    const workUnitsTotal = computeFetchWorkUnits(withIds.length, resourceTypes);
    const state = emptyPatientFetchProgress(withIds.length, workUnitsTotal);
    const emit = () => {
      options.onProgress?.({
        ...state,
        resourcesByType: { ...state.resourcesByType },
      });
    };
    emit();

    const bundles = await mapWithConcurrency(
      withIds,
      PATIENT_COMPARTMENT_FETCH_CONCURRENCY,
      p => this.fetchPatientCompartmentViaSearch(p, nonPatientTypes, state, emit),
    );
    return mergeBundles(bundles);
  }

  buildDataKeyFromPatients(patients: Patient[], resourceTypes: string[] = []): string {
    const ids = patients.map(p => p.id).filter(Boolean).sort();
    const types = [...new Set(resourceTypes.filter(t => t.trim()))].sort();
    if (ids.length === 0) {
      return 'patients:none';
    }
    return types.length
      ? `patients:${ids.join(',')}|types:${types.join(',')}`
      : `patients:${ids.join(',')}`;
  }

  buildDataKeyFromBundle(bundle: Bundle): string {
    const ids = (bundle.entry ?? [])
      .map(e => e.resource)
      .filter((r): r is Resource & { id: string } => !!r?.id && !!r.resourceType)
      .map(r => `${r.resourceType}/${r.id}`)
      .sort();
    return ids.length ? `bundle:${ids.join(',')}` : 'bundle:empty';
  }

  async prepareValueSetRows(
    elmJson: string,
    bundledValueSets: ValueSet[] = [],
  ): Promise<{ rows: FlatRow[]; errors: string[] }> {
    const baseUrl = this.getTerminologyBaseUrl();
    const result = await prepareValueSetRowsForExecution(
      elmJson,
      bundledValueSets,
      refs => loadValueSetExpansions(baseUrl, refs, this.buildAuthenticatedFetch()),
    );
    return { rows: result.rows, errors: result.errors };
  }

  valueSetRowsFromBundled(valueSets: ValueSet[]): FlatRow[] {
    return flattenValueSets(valueSets);
  }

  /** Upsert compose-defined ValueSets onto the configured FHIR/terminology server (client-assigned ids). */
  async publishValueSetsToServer(valueSets: ValueSet[]): Promise<void> {
    const baseUrl = this.getTerminologyBaseUrl();
    if (!baseUrl) {
      throw new Error('FHIR base URL is not configured');
    }
    if (valueSets.length === 0) {
      return;
    }
    await firstValueFrom(
      forkJoin(valueSets.map(vs => this.http.put<ValueSet>(
        `${baseUrl}/ValueSet/${encodeURIComponent(vs.id!)}`,
        valueSetForServerPut(vs),
        { headers: this.terminologyHeaders() },
      ))),
    );
  }

  /** Import collection-bundle resources onto the configured FHIR server via one transaction. */
  async publishBundleToServer(bundle: Bundle): Promise<void> {
    if (!this.fhirClient.getBaseUrl()) {
      throw new Error('FHIR base URL is not configured');
    }
    const resources = resourcesFromExecutionBundle(bundle);
    if (resources.length === 0) {
      throw new Error('Bundle has no resources with logical ids to import');
    }
    const transaction = buildTransactionBundleForServerPublish(resources);
    await firstValueFrom(this.fhirClient.postBundle(transaction));
  }

  private async fetchPatientCompartmentViaSearch(
    patientStub: Patient,
    nonPatientTypes: string[],
    state: PatientFetchProgress,
    emit: () => void,
  ): Promise<Bundle> {
    const patientId = patientStub.id!;
    const label = patientDisplayLabel(patientStub);
    state.currentPatientId = patientId;
    state.currentPatientLabel = label;
    state.currentResourceType = 'Patient';
    emit();

    const patient = await firstValueFrom(this.patientService.get(patientId));
    const bundles: Bundle[] = [
      {
        resourceType: 'Bundle',
        type: 'collection',
        entry: [{ resource: patient }],
      },
    ];
    state.resourcesByType['Patient'] = (state.resourcesByType['Patient'] ?? 0) + 1;
    state.totalResources += 1;
    state.workUnitsCompleted += 1;
    state.currentPatientId = patientId;
    state.currentPatientLabel = patientDisplayLabel(patient) || label;
    state.currentResourceType = nonPatientTypes[0] ?? null;
    emit();

    const ref = patientReference(patientId);
    for (const resourceType of nonPatientTypes) {
      state.currentPatientId = patientId;
      state.currentPatientLabel = patientDisplayLabel(patient) || label;
      state.currentResourceType = resourceType;
      emit();
      const searchParam = patientSearchParamForResourceType(resourceType);
      const initial = await firstValueFrom(
        this.fhirSearch.search(
          resourceType,
          { [searchParam]: ref },
          { count: PATIENT_COMPARTMENT_SEARCH_PAGE_SIZE },
        ),
      );
      const full = await fetchAllBundlePages(
        initial,
        url => firstValueFrom(this.fhirSearch.fetchFromUrl(url)),
        page => {
          const count = page.entry?.filter(e => e.resource).length ?? 0;
          if (count > 0) {
            state.resourcesByType[resourceType] = (state.resourcesByType[resourceType] ?? 0) + count;
            state.totalResources += count;
            emit();
          }
        },
      );
      bundles.push(full);
      state.workUnitsCompleted += 1;
      state.currentPatientId = patientId;
      state.currentPatientLabel = patientDisplayLabel(patient) || label;
      state.currentResourceType = resourceType;
      emit();
    }

    state.patientsCompleted += 1;
    state.currentPatientId = patientId;
    state.currentPatientLabel = patientDisplayLabel(patient) || label;
    state.currentResourceType = null;
    emit();
    return mergeBundles(bundles);
  }

  private terminologyHeaders(): HttpHeaders {
    const ctx = this.settingsService.getEndpointHttpContext('terminology', {
      'Content-Type': 'application/fhir+json',
      Accept: 'application/fhir+json'
    });
    return buildHttpHeaders(
      { ...this.settingsService.getActiveEnvironment().terminologyEndpoint, address: ctx.address },
      ctx.headers
    );
  }

  private buildAuthenticatedFetch(): typeof fetch {
    const headers = this.terminologyHeaders();
    return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const method = init?.method?.toUpperCase() ?? 'GET';
      if (method !== 'GET') {
        throw new Error(`Unsupported fetch method for ValueSet load: ${method}`);
      }
      try {
        const response = await firstValueFrom(
          this.http.get<unknown>(url, { headers, observe: 'response' }),
        );
        return new Response(JSON.stringify(response.body ?? null), {
          status: response.status,
          statusText: response.statusText,
          headers: { 'Content-Type': 'application/fhir+json' },
        });
      } catch (err: unknown) {
        if (err instanceof HttpErrorResponse) {
          const body = err.error != null ? JSON.stringify(err.error) : '';
          return new Response(body, { status: err.status, statusText: err.statusText });
        }
        throw err;
      }
    };
  }

  private getTerminologyBaseUrl(): string {
    const term = this.settingsService.getEffectiveTerminologyEndpointAddress().trim().replace(/\/+$/, '');
    if (term) {
      return term;
    }
    return this.settingsService.getEffectiveDataEndpointAddress().trim().replace(/\/+$/, '');
  }
}

function patientDisplayLabel(patient: Patient): string {
  const name = patient.name?.[0];
  if (name?.text) {
    return name.text;
  }
  const given = name?.given?.join(' ') ?? '';
  const family = name?.family ?? '';
  return `${given} ${family}`.trim() || patient.id || 'Patient';
}

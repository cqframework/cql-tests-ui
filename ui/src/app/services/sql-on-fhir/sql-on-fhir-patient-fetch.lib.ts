// Author: Preston Lee

export const PATIENT_COMPARTMENT_SEARCH_PAGE_SIZE = 200;
export const PATIENT_COMPARTMENT_FETCH_CONCURRENCY = 5;

export const SQL_ON_FHIR_DATA_SIZE_WARN_BYTES = 32 * 1024 * 1024;

/** FHIR search parameter that scopes a resource type to a patient. */
export function patientSearchParamForResourceType(resourceType: string): string {
  switch (resourceType) {
    case 'Coverage':
      return 'beneficiary';
    case 'AllergyIntolerance':
    case 'Immunization':
      return 'patient';
    default:
      return 'patient';
  }
}

export interface PatientFetchProgress {
  patientsTotal: number;
  patientsCompleted: number;
  currentPatientId: string | null;
  currentPatientLabel: string | null;
  currentResourceType: string | null;
  workUnitsTotal: number;
  workUnitsCompleted: number;
  resourcesByType: Record<string, number>;
  totalResources: number;
}

export function emptyPatientFetchProgress(patientsTotal = 0, workUnitsTotal = 0): PatientFetchProgress {
  return {
    patientsTotal,
    patientsCompleted: 0,
    currentPatientId: null,
    currentPatientLabel: null,
    currentResourceType: null,
    workUnitsTotal,
    workUnitsCompleted: 0,
    resourcesByType: {},
    totalResources: 0,
  };
}

export function computeFetchWorkUnits(patientCount: number, resourceTypes: string[]): number {
  const nonPatient = nonPatientResourceTypes(resourceTypes).length;
  return patientCount * (1 + nonPatient);
}

export function addResourcesToProgress(
  progress: PatientFetchProgress,
  resourceType: string,
  count: number,
): PatientFetchProgress {
  if (count <= 0) {
    return progress;
  }
  const resourcesByType = { ...progress.resourcesByType };
  resourcesByType[resourceType] = (resourcesByType[resourceType] ?? 0) + count;
  return {
    ...progress,
    resourcesByType,
    totalResources: progress.totalResources + count,
  };
}

export function nonPatientResourceTypes(resourceTypes: string[]): string[] {
  return resourceTypes.filter(t => t.trim() && t !== 'Patient');
}

export function patientReference(patientId: string): string {
  return `Patient/${patientId}`;
}

export async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  mapper: (item: T) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) {
    return [];
  }
  const results: R[] = new Array(items.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex++;
      results[index] = await mapper(items[index]);
    }
  });
  await Promise.all(workers);
  return results;
}

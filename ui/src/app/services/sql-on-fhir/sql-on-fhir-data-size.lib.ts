// Author: Preston Lee

import type { Bundle, ValueSet } from 'fhir/r4';
import { summarizeBundleResources } from './sql-on-fhir-execution-data.lib';
import { SQL_ON_FHIR_DATA_SIZE_WARN_BYTES } from './sql-on-fhir-patient-fetch.lib';

export { SQL_ON_FHIR_DATA_SIZE_WARN_BYTES };

export interface ExecutionDataSizeEstimate {
  estimatedBytes: number;
  totalResources: number;
  countsByType: Record<string, number>;
  exceedsWarningThreshold: boolean;
}

export function estimateExecutionDataSize(
  bundle: Bundle | null | undefined,
  valueSets: ValueSet[] = [],
): ExecutionDataSizeEstimate {
  const summary = bundle ? summarizeBundleResources(bundle) : {
    patientIds: [],
    countsByType: {},
    totalResources: 0,
  };
  let estimatedBytes = 0;
  if (bundle) {
    estimatedBytes += utf8JsonByteLength(bundle);
  }
  for (const vs of valueSets) {
    estimatedBytes += utf8JsonByteLength(vs);
  }
  return {
    estimatedBytes,
    totalResources: summary.totalResources,
    countsByType: summary.countsByType,
    exceedsWarningThreshold: estimatedBytes >= SQL_ON_FHIR_DATA_SIZE_WARN_BYTES,
  };
}

export function formatDataSize(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KiB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

function utf8JsonByteLength(value: unknown): number {
  const json = JSON.stringify(value) ?? '';
  if (typeof TextEncoder !== 'undefined') {
    return new TextEncoder().encode(json).length;
  }
  return unescape(encodeURIComponent(json)).length;
}

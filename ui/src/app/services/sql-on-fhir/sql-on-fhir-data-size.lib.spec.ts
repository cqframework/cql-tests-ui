// Author: Preston Lee

import { describe, expect, test } from 'vitest';
import type { Bundle } from 'fhir/r4';
import {
  estimateExecutionDataSize,
  formatDataSize,
  SQL_ON_FHIR_DATA_SIZE_WARN_BYTES,
} from './sql-on-fhir-data-size.lib';

describe('sql-on-fhir-data-size.lib', () => {
  test('estimates bytes and counts from a bundle', () => {
    const bundle: Bundle = {
      resourceType: 'Bundle',
      type: 'collection',
      entry: [
        { resource: { resourceType: 'Patient', id: 'p1' } },
        { resource: { resourceType: 'Observation', id: 'o1' } },
      ],
    };
    const estimate = estimateExecutionDataSize(bundle);
    expect(estimate.totalResources).toBe(2);
    expect(estimate.countsByType['Patient']).toBe(1);
    expect(estimate.estimatedBytes).toBeGreaterThan(50);
    expect(estimate.exceedsWarningThreshold).toBe(false);
  });

  test('flags payload at or above 32 MiB', () => {
    const big = 'x'.repeat(SQL_ON_FHIR_DATA_SIZE_WARN_BYTES);
    const bundle: Bundle = {
      resourceType: 'Bundle',
      type: 'collection',
      entry: [{ resource: { resourceType: 'Patient', id: 'p1', text: { div: big, status: 'generated' } } }],
    };
    expect(estimateExecutionDataSize(bundle).exceedsWarningThreshold).toBe(true);
  });

  test('formatDataSize renders human-readable units', () => {
    expect(formatDataSize(500)).toBe('500 B');
    expect(formatDataSize(2048)).toBe('2.0 KiB');
    expect(formatDataSize(2 * 1024 * 1024)).toBe('2.0 MiB');
  });
});

// Author: Preston Lee

import type { Library } from 'fhir/r4';
import { stripFhirNamespace } from './elm-to-sql';

/** Resource types supported by flattenBundle / PGlite seed tables. */
export const FLATTENABLE_RESOURCE_TYPES = [
  'Patient',
  'Encounter',
  'Observation',
  'Procedure',
  'Condition',
  'MedicationRequest',
  'DiagnosticReport',
  'Coverage',
  'AllergyIntolerance',
  'Immunization',
  'ServiceRequest',
] as const;

export type FlattenableResourceType = (typeof FLATTENABLE_RESOURCE_TYPES)[number];

const FLATTENABLE_SET = new Set<string>(FLATTENABLE_RESOURCE_TYPES);

export interface ExecutionResourceTypesResult {
  derivedTypes: string[];
  unsupportedTypes: string[];
}

function isRetrieveNode(value: unknown): value is { type: 'Retrieve'; dataType: string } {
  if (typeof value !== 'object' || value == null) {
    return false;
  }
  const node = value as Record<string, unknown>;
  return node['type'] === 'Retrieve' && typeof node['dataType'] === 'string';
}

function collectRetrieveTypes(value: unknown, out: Set<string>): void {
  if (Array.isArray(value)) {
    for (const item of value) {
      collectRetrieveTypes(item, out);
    }
    return;
  }
  if (!value || typeof value !== 'object') {
    return;
  }
  if (isRetrieveNode(value)) {
    out.add(stripFhirNamespace(value.dataType));
  }
  for (const child of Object.values(value)) {
    collectRetrieveTypes(child, out);
  }
}

export function extractRetrieveTypesFromElm(elmJson: string | null | undefined): string[] {
  if (!elmJson?.trim()) {
    return [];
  }
  try {
    const parsed = JSON.parse(elmJson) as unknown;
    const types = new Set<string>();
    collectRetrieveTypes(parsed, types);
    return [...types].sort();
  } catch {
    return [];
  }
}

export function extractTypesFromLibrary(library: Library | null | undefined): string[] {
  const types = new Set<string>();
  for (const req of library?.dataRequirement ?? []) {
    if (req.type?.trim()) {
      types.add(req.type.trim());
    }
  }
  return [...types].sort();
}

function unionSorted(...lists: string[][]): string[] {
  const merged = new Set<string>();
  for (const list of lists) {
    for (const t of list) {
      if (t.trim()) {
        merged.add(t.trim());
      }
    }
  }
  merged.add('Patient');
  return [...merged].sort();
}

export function resolveExecutionResourceTypes(input: {
  elmJson: string | null | undefined;
  library: Library | null | undefined;
}): ExecutionResourceTypesResult {
  const fromElm = extractRetrieveTypesFromElm(input.elmJson);
  const fromLibrary = extractTypesFromLibrary(input.library);
  const referenced = unionSorted(fromElm, fromLibrary);

  const derivedTypes: string[] = [];
  const unsupportedTypes: string[] = [];
  for (const type of referenced) {
    if (FLATTENABLE_SET.has(type)) {
      derivedTypes.push(type);
    } else {
      unsupportedTypes.push(type);
    }
  }
  if (!derivedTypes.includes('Patient')) {
    derivedTypes.unshift('Patient');
    derivedTypes.sort();
  }
  return { derivedTypes, unsupportedTypes };
}

export function isFlattenableResourceType(type: string): type is FlattenableResourceType {
  return FLATTENABLE_SET.has(type);
}

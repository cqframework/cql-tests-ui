// Author: Eugene Vestel
//
// Flattens a FHIR R4 Bundle into rows for the SQL-on-FHIR flat-table schema
// expected by the elm-to-sql library's STANDARD_VIEW_DEFINITIONS.
//
// Pure functions only — no HTTP, no Node APIs, no DB drivers. Output rows are
// consumed by sql-on-fhir-pglite.service.ts to seed an in-browser Postgres.

import type {
  Bundle,
  ValueSet,
  Patient,
  Encounter,
  Observation,
  Procedure,
  Condition,
  MedicationRequest,
  DiagnosticReport,
  Coverage,
  AllergyIntolerance,
  Immunization,
  ServiceRequest,
  CodeableConcept,
  Period,
  Reference,
} from 'fhir/r4';
import { resourceTypeOf } from '../fhir-resource-type.lib';

/** A single flat row keyed by column name. Values are JSON-safe primitives. */
export type FlatRow = Record<string, string | number | boolean | null>;

/** Rows grouped by target table name (matches STANDARD_VIEW_DEFINITIONS names). */
export interface FlatTables {
  patient_view: FlatRow[];
  encounter_view: FlatRow[];
  observation_view: FlatRow[];
  procedure_view: FlatRow[];
  condition_view: FlatRow[];
  medication_request_view: FlatRow[];
  diagnostic_report_view: FlatRow[];
  coverage_view: FlatRow[];
  allergy_intolerance_view: FlatRow[];
  immunization_view: FlatRow[];
  service_request_view: FlatRow[];
  /** value_set_id is the canonical URL of the ValueSet; code is one expansion entry's code. */
  value_set_expansion: FlatRow[];
}

export function emptyFlatTables(): FlatTables {
  return {
    patient_view: [],
    encounter_view: [],
    observation_view: [],
    procedure_view: [],
    condition_view: [],
    medication_request_view: [],
    diagnostic_report_view: [],
    coverage_view: [],
    allergy_intolerance_view: [],
    immunization_view: [],
    service_request_view: [],
    value_set_expansion: [],
  };
}

export function flattenBundle(bundle: Bundle): FlatTables {
  const out = emptyFlatTables();
  for (const entry of bundle.entry ?? []) {
    const r = entry.resource;
    if (!r) continue;
    switch (resourceTypeOf(r)) {
      case 'Patient':
        out.patient_view.push(flattenPatient(r as Patient));
        break;
      case 'Encounter':
        out.encounter_view.push(flattenEncounter(r as Encounter));
        break;
      case 'Observation':
        out.observation_view.push(flattenObservation(r as Observation));
        break;
      case 'Procedure':
        out.procedure_view.push(flattenProcedure(r as Procedure));
        break;
      case 'Condition':
        out.condition_view.push(flattenCondition(r as Condition));
        break;
      case 'MedicationRequest':
        out.medication_request_view.push(flattenMedicationRequest(r as MedicationRequest));
        break;
      case 'DiagnosticReport':
        out.diagnostic_report_view.push(flattenDiagnosticReport(r as DiagnosticReport));
        break;
      case 'Coverage':
        out.coverage_view.push(flattenCoverage(r as Coverage));
        break;
      case 'AllergyIntolerance':
        out.allergy_intolerance_view.push(flattenAllergyIntolerance(r as AllergyIntolerance));
        break;
      case 'Immunization':
        out.immunization_view.push(flattenImmunization(r as Immunization));
        break;
      case 'ServiceRequest':
        out.service_request_view.push(flattenServiceRequest(r as ServiceRequest));
        break;
      case 'ValueSet':
        out.value_set_expansion.push(...flattenValueSetExpansion(r as ValueSet));
        break;
    }
  }
  return out;
}

export function flattenValueSets(valueSets: ValueSet[]): FlatRow[] {
  return valueSets.flatMap(flattenValueSetExpansion);
}

export function flattenValueSetExpansion(vs: ValueSet): FlatRow[] {
  const url = vs.url ?? null;
  const contains = vs.expansion?.contains ?? [];
  if (contains.length > 0) {
    return contains
      .filter(c => !!c.code)
      .map(c => ({
        value_set_id: url,
        code: c.code ?? null,
        system: c.system ?? null,
        display: c.display ?? null,
        version: c.version ?? null,
      }));
  }
  const rows: FlatRow[] = [];
  for (const include of vs.compose?.include ?? []) {
    const system = include.system ?? null;
    for (const concept of include.concept ?? []) {
      if (!concept.code) {
        continue;
      }
      rows.push({
        value_set_id: url,
        code: concept.code,
        system,
        display: concept.display ?? null,
        version: null,
      });
    }
  }
  return rows;
}

export function flattenPatient(p: Patient): FlatRow {
  const officialName = p.name?.find(n => n.use === 'official') ?? p.name?.[0];
  return {
    id: p.id ?? null,
    gender: p.gender ?? null,
    birthdate: p.birthDate ?? null,
    active: typeof p.active === 'boolean' ? p.active : null,
    name_family: officialName?.family ?? null,
    name_given: officialName?.given?.[0] ?? null,
    deceased: typeof p.deceasedBoolean === 'boolean' ? p.deceasedBoolean : null,
    deceased_datetime: p.deceasedDateTime ?? null,
    race_code: extractUsCoreOmbCategory(p, 'us-core-race') ?? null,
    ethnicity_code: extractUsCoreOmbCategory(p, 'us-core-ethnicity') ?? null,
  };
}

export function flattenEncounter(e: Encounter): FlatRow {
  const firstType = e.type?.[0];
  const firstTypeCoding = firstType?.coding?.[0];
  return {
    id: e.id ?? null,
    subject_id: extractReferenceId(e.subject) ?? null,
    status: e.status ?? null,
    class_code: e.class?.code ?? null,
    type_code: firstTypeCoding?.code ?? null,
    type_system: firstTypeCoding?.system ?? null,
    type_display: firstTypeCoding?.display ?? null,
    period_start: e.period?.start ?? null,
    period_end: e.period?.end ?? null,
    service_provider_id: extractReferenceId(e.serviceProvider) ?? null,
  };
}

export function flattenObservation(o: Observation): FlatRow {
  const firstCoding = o.code?.coding?.[0];
  const valueQuantity = o.valueQuantity;
  const valueCC = o.valueCodeableConcept?.coding?.[0];
  const effectivePeriod = (o as Observation & { effectivePeriod?: Period }).effectivePeriod;
  return {
    id: o.id ?? null,
    subject_id: extractReferenceId(o.subject) ?? null,
    status: o.status ?? null,
    code: firstCoding?.code ?? null,
    code_system: firstCoding?.system ?? null,
    code_display: firstCoding?.display ?? null,
    code_text: o.code?.text ?? null,
    effective_datetime: o.effectiveDateTime ?? null,
    effective_start: effectivePeriod?.start ?? null,
    effective_end: effectivePeriod?.end ?? null,
    value_quantity: typeof valueQuantity?.value === 'number' ? valueQuantity.value : null,
    value_unit: valueQuantity?.unit ?? null,
    value_code: valueCC?.code ?? null,
    value_string: o.valueString ?? null,
    encounter_id: extractReferenceId(o.encounter) ?? null,
    category_code: firstCategoryCode(o.category) ?? null,
  };
}

export function flattenProcedure(p: Procedure): FlatRow {
  const firstCoding = p.code?.coding?.[0];
  const performedPeriod = (p as Procedure & { performedPeriod?: Period }).performedPeriod;
  return {
    id: p.id ?? null,
    subject_id: extractReferenceId(p.subject) ?? null,
    status: p.status ?? null,
    code: firstCoding?.code ?? null,
    code_system: firstCoding?.system ?? null,
    code_display: firstCoding?.display ?? null,
    code_text: p.code?.text ?? null,
    performed_datetime: p.performedDateTime ?? null,
    performed_start: performedPeriod?.start ?? null,
    performed_end: performedPeriod?.end ?? null,
    encounter_id: extractReferenceId(p.encounter) ?? null,
    category_code: p.category?.coding?.[0]?.code ?? null,
  };
}

export function flattenCondition(c: Condition): FlatRow {
  const firstCoding = c.code?.coding?.[0];
  const onsetPeriod = (c as Condition & { onsetPeriod?: Period }).onsetPeriod;
  return {
    id: c.id ?? null,
    subject_id: extractReferenceId(c.subject) ?? null,
    code: firstCoding?.code ?? null,
    code_system: firstCoding?.system ?? null,
    code_display: firstCoding?.display ?? null,
    code_text: c.code?.text ?? null,
    clinical_status: c.clinicalStatus?.coding?.[0]?.code ?? null,
    verification_status: c.verificationStatus?.coding?.[0]?.code ?? null,
    onset_datetime: c.onsetDateTime ?? null,
    onset_start: onsetPeriod?.start ?? null,
    abatement_datetime: c.abatementDateTime ?? null,
    recorded_date: c.recordedDate ?? null,
    encounter_id: extractReferenceId(c.encounter) ?? null,
    category_code: firstCategoryCode(c.category) ?? null,
  };
}

export function flattenMedicationRequest(m: MedicationRequest): FlatRow {
  const medCc = m.medicationCodeableConcept;
  const medCoding = medCc?.coding?.[0];
  return {
    id: m.id ?? null,
    subject_id: extractReferenceId(m.subject) ?? null,
    status: m.status ?? null,
    intent: m.intent ?? null,
    medication_code: medCoding?.code ?? null,
    medication_system: medCoding?.system ?? null,
    medication_display: medCoding?.display ?? null,
    authored_on: m.authoredOn ?? null,
    encounter_id: extractReferenceId(m.encounter) ?? null,
    requester_id: extractReferenceId(m.requester) ?? null,
  };
}

export function flattenDiagnosticReport(d: DiagnosticReport): FlatRow {
  const firstCoding = d.code?.coding?.[0];
  return {
    id: d.id ?? null,
    subject_id: extractReferenceId(d.subject) ?? null,
    status: d.status ?? null,
    code: firstCoding?.code ?? null,
    code_system: firstCoding?.system ?? null,
    effective_datetime: d.effectiveDateTime ?? null,
    issued: d.issued ?? null,
    encounter_id: extractReferenceId(d.encounter) ?? null,
    category_code: firstCategoryCode(d.category) ?? null,
  };
}

export function flattenCoverage(c: Coverage): FlatRow {
  return {
    id: c.id ?? null,
    beneficiary_id: extractReferenceId(c.beneficiary) ?? null,
    status: c.status ?? null,
    type_code: c.type?.coding?.[0]?.code ?? null,
    payer_id: extractReferenceId(c.payor?.[0]) ?? null,
    period_start: c.period?.start ?? null,
    period_end: c.period?.end ?? null,
  };
}

export function flattenAllergyIntolerance(a: AllergyIntolerance): FlatRow {
  const firstCoding = a.code?.coding?.[0];
  return {
    id: a.id ?? null,
    patient_id: extractReferenceId(a.patient) ?? null,
    clinical_status: a.clinicalStatus?.coding?.[0]?.code ?? null,
    verification_status: a.verificationStatus?.coding?.[0]?.code ?? null,
    code: firstCoding?.code ?? null,
    code_system: firstCoding?.system ?? null,
    onset_datetime: a.onsetDateTime ?? null,
    recorded_date: a.recordedDate ?? null,
  };
}

export function flattenImmunization(i: Immunization): FlatRow {
  const vaccineCoding = i.vaccineCode?.coding?.[0];
  return {
    id: i.id ?? null,
    patient_id: extractReferenceId(i.patient) ?? null,
    status: i.status ?? null,
    vaccine_code: vaccineCoding?.code ?? null,
    vaccine_system: vaccineCoding?.system ?? null,
    occurrence_datetime: i.occurrenceDateTime ?? null,
    primary_source: typeof i.primarySource === 'boolean' ? i.primarySource : null,
    encounter_id: extractReferenceId(i.encounter) ?? null,
  };
}

export function flattenServiceRequest(s: ServiceRequest): FlatRow {
  const firstCoding = s.code?.coding?.[0];
  const occurrencePeriod = (s as ServiceRequest & { occurrencePeriod?: Period }).occurrencePeriod;
  return {
    id: s.id ?? null,
    subject_id: extractReferenceId(s.subject) ?? null,
    status: s.status ?? null,
    intent: s.intent ?? null,
    category_code: firstCategoryCode(s.category) ?? null,
    category_system: Array.isArray(s.category) ? s.category[0]?.coding?.[0]?.system ?? null : null,
    code: firstCoding?.code ?? null,
    code_system: firstCoding?.system ?? null,
    code_display: firstCoding?.display ?? null,
    code_text: s.code?.text ?? null,
    occurrence_datetime: s.occurrenceDateTime ?? null,
    occurrence_start: occurrencePeriod?.start ?? null,
    occurrence_end: occurrencePeriod?.end ?? null,
    authored_on: s.authoredOn ?? null,
    requester_id: extractReferenceId(s.requester) ?? null,
    performer_id: extractReferenceId(s.performer?.[0]) ?? null,
    reason_code: s.reasonCode?.[0]?.coding?.[0]?.code ?? null,
    do_not_perform: typeof s.doNotPerform === 'boolean' ? s.doNotPerform : null,
    priority: s.priority ?? null,
    encounter_id: extractReferenceId(s.encounter) ?? null,
    insurance_id: extractReferenceId(s.insurance?.[0]) ?? null,
  };
}

function extractReferenceId(ref: Reference | undefined): string | null {
  const r = ref?.reference;
  if (!r) return null;
  const idx = r.lastIndexOf('/');
  return idx >= 0 ? r.slice(idx + 1) : r;
}

function firstCategoryCode(category: CodeableConcept[] | CodeableConcept | undefined): string | null {
  const cc = Array.isArray(category) ? category[0] : category;
  return cc?.coding?.[0]?.code ?? null;
}

const US_CORE_OMB_URLS: Record<string, string> = {
  'us-core-race': 'http://hl7.org/fhir/us/core/StructureDefinition/us-core-race',
  'us-core-ethnicity': 'http://hl7.org/fhir/us/core/StructureDefinition/us-core-ethnicity',
};

function extractUsCoreOmbCategory(p: Patient, kind: 'us-core-race' | 'us-core-ethnicity'): string | null {
  const url = US_CORE_OMB_URLS[kind];
  const outer = p.extension?.find(e => e.url === url);
  const ombCat = outer?.extension?.find(e => e.url === 'ombCategory');
  return ombCat?.valueCoding?.code ?? null;
}

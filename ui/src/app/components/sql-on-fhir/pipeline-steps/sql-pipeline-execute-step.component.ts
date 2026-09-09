// Author: Preston Lee

import { Component, computed, input, output } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { Patient } from 'fhir/r4';
import { SyntaxHighlighterComponent } from '../../shared/syntax-highlighter/syntax-highlighter.component';
import type { LibraryParameterSpec, LibraryParameterValues, ParameterValue } from '../library-parameters.lib';
import type { CompatibilityIssue } from '../measure-library-compatibility.lib';
import type { BundleResourceSummary } from '../../../services/sql-on-fhir/sql-on-fhir-execution-data.service';
import type { PatientFetchProgress } from '../../../services/sql-on-fhir/sql-on-fhir-patient-fetch.lib';

@Component({
  selector: 'app-sql-pipeline-execute-step',
  imports: [FormsModule, SyntaxHighlighterComponent, RouterLink],
  templateUrl: './sql-pipeline-execute-step.component.html',
  styleUrl: './sql-pipeline-execute-step.component.scss',
})
export class SqlPipelineExecuteStepComponent {
  readonly sqlText = input('');
  readonly sqlResultsRaw = input('');
  readonly measureReportJson = input('');
  readonly sqlExecutionStatus = input<string | null>(null);
  readonly measureReportStatus = input<string | null>(null);
  readonly hasMeasureReport = input(false);
  readonly persistedMeasureReportId = input<string | null>(null);
  readonly isExecutingSql = input(false);
  readonly canExecuteSql = input(false);
  readonly compatibilityIssues = input<CompatibilityIssue[]>([]);
  readonly compatibilityReady = input(false);
  readonly parameterSpecs = input<LibraryParameterSpec[]>([]);
  readonly parameterValues = input<LibraryParameterValues>({});
  readonly selectedPatients = input<Patient[]>([]);
  readonly patientSearchTerm = input('');
  readonly patientSearchResults = input<Patient[]>([]);
  readonly isLoadingPatients = input(false);
  readonly patientSearchError = input<string | null>(null);
  readonly hasExecutionBundle = input(false);
  readonly showResourceTypeSelection = input(false);
  readonly flattenableResourceTypes = input<string[]>([]);
  readonly derivedResourceTypes = input<string[]>([]);
  readonly unsupportedResourceTypes = input<string[]>([]);
  readonly executionResourceTypes = input<string[]>(['Patient']);
  readonly isLoadingPatientData = input(false);
  readonly patientFetchProgress = input<PatientFetchProgress | null>(null);
  readonly usingCms125Preset = input(false);
  readonly executionBundleSummary = input<BundleResourceSummary>({
    patientIds: [],
    countsByType: {},
    totalResources: 0,
  });
  readonly executionDataSizeLabel = input('0 B');
  readonly executionDataSizeWarn = input(false);

  readonly executeSql = output<void>();
  readonly generateMeasureReport = output<void>();
  readonly saveMeasureReport = output<void>();
  readonly patientSearchNow = output<void>();
  readonly patientSearchTermChange = output<string>();
  readonly togglePatient = output<Patient>();
  readonly removePatient = output<string>();
  readonly parameterValueChange = output<{ name: string; value: ParameterValue }>();
  readonly periodFieldChange = output<{ name: string; field: 'start' | 'end'; value: string }>();
  readonly scalarParameterChange = output<{
    name: string;
    kind: 'string' | 'boolean' | 'integer' | 'decimal' | 'dateTime';
    value: string | boolean;
  }>();
  readonly toggleExecutionResourceType = output<{ type: string; checked: boolean }>();
  readonly selectAllExecutionResourceTypes = output<boolean>();
  readonly clearClinicalData = output<void>();

  protected readonly fetchProgressPercent = computed(() => {
    const p = this.patientFetchProgress();
    if (!p || p.workUnitsTotal <= 0) {
      return 0;
    }
    return Math.min(100, Math.round((100 * p.workUnitsCompleted) / p.workUnitsTotal));
  });

  protected readonly fetchProgressStatusLine = computed(() => {
    const p = this.patientFetchProgress();
    if (!p) {
      return '';
    }
    const patientPart =
      p.currentPatientLabel || p.currentPatientId
        ? `Patient ${Math.min(p.patientsCompleted + 1, p.patientsTotal)} of ${p.patientsTotal} — ${p.currentPatientLabel ?? p.currentPatientId}`
        : `Patients ${p.patientsCompleted} of ${p.patientsTotal}`;
    const typePart = p.currentResourceType ? ` · fetching ${p.currentResourceType}…` : '';
    return `${patientPart}${typePart}`;
  });

  protected readonly fetchProgressTallyLine = computed(() => {
    const p = this.patientFetchProgress();
    if (!p) {
      return '';
    }
    const parts = Object.keys(p.resourcesByType)
      .sort()
      .map(type => `${type} ${p.resourcesByType[type]}`);
    const detail = parts.length ? ` (${parts.join(' · ')})` : '';
    return `${p.totalResources} resource${p.totalResources === 1 ? '' : 's'}${detail}`;
  });

  protected blockingIssues(): CompatibilityIssue[] {
    return this.compatibilityIssues().filter(i => i.severity === 'blocking');
  }

  protected warningIssues(): CompatibilityIssue[] {
    return this.compatibilityIssues().filter(i => i.severity === 'warning');
  }

  protected periodStart(name: string): string {
    const v = this.parameterValues()[name];
    if (v?.kind !== 'period') {
      return '';
    }
    return v.start?.length >= 16 ? v.start.slice(0, 16) : v.start;
  }

  protected periodEnd(name: string): string {
    const v = this.parameterValues()[name];
    if (v?.kind !== 'period') {
      return '';
    }
    return v.end?.length >= 16 ? v.end.slice(0, 16) : v.end;
  }

  protected stringParameterValue(name: string): string {
    const v = this.parameterValues()[name];
    return v?.kind === 'string' ? v.value : '';
  }

  protected numberParameterValue(name: string, kind: 'integer' | 'decimal'): number {
    const v = this.parameterValues()[name];
    return v?.kind === kind ? v.value : 0;
  }

  protected booleanParameterChecked(name: string): boolean {
    const v = this.parameterValues()[name];
    return v?.kind === 'boolean' ? v.value : false;
  }

  protected dateTimeParameterValue(name: string): string {
    const v = this.parameterValues()[name];
    if (v?.kind === 'dateTime' && v.value.length >= 16) {
      return v.value.slice(0, 16);
    }
    return v?.kind === 'dateTime' ? v.value : '';
  }

  protected getPatientDisplayName(patient: Patient): string {
    const name = patient.name?.[0];
    if (name?.text) {
      return name.text;
    }
    const given = name?.given?.join(' ') ?? '';
    const family = name?.family ?? '';
    return `${given} ${family}`.trim() || patient.id || 'Patient';
  }

  protected isMeasureDerivedType(type: string): boolean {
    return this.derivedResourceTypes().includes(type);
  }

  protected importedResourceSummary(): string {
    const summary = this.executionBundleSummary();
    const parts: string[] = [];
    if (summary.patientIds.length) {
      parts.push(
        `${summary.patientIds.length} patient${summary.patientIds.length === 1 ? '' : 's'} (${summary.patientIds.join(', ')})`,
      );
    }
    const clinicalTypes = this.showResourceTypeSelection()
      ? this.executionResourceTypes().filter(t => t !== 'Patient').sort()
      : this.usingCms125Preset()
        ? this.executionResourceTypes().filter(t => t !== 'Patient').sort()
        : Object.keys(summary.countsByType).filter(t => t !== 'Patient').sort();
    for (const type of clinicalTypes) {
      const count = summary.countsByType[type] ?? 0;
      parts.push(`${count} ${type}${count === 1 ? '' : 's'}`);
    }
    return parts.join('; ');
  }

  protected importDataWarnings(): string[] {
    const summary = this.executionBundleSummary();
    const warnings: string[] = [];
    if (!summary.patientIds.length) {
      return warnings;
    }
    if (
      this.derivedResourceTypes().includes('Encounter') &&
      (summary.countsByType['Encounter'] ?? 0) === 0
    ) {
      warnings.push(
        'No Encounters were imported. Measures that require qualifying office visits (e.g. CMS125 Initial Population) will count zero until finished Encounter resources exist on the server for these patients.',
      );
    }
    return warnings;
  }
}

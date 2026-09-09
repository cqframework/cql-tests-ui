// Author: Preston Lee
// Demo wiring contributions: Eugene Vestel

import {Component, ChangeDetectionStrategy, inject, signal, computed, effect} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { Subject, firstValueFrom, of } from 'rxjs';
import { catchError, debounceTime, distinctUntilChanged, switchMap } from 'rxjs/operators';
import { Bundle, Library, MeasureReport, Patient, ValueSet } from 'fhir/r4';
import type { PopulationCounts } from './elm-to-sql';
import { LibraryService } from '../../services/library.service';
import { SqlOnFhirPipelineService, type GenerateSqlResult } from '../../services/sql-on-fhir/sql-on-fhir-pipeline.service';
import { SqlOnFhirDemoService, decodeLibraryCql, CMS125_DATA_KEY } from '../../services/sql-on-fhir/sql-on-fhir-demo.service';
import {
  SqlOnFhirExecutionDataService,
  bundleHasClinicalResources,
  resourceTypesInBundle,
  summarizeBundleResources,
} from '../../services/sql-on-fhir/sql-on-fhir-execution-data.service';
import { PatientService } from '../../services/patient.service';
import { TranslationService } from '../../services/translation.service';
import { ToastService } from '../../services/toast.service';
import { isResourceType } from '../../services/fhir-resource-type.lib';
import { formatElmXml } from './format-elm-xml';
import {
  buildDefaultParameterValues,
  buildLibraryParameterSpecs,
  type LibraryParameterValues,
  type ParameterValue,
} from './library-parameters.lib';
import {
  assessMeasureLibraryCompatibility,
  hasBlockingCompatibilityIssues,
} from './measure-library-compatibility.lib';
import { resolveExecutionResourceTypes, FLATTENABLE_RESOURCE_TYPES } from './measure-resource-types.lib';
import {
  estimateExecutionDataSize,
  formatDataSize,
  type ExecutionDataSizeEstimate,
} from '../../services/sql-on-fhir/sql-on-fhir-data-size.lib';
import type { PatientFetchProgress } from '../../services/sql-on-fhir/sql-on-fhir-patient-fetch.lib';
import { emptyPatientFetchProgress } from '../../services/sql-on-fhir/sql-on-fhir-patient-fetch.lib';
import { SqlOnFhirPgliteService } from '../../services/sql-on-fhir/sql-on-fhir-pglite.service';
import {
  ensureCms125ValueSetsOnServer,
  publishCms125DemoToServerInitial,
  publishCms125ValueSetsToServer,
  resolveCms125BundledValueSets,
} from './sql-cms125-publish.lib';
import {
  SQL_WORKFLOW_ORDER,
  canNavigateToWorkflowStep,
  firstIncompleteWorkflowStep,
  isCqlStepComplete,
  isElmStepComplete,
  isLibraryStepComplete,
  isSqlGenStepComplete,
  workflowStepIconClasses as workflowStepIconClassesForStatus,
  workflowStepLabel as workflowStepLabelForStep,
  workflowStepStatus as workflowStepStatusForProgress,
  type SqlWorkflowProgress,
  type SqlWorkflowStep,
} from './sql-workflow.lib';
import { SqlLibraryListPanelComponent } from './sql-library-list-panel/sql-library-list-panel.component';
import { SqlPipelineCqlStepComponent } from './pipeline-steps/sql-pipeline-cql-step.component';
import { SqlPipelineElmStepComponent } from './pipeline-steps/sql-pipeline-elm-step.component';
import { SqlPipelineExecuteStepComponent } from './pipeline-steps/sql-pipeline-execute-step.component';
import { SqlPipelineLibraryStepComponent } from './pipeline-steps/sql-pipeline-library-step.component';
import { SqlPipelineSqlGenStepComponent } from './pipeline-steps/sql-pipeline-sql-gen-step.component';

export type { SqlWorkflowStep };

@Component({
  selector: 'app-sql-on-fhir',
  imports: [
    SqlLibraryListPanelComponent,
    SqlPipelineLibraryStepComponent,
    SqlPipelineCqlStepComponent,
    SqlPipelineElmStepComponent,
    SqlPipelineSqlGenStepComponent,
    SqlPipelineExecuteStepComponent
  ],
  templateUrl: './sql-on-fhir.component.html',

  styleUrl: './sql-on-fhir.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SqlOnFhirComponent {
  private readonly libraryService = inject(LibraryService);
  private readonly pipeline = inject(SqlOnFhirPipelineService);
  private readonly translationService = inject(TranslationService);
  private readonly demoService = inject(SqlOnFhirDemoService);
  private readonly executionDataService = inject(SqlOnFhirExecutionDataService);
  private readonly pglite = inject(SqlOnFhirPgliteService);
  private readonly patientService = inject(PatientService);
  private readonly toastService = inject(ToastService);

  /** Parsed population counts from the most recent executeSql, fed into MeasureReport generation. */
  private latestPopulationCounts: PopulationCounts | null = null;

  private elmRunId = 0;
  private sqlRunId = 0;
  /** Bumps when selection is cleared or a new library load starts; stale HTTP callbacks no-op. */
  private libraryLoadGeneration = 0;
  /** Library id for which executionParameters defaults were last applied. */
  private parameterDefaultsLibraryId: string | null = null;
  /** Library id for which executionResourceTypes defaults were last applied. */
  private resourceTypesDefaultsLibraryId: string | null = null;
  /** Bumps when patient compartment fetch starts; stale callbacks no-op. */
  private patientDataFetchGeneration = 0;
  /** Avoid duplicate CMS125 ValueSet publish runs for the same ELM + bundled content. */
  private cms125ValueSetPublishToken: string | null = null;
  private readonly patientSearchTrigger = new Subject<string>();

  protected readonly selectedLibrary = signal<Library | null>(null);
  protected readonly selectedLibraryJson = signal('');
  protected readonly cqlPreview = signal('');
  protected readonly elmXmlRaw = signal<string | null>(null);
  protected readonly elmJsonRaw = signal<string | null>(null);
  protected readonly isLoadingDemo = signal(false);
  protected readonly demoLoadError = signal<string | null>(null);
  protected readonly isExecutingSql = signal(false);
  protected readonly isTranslatingElm = signal(false);
  protected readonly elmTranslationErrors = signal<string[]>([]);
  protected readonly elmTranslationWarnings = signal<string[]>([]);
  protected readonly elmTranslationMessages = signal<string[]>([]);
  protected readonly formattedElmXml = computed(() => {
    const xml = this.elmXmlRaw();
    if (!xml) {
      return '';
    }
    return formatElmXml(xml);
  });
  protected readonly sqlText = signal('');
  protected readonly sqlResultsRaw = signal('');
  protected readonly sqlExecuteFailed = signal(false);
  protected readonly generateSqlResult = signal<GenerateSqlResult | null>(null);
  protected readonly generateSqlError = signal<string | null>(null);
  protected readonly executionParameters = signal<LibraryParameterValues>({});
  protected readonly executionBundle = signal<Bundle | null>(null);
  protected readonly executionDataKey = signal<string>('');
  protected readonly usingCms125Preset = signal(false);
  protected readonly bundledValueSets = signal<ValueSet[]>([]);
  protected readonly cms125ValueSetsOnServer = signal(false);
  protected readonly selectedPatients = signal<Patient[]>([]);
  protected readonly patientSearchTerm = signal('');
  protected readonly patientSearchResults = signal<Patient[]>([]);
  protected readonly isLoadingPatients = signal(false);
  protected readonly isLoadingPatientData = signal(false);
  protected readonly patientFetchProgress = signal<PatientFetchProgress | null>(null);
  protected readonly patientSearchError = signal<string | null>(null);
  protected readonly executionResourceTypes = signal<string[]>([...FLATTENABLE_RESOURCE_TYPES]);
  protected readonly measureReport = signal<MeasureReport | null>(null);
  protected readonly persistedMeasureReportId = signal<string | null>(null);
  private readonly persistedMeasureReportMeta = signal<MeasureReport['meta'] | null>(null);
  protected readonly sqlExecutionStatus = signal<string | null>(null);
  protected readonly measureReportStatus = signal<string | null>(null);

  protected readonly activeStep = signal<SqlWorkflowStep>('library');
  protected readonly workflowSteps = SQL_WORKFLOW_ORDER;

  protected readonly measureReportJson = computed(() => {
    const r = this.measureReport();
    return r ? JSON.stringify(r, null, 2) : '';
  });

  /** Non-null only when a library row is selected and JSON was loaded successfully; drives pipeline UI visibility. */
  protected readonly activePipelineLibrary = computed((): Library | null => {
    const lib = this.selectedLibrary();
    if (!lib?.id || this.selectedLibraryJson().trim().length === 0) {
      return null;
    }
    return lib;
  });

  protected readonly parameterSpecs = computed(() =>
    buildLibraryParameterSpecs(this.selectedLibrary(), this.elmJsonRaw()),
  );

  protected readonly resolvedResourceTypes = computed(() =>
    resolveExecutionResourceTypes({
      elmJson: this.elmJsonRaw(),
      library: this.selectedLibrary(),
    }),
  );

  protected readonly derivedResourceTypes = computed(
    () => this.resolvedResourceTypes().derivedTypes,
  );

  protected readonly flattenableResourceTypes = computed(() => [...FLATTENABLE_RESOURCE_TYPES]);

  protected readonly unsupportedResourceTypes = computed(
    () => this.resolvedResourceTypes().unsupportedTypes,
  );

  protected readonly usesFhirPatientFetch = computed(
    () => !this.usingCms125Preset() && this.selectedPatients().length > 0,
  );

  protected readonly showResourceTypeSelection = computed(() => !this.usingCms125Preset());

  protected readonly executionBundleSummary = computed(() =>
    summarizeBundleResources(this.executionBundle()),
  );

  protected readonly executionDataSize = computed((): ExecutionDataSizeEstimate =>
    estimateExecutionDataSize(this.executionBundle(), this.bundledValueSets()),
  );

  protected readonly executionDataSizeLabel = computed(() =>
    formatDataSize(this.executionDataSize().estimatedBytes),
  );

  protected readonly compatibilityIssues = computed(() =>
    assessMeasureLibraryCompatibility({
      library: this.selectedLibrary(),
      cqlTranslationErrors: this.elmTranslationErrors(),
      elmJson: this.elmJsonRaw(),
      generateSqlResult: this.generateSqlResult(),
      generateSqlError: this.generateSqlError(),
      parameterSpecs: this.parameterSpecs(),
      parameterValues: this.executionParameters(),
      hasExecutionBundle: bundleHasClinicalResources(this.executionBundle()),
      derivedResourceTypes: this.derivedResourceTypes(),
      selectedResourceTypes: this.executionResourceTypes(),
      unsupportedResourceTypes: this.unsupportedResourceTypes(),
      usesFhirPatientFetch: this.usesFhirPatientFetch(),
    }),
  );

  protected readonly canExecuteSql = computed(
    () =>
      !hasBlockingCompatibilityIssues(this.compatibilityIssues()) &&
      this.sqlText().trim().length > 0 &&
      !this.isExecutingSql() &&
      !this.isLoadingPatientData(),
  );

  protected readonly compatibilityReady = computed(
    () =>
      this.generateSqlResult() != null &&
      this.generateSqlResult()!.populations.length > 0 &&
      !hasBlockingCompatibilityIssues(this.compatibilityIssues()),
  );

  constructor() {
    effect(() => {
      const lib = this.selectedLibrary();
      const cql = this.cqlPreview().trim();
      if (!lib?.id) {
        this.elmRunId++;
        this.elmXmlRaw.set(null);
        this.elmJsonRaw.set(null);
        this.elmTranslationErrors.set([]);
        this.elmTranslationWarnings.set([]);
        this.elmTranslationMessages.set([]);
        this.isTranslatingElm.set(false);
        return;
      }
      if (!cql) {
        this.elmRunId++;
        this.elmXmlRaw.set(null);
        this.elmJsonRaw.set(null);
        this.elmTranslationErrors.set([]);
        this.elmTranslationWarnings.set([]);
        this.elmTranslationMessages.set([]);
        this.isTranslatingElm.set(false);
        return;
      }

      const runId = ++this.elmRunId;
      this.isTranslatingElm.set(true);
      this.elmTranslationErrors.set([]);
      this.elmTranslationWarnings.set([]);
      this.elmTranslationMessages.set([]);

      void this.translationService
        .translateCqlToElmAsync(cql)
        .then(result => {
          if (runId !== this.elmRunId) {
            return;
          }
          this.isTranslatingElm.set(false);
          this.elmXmlRaw.set(result.elmXml ?? '');
          this.elmJsonRaw.set(result.elmJson ?? null);
          this.elmTranslationErrors.set(result.errors);
          this.elmTranslationWarnings.set(result.warnings);
          this.elmTranslationMessages.set(result.messages);
        })
        .catch((e: unknown) => {
          if (runId !== this.elmRunId) {
            return;
          }
          this.isTranslatingElm.set(false);
          this.elmXmlRaw.set(null);
          this.elmJsonRaw.set(null);
          const msg = e instanceof Error ? e.message : String(e);
          this.elmTranslationErrors.set([`Failed to load translation assets: ${msg}`]);
          this.elmTranslationWarnings.set([]);
          this.elmTranslationMessages.set([]);
        });
    });

    effect(() => {
      const lib = this.selectedLibrary();
      const elmJson = this.elmJsonRaw();
      if (!lib?.id || !elmJson?.trim()) {
        this.executionParameters.set({});
        this.parameterDefaultsLibraryId = null;
        return;
      }
      if (this.parameterDefaultsLibraryId === lib.id) {
        return;
      }
      const specs = buildLibraryParameterSpecs(lib, elmJson);
      this.executionParameters.set(buildDefaultParameterValues(specs, lib, elmJson));
      this.parameterDefaultsLibraryId = lib.id;
    });

    effect(() => {
      const lib = this.selectedLibrary();
      const elmJson = this.elmJsonRaw();
      if (!lib?.id || !elmJson?.trim()) {
        this.executionResourceTypes.set([...FLATTENABLE_RESOURCE_TYPES]);
        this.resourceTypesDefaultsLibraryId = null;
        return;
      }
      if (this.resourceTypesDefaultsLibraryId === lib.id) {
        return;
      }
      this.executionResourceTypes.set([...FLATTENABLE_RESOURCE_TYPES]);
      this.resourceTypesDefaultsLibraryId = lib.id;
    });

    effect(() => {
      if (this.usingCms125Preset()) {
        return;
      }
      const patients = this.selectedPatients();
      const resourceTypes = this.executionResourceTypes();
      void this.refreshExecutionBundleFromPatients(patients, resourceTypes);
    });

    effect(() => {
      const lib = this.selectedLibrary();
      const elmJson = this.elmJsonRaw();
      const params = this.executionParameters();
      if (!lib?.id || elmJson == null || elmJson.trim() === '') {
        this.sqlRunId++;
        this.sqlText.set('');
        this.generateSqlResult.set(null);
        this.generateSqlError.set(null);
        return;
      }
      const runId = ++this.sqlRunId;
      void (async () => {
        try {
          const result = await firstValueFrom(this.pipeline.generateSql(elmJson, lib, params));
          if (runId !== this.sqlRunId) {
            return;
          }
          this.sqlText.set(result.sql);
          this.generateSqlResult.set(result);
          this.generateSqlError.set(null);
        } catch (err: unknown) {
          if (runId !== this.sqlRunId) {
            return;
          }
          this.sqlText.set('');
          this.generateSqlResult.set(null);
          const msg = err instanceof Error ? err.message : String(err);
          this.generateSqlError.set(msg);
        }
      })();
    });

    effect(() => {
      if (!this.selectedLibrary()) {
        return;
      }
      const first = firstIncompleteWorkflowStep(this.workflowProgress());
      if (first == null) {
        return;
      }
      const ai = SQL_WORKFLOW_ORDER.indexOf(this.activeStep());
      const fi = SQL_WORKFLOW_ORDER.indexOf(first);
      if (ai > fi) {
        this.activeStep.set(first);
      }
    });

    effect(() => {
      if (this.executionDataKey() !== CMS125_DATA_KEY) {
        return;
      }
      const elmJson = this.elmJsonRaw();
      const bundled = this.bundledValueSets();
      if (!elmJson?.trim() || bundled.length === 0) {
        return;
      }
      const token = `${elmJson.length}:${bundled.map(v => v.id).join(',')}`;
      if (this.cms125ValueSetPublishToken === token) {
        return;
      }
      this.cms125ValueSetPublishToken = token;
      void this.runPublishCms125ValueSetsToServer(elmJson, bundled, token);
    });

    this.patientSearchTrigger.pipe(
      debounceTime(300),
      distinctUntilChanged(),
      switchMap(term => {
        const trimmed = term.trim();
        if (trimmed.length === 0) {
          this.isLoadingPatients.set(false);
          this.patientSearchResults.set([]);
          this.patientSearchError.set(null);
          return of(null);
        }
        this.isLoadingPatients.set(true);
        this.patientSearchError.set(null);
        return this.patientService.search(trimmed).pipe(
          catchError((err: unknown) => {
            const msg = err instanceof Error ? err.message : String(err);
            this.patientSearchError.set(msg);
            return of(null);
          }),
        );
      }),
      takeUntilDestroyed(),
    ).subscribe(bundle => {
      this.isLoadingPatients.set(false);
      if (bundle == null) {
        return;
      }
      const patients =
        bundle.entry
          ?.map(e => e.resource)
          .filter((r): r is Patient => isResourceType(r, 'Patient')) ?? [];
      this.patientSearchResults.set(patients);
    });
  }

  protected async selectLibraryFromList(library: Library): Promise<void> {
    if (!library.id) {
      return;
    }
    if (this.selectedLibrary()?.id === library.id) {
      this.clearLibrarySelection();
      return;
    }

    this.clearExecuteStepStatus();
    const gen = ++this.libraryLoadGeneration;

    try {
      const fresh = await firstValueFrom(this.libraryService.get(library.id));
      if (gen !== this.libraryLoadGeneration) {
        return;
      }
      if (!fresh.id) {
        return;
      }
      this.clearPipelineOutputs();
      this.selectedLibrary.set(fresh);
      this.selectedLibraryJson.set(JSON.stringify(fresh, null, 2));
      try {
        const { cqlContent } = await firstValueFrom(this.libraryService.getCqlContent(fresh));
        if (gen !== this.libraryLoadGeneration) {
          return;
        }
        this.cqlPreview.set(cqlContent ?? '');
      } catch {
        if (gen !== this.libraryLoadGeneration) {
          return;
        }
        this.cqlPreview.set('');
      }
    } catch (err: unknown) {
      if (gen !== this.libraryLoadGeneration) {
        return;
      }
      const msg =
        err &&
        typeof err === 'object' &&
        'message' in err &&
        typeof (err as { message: unknown }).message === 'string'
          ? (err as { message: string }).message
          : 'Unable to load library from server';
      this.toastService.showError(msg, 'Library');
      // Keep the previously selected library; only toast the failure.
    }
  }

  private clearLibrarySelection(): void {
    this.libraryLoadGeneration++;
    this.clearExecuteStepStatus();
    this.clearPipelineOutputs();
    this.selectedLibrary.set(null);
    this.selectedLibraryJson.set('');
  }

  private clearPipelineOutputs(clearExecution = true): void {
    this.elmRunId++;
    this.sqlRunId++;
    this.activeStep.set('library');
    this.sqlExecuteFailed.set(false);
    this.elmXmlRaw.set(null);
    this.elmJsonRaw.set(null);
    this.elmTranslationErrors.set([]);
    this.elmTranslationWarnings.set([]);
    this.elmTranslationMessages.set([]);
    this.isTranslatingElm.set(false);
    this.sqlText.set('');
    this.sqlResultsRaw.set('');
    this.measureReport.set(null);
    this.persistedMeasureReportId.set(null);
    this.persistedMeasureReportMeta.set(null);
    this.cqlPreview.set('');
    this.latestPopulationCounts = null;
    this.generateSqlResult.set(null);
    this.generateSqlError.set(null);
    this.executionParameters.set({});
    this.parameterDefaultsLibraryId = null;
    this.resourceTypesDefaultsLibraryId = null;
    this.patientDataFetchGeneration++;
    this.isLoadingPatientData.set(false);
    this.patientFetchProgress.set(null);
    if (clearExecution) {
      this.executionResourceTypes.set([...FLATTENABLE_RESOURCE_TYPES]);
      this.executionBundle.set(null);
      this.executionDataKey.set('');
      this.usingCms125Preset.set(false);
      this.bundledValueSets.set([]);
      this.cms125ValueSetsOnServer.set(false);
      this.cms125ValueSetPublishToken = null;
      this.selectedPatients.set([]);
    }
    this.patientSearchResults.set([]);
    this.clearExecuteStepStatus();
  }

  private clearExecuteStepStatus(): void {
    this.sqlExecutionStatus.set(null);
    this.measureReportStatus.set(null);
  }

  protected async executeSql(): Promise<void> {
    if (!this.canExecuteSql()) {
      return;
    }
    const elmJson = this.elmJsonRaw();
    if (!elmJson?.trim()) {
      return;
    }
    this.sqlExecutionStatus.set(null);
    this.measureReportStatus.set(null);
    this.measureReport.set(null);
    this.sqlExecuteFailed.set(false);
    this.isExecutingSql.set(true);

    try {
      const seedData = await this.prepareExecutionSeedData(elmJson);
      if (!seedData) {
        this.isExecutingSql.set(false);
        return;
      }
      const result = await firstValueFrom(this.pipeline.executeSql(this.sqlText(), seedData));
      this.isExecutingSql.set(false);
      this.sqlResultsRaw.set(result.raw);
      this.latestPopulationCounts = result.counts;
      this.sqlExecuteFailed.set(false);
      this.toastService.showSuccess(`SQL executed in ${result.durationMs.toFixed(0)} ms.`, 'Execute SQL');
      void this.generateMeasureReport();
    } catch (err: unknown) {
      this.isExecutingSql.set(false);
      this.sqlExecuteFailed.set(true);
      const msg = err instanceof Error ? err.message : String(err);
      this.sqlExecutionStatus.set(`SQL execution failed: ${msg}`);
    }
  }

  private async prepareExecutionSeedData(elmJson: string) {
    const bundle = this.executionBundle();
    if (!bundle || !bundleHasClinicalResources(bundle)) {
      this.sqlExecutionStatus.set(
        'No clinical data selected — choose patients from the FHIR server or load the CMS125 preset bundle.',
      );
      this.sqlExecuteFailed.set(true);
      return null;
    }
    let bundledForRows = this.bundledValueSets();
    if (this.executionDataKey() === CMS125_DATA_KEY) {
      try {
        await ensureCms125ValueSetsOnServer(elmJson, this.cms125PublishDeps());
        bundledForRows = await resolveCms125BundledValueSets(this.cms125PublishDeps());
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        this.sqlExecutionStatus.set(`Value set loading failed: ${msg}`);
        this.sqlExecuteFailed.set(true);
        return null;
      }
    }
    const { rows, errors } = await this.executionDataService.prepareValueSetRows(elmJson, bundledForRows);
    if (errors.length) {
      this.sqlExecutionStatus.set(`Value set loading failed: ${errors.join('; ')}`);
      this.sqlExecuteFailed.set(true);
      return null;
    }
    const bundleKey = this.executionDataService.buildDataKeyFromBundle(bundle);
    const patientKey = this.executionDataKey();
    const dataKey = patientKey ? `${patientKey}|${bundleKey}` : bundleKey;
    return {
      dataKey,
      bundle,
      valueSetRows: rows,
    };
  }

  /**
   * User edited the CQL in the pipeline's CQL step. Setting cqlPreview re-fires
   * the translation effect, which cascades into SQL regeneration; downstream
   * results are cleared so stale counts/reports aren't shown against new logic.
   * Execution data (bundle, value sets, patients) is intentionally kept so the
   * edited measure runs against the same cohort — that's the authoring loop.
   */
  protected onCqlEdited(newCql: string): void {
    this.sqlResultsRaw.set('');
    this.sqlExecuteFailed.set(false);
    this.measureReport.set(null);
    this.latestPopulationCounts = null;
    // Allow parameter/resource-type defaults to re-derive from the new ELM.
    this.parameterDefaultsLibraryId = null;
    this.resourceTypesDefaultsLibraryId = null;
    this.cqlPreview.set(newCql);
  }

  protected async loadCms125Demo(): Promise<void> {
    this.isLoadingDemo.set(true);
    this.demoLoadError.set(null);
    this.clearExecuteStepStatus();
    try {
      const content = await firstValueFrom(this.demoService.loadCms125());
      this.libraryLoadGeneration++;
      this.patientDataFetchGeneration++;
      this.clearPipelineOutputs(false);
      this.usingCms125Preset.set(true);
      this.selectedLibrary.set(content.library);
      this.selectedLibraryJson.set(JSON.stringify(content.library, null, 2));
      this.cqlPreview.set(content.cqlSource || decodeLibraryCql(content.library));
      this.executionBundle.set(content.bundle);
      this.executionDataKey.set(content.dataKey);
      this.bundledValueSets.set(content.valueSets);
      this.executionResourceTypes.set(resourceTypesInBundle(content.bundle));
      this.resourceTypesDefaultsLibraryId = content.library.id ?? null;
      this.selectedPatients.set([]);
      this.patientDataFetchGeneration++;
      void publishCms125DemoToServerInitial(content.valueSets, content.bundle, {
        publishValueSetsToServer: vs => this.executionDataService.publishValueSetsToServer(vs),
        publishBundleToServer: b => this.executionDataService.publishBundleToServer(b),
        setOnServer: v => this.cms125ValueSetsOnServer.set(v),
        setDemoLoadError: msg => this.demoLoadError.set(msg),
      }).finally(() => {
        this.isLoadingDemo.set(false);
      });
    } catch (err: unknown) {
      this.isLoadingDemo.set(false);
      const msg = err instanceof Error ? err.message : String(err);
      this.demoLoadError.set(`Failed to load CMS125 demo: ${msg}`);
    }
  }

  protected selectWorkflowStep(step: SqlWorkflowStep): void {
    if (!this.canNavigateToStep(step)) {
      return;
    }
    this.activeStep.set(step);
  }

  private workflowProgress(): SqlWorkflowProgress {
    return {
      hasSelectedLibrary: this.selectedLibrary() != null,
      libraryComplete:
        !!this.selectedLibrary()?.id && this.selectedLibraryJson().trim().length > 0,
      cqlPreview: this.cqlPreview(),
      isTranslatingElm: this.isTranslatingElm(),
      hasElmTranslationErrors: this.hasElmTranslationErrors(),
      hasElmTranslationWarnings: this.hasElmTranslationWarnings(),
      elmXmlRaw: this.elmXmlRaw(),
      formattedElmXml: this.formattedElmXml(),
      sqlText: this.sqlText(),
      sqlExecuteFailed: this.sqlExecuteFailed(),
      sqlResultsRaw: this.sqlResultsRaw(),
    };
  }

  protected canNavigateToStep(step: SqlWorkflowStep): boolean {
    return canNavigateToWorkflowStep(step, this.workflowProgress());
  }

  protected libraryStepComplete(): boolean {
    return isLibraryStepComplete(this.workflowProgress());
  }

  protected cqlStepComplete(): boolean {
    return isCqlStepComplete(this.workflowProgress());
  }

  protected elmStepComplete(): boolean {
    return isElmStepComplete(this.workflowProgress());
  }

  protected sqlGenStepComplete(): boolean {
    return isSqlGenStepComplete(this.workflowProgress());
  }

  /** First step whose prerequisites are not fully satisfied (where the user should resume). */
  protected firstIncompleteStep(): SqlWorkflowStep | null {
    return firstIncompleteWorkflowStep(this.workflowProgress());
  }

  protected workflowStepLabel(step: SqlWorkflowStep): string {
    return workflowStepLabelForStep(step);
  }

  protected workflowStepStatus(step: SqlWorkflowStep): 'locked' | 'loading' | 'ok' | 'warn' | 'error' {
    return workflowStepStatusForProgress(step, this.workflowProgress());
  }

  protected workflowStepIconClasses(step: SqlWorkflowStep): string {
    return workflowStepIconClassesForStatus(this.workflowStepStatus(step));
  }

  protected async generateMeasureReport(): Promise<void> {
    const lib = this.selectedLibrary();
    const counts = this.latestPopulationCounts;
    if (!counts) {
      this.measureReportStatus.set('Run "Execute SQL" first — no population counts available yet.');
      return;
    }
    this.measureReportStatus.set(null);
    try {
      const r = await firstValueFrom(
        this.pipeline.generateMeasureReport(counts, lib, this.executionParameters()),
      );
      this.measureReport.set(r);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.measureReportStatus.set(`MeasureReport generation failed: ${msg}`);
    }
  }

  protected async saveMeasureReport(): Promise<void> {
    const r = this.measureReport();
    if (!r) {
      this.measureReportStatus.set('Nothing to save.');
      return;
    }
    this.measureReportStatus.set(null);
    try {
      const saved = await firstValueFrom(
        this.pipeline.saveMeasureReport(
          r,
          this.persistedMeasureReportId(),
          this.persistedMeasureReportMeta(),
        ),
      );
      this.measureReport.set(saved);
      if (saved.id) {
        this.persistedMeasureReportId.set(saved.id);
      }
      if (saved.meta) {
        this.persistedMeasureReportMeta.set(saved.meta);
      }
      this.toastService.showSuccess(`MeasureReport saved (id: ${saved.id ?? 'unknown'}).`, 'Save');
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.measureReportStatus.set(`MeasureReport save failed: ${msg}`);
    }
  }

  protected readonly hasElmTranslationErrors = computed(() => this.elmTranslationErrors().length > 0);
  protected readonly hasElmTranslationWarnings = computed(() => this.elmTranslationWarnings().length > 0);

  protected readonly bundleHasClinicalResources = bundleHasClinicalResources;

  protected onPatientSearchTermChange(term: string): void {
    this.patientSearchTerm.set(term);
    this.patientSearchTrigger.next(term);
  }

  protected async onPatientSearchNow(): Promise<void> {
    const term = this.patientSearchTerm().trim();
    if (term.length === 0) {
      this.patientSearchResults.set([]);
      this.patientSearchError.set(null);
      return;
    }
    this.isLoadingPatients.set(true);
    this.patientSearchError.set(null);
    try {
      const bundle = await firstValueFrom(this.patientService.search(term));
      this.isLoadingPatients.set(false);
      const patients =
        bundle.entry
          ?.map(e => e.resource)
          .filter((r): r is Patient => isResourceType(r, 'Patient')) ?? [];
      this.patientSearchResults.set(patients);
    } catch (err: unknown) {
      this.isLoadingPatients.set(false);
      const msg = err instanceof Error ? err.message : String(err);
      this.patientSearchError.set(msg);
      this.patientSearchResults.set([]);
    }
  }

  protected togglePatient(patient: Patient): void {
    const current = this.selectedPatients();
    const exists = current.some(p => p.id === patient.id);
    const next = exists ? current.filter(p => p.id !== patient.id) : [...current, patient];
    if (this.usingCms125Preset() && !exists) {
      this.usingCms125Preset.set(false);
      this.executionBundle.set(null);
      this.executionDataKey.set('');
      this.bundledValueSets.set([]);
      this.cms125ValueSetsOnServer.set(false);
      this.cms125ValueSetPublishToken = null;
    } else if (!this.usingCms125Preset()) {
      this.bundledValueSets.set([]);
    }
    this.selectedPatients.set(next);
  }

  protected removeSelectedPatient(patientId: string): void {
    const next = this.selectedPatients().filter(p => p.id !== patientId);
    this.selectedPatients.set(next);
    if (!this.usingCms125Preset()) {
      this.bundledValueSets.set([]);
    }
  }

  protected onExecutionResourceTypesChange(types: string[]): void {
    const withPatient = types.includes('Patient') ? types : ['Patient', ...types];
    this.executionResourceTypes.set([...new Set(withPatient)].sort());
  }

  protected toggleExecutionResourceType(type: string, checked: boolean): void {
    if (type === 'Patient' && !checked) {
      return;
    }
    const current = new Set(this.executionResourceTypes());
    if (checked) {
      current.add(type);
    } else {
      current.delete(type);
    }
    this.onExecutionResourceTypesChange([...current]);
  }

  protected setAllNonPatientResourceTypes(selected: boolean): void {
    const all = [...FLATTENABLE_RESOURCE_TYPES];
    const next = selected ? all : ['Patient'];
    this.onExecutionResourceTypesChange(next);
  }

  protected clearClinicalData(): void {
    this.patientDataFetchGeneration++;
    this.selectedPatients.set([]);
    this.patientFetchProgress.set(null);
    this.isLoadingPatientData.set(false);
    this.executionBundle.set(null);
    this.executionDataKey.set('');
    this.bundledValueSets.set([]);
    this.usingCms125Preset.set(false);
    void this.pglite.clearSeededData();
  }

  protected isExecutionResourceTypeSelected(type: string): boolean {
    return this.executionResourceTypes().includes(type);
  }

  protected isPatientSelected(patient: Patient): boolean {
    return this.selectedPatients().some(p => p.id === patient.id);
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

  private async refreshExecutionBundleFromPatients(
    patients: Patient[],
    resourceTypes: string[],
  ): Promise<void> {
    const generation = ++this.patientDataFetchGeneration;
    if (patients.length === 0) {
      if (generation !== this.patientDataFetchGeneration) {
        return;
      }
      if (this.usingCms125Preset()) {
        return;
      }
      this.executionBundle.set(null);
      this.executionDataKey.set('');
      this.isLoadingPatientData.set(false);
      return;
    }
    this.isLoadingPatientData.set(true);
    this.patientFetchProgress.set(
      emptyPatientFetchProgress(patients.length, patients.length * (1 + resourceTypes.filter(t => t !== 'Patient').length)),
    );
    try {
      const bundle = await this.executionDataService.buildBundleFromPatients(patients, {
        resourceTypes,
        onProgress: progress => {
          if (generation !== this.patientDataFetchGeneration) {
            return;
          }
          this.patientFetchProgress.set(progress);
        },
      });
      if (generation !== this.patientDataFetchGeneration) {
        return;
      }
      this.executionBundle.set(bundle);
      this.executionDataKey.set(
        this.executionDataService.buildDataKeyFromPatients(patients, resourceTypes),
      );
    } catch (err: unknown) {
      if (generation !== this.patientDataFetchGeneration) {
        return;
      }
      const msg = err instanceof Error ? err.message : String(err);
      this.sqlExecutionStatus.set(`Failed to load patient data: ${msg}`);
      this.executionBundle.set(null);
      this.executionDataKey.set('');
    } finally {
      if (generation === this.patientDataFetchGeneration) {
        this.isLoadingPatientData.set(false);
        this.patientFetchProgress.set(null);
      }
    }
  }

  protected setParameterValue(name: string, value: ParameterValue): void {
    this.executionParameters.update(v => ({ ...v, [name]: value }));
  }

  protected setPeriodField(name: string, field: 'start' | 'end', localValue: string): void {
    const current = this.executionParameters()[name];
    const iso = localValue ? `${localValue}:00.000Z` : '';
    if (current?.kind === 'period') {
      this.setParameterValue(name, {
        kind: 'period',
        start: field === 'start' ? iso : current.start,
        end: field === 'end' ? iso : current.end,
      });
    } else {
      this.setParameterValue(name, {
        kind: 'period',
        start: field === 'start' ? iso : '',
        end: field === 'end' ? iso : '',
      });
    }
  }

  protected periodFieldValue(name: string, field: 'start' | 'end'): string {
    const v = this.executionParameters()[name];
    if (v?.kind !== 'period') {
      return '';
    }
    const iso = field === 'start' ? v.start : v.end;
    return iso?.length >= 16 ? iso.slice(0, 16) : iso;
  }

  protected setScalarParameter(name: string, kind: 'string' | 'boolean' | 'integer' | 'decimal' | 'dateTime', raw: string | boolean): void {
    switch (kind) {
      case 'string':
        this.setParameterValue(name, { kind: 'string', value: String(raw) });
        break;
      case 'boolean':
        this.setParameterValue(name, { kind: 'boolean', value: Boolean(raw) });
        break;
      case 'integer':
        this.setParameterValue(name, { kind: 'integer', value: Number.parseInt(String(raw), 10) || 0 });
        break;
      case 'decimal':
        this.setParameterValue(name, { kind: 'decimal', value: Number.parseFloat(String(raw)) || 0 });
        break;
      case 'dateTime':
        this.setParameterValue(name, {
          kind: 'dateTime',
          value: raw ? `${String(raw)}:00.000Z` : new Date().toISOString(),
        });
        break;
    }
  }

  protected scalarParameterValue(name: string, kind: 'string' | 'integer' | 'decimal'): string | number {
    const v = this.executionParameters()[name];
    if (v?.kind === kind) {
      return v.value;
    }
    return kind === 'string' ? '' : 0;
  }

  protected booleanParameterValue(name: string): boolean {
    const v = this.executionParameters()[name];
    return v?.kind === 'boolean' ? v.value : false;
  }

  protected dateTimeParameterValue(name: string): string {
    const v = this.executionParameters()[name];
    if (v?.kind === 'dateTime' && v.value.length >= 16) {
      return v.value.slice(0, 16);
    }
    return v?.kind === 'dateTime' ? v.value : '';
  }

  private cms125PublishDeps() {
    return {
      getBundled: () => this.bundledValueSets(),
      setBundled: (vs: ValueSet[]) => this.bundledValueSets.set(vs),
      loadCms125ValueSets: () => this.demoService.loadCms125ValueSets(),
      alreadyOnServer: () => this.cms125ValueSetsOnServer(),
      setOnServer: (v: boolean) => this.cms125ValueSetsOnServer.set(v),
      publishValueSetsToServer: (vs: ValueSet[]) =>
        this.executionDataService.publishValueSetsToServer(vs),
    };
  }

  private async runPublishCms125ValueSetsToServer(
    elmJson: string,
    bundled: ValueSet[],
    token: string,
  ): Promise<void> {
    await publishCms125ValueSetsToServer(elmJson, bundled, token, {
      getPublishToken: () => this.cms125ValueSetPublishToken,
      setPublishToken: t => {
        this.cms125ValueSetPublishToken = t;
      },
      setOnServer: v => this.cms125ValueSetsOnServer.set(v),
      setDemoLoadError: msg => this.demoLoadError.set(msg),
      publishValueSetsToServer: vs => this.executionDataService.publishValueSetsToServer(vs),
    });
  }
}

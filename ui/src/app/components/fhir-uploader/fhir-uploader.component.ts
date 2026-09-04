// Author: Preston Lee

import { Component, signal, ElementRef, HostBinding, AfterViewInit, viewChild, inject, afterNextRender, Injector, ChangeDetectionStrategy } from '@angular/core';
import { DecimalPipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { SettingsService } from '../../services/settings.service';
import { FhirPackageLoadService } from '../../services/fhir-package-load.service';
import { FhirPackageLocalUploadStagingService } from '../../services/fhir-package-local-upload-staging.service';
import {
  FHIR_REGISTRY_IMPORTER_QUERY_SOURCE,
  FHIR_REGISTRY_IMPORTER_SOURCE_LOCAL
} from '../fhir-registry-importer/fhir-registry-importer.deep-link';
import { Library, Bundle, ImplementationGuide, Resource } from 'fhir/r4';
import { convertCqlToFhirLibrary } from '../../services/cql-file-to-fhir-library.lib';
import {
  FHIR_BUNDLE_EXAMPLE_PATHS,
  FHIR_CQL_EXAMPLE_PATHS
} from '../../constants/example-paths.constants';
import { ImplementationGuidePanelComponent } from '../shared/implementation-guide-panel/implementation-guide-panel.component';
import { AddToWorkspacesPanelComponent } from '../shared/add-to-workspaces-panel/add-to-workspaces-panel.component';
import {
  defaultSelectedIgEntryKeys,
  enrichIgEntriesForBundle,
  filterImplementationGuide,
  IgResourceEntryVm,
  parseImplementationGuideEntries
} from '../../services/implementation-guide.lib';
import { AuthService } from '../../services/auth.service';
import { WorkspaceResourceLinkService } from '../../services/workspace-resource-link.service';
import {
  WorkspaceResourceLinkInput,
  workspaceLinkInputFromFhirResource,
} from '../../services/workspace-resource-link.lib';
import { isFhirPackageArchiveName } from '../../services/fhir-package-archive-path.lib';

interface BundleIgState {
  entryIndex: number;
  ig: ImplementationGuide;
  entries: IgResourceEntryVm[];
  selectedEntryKeys: ReadonlySet<string>;
  selectedGlobalIndices: ReadonlySet<number>;
  sanitize: boolean;
  expanded: boolean;
}

interface BundleFile {
  id: string;
  file: File;
  name: string;
  size: number;
  isValid: boolean;
  error?: string;
  enabled: boolean;
  igStates?: BundleIgState[];
  uploadResult?: {
    success: boolean;
    error?: string;
    result?: any;
  };
}

interface CqlFile {
  id: string;
  file: File;
  name: string;
  size: number;
  isValid: boolean;
  error?: string;
  enabled: boolean;
  cqlContent?: string;
  fhirLibrary?: any;
  uploadResult?: {
    success: boolean;
    error?: string;
    result?: any;
  };
}

@Component({
  selector: 'app-fhir-uploader',
  imports: [DecimalPipe, FormsModule, ImplementationGuidePanelComponent, AddToWorkspacesPanelComponent],
  templateUrl: './fhir-uploader.component.html',

  styleUrl: './fhir-uploader.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class FhirUploaderComponent implements AfterViewInit {
  protected readonly files = signal<BundleFile[]>([]);
  protected readonly cqlFiles = signal<CqlFile[]>([]);
  protected readonly fhirBaseUrl = signal<string>('');
  protected readonly continueOnError = signal<boolean>(false);
  protected readonly isUploading = signal<boolean>(false);
  protected readonly uploadProgress = signal<number>(0);
  protected readonly selectedWorkspaceIds = signal<string[]>([]);
  protected readonly workspaceLinkStatus = signal<string | null>(null);
  protected readonly isDragOver = signal<boolean>(false);
  protected readonly isCqlDragOver = signal<boolean>(false);
  protected readonly isPackageDragOver = signal<boolean>(false);
  protected readonly isPackageLoading = signal<boolean>(false);
  protected readonly packageError = signal<string | null>(null);
  protected readonly draggedFileId = signal<string | null>(null);
  protected readonly expandedResult = signal<string | null>(null);
  protected readonly isExpunging = signal<boolean>(false);
  protected readonly isPurging = signal<boolean>(false);
  protected readonly showExpungeModal = signal<boolean>(false);
  protected readonly showPurgeModal = signal<boolean>(false);
  protected readonly showUploadModal = signal<boolean>(false);
  protected readonly modalMessage = signal<string>('');
  protected readonly modalTitle = signal<string>('');
  protected readonly modalType = signal<'success' | 'error' | 'warning'>('success');
  protected readonly isAddingExamples = signal<boolean>(false);

  @HostBinding('class.modal-open')
  get hasModalOpen(): boolean {
    return this.showExpungeModal() || this.showPurgeModal() || this.showUploadModal();
  }

  expungeConfirmButton = viewChild<ElementRef<HTMLButtonElement>>('expungeConfirmButton');
  purgeConfirmButton = viewChild<ElementRef<HTMLButtonElement>>('purgeConfirmButton');
  resultModalButton = viewChild<ElementRef<HTMLButtonElement>>('resultModalButton');

  protected settingsService = inject(SettingsService);
  protected readonly auth = inject(AuthService);
  private readonly workspaceResourceLink = inject(WorkspaceResourceLinkService);
  private router = inject(Router);
  private http = inject(HttpClient);
  private injector = inject(Injector);
  private packageLoadService = inject(FhirPackageLoadService);
  private packageStaging = inject(FhirPackageLocalUploadStagingService);

  constructor() {
    // Initialize with the effective FHIR base URL from settings
    this.fhirBaseUrl.set(this.settingsService.getEffectiveEvaluationServerUrl());
  }

  getEffectiveEvaluationServerUrl(): string {
    return this.settingsService.getEffectiveEvaluationServerUrl();
  }

  navigateToSettings(event: Event): void {
    event.preventDefault();
    this.router.navigate(['/settings/environments']);
  }

  ngAfterViewInit(): void {
    // Focus management will be handled by the template
  }

  private focusModalButton(buttonRef: ElementRef<HTMLButtonElement> | undefined): void {
    if (buttonRef?.nativeElement) {
      queueMicrotask(() => buttonRef.nativeElement.focus());
    }
  }

  private scheduleModalFocus(buttonRef: () => ElementRef<HTMLButtonElement> | undefined): void {
    afterNextRender(() => this.focusModalButton(buttonRef()), { injector: this.injector });
  }

  onDragOver(event: DragEvent): void {
    event.preventDefault();
    event.stopPropagation();
    this.isDragOver.set(true);
  }

  onDragLeave(event: DragEvent): void {
    event.preventDefault();
    event.stopPropagation();
    this.isDragOver.set(false);
  }

  onDrop(event: DragEvent): void {
    event.preventDefault();
    event.stopPropagation();
    this.isDragOver.set(false);

    const files = event.dataTransfer?.files;
    if (files) {
      this.addFiles(Array.from(files));
    }
  }

  onFileSelect(event: Event): void {
    const input = event.target as HTMLInputElement;
    if (input.files) {
      this.addFiles(Array.from(input.files));
    }
  }

  onCqlDragOver(event: DragEvent): void {
    event.preventDefault();
    event.stopPropagation();
    this.isCqlDragOver.set(true);
  }

  onCqlDragLeave(event: DragEvent): void {
    event.preventDefault();
    event.stopPropagation();
    this.isCqlDragOver.set(false);
  }

  onCqlDrop(event: DragEvent): void {
    event.preventDefault();
    event.stopPropagation();
    this.isCqlDragOver.set(false);

    const files = event.dataTransfer?.files;
    if (files) {
      this.addCqlFiles(Array.from(files));
    }
  }

  onCqlFileSelect(event: Event): void {
    const input = event.target as HTMLInputElement;
    if (input.files) {
      this.addCqlFiles(Array.from(input.files));
    }
  }

  onPackageDragOver(event: DragEvent): void {
    event.preventDefault();
    event.stopPropagation();
    this.isPackageDragOver.set(true);
  }

  onPackageDragLeave(event: DragEvent): void {
    event.preventDefault();
    event.stopPropagation();
    this.isPackageDragOver.set(false);
  }

  onPackageDrop(event: DragEvent): void {
    event.preventDefault();
    event.stopPropagation();
    this.isPackageDragOver.set(false);
    const files = event.dataTransfer?.files;
    if (files?.length) {
      void this.handlePackageFile(files[0]);
    }
  }

  onPackageFileSelect(event: Event): void {
    const input = event.target as HTMLInputElement;
    if (input.files?.length) {
      void this.handlePackageFile(input.files[0]);
      input.value = '';
    }
  }

  private async handlePackageFile(file: File): Promise<void> {
    this.packageError.set(null);
    if (!isFhirPackageArchiveName(file.name)) {
      this.packageError.set('Please choose a FHIR package archive (.tgz or .tar.gz).');
      return;
    }

    this.isPackageLoading.set(true);
    try {
      const bytes = await file.arrayBuffer();
      // Strict FHIR packaging validation before handoff.
      this.packageLoadService.parseLocalFhirPackageTarball(bytes, file.name.replace(/\.(tgz|tar\.gz)$/i, ''));
      this.packageStaging.stage(file.name, bytes);
      await this.router.navigate(['/fhir-registry-importer'], {
        queryParams: {
          [FHIR_REGISTRY_IMPORTER_QUERY_SOURCE]: FHIR_REGISTRY_IMPORTER_SOURCE_LOCAL
        }
      });
    } catch (error) {
      this.packageStaging.clear();
      this.packageError.set(
        error instanceof Error ? error.message : 'Failed to validate FHIR package.'
      );
    } finally {
      this.isPackageLoading.set(false);
    }
  }

  private addFiles(files: File[]): void {
    const newFiles: BundleFile[] = files
      .filter(file => file.name.toLowerCase().endsWith('.json'))
      .map(file => {
        const id = Math.random().toString(36).substr(2, 9);
        return {
          id,
          file,
          name: file.name,
          size: file.size,
          isValid: false,
          error: undefined,
          enabled: true
        };
      });

    // Validate each file
    newFiles.forEach(bundleFile => {
      this.validateBundleFile(bundleFile);
    });

    this.files.set([...this.files(), ...newFiles]);
  }

  private addCqlFiles(files: File[]): void {
    const newCqlFiles: CqlFile[] = files
      .filter(file => file.name.toLowerCase().endsWith('.cql'))
      .map(file => {
        const id = Math.random().toString(36).substr(2, 9);
        return {
          id,
          file,
          name: file.name,
          size: file.size,
          isValid: false,
          error: undefined,
          enabled: true
        };
      });

    // Process each CQL file
    newCqlFiles.forEach(cqlFile => {
      this.processCqlFile(cqlFile);
    });

    this.cqlFiles.set([...this.cqlFiles(), ...newCqlFiles]);
  }

  private async validateBundleFile(bundleFile: BundleFile): Promise<void> {
    try {
      const text = await this.readFileAsText(bundleFile.file);
      const json = JSON.parse(text) as Bundle;

      if (json.resourceType === 'Bundle' && Array.isArray(json.entry)) {
        bundleFile.isValid = true;
        bundleFile.error = undefined;
        bundleFile.igStates = this.buildIgStatesFromBundle(json);
      } else {
        bundleFile.isValid = false;
        bundleFile.error = 'Not a valid FHIR Bundle resource';
        bundleFile.igStates = undefined;
      }
    } catch (error) {
      bundleFile.isValid = false;
      bundleFile.error = 'Invalid JSON or file read error';
      bundleFile.igStates = undefined;
    }
    this.files.update((list) => list.map((f) => (f.id === bundleFile.id ? { ...bundleFile } : f)));
  }

  private buildIgStatesFromBundle(bundle: Bundle): BundleIgState[] {
    const resources = (bundle.entry ?? [])
      .map((e) => e.resource)
      .filter((r): r is Resource => !!r);
    const states: BundleIgState[] = [];
    (bundle.entry ?? []).forEach((entry, entryIndex) => {
      if (entry.resource?.resourceType !== 'ImplementationGuide') {
        return;
      }
      const ig = entry.resource as ImplementationGuide;
      const entries = enrichIgEntriesForBundle(parseImplementationGuideEntries(ig), resources);
      states.push({
        entryIndex,
        ig,
        entries,
        selectedEntryKeys: defaultSelectedIgEntryKeys(entries),
        selectedGlobalIndices: new Set((ig.global ?? []).map((_, i) => i)),
        sanitize: true,
        expanded: true
      });
    });
    return states;
  }

  toggleBundleIgExpanded(fileId: string, igIndex: number): void {
    this.files.update((list) =>
      list.map((f) => {
        if (f.id !== fileId || !f.igStates) {
          return f;
        }
        const igStates = f.igStates.map((s, i) =>
          i === igIndex ? { ...s, expanded: !s.expanded } : s
        );
        return { ...f, igStates };
      })
    );
  }

  onBundleIgEntryKeysChange(fileId: string, igIndex: number, keys: ReadonlySet<string>): void {
    this.patchBundleIgState(fileId, igIndex, { selectedEntryKeys: keys });
  }

  onBundleIgGlobalIndicesChange(fileId: string, igIndex: number, indices: ReadonlySet<number>): void {
    this.patchBundleIgState(fileId, igIndex, { selectedGlobalIndices: indices });
  }

  onBundleIgSanitizeChange(fileId: string, igIndex: number, sanitize: boolean): void {
    this.patchBundleIgState(fileId, igIndex, { sanitize });
  }

  selectBundleIgReferenced(fileId: string, igIndex: number): void {
    const file = this.files().find((f) => f.id === fileId);
    const state = file?.igStates?.[igIndex];
    if (!state) {
      return;
    }
    const keys = new Set(
      state.entries.filter((e) => e.importable && e.matchedResourceKey).map((e) => e.key)
    );
    this.patchBundleIgState(fileId, igIndex, { selectedEntryKeys: keys });
  }

  selectBundleIgConformanceOnly(fileId: string, igIndex: number): void {
    const file = this.files().find((f) => f.id === fileId);
    const state = file?.igStates?.[igIndex];
    if (!state) {
      return;
    }
    this.patchBundleIgState(fileId, igIndex, {
      selectedEntryKeys: defaultSelectedIgEntryKeys(state.entries)
    });
  }

  selectBundleIgMetadataOnly(fileId: string, igIndex: number): void {
    this.patchBundleIgState(fileId, igIndex, {
      selectedEntryKeys: new Set(),
      selectedGlobalIndices: new Set()
    });
  }

  private patchBundleIgState(
    fileId: string,
    igIndex: number,
    patch: Partial<BundleIgState>
  ): void {
    this.files.update((list) =>
      list.map((f) => {
        if (f.id !== fileId || !f.igStates) {
          return f;
        }
        const igStates = f.igStates.map((s, i) => (i === igIndex ? { ...s, ...patch } : s));
        return { ...f, igStates };
      })
    );
  }

  private async processCqlFile(cqlFile: CqlFile): Promise<void> {
    let next: CqlFile;
    try {
      const cqlContent = await this.readFileAsText(cqlFile.file);
      const fhirLibrary = convertCqlToFhirLibrary(
        cqlContent,
        cqlFile.name,
        this.settingsService.getEffectiveEvaluationServerUrl()
      );
      next = {
        ...cqlFile,
        cqlContent,
        fhirLibrary,
        isValid: true,
        error: undefined
      };
    } catch (error) {
      next = {
        ...cqlFile,
        isValid: false,
        error: 'Error reading or processing CQL file'
      };
    }
    this.cqlFiles.update((list) => list.map((f) => (f.id === cqlFile.id ? next : f)));
  }

  private readFileAsText(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.onerror = () => reject(reader.error);
      reader.readAsText(file);
    });
  }

  removeFile(id: string): void {
    this.files.set(this.files().filter(file => file.id !== id));
  }

  moveFileUp(id: string): void {
    const currentFiles = [...this.files()];
    const index = currentFiles.findIndex(file => file.id === id);
    if (index > 0) {
      [currentFiles[index - 1], currentFiles[index]] = [currentFiles[index], currentFiles[index - 1]];
      this.files.set(currentFiles);
    }
  }

  moveFileDown(id: string): void {
    const currentFiles = [...this.files()];
    const index = currentFiles.findIndex(file => file.id === id);
    if (index < currentFiles.length - 1) {
      [currentFiles[index], currentFiles[index + 1]] = [currentFiles[index + 1], currentFiles[index]];
      this.files.set(currentFiles);
    }
  }

  onFileDragStart(event: DragEvent, fileId: string): void {
    this.draggedFileId.set(fileId);
    if (event.dataTransfer) {
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData('text/plain', fileId);
    }
  }

  onFileDragOver(event: DragEvent, targetFileId: string): void {
    event.preventDefault();
    if (event.dataTransfer) {
      event.dataTransfer.dropEffect = 'move';
    }
  }

  onFileDrop(event: DragEvent, targetFileId: string): void {
    event.preventDefault();
    const draggedId = this.draggedFileId();
    
    if (draggedId && draggedId !== targetFileId) {
      // Check if it's a JSON file
      const currentFiles = [...this.files()];
      const draggedIndex = currentFiles.findIndex(file => file.id === draggedId);
      const targetIndex = currentFiles.findIndex(file => file.id === targetFileId);
      
      if (draggedIndex !== -1 && targetIndex !== -1) {
        // Remove the dragged file from its current position
        const draggedFile = currentFiles.splice(draggedIndex, 1)[0];
        // Insert it at the target position
        currentFiles.splice(targetIndex, 0, draggedFile);
        this.files.set(currentFiles);
      } else {
        // Check if it's a CQL file
        const currentCqlFiles = [...this.cqlFiles()];
        const draggedCqlIndex = currentCqlFiles.findIndex(file => file.id === draggedId);
        const targetCqlIndex = currentCqlFiles.findIndex(file => file.id === targetFileId);
        
        if (draggedCqlIndex !== -1 && targetCqlIndex !== -1) {
          // Remove the dragged file from its current position
          const draggedFile = currentCqlFiles.splice(draggedCqlIndex, 1)[0];
          // Insert it at the target position
          currentCqlFiles.splice(targetCqlIndex, 0, draggedFile);
          this.cqlFiles.set(currentCqlFiles);
        }
      }
    }
    
    this.draggedFileId.set(null);
  }

  onFileDragEnd(): void {
    this.draggedFileId.set(null);
  }

  toggleFileEnabled(fileId: string): void {
    const currentFiles = [...this.files()];
    const fileIndex = currentFiles.findIndex(file => file.id === fileId);
    if (fileIndex !== -1) {
      currentFiles[fileIndex].enabled = !currentFiles[fileIndex].enabled;
      this.files.set(currentFiles);
    }
  }

  toggleAllFiles(): void {
    const currentFiles = [...this.files()];
    const currentCqlFiles = [...this.cqlFiles()];

    currentFiles.forEach(file => {
      file.enabled = !file.enabled;
    });

    currentCqlFiles.forEach(file => {
      file.enabled = !file.enabled;
    });

    this.files.set(currentFiles);
    this.cqlFiles.set(currentCqlFiles);
  }

  reorderForSynthea(): void {
    const current = [...this.files()];
    const hospital = current.filter(f => f.name.toLowerCase().startsWith('hospital'));
    const practitioner = current.filter(f => f.name.toLowerCase().startsWith('practitioner'));
    const group = current.filter(f => f.name.toLowerCase().startsWith('group'));
    const rest = current.filter(
      f => !f.name.toLowerCase().startsWith('hospital')
        && !f.name.toLowerCase().startsWith('practitioner')
        && !f.name.toLowerCase().startsWith('group')
    );
    this.files.set([...hospital, ...practitioner, ...rest, ...group]);
  }

  async addBundleExamples(): Promise<void> {
    this.isAddingExamples.set(true);
    try {
      const bundleFiles: File[] = [];
      for (const path of FHIR_BUNDLE_EXAMPLE_PATHS) {
        try {
          const text = await firstValueFrom(this.http.get(path, { responseType: 'text' }));
          const name = path.split('/').pop() ?? path;
          bundleFiles.push(new File([text], name, { type: 'application/json' }));
        } catch {
          // Skip missing or failed bundle
        }
      }
      const cqlFiles: File[] = [];
      for (const path of FHIR_CQL_EXAMPLE_PATHS) {
        try {
          const text = await firstValueFrom(this.http.get(path, { responseType: 'text' }));
          const name = path.split('/').pop() ?? path;
          cqlFiles.push(new File([text], name, { type: 'text/plain' }));
        } catch {
          // Skip missing or failed CQL file
        }
      }
      this.addFiles(bundleFiles);
      this.addCqlFiles(cqlFiles);
      if (bundleFiles.length > 0) {
        this.reorderForSynthea();
      }
    } finally {
      this.isAddingExamples.set(false);
    }
  }

  clearAllFiles(): void {
    this.files.set([]);
    this.cqlFiles.set([]);
    this.expandedResult.set(null);
  }

  removeCqlFile(id: string): void {
    this.cqlFiles.set(this.cqlFiles().filter(file => file.id !== id));
  }

  moveCqlFileUp(id: string): void {
    const currentCqlFiles = [...this.cqlFiles()];
    const index = currentCqlFiles.findIndex(file => file.id === id);
    if (index > 0) {
      [currentCqlFiles[index - 1], currentCqlFiles[index]] = [currentCqlFiles[index], currentCqlFiles[index - 1]];
      this.cqlFiles.set(currentCqlFiles);
    }
  }

  moveCqlFileDown(id: string): void {
    const currentCqlFiles = [...this.cqlFiles()];
    const index = currentCqlFiles.findIndex(file => file.id === id);
    if (index < currentCqlFiles.length - 1) {
      [currentCqlFiles[index], currentCqlFiles[index + 1]] = [currentCqlFiles[index + 1], currentCqlFiles[index]];
      this.cqlFiles.set(currentCqlFiles);
    }
  }

  toggleCqlFileEnabled(fileId: string): void {
    const currentCqlFiles = [...this.cqlFiles()];
    const fileIndex = currentCqlFiles.findIndex(file => file.id === fileId);
    if (fileIndex !== -1) {
      currentCqlFiles[fileIndex].enabled = !currentCqlFiles[fileIndex].enabled;
      this.cqlFiles.set(currentCqlFiles);
    }
  }


  async uploadBundles(): Promise<void> {
    const enabledFiles = this.files().filter(file => file.enabled);
    const enabledCqlFiles = this.cqlFiles().filter(file => file.enabled);
    
    if (enabledFiles.length === 0 && enabledCqlFiles.length === 0) {
      alert('Please enable at least one file to upload.');
      return;
    }

    const invalidEnabledFiles = enabledFiles.filter(file => !file.isValid);
    const invalidEnabledCqlFiles = enabledCqlFiles.filter(file => !file.isValid);
    
    if (invalidEnabledFiles.length > 0 || invalidEnabledCqlFiles.length > 0) {
      alert(`Please fix ${invalidEnabledFiles.length + invalidEnabledCqlFiles.length} invalid enabled file(s) before uploading.`);
      return;
    }

    const effectiveFhirBaseUrl = this.settingsService.getEffectiveEvaluationServerUrl();
    if (!effectiveFhirBaseUrl.trim()) {
      alert('Please configure a FHIR Base URL in Application Settings.');
      return;
    }

    this.files.set(this.files().map(f => ({ ...f, uploadResult: undefined })));
    this.cqlFiles.set(this.cqlFiles().map(f => ({ ...f, uploadResult: undefined })));
    this.expandedResult.set(null);
    this.workspaceLinkStatus.set(null);

    this.isUploading.set(true);
    this.uploadProgress.set(0);

    const totalFiles = enabledFiles.length + enabledCqlFiles.length;
    let processedFiles = 0;
    const linkInputs: WorkspaceResourceLinkInput[] = [];

    try {
      // Upload JSON bundles first
      for (let i = 0; i < enabledFiles.length; i++) {
        const bundleFile = enabledFiles[i];
        this.uploadProgress.set((processedFiles / totalFiles) * 100);

        try {
          const { result, resources } = await this.uploadSingleBundle(bundleFile);
          linkInputs.push(...resources);
          // Update the file with success result
          this.updateFileResult(bundleFile.id, {
            success: true,
            result
          });
        } catch (error) {
          // Update the file with error result
          this.updateFileResult(bundleFile.id, {
            success: false,
            error: error instanceof Error ? error.message : 'Unknown error'
          });

          if (!this.continueOnError()) {
            break;
          }
        }
        processedFiles++;
      }

      // Upload CQL files as FHIR Library resources
      for (let i = 0; i < enabledCqlFiles.length; i++) {
        const cqlFile = enabledCqlFiles[i];
        this.uploadProgress.set((processedFiles / totalFiles) * 100);

        try {
          const result = await this.uploadSingleCqlFile(cqlFile);
          const libraryInput = workspaceLinkInputFromFhirResource(
            (cqlFile.fhirLibrary ?? result) as Resource
          );
          if (libraryInput) {
            linkInputs.push(libraryInput);
          }
          // Update the file with success result
          this.updateCqlFileResult(cqlFile.id, {
            success: true,
            result
          });
        } catch (error) {
          // Update the file with error result
          this.updateCqlFileResult(cqlFile.id, {
            success: false,
            error: error instanceof Error ? error.message : 'Unknown error'
          });

          if (!this.continueOnError()) {
            break;
          }
        }
        processedFiles++;
      }

      this.uploadProgress.set(100);
      await this.linkUploadedResourcesToWorkspaces(linkInputs);
    } finally {
      this.isUploading.set(false);
    }
  }

  private async linkUploadedResourcesToWorkspaces(
    resources: WorkspaceResourceLinkInput[]
  ): Promise<void> {
    const workspaceIds = this.selectedWorkspaceIds();
    if (!this.auth.isAuthenticated() || workspaceIds.length === 0 || resources.length === 0) {
      return;
    }
    const byKey = new Map<string, WorkspaceResourceLinkInput>();
    for (const r of resources) {
      const key = `${r.resourceType}|${r.resourceId}`;
      if (!byKey.has(key)) {
        byKey.set(key, r);
      }
    }
    const summary = await this.workspaceResourceLink.linkResourcesToWorkspaces(
      workspaceIds,
      [...byKey.values()],
      (msg) => this.workspaceLinkStatus.set(msg)
    );
    if (summary.message) {
      this.workspaceLinkStatus.set(summary.message);
    }
  }

  private async prepareBundleUploadBody(bundleFile: BundleFile): Promise<{
    body: string;
    resources: WorkspaceResourceLinkInput[];
  }> {
    const text = await this.readFileAsText(bundleFile.file);
    let bundle = JSON.parse(text) as Bundle;
    const igStates = bundleFile.igStates;
    if (igStates?.some((s) => s.sanitize)) {
      for (const state of igStates) {
        if (!state.sanitize) {
          continue;
        }
        const entry = bundle.entry?.[state.entryIndex];
        if (entry?.resource?.resourceType === 'ImplementationGuide') {
          entry.resource = filterImplementationGuide(
            entry.resource as ImplementationGuide,
            state.selectedEntryKeys,
            state.selectedGlobalIndices
          );
        }
      }
    }
    const resources = (bundle.entry ?? [])
      .map((e) => e.resource)
      .filter((r): r is Resource => !!r)
      .map((r) => workspaceLinkInputFromFhirResource(r))
      .filter((r): r is WorkspaceResourceLinkInput => r != null);
    return { body: JSON.stringify(bundle), resources };
  }

  private async uploadSingleBundle(bundleFile: BundleFile): Promise<{
    result: unknown;
    resources: WorkspaceResourceLinkInput[];
  }> {
    const { body, resources } = await this.prepareBundleUploadBody(bundleFile);

    const effectiveFhirBaseUrl = this.settingsService.getEffectiveEvaluationServerUrl();
    const response = await fetch(effectiveFhirBaseUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/fhir+json',
        'Accept': 'application/fhir+json'
      },
      body
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const result = await response.json();
    return { result, resources };
  }

  private async uploadSingleCqlFile(cqlFile: CqlFile): Promise<any> {
    if (!cqlFile.fhirLibrary) {
      throw new Error('CQL file has not been processed into a FHIR Library resource');
    }

    const effectiveFhirBaseUrl = this.settingsService.getEffectiveEvaluationServerUrl();
    const libraryId = cqlFile.fhirLibrary.id;
    const response = await fetch(`${effectiveFhirBaseUrl}/Library/${libraryId}`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/fhir+json',
        'Accept': 'application/fhir+json'
      },
      body: JSON.stringify(cqlFile.fhirLibrary)
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    return await response.json();
  }

  formatFileSize(bytes: number): string {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  }

  getEnabledFilesCount(): number {
    return this.files().filter(file => file.enabled).length + this.cqlFiles().filter(file => file.enabled).length;
  }

  hasEnabledFiles(): boolean {
    return this.getEnabledFilesCount() > 0;
  }

  updateFileResult(fileId: string, result: { success: boolean; error?: string; result?: any }): void {
    const currentFiles = this.files().map(file => 
      file.id === fileId 
        ? { ...file, uploadResult: result }
        : file
    );
    this.files.set(currentFiles);
  }

  updateCqlFileResult(fileId: string, result: { success: boolean; error?: string; result?: any }): void {
    const currentCqlFiles = this.cqlFiles().map(file => 
      file.id === fileId 
        ? { ...file, uploadResult: result }
        : file
    );
    this.cqlFiles.set(currentCqlFiles);
  }

  toggleResultExpansion(fileId: string): void {
    if (this.expandedResult() === fileId) {
      this.expandedResult.set(null);
    } else {
      this.expandedResult.set(fileId);
    }
  }

  isResultExpanded(fileId: string): boolean {
    return this.expandedResult() === fileId;
  }

  formatJsonResponse(response: any): string {
    return JSON.stringify(response, null, 2);
  }

  showModal(title: string, message: string, type: 'success' | 'error' | 'warning' = 'success'): void {
    this.modalTitle.set(title);
    this.modalMessage.set(message);
    this.modalType.set(type);
    this.showUploadModal.set(true);
    this.scheduleModalFocus(() => this.resultModalButton());
  }

  closeModal(): void {
    this.showUploadModal.set(false);
    this.showExpungeModal.set(false);
    this.showPurgeModal.set(false);
  }

  showExpungeConfirmation(): void {
    this.showExpungeModal.set(true);
    this.scheduleModalFocus(() => this.expungeConfirmButton());
  }

  showPurgeConfirmation(): void {
    this.showPurgeModal.set(true);
    this.scheduleModalFocus(() => this.purgeConfirmButton());
  }

  confirmExpunge(): void {
    this.showExpungeModal.set(false);
    this.expungeServer();
  }

  confirmPurge(): void {
    this.showPurgeModal.set(false);
    this.purgeAllServer();
  }

  async expungeServer(): Promise<void> {
    this.isExpunging.set(true);
    try {
      // HAPI FHIR expunge operation
      const effectiveFhirBaseUrl = this.settingsService.getEffectiveEvaluationServerUrl();
      const response = await fetch(`${effectiveFhirBaseUrl}/$expunge`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/fhir+json',
          'Accept': 'application/fhir+json'
        },
        body: JSON.stringify({
          resourceType: 'Parameters',
          parameter: [
            {
              name: 'expungeEverything',
              valueBoolean: true
            }
          ]
        })
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      await response.json();
      this.showModal('Success', 'Server expunged successfully!', 'success');
    } catch (error) {
      this.showModal('Error', `Failed to expunge server: ${error instanceof Error ? error.message : 'Unknown error'}`, 'error');
      console.error('Expunge error:', error);
    } finally {
      this.isExpunging.set(false);
    }
  }

  async purgeAllServer(): Promise<void> {
    this.isPurging.set(true);
    try {
      // WildFHIR purge operation
      const effectiveFhirBaseUrl = this.settingsService.getEffectiveEvaluationServerUrl();
      const response = await fetch(`${effectiveFhirBaseUrl}/$purge`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/fhir+json',
          'Accept': 'application/fhir+json'
        },
        body: JSON.stringify({
          resourceType: 'Parameters',
          parameter: [
            {
              name: 'purgeAll',
              valueBoolean: true
            }
          ]
        })
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      await response.json();
      this.showModal('Success', 'Server purged successfully!', 'success');
    } catch (error) {
      this.showModal('Error', `Failed to purge server: ${error instanceof Error ? error.message : 'Unknown error'}`, 'error');
      console.error('Purge error:', error);
    } finally {
      this.isPurging.set(false);
    }
  }
}

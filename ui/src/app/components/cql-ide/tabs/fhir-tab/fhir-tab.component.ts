// Author: Preston Lee

import {Component, ChangeDetectionStrategy, output, computed, inject} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { Library, Patient, Group } from 'fhir/r4';
import { LibraryService } from '../../../../services/library.service';
import { PatientService } from '../../../../services/patient.service';
import { GroupService } from '../../../../services/group.service';
import { IdeContextService } from '../../../../services/ide-context.service';
import { IdeStateService } from '../../../../services/ide-state.service';
import { SettingsService } from '../../../../services/settings.service';
import { SyntaxHighlighterComponent } from '../../../shared/syntax-highlighter/syntax-highlighter.component';
import { encodeUtf8Base64 } from '../../../../services/utf8-encoding.lib';

@Component({
  selector: 'app-fhir-tab',
  imports: [FormsModule, SyntaxHighlighterComponent],
  templateUrl: './fhir-tab.component.html',

  styleUrls: ['./fhir-tab.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class FhirTabComponent {
  saveLibrary = output<void>();
  deleteLibrary = output<void>();

  readonly libraryService = inject(LibraryService);
  readonly patientService = inject(PatientService);
  readonly groupService = inject(GroupService);
  readonly ideContextService = inject(IdeContextService);
  readonly ideStateService = inject(IdeStateService);
  readonly settingsService = inject(SettingsService);
  readonly router = inject(Router);

  public activeLibrary = computed(() => this.ideStateService.getActiveLibraryResource());
  public hasSelectedLibrary = computed(() => !!this.activeLibrary());
  public hasSelectedPatients = computed(() => {
    this.ideContextService.selectionVersion();
    return this.patientService.selectedPatients.length > 0;
  });
  public selectedPatients = computed(() => {
    this.ideContextService.selectionVersion();
    return this.patientService.selectedPatients;
  });
  public hasSelectedGroups = computed(() => {
    this.ideContextService.selectionVersion();
    return this.groupService.selectedGroups.length > 0;
  });
  public selectedGroups = computed(() => {
    this.ideContextService.selectionVersion();
    return this.groupService.selectedGroups;
  });
  public contextType = this.ideContextService.contextType;
  public hasSelectedContext = computed(() => this.ideContextService.hasSelection());
  public fhirServerUrl = computed(() => this.settingsService.getEffectiveEvaluationServerUrl());

  onLibraryIdChange(value: string): void {
    const activeLibrary = this.activeLibrary();
    if (!activeLibrary) return;

    const trimmedValue = value.trim();
    const oldId = activeLibrary.id;

    if (trimmedValue === oldId) return;

    if (!trimmedValue) {
      this.ideStateService.updateLibraryResource(oldId, { id: '' });
      this.ideStateService.selectLibraryResource('');
      return;
    }

    this.ideStateService.updateLibraryResource(oldId, { id: trimmedValue });
    this.ideStateService.selectLibraryResource(trimmedValue);
    this.saveLibrary.emit();
  }

  onGenerateDefaultId(): void {
    const activeLibrary = this.activeLibrary();
    if (!activeLibrary) return;

    const base = (activeLibrary.name || 'NewLibrary').trim() || 'NewLibrary';
    const newId = base.replace(/[^-a-zA-Z0-9_]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '') || 'NewLibrary';
    const oldId = activeLibrary.id;

    this.ideStateService.updateLibraryResource(oldId, { id: newId });
    this.ideStateService.selectLibraryResource(newId);
    this.saveLibrary.emit();
  }

  onLibraryVersionChange(value: string): void {
    const activeLibrary = this.activeLibrary();
    if (activeLibrary) {
      this.ideStateService.updateLibraryResource(activeLibrary.id, { version: value });
      // Trigger a save operation to persist the changes to the server
      this.saveLibrary.emit();
    }
  }

  onLibraryDescriptionChange(value: string): void {
    const activeLibrary = this.activeLibrary();
    if (activeLibrary) {
      this.ideStateService.updateLibraryResource(activeLibrary.id, { description: value });
      // Trigger a save operation to persist the changes to the server
      this.saveLibrary.emit();
    }
  }

  onLibraryNameInput(event: Event): void {
    const input = event.target as HTMLInputElement;
    const value = input.value;
    
    // Remove invalid characters (only allow letters, numbers, hyphens, and underscores)
    const validValue = value.replace(/[^-a-zA-Z0-9_]/g, '');
    
    // Update the input value if it was changed
    if (validValue !== value) {
      input.value = validValue;
      // Trigger the ngModelChange to update the component state
      this.onLibraryNameChange(validValue);
    }
    
    // Add visual feedback
    this.updateInputValidation(input, validValue);
  }

  private updateInputValidation(input: HTMLInputElement, value: string): void {
    // Remove existing validation classes
    input.classList.remove('is-valid', 'is-invalid');
    
    // Add validation class based on value
    if (value.length > 0) {
      // Check if the value matches the valid pattern
      const isValid = /^[-a-zA-Z0-9_]+$/.test(value);
      input.classList.add(isValid ? 'is-valid' : 'is-invalid');
    }
  }

  onLibraryNameChange(value: string): void {
    const activeLibrary = this.activeLibrary();
    if (activeLibrary) {
      // Update only the name, not the ID
      this.ideStateService.updateLibraryResource(activeLibrary.id, { name: value });
      // Trigger a save operation to persist the changes to the server
      this.saveLibrary.emit();
    }
  }

  onLibraryTitleChange(value: string): void {
    const activeLibrary = this.activeLibrary();
    if (activeLibrary) {
      this.ideStateService.updateLibraryResource(activeLibrary.id, { title: value });
      // Trigger a save operation to persist the changes to the server
      this.saveLibrary.emit();
    }
  }

  onLibraryUrlChange(value: string): void {
    const activeLibrary = this.activeLibrary();
    if (activeLibrary) {
      const trimmed = value.trim();
      this.ideStateService.updateLibraryResource(activeLibrary.id, { url: trimmed || undefined });
      this.saveLibrary.emit();
    }
  }

  onGenerateDefaultUrl(): void {
    const activeLibrary = this.activeLibrary();
    if (activeLibrary?.id) {
      const defaultUrl = this.libraryService.urlFor(activeLibrary.id);
      this.ideStateService.updateLibraryResource(activeLibrary.id, { url: defaultUrl });
      this.saveLibrary.emit();
    }
  }

  onSaveLibrary(): void {
    this.saveLibrary.emit();
  }

  onDeleteLibrary(): void {
    this.deleteLibrary.emit();
  }

  onNavigateToSettings(): void {
    this.router.navigate(['/settings/environments']);
  }

  libraryAsString(): string {
    const activeLibrary = this.activeLibrary();
    if (!activeLibrary) return '';

    const libraryCopy = { ...activeLibrary.library } as Record<string, unknown>;
    if (!libraryCopy) return '';

    if ((activeLibrary.id ?? '').trim()) {
      libraryCopy['id'] = activeLibrary.id!.trim();
    } else {
      delete libraryCopy['id'];
    }
    const nameVal = (activeLibrary.name ?? activeLibrary.id ?? '').trim();
    if (nameVal) {
      libraryCopy['name'] = nameVal;
    } else {
      delete libraryCopy['name'];
    }
    const titleVal = (activeLibrary.title ?? activeLibrary.name ?? activeLibrary.id ?? '').trim();
    if (titleVal) {
      libraryCopy['title'] = titleVal;
    } else {
      delete libraryCopy['title'];
    }
    if ((activeLibrary.description ?? '').trim()) {
      libraryCopy['description'] = activeLibrary.description!.trim();
    } else {
      delete libraryCopy['description'];
    }
    if ((activeLibrary.url ?? '').trim()) {
      libraryCopy['url'] = activeLibrary.url!.trim();
    } else {
      delete libraryCopy['url'];
    }
    if ((activeLibrary.version ?? '').trim()) {
      libraryCopy['version'] = activeLibrary.version!.trim();
    } else {
      delete libraryCopy['version'];
    }

    if (activeLibrary.cqlContent && activeLibrary.cqlContent.trim()) {
      libraryCopy['content'] = [{
        contentType: 'text/cql',
        data: encodeUtf8Base64(activeLibrary.cqlContent)
      }];
    } else {
      libraryCopy['content'] = [];
    }

    return JSON.stringify(libraryCopy, null, 2);
  }

  patientAsString(patient?: Patient): string {
    const targetPatient = patient || this.patientService.selectedPatient;
    if (targetPatient) {
      return JSON.stringify(targetPatient, null, 2);
    }
    return '';
  }

  getPatientDisplayName(patient: Patient): string {
    return this.patientService.getDisplayName(patient);
  }

  groupAsString(group?: Group): string {
    const targetGroup = group || this.groupService.selectedGroup;
    if (targetGroup) {
      return JSON.stringify(targetGroup, null, 2);
    }
    return '';
  }

  getGroupDisplayName(group: Group): string {
    return this.groupService.getDisplayName(group);
  }

  trackByPatientId(index: number, patient: Patient): string {
    return patient.id || index.toString();
  }

  trackByGroupId(index: number, group: Group): string {
    return group.id || index.toString();
  }

  onCopyResourceToClipboard(): void {
    const resources: string[] = [];
    
    // Add library resource if available
    if (this.hasSelectedLibrary()) {
      const libraryJson = this.libraryAsString();
      if (libraryJson) {
        resources.push(`// Library Resource\n${libraryJson}`);
      }
    }
    
    // Add patient resources if available
    if (this.hasSelectedPatients()) {
      this.selectedPatients().forEach(patient => {
        const patientJson = this.patientAsString(patient);
        if (patientJson) {
          resources.push(`// Patient Resource: ${this.getPatientDisplayName(patient)}\n${patientJson}`);
        }
      });
    }

    // Add group resources if available
    if (this.hasSelectedGroups()) {
      this.selectedGroups().forEach(group => {
        const groupJson = this.groupAsString(group);
        if (groupJson) {
          resources.push(`// Group Resource: ${this.getGroupDisplayName(group)}\n${groupJson}`);
        }
      });
    }
    
    if (resources.length === 0) {
      this.ideStateService.addTextOutput(
        'Copy Failed', 
        'No FHIR resources available to copy', 
        'error'
      );
      return;
    }
    
    const combinedJson = resources.join('\n\n');
    
    // Copy to clipboard
    navigator.clipboard.writeText(combinedJson).then(() => {
      this.ideStateService.addTextOutput(
        'Resource Copied', 
        `Successfully copied ${resources.length} FHIR resource(s) to clipboard`, 
        'success'
      );
    }).catch((error) => {
      this.ideStateService.addTextOutput(
        'Copy Failed', 
        `Failed to copy to clipboard: ${error.message}`, 
        'error'
      );
    });
  }
}

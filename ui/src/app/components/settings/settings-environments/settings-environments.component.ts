// Author: Preston Lee

import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { EnvironmentService } from '../../../services/environment.service';
import { EnvironmentSwitchService } from '../../../services/environment-switch.service';
import { SettingsService } from '../../../services/settings.service';
import { CqlEnvironment, EndpointConfiguration } from '../../../models/environment.model';
import { cloneEndpointConfiguration } from '../../../services/endpoint-config.lib';
import { SettingsEndpointEditorComponent } from '../settings-endpoint-editor/settings-endpoint-editor.component';
import { ToastService } from '../../../services/toast.service';

@Component({
  selector: 'app-settings-environments',
  imports: [FormsModule, SettingsEndpointEditorComponent],
  templateUrl: './settings-environments.component.html'
})
export class SettingsEnvironmentsComponent {
  private readonly environmentSwitchService = inject(EnvironmentSwitchService);
  private readonly toastService = inject(ToastService);
  protected readonly settingsService = inject(SettingsService);
  protected readonly environmentService = inject(EnvironmentService);

  readonly environments = this.environmentService.environments;
  readonly activeEnvironmentId = this.environmentService.activeEnvironmentId;

  readonly selectedEnvironmentId = signal<string | null>(null);
  private readonly drafts = signal<Record<string, CqlEnvironment>>({});
  readonly busy = signal(false);
  readonly saveError = signal<string | null>(null);
  readonly endpointSections = [
    { field: 'evaluationServer', id: 'settings-evaluation-server', sectionId: 'settings-environment-evaluation-section', title: 'Evaluation server', description: 'FHIR libraries, CQL evaluation, and measure operations.' },
    { field: 'dataEndpoint', id: 'settings-data-endpoint', sectionId: 'settings-environment-data-section', title: 'Data endpoint', description: 'Patient data, searches, and AI FHIR tools.' },
    { field: 'terminologyEndpoint', id: 'settings-terminology-endpoint', sectionId: 'settings-environment-terminology-section', title: 'Terminology endpoint', description: 'ValueSet expansion, CodeSystem lookup, and terminology browsing.' },
    { field: 'contentEndpoint', id: 'settings-content-endpoint', sectionId: 'settings-environment-content-section', title: 'Content endpoint', description: 'Library dependencies and shared quality artifacts.' },
  ] as const;

  readonly defaultEvaluationServerUrl = computed(
    () => this.environments().find((env) => env.builtIn)?.evaluationServer.address ?? ''
  );

  readonly selectedEnvironment = computed(() => {
    const id = this.selectedEnvironmentId() ?? this.activeEnvironmentId();
    return this.environments().find(env => env.id === id) ?? this.environments()[0] ?? null;
  });

  readonly editingEnvironment = computed(() => {
    const env = this.selectedEnvironment();
    return env ? this.drafts()[env.id] ?? this.cloneEnvironment(env) : null;
  });

  readonly hasUnsavedChanges = computed(() => {
    const env = this.selectedEnvironment();
    return !!env && JSON.stringify(this.editingEnvironment()) !== JSON.stringify(this.cloneEnvironment(env));
  });

  readonly canDeleteSelected = computed(() => {
    const env = this.selectedEnvironment();
    return !!env && !env.builtIn;
  });

  readonly isActiveSelected = computed(() => {
    const env = this.selectedEnvironment();
    return !!env && this.environmentService.isPersonalEnvironmentSelected(env.id);
  });

  selectEnvironment(id: string): void {
    this.selectedEnvironmentId.set(id);
    this.saveError.set(null);
  }

  updateSelectedName(name: string): void {
    this.updateDraft({ name });
  }

  updateEndpoint(
    field: 'evaluationServer' | 'dataEndpoint' | 'terminologyEndpoint' | 'contentEndpoint',
    endpoint: EndpointConfiguration
  ): void {
    this.updateDraft({ [field]: cloneEndpointConfiguration(endpoint) });
  }

  private updateDraft(patch: Partial<CqlEnvironment>): void {
    const env = this.editingEnvironment();
    if (!env || env.builtIn || this.busy()) return;
    this.drafts.update(drafts => ({ ...drafts, [env.id]: { ...env, ...patch } }));
    this.saveError.set(null);
  }

  discardChanges(): void {
    const env = this.selectedEnvironment();
    if (env) this.clearDraft(env.id);
    this.saveError.set(null);
  }

  setAsActive(): void {
    const env = this.selectedEnvironment();
    if (!env || this.hasUnsavedChanges() || this.busy()) {
      return;
    }
    this.environmentSwitchService.activateEnvironment(env.id);
  }

  async duplicateSelected(): Promise<void> {
    const env = this.selectedEnvironment();
    if (!env || this.busy()) {
      return;
    }
    const copy = this.environmentService.duplicateEnvironment(env.id);
    if (!copy) {
      return;
    }
    this.busy.set(true);
    this.saveError.set(null);
    try {
      const saved = await this.settingsService.persistEnvironment(copy);
      this.selectedEnvironmentId.set(saved.id);
    } catch (err) {
      this.environmentService.deleteEnvironment(copy.id);
      this.toastService.showError(
        err instanceof Error ? err.message : 'Failed to save environment',
        'Environment'
      );
    } finally {
      this.busy.set(false);
    }
  }

  async deleteSelected(): Promise<void> {
    const env = this.selectedEnvironment();
    if (!env || env.builtIn || this.busy()) {
      return;
    }
    if (!this.environmentService.deleteEnvironment(env.id)) {
      return;
    }
    this.busy.set(true);
    try {
      await this.settingsService.deletePersonalEnvironment(env.id);
      this.clearDraft(env.id);
      this.selectedEnvironmentId.set(this.activeEnvironmentId());
    } catch (err) {
      this.toastService.showError(
        err instanceof Error ? err.message : 'Failed to delete environment',
        'Environment'
      );
      await this.settingsService.reloadFromServer();
    } finally {
      this.busy.set(false);
    }
  }

  resetBuiltIn(): void {
    this.environmentService.resetBuiltInEnvironment();
    this.selectedEnvironmentId.set(this.activeEnvironmentId());
  }

  async saveEnvironment(): Promise<void> {
    const updated = this.editingEnvironment();
    if (!updated || updated.builtIn || this.busy() || !this.hasUnsavedChanges()) {
      return;
    }
    if (!updated.name.trim()) {
      this.saveError.set('Enter an environment name.');
      return;
    }
    this.busy.set(true);
    this.saveError.set(null);
    try {
      const saved = await this.settingsService.persistEnvironment({ ...updated, name: updated.name.trim() });
      this.clearDraft(updated.id);
      this.selectedEnvironmentId.set(saved.id);
      this.toastService.showSuccess('Environment saved.', 'Environment');
    } catch (err) {
      this.saveError.set(err instanceof Error ? err.message : 'Failed to save environment');
    } finally {
      this.busy.set(false);
    }
  }

  private clearDraft(id: string): void {
    this.drafts.update(drafts => {
      const remaining = { ...drafts };
      delete remaining[id];
      return remaining;
    });
  }

  private cloneEnvironment(env: CqlEnvironment): CqlEnvironment {
    return {
      id: env.id,
      name: env.name,
      builtIn: env.builtIn,
      evaluationServer: cloneEndpointConfiguration(env.evaluationServer),
      dataEndpoint: cloneEndpointConfiguration(env.dataEndpoint),
      terminologyEndpoint: cloneEndpointConfiguration(env.terminologyEndpoint),
      contentEndpoint: cloneEndpointConfiguration(env.contentEndpoint)
    };
  }
}

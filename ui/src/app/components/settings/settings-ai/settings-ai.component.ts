// Author: Preston Lee

import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { AiProviderType } from '../../../models/settings.model';
import { AiCredentialsService } from '../../../services/ai-credentials.service';
import { OpenCodeService } from '../../../services/opencode.service';
import { SettingsService } from '../../../services/settings.service';
import { ToastService } from '../../../services/toast.service';

@Component({
  selector: 'app-settings-ai',
  imports: [FormsModule],
  templateUrl: './settings-ai.component.html'
})
export class SettingsAiComponent {
  protected readonly settingsService = inject(SettingsService);
  protected readonly aiCredentials = inject(AiCredentialsService);
  private readonly openCodeService = inject(OpenCodeService);
  private readonly toastService = inject(ToastService);

  readonly providerModels = signal<string[]>([]);
  readonly modelsLoading = signal(false);
  readonly modelsError = signal<string | null>(null);
  readonly deletingSessions = signal(false);

  onAiProviderChange(value: AiProviderType): void {
    this.settingsService.patchSettings({ aiProvider: value });
    this.providerModels.set([]);
    this.modelsError.set(null);
  }

  async refreshProviderModels(): Promise<void> {
    const type = this.settingsService.getEffectiveAiProvider();
    this.modelsLoading.set(true);
    this.modelsError.set(null);
    try {
      const models = await this.openCodeService.listProviderModels({
        type,
        ...(type === 'ollama' ? {
          baseUrl: this.settingsService.getEffectiveOllamaBaseUrl(),
          apiKey: this.settingsService.getEffectiveOllamaApiKey() || undefined,
        } : type === 'openai-compatible' ? {
          baseUrl: this.settingsService.getEffectiveCompatibleProviderBaseUrl(),
          apiKey: this.settingsService.getEffectiveCompatibleProviderApiKey() || undefined,
        } : {
          apiKey: this.settingsService.getEffectiveOpenAiApiKey() || undefined,
        }),
      });
      this.providerModels.set(models);
      const current = this.settingsService.settings();
      const currentModel = type === 'ollama' ? current.ollamaModel
        : type === 'openai' ? current.openaiModel : current.compatibleProviderModel;
      if (!currentModel.trim() && models.length > 0) {
        this.settingsService.patchSettings(type === 'ollama'
          ? { ollamaModel: models[0] }
          : type === 'openai' ? { openaiModel: models[0] } : { compatibleProviderModel: models[0] });
      }
    } catch (error) {
      this.modelsError.set(error instanceof Error ? error.message : 'Unable to load provider models.');
    } finally {
      this.modelsLoading.set(false);
    }
  }

  async deleteAllOpenCodeSessions(): Promise<void> {
    if (this.deletingSessions()) {
      return;
    }
    const confirmed = confirm(
      'Permanently delete all OpenCode AI sessions and conversation history for your account? This cannot be undone.'
    );
    if (!confirmed) {
      return;
    }
    this.deletingSessions.set(true);
    try {
      const { deleted } = await this.openCodeService.deleteAllSessions();
      this.toastService.showSuccess(
        deleted === 0
          ? 'No OpenCode sessions were stored for your account.'
          : `Deleted ${deleted} OpenCode session${deleted === 1 ? '' : 's'} from your account.`,
        deleted === 0 ? 'AI data' : 'AI data deleted'
      );
    } catch (error) {
      this.toastService.showError(
        error instanceof Error ? error.message : 'Unable to delete OpenCode sessions.',
        'AI data'
      );
    } finally {
      this.deletingSessions.set(false);
    }
  }
}

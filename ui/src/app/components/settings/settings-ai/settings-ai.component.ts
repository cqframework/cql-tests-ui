// Author: Preston Lee

import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { AiProviderType } from '../../../models/settings.model';
import { AiCredentialsService } from '../../../services/ai-credentials.service';
import { OpenCodeService } from '../../../services/opencode.service';
import { SettingsService } from '../../../services/settings.service';

@Component({
  selector: 'app-settings-ai',
  imports: [FormsModule],
  templateUrl: './settings-ai.component.html'
})
export class SettingsAiComponent {
  protected readonly settingsService = inject(SettingsService);
  protected readonly aiCredentials = inject(AiCredentialsService);
  private readonly openCodeService = inject(OpenCodeService);

  readonly providerModels = signal<string[]>([]);
  readonly modelsLoading = signal(false);
  readonly modelsError = signal<string | null>(null);

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
}

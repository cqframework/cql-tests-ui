// Author: Preston Lee

import { Component, ElementRef, inject, viewChild } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ThemeType } from '../../../models/settings.model';
import { ClipboardService } from '../../../services/clipboard.service';
import { SettingsService } from '../../../services/settings.service';
import { ToastService } from '../../../services/toast.service';
import { SettingsActionsComponent } from '../settings-actions/settings-actions.component';

@Component({
  selector: 'app-settings-advanced',
  imports: [FormsModule, SettingsActionsComponent],
  templateUrl: './settings-advanced.component.html'
})
export class SettingsAdvancedComponent {
  private readonly importFileInput = viewChild.required<ElementRef<HTMLInputElement>>('importFileInput');

  protected readonly settingsService = inject(SettingsService);
  private readonly clipboardService = inject(ClipboardService);
  private readonly toastService = inject(ToastService);

  themeTypes() {
    return ThemeType;
  }

  onThemePreferredChange(value: ThemeType): void {
    this.settingsService.updateSettings({ theme_preferred: value });
    this.settingsService.setEffectiveTheme();
  }

  onValidateSchemaChange(value: boolean): void {
    this.settingsService.updateSettings({ validateSchema: value });
  }

  onResetClipboard(): void {
    this.clipboardService.resetClipboard();
    this.toastService.showSuccess('Clipboard has been cleared.', 'Clipboard Reset');
  }

  onExportSettings(): void {
    const json = this.settingsService.exportSettingsJson();
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = SettingsService.EXPORT_FILENAME;
    a.click();
    URL.revokeObjectURL(url);
    this.toastService.showSuccess('Settings exported to ' + SettingsService.EXPORT_FILENAME, 'Settings Exported');
  }

  onImportSettings(): void {
    this.importFileInput().nativeElement.click();
  }

  onImportFile(event: Event): void {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file) {
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      void (async () => {
        const text = reader.result as string;
        if (await this.settingsService.importSettingsJson(text)) {
          this.toastService.showSuccess('Settings loaded from file.', 'Settings Imported');
        } else {
          this.toastService.showError('File is not valid settings JSON.', 'Import Failed');
        }
      })();
    };
    reader.readAsText(file);
  }
}

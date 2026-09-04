// Author: Preston Lee

import { Component, OnInit, inject } from '@angular/core';
import { ActivatedRoute, Router, RouterOutlet } from '@angular/router';
import { SettingsService } from '../../services/settings.service';
import { ToastService } from '../../services/toast.service';
import { SettingsActionsComponent } from './settings-actions/settings-actions.component';
import { SettingsSectionNavComponent, SettingsSectionId } from './settings-section-nav/settings-section-nav.component';

@Component({
  selector: 'app-settings',
  imports: [RouterOutlet, SettingsActionsComponent, SettingsSectionNavComponent],
  templateUrl: './settings.component.html',
  styleUrl: './settings.component.scss'
})
export class SettingsComponent implements OnInit {
  private readonly settingsService = inject(SettingsService);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  private readonly toastService = inject(ToastService);

  ngOnInit() {
    this.settingsService.setEffectiveTheme();
    const section = this.route.snapshot.queryParamMap.get('section');
    if (this.isValidSection(section)) {
      void this.router.navigate(['/settings', section], {
        replaceUrl: true,
        queryParams: {}
      });
    }
  }

  isEnvironmentsSection(): boolean {
    return this.router.url.split(/[?#]/, 1)[0] === '/settings/environments';
  }

  async save(): Promise<void> {
    try {
      await this.settingsService.saveSettings();
      this.toastService.showSuccess(
        'Your settings were saved to CQL Studio Server. Provider API keys remain in memory only.',
        'Settings Saved'
      );
    } catch (err) {
      this.toastService.showError(
        err instanceof Error ? err.message : 'Failed to save settings',
        'Save Failed'
      );
    }
  }

  private isValidSection(section: string | null): section is SettingsSectionId {
    return section === 'environments'
      || section === 'advanced'
      || section === 'runner'
      || section === 'registry'
      || section === 'vsac'
      || section === 'ai'
      || section === 'server';
  }
}

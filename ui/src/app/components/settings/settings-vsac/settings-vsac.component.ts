// Author: Preston Lee

import { Component, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { SettingsService } from '../../../services/settings.service';

@Component({
  selector: 'app-settings-vsac',
  imports: [FormsModule],
  templateUrl: './settings-vsac.component.html'
})
export class SettingsVsacComponent {
  protected readonly settingsService = inject(SettingsService);
}

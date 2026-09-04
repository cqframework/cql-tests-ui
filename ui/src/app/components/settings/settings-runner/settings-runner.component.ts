// Author: Preston Lee

import { Component, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { SettingsService } from '../../../services/settings.service';

@Component({
  selector: 'app-settings-runner',
  imports: [FormsModule],
  templateUrl: './settings-runner.component.html'
})
export class SettingsRunnerComponent {
  protected readonly settingsService = inject(SettingsService);
}

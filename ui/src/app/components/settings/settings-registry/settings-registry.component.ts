// Author: Preston Lee

import { Component, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { SettingsService } from '../../../services/settings.service';

@Component({
  selector: 'app-settings-registry',
  imports: [FormsModule],
  templateUrl: './settings-registry.component.html'
})
export class SettingsRegistryComponent {
  protected readonly settingsService = inject(SettingsService);
}

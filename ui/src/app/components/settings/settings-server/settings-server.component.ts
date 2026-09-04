// Author: Preston Lee

import { Component, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { SettingsService } from '../../../services/settings.service';

@Component({
  selector: 'app-settings-server',
  imports: [FormsModule],
  templateUrl: './settings-server.component.html'
})
export class SettingsServerComponent {
  protected readonly settingsService = inject(SettingsService);
}

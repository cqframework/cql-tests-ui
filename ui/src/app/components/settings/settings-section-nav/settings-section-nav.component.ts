// Author: Preston Lee

import { Component } from '@angular/core';
import { RouterLink, RouterLinkActive } from '@angular/router';

export type SettingsSectionId =
  | 'environments'
  | 'advanced'
  | 'runner'
  | 'registry'
  | 'vsac'
  | 'ai'
  | 'server';

export interface SettingsSection {
  id: SettingsSectionId;
  label: string;
  icon: string;
}

@Component({
  selector: 'app-settings-section-nav',
  imports: [RouterLink, RouterLinkActive],
  templateUrl: './settings-section-nav.component.html'
})
export class SettingsSectionNavComponent {
  readonly sections: SettingsSection[] = [
    { id: 'environments', label: 'Environments', icon: 'bi-globe2' },
    { id: 'advanced', label: 'Advanced', icon: 'bi-sliders' },
    { id: 'runner', label: 'Runner', icon: 'bi-play-circle' },
    { id: 'registry', label: 'Registry', icon: 'bi-box-seam' },
    { id: 'vsac', label: 'VSAC', icon: 'bi-cloud-download' },
    { id: 'ai', label: 'AI', icon: 'bi-robot' },
    { id: 'server', label: 'CQL Studio Server', icon: 'bi-server' }
  ];
}

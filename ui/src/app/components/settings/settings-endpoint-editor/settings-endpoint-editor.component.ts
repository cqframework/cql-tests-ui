// Author: Preston Lee

import { Component, input, model } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { EndpointConfiguration } from '../../../models/environment.model';

@Component({
  selector: 'app-settings-endpoint-editor',
  imports: [FormsModule],
  templateUrl: './settings-endpoint-editor.component.html'
})
export class SettingsEndpointEditorComponent {
  readonly label = input.required<string>();
  readonly description = input<string>('');
  readonly idPrefix = input.required<string>();
  readonly showCustomHeaders = input(true);
  readonly placeholder = input('');
  readonly disabled = input(false);
  readonly readonly = input(false);

  readonly endpoint = model.required<EndpointConfiguration>();

  patchEndpoint(patch: Partial<EndpointConfiguration>): void {
    if (this.disabled() || this.readonly()) {
      return;
    }
    this.endpoint.set({ ...this.endpoint(), ...patch });
  }

  addHeader(): void {
    if (this.disabled() || this.readonly()) {
      return;
    }
    const current = this.endpoint();
    this.endpoint.set({
      ...current,
      headers: [...(current.headers ?? []), '']
    });
  }

  removeHeader(index: number): void {
    if (this.disabled() || this.readonly()) {
      return;
    }
    const current = this.endpoint();
    const headers = [...(current.headers ?? [])];
    headers.splice(index, 1);
    this.endpoint.set({ ...current, headers });
  }

  updateHeader(index: number, value: string): void {
    if (this.disabled() || this.readonly()) {
      return;
    }
    const current = this.endpoint();
    const headers = [...(current.headers ?? [])];
    headers[index] = value;
    this.endpoint.set({ ...current, headers });
  }
}

// Author: Preston Lee

import {Component, ChangeDetectionStrategy, signal, computed, inject, OnInit} from '@angular/core';
import { RouterLink, RouterLinkActive, RouterOutlet, Router } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { SettingsService } from '../../services/settings.service';
import { TerminologyService } from '../../services/terminology.service';
import { ToastService } from '../../services/toast.service';
import {
  hasTerminologyConfigured,
  terminologyHttpErrorMessage,
} from '../../services/terminology-ui.lib';

@Component({
  selector: 'app-terminology-layout',
  imports: [RouterLink, RouterLinkActive, RouterOutlet],
  templateUrl: './terminology-layout.component.html',

  styleUrl: './terminology-layout.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class TerminologyLayoutComponent implements OnInit {

  // Server availability
  protected readonly serverAvailable = signal<boolean>(false);
  protected readonly serverLoading = signal<boolean>(true);
  protected readonly serverError = signal<string | null>(null);
  protected readonly resourceCounts = signal<{
    valuesets: number;
    codesystems: number;
    conceptmaps: number;
  } | null>(null);

  protected readonly hasValidConfiguration = computed(() =>
    hasTerminologyConfigured(this.settingsService.getEffectiveTerminologyEndpointAddress())
  );

  protected readonly configurationStatus = computed(() => {
    if (!this.hasValidConfiguration()) {
      return {
        type: 'warning',
        message: 'Terminology service not configured. Please configure the terminology base URL in Settings.',
        showSettings: true
      };
    }
    return {
      type: 'success',
      message: `Connected to ${this.settingsService.getEffectiveTerminologyEndpointAddress()}`,
      showSettings: false
    };
  });

  protected settingsService = inject(SettingsService);
  private terminologyService = inject(TerminologyService);
  private toastService = inject(ToastService);
  private router = inject(Router);

  ngOnInit(): void {
    // Initialize server availability check
    this.initializeServerCheck();
  }

  // Server initialization
  private async initializeServerCheck(): Promise<void> {
    if (!this.hasValidConfiguration()) {
      this.serverLoading.set(false);
      this.serverAvailable.set(false);
      this.serverError.set('Terminology service not configured');
      return;
    }

    this.serverLoading.set(true);
    this.serverError.set(null);

    try {
      // Check server availability and get resource counts
      await this.checkServerAvailability();
      this.serverAvailable.set(true);
    } catch (error) {
      const errorMessage = terminologyHttpErrorMessage(error);
      this.serverAvailable.set(false);
      this.serverError.set(errorMessage);
      this.toastService.showError(errorMessage, 'Server Connection Failed');
    } finally {
      this.serverLoading.set(false);
    }
  }

  private async checkServerAvailability(): Promise<void> {
    try {
      // Get resource counts in parallel
      const [valuesetsResult, codesystemsResult, conceptmapsResult] = await Promise.all([
        firstValueFrom(this.terminologyService.searchValueSets({ _count: 1 })).catch(() => ({ total: 0 })),
        firstValueFrom(this.terminologyService.searchCodeSystems({ _count: 1 })).catch(() => ({ total: 0 })),
        firstValueFrom(this.terminologyService.searchConceptMaps({ _count: 1 })).catch(() => ({ total: 0 }))
      ]);

      this.resourceCounts.set({
        valuesets: valuesetsResult?.total || 0,
        codesystems: codesystemsResult?.total || 0,
        conceptmaps: conceptmapsResult?.total || 0
      });
    } catch (error) {
      console.error('Server availability check failed:', error);
      throw error;
    }
  }

  navigateToSettings(): void {
    this.router.navigate(['/settings/environments']);
  }
}

// Author: Preston Lee

import { Routes } from '@angular/router';
import { sqlOnFhirGuard } from './components/sql-on-fhir/sql-on-fhir.guard';
import { authGuard } from './guards/auth.guard';

export const routes: Routes = [
  {
    path: '',
    loadComponent: () =>
      import('./components/landing/landing.component').then((m) => m.LandingComponent),
    pathMatch: 'full',
  },
  {
    path: '',
    canActivateChild: [authGuard],
    children: [
      {
        path: 'results/open',
        loadComponent: () =>
          import('./components/open/open.component').then((m) => m.OpenComponent),
      },
      {
        path: 'results',
        loadComponent: () =>
          import('./components/results-viewer/results-viewer.component').then(
            (m) => m.ResultsViewerComponent
          ),
      },
      { path: 'documentation', redirectTo: '/documentation/results', pathMatch: 'full' },
      {
        path: 'documentation/results',
        loadComponent: () =>
          import('./components/results-documentation/results-documentation.component').then(
            (m) => m.ResultsDocumentationComponent
          ),
      },
      {
        path: 'documentation/runner',
        loadComponent: () =>
          import('./components/runner-documentation/runner-documentation.component').then(
            (m) => m.RunnerDocumentationComponent
          ),
      },
      {
        path: 'settings',
        loadComponent: () =>
          import('./components/settings/settings.component').then((m) => m.SettingsComponent),
        children: [
          { path: '', redirectTo: 'environments', pathMatch: 'full' },
          {
            path: 'environments',
            loadComponent: () =>
              import('./components/settings/settings-environments/settings-environments.component').then(
                (m) => m.SettingsEnvironmentsComponent
              ),
          },
          {
            path: 'advanced',
            loadComponent: () =>
              import('./components/settings/settings-advanced/settings-advanced.component').then(
                (m) => m.SettingsAdvancedComponent
              ),
          },
          {
            path: 'runner',
            loadComponent: () =>
              import('./components/settings/settings-runner/settings-runner.component').then(
                (m) => m.SettingsRunnerComponent
              ),
          },
          {
            path: 'registry',
            loadComponent: () =>
              import('./components/settings/settings-registry/settings-registry.component').then(
                (m) => m.SettingsRegistryComponent
              ),
          },
          {
            path: 'vsac',
            loadComponent: () =>
              import('./components/settings/settings-vsac/settings-vsac.component').then(
                (m) => m.SettingsVsacComponent
              ),
          },
          {
            path: 'ai',
            loadComponent: () =>
              import('./components/settings/settings-ai/settings-ai.component').then(
                (m) => m.SettingsAiComponent
              ),
          },
          {
            path: 'server',
            loadComponent: () =>
              import('./components/settings/settings-server/settings-server.component').then(
                (m) => m.SettingsServerComponent
              ),
          },
        ],
      },
      {
        path: 'examples',
        loadComponent: () =>
          import('./components/examples/examples.component').then((m) => m.ExamplesComponent),
        children: [
          { path: '', redirectTo: 'lipid-management', pathMatch: 'full' },
          {
            path: 'lipid-management',
            loadComponent: () =>
              import(
                './components/examples/lipid-management-example/lipid-management-example.component'
              ).then((m) => m.LipidManagementExampleComponent),
          },
          {
            path: 'hospital-at-home',
            loadComponent: () =>
              import(
                './components/examples/hospital-at-home-example/hospital-at-home-example.component'
              ).then((m) => m.HospitalAtHomeExampleComponent),
          },
        ],
      },
      {
        path: 'dashboard',
        loadComponent: () =>
          import('./components/dashboard/dashboard.component').then((m) => m.DashboardComponent),
      },
      {
        path: 'team/dashboard',
        loadComponent: () =>
          import('./components/team/team-dashboard/team-dashboard.component').then(
            (m) => m.TeamDashboardComponent
          ),
      },
      {
        path: 'team/workspaces',
        loadComponent: () =>
          import('./components/team/team-workspaces/team-workspaces.component').then(
            (m) => m.TeamWorkspacesComponent
          ),
      },
      {
        path: 'team/workspaces/:workspaceId',
        loadComponent: () =>
          import('./components/team/team-workspaces/team-workspaces.component').then(
            (m) => m.TeamWorkspacesComponent
          ),
      },
      {
        path: 'runner',
        loadComponent: () =>
          import('./components/runner/runner.component').then((m) => m.RunnerComponent),
      },
      {
        path: 'uploader',
        loadComponent: () =>
          import('./components/fhir-uploader/fhir-uploader.component').then(
            (m) => m.FhirUploaderComponent
          ),
      },
      {
        path: 'terminology',
        loadComponent: () =>
          import('./components/terminology/terminology-layout.component').then(
            (m) => m.TerminologyLayoutComponent
          ),
        children: [
          { path: '', redirectTo: 'valuesets', pathMatch: 'full' },
          {
            path: 'valuesets',
            loadComponent: () =>
              import('./components/terminology/valuesets-tab/valuesets-tab.component').then(
                (m) => m.ValueSetsTabComponent
              ),
          },
          {
            path: 'conceptmaps',
            loadComponent: () =>
              import('./components/terminology/conceptmaps-tab/conceptmaps-tab.component').then(
                (m) => m.ConceptMapsTabComponent
              ),
          },
          {
            path: 'codesystems',
            loadComponent: () =>
              import('./components/terminology/codesystems-tab/codesystems-tab.component').then(
                (m) => m.CodeSystemsTabComponent
              ),
          },
          {
            path: 'validation',
            loadComponent: () =>
              import('./components/terminology/validation-tab/validation-tab.component').then(
                (m) => m.ValidationTabComponent
              ),
          },
          {
            path: 'search',
            loadComponent: () =>
              import('./components/terminology/code-search-tab/code-search-tab.component').then(
                (m) => m.CodeSearchTabComponent
              ),
          },
        ],
      },
      {
        path: 'measure-reports',
        loadComponent: () =>
          import('./components/measure-editor/measure-reports-list/measure-reports-list.component').then(
            (m) => m.MeasureReportsListComponent
          ),
      },
      {
        path: 'measure-reports/:reportId',
        loadComponent: () =>
          import(
            './components/measure-editor/measure-report-viewer/measure-report-viewer.component'
          ).then((m) => m.MeasureReportViewerComponent),
      },
      { path: 'measures/reports/:reportId', redirectTo: 'measure-reports/:reportId' },
      { path: 'measures/reports', redirectTo: 'measure-reports', pathMatch: 'full' },
      {
        path: 'measures',
        loadComponent: () =>
          import('./components/measure-editor/measure-editor.component').then(
            (m) => m.MeasureEditorComponent
          ),
        children: [
          {
            path: '',
            loadComponent: () =>
              import('./components/measure-editor/measure-library/measure-library.component').then(
                (m) => m.MeasureLibraryComponent
              ),
          },
          {
            path: 'new',
            loadComponent: () =>
              import(
                './components/measure-editor/measure-workspace/measure-workspace.component'
              ).then((m) => m.MeasureWorkspaceComponent),
          },
          {
            path: ':id',
            loadComponent: () =>
              import(
                './components/measure-editor/measure-workspace/measure-workspace.component'
              ).then((m) => m.MeasureWorkspaceComponent),
          },
        ],
      },
      {
        path: 'vsac',
        loadComponent: () =>
          import('./components/vsac-browser/vsac-browser.component').then((m) => m.VsacBrowserComponent),
      },
      // Short alias; Angular preserves ?package=&version= on redirect for external deep links.
      { path: 'fhir-registry', redirectTo: 'fhir-registry-importer', pathMatch: 'full' },
      {
        path: 'fhir-registry-importer',
        loadComponent: () =>
          import('./components/fhir-registry-importer/fhir-registry-importer.component').then(
            (m) => m.FhirRegistryImporterComponent
          ),
      },
      {
        path: 'export',
        loadComponent: () =>
          import('./components/export/export.component').then((m) => m.ExportComponent),
      },
      {
        path: 'guidelines',
        loadComponent: () =>
          import('./components/guidelines/guidelines.component').then((m) => m.GuidelinesComponent),
      },
      {
        path: 'guidelines/:id/testing',
        loadComponent: () =>
          import('./components/guidelines/guidelines.component').then((m) => m.GuidelinesComponent),
      },
      {
        path: 'guidelines/:id',
        loadComponent: () =>
          import('./components/guidelines/guidelines.component').then((m) => m.GuidelinesComponent),
      },
      {
        path: 'sql',
        loadComponent: () =>
          import('./components/sql-on-fhir/sql-on-fhir.component').then((m) => m.SqlOnFhirComponent),
        canActivate: [sqlOnFhirGuard],
      },
      {
        path: 'clipboard',
        loadComponent: () =>
          import('./components/clipboard-manager/clipboard-manager.component').then(
            (m) => m.ClipboardManagerComponent
          ),
      },
      {
        path: 'ide',
        loadComponent: () =>
          import('./components/ide-layout/ide-layout.component').then((m) => m.IdeLayoutComponent),
        children: [
          {
            path: '',
            loadComponent: () =>
              import('./components/cql-ide/cql-ide.component').then((m) => m.CqlIdeComponent),
          },
        ],
      },
    ],
  },

  { path: '**', redirectTo: '' },
];

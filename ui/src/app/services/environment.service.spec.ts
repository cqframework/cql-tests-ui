// Author: Preston Lee

import { describe, expect, it, beforeEach } from 'vitest';
import { EnvironmentService } from './environment.service';
import { BUILT_IN_ENVIRONMENT_ID } from '../models/environment.model';

describe('EnvironmentService', () => {
  let service: EnvironmentService;

  beforeEach(() => {
    service = new EnvironmentService();
    service.syncFromSettings([], BUILT_IN_ENVIRONMENT_ID);
  });

  it('seeds built-in environment when list is empty', () => {
    const envs = service.environments();
    expect(envs.length).toBe(1);
    expect(envs[0].id).toBe(BUILT_IN_ENVIRONMENT_ID);
    expect(envs[0].builtIn).toBe(true);
    expect(envs[0].dataEndpoint.address).toBe('');
    expect(envs[0].terminologyEndpoint.address).toBe('');
    expect(envs[0].contentEndpoint.address).toBe('');
    expect(envs[0].evaluationServer.address).toBeTruthy();
  });

  it('migrates legacy flat settings into built-in environment', () => {
    const migrated = service.migrateLegacySettings({
      fhirBaseUrl: 'http://legacy/fhir',
      terminologyBaseUrl: 'http://legacy/term',
      terminologyBasicAuthUsername: 'user',
      terminologyBasicAuthPassword: 'pass'
    });
    expect(migrated.environments).toHaveLength(1);
    expect(migrated.environments[0].evaluationServer.address).toBe('http://legacy/fhir');
    expect(migrated.environments[0].dataEndpoint.address).toBe('');
    expect(migrated.environments[0].terminologyEndpoint.headers).toContain(
      `Authorization: Basic ${btoa('user:pass')}`
    );
  });

  it('duplicates environment with new id and copy suffix', () => {
    const copy = service.duplicateEnvironment(BUILT_IN_ENVIRONMENT_ID);
    expect(copy).not.toBeNull();
    expect(copy!.id).not.toBe(BUILT_IN_ENVIRONMENT_ID);
    expect(copy!.name).toContain('(copy)');
    expect(copy!.builtIn).toBeFalsy();
    expect(service.environments().length).toBe(2);
  });

  it('cannot delete built-in environment', () => {
    expect(service.deleteEnvironment(BUILT_IN_ENVIRONMENT_ID)).toBe(false);
  });

  it('resolves effective addresses with role fallbacks', () => {
    service.updateEnvironment({
      ...service.activeEnvironment(),
      evaluationServer: { address: 'http://eval/fhir' },
      dataEndpoint: { address: '' },
      terminologyEndpoint: { address: 'http://term/fhir' },
      contentEndpoint: { address: '' }
    });
    expect(service.getEffectiveAddressForRole('evaluation')).toBe('http://eval/fhir');
    expect(service.getEffectiveAddressForRole('data')).toBe('http://eval/fhir');
    expect(service.getEffectiveAddressForRole('terminology')).toBe('http://term/fhir');
    expect(service.getEffectiveAddressForRole('content')).toBe('http://eval/fhir');
  });

  it('builds HTTP context with authorization headers', () => {
    service.updateEnvironment({
      ...service.activeEnvironment(),
      terminologyEndpoint: {
        address: 'http://term/fhir',
        headers: [`Authorization: Basic ${btoa('u:p')}`]
      }
    });
    const ctx = service.getEndpointHttpContext('terminology');
    expect(ctx.address).toBe('http://term/fhir');
    expect(ctx.headers['Authorization']).toBe(`Basic ${btoa('u:p')}`);
  });

  it('resolves default endpoint roles for AI sessions without changing stored defaults', () => {
    const before = structuredClone(service.activeEnvironment());
    const resolved = service.getEffectiveActiveEnvironment();
    for (const endpoint of [resolved.evaluationServer, resolved.dataEndpoint, resolved.terminologyEndpoint, resolved.contentEndpoint]) {
      expect(endpoint.address).toBe(before.evaluationServer.address);
    }
    expect(service.activeEnvironment()).toEqual(before);
    expect(service.activeEnvironment().dataEndpoint.address).toBe('');
  });

  it('preserves role-specific addresses and credentials when resolving a session snapshot', () => {
    service.updateEnvironment({
      ...service.activeEnvironment(),
      evaluationServer: { address: 'http://eval/fhir/', headers: ['Authorization: Bearer evaluation-only'] },
      dataEndpoint: { address: ' ', headers: ['X-Data-Tenant: example'] },
      terminologyEndpoint: { address: 'http://term/fhir/', headers: ['Authorization: Bearer terminology-only'] },
      contentEndpoint: { address: '', headers: [] },
    });
    const resolved = service.getEffectiveActiveEnvironment();
    expect(resolved.dataEndpoint.address).toBe('http://eval/fhir');
    expect(resolved.dataEndpoint.headers).toEqual(['X-Data-Tenant: example']);
    expect(resolved.terminologyEndpoint.address).toBe('http://term/fhir');
    expect(resolved.terminologyEndpoint.headers).toEqual(['Authorization: Bearer terminology-only']);
    expect(resolved.contentEndpoint.headers).toEqual([]);
    resolved.dataEndpoint.headers?.push('X-Probe: isolated');
    expect(service.activeEnvironment().dataEndpoint.headers).toEqual(['X-Data-Tenant: example']);
  });

  it('activates a workspace shared environment as first-class selection', () => {
    service.setWorkspaceCatalog([
      {
        workspaceId: 'ws-1',
        workspaceName: 'Team Alpha',
        environments: [
          {
            id: 'env-1',
            workspaceId: 'ws-1',
            name: 'Shared HAPI',
            config: {
              evaluationServer: { address: 'http://shared/fhir' },
              dataEndpoint: { address: 'http://shared/data' },
              terminologyEndpoint: { address: '' },
              contentEndpoint: { address: '' },
            },
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          },
        ],
      },
    ]);

    const activated = service.setActiveWorkspaceEnvironment('ws-1', 'env-1');
    expect(activated).not.toBeNull();
    expect(service.activeEnvironmentSource()).toBe('workspace');
    expect(service.isWorkspaceEnvironmentSelected('ws-1', 'env-1')).toBe(true);
    expect(service.isPersonalEnvironmentSelected(BUILT_IN_ENVIRONMENT_ID)).toBe(false);
    expect(service.activeEnvironment().evaluationServer.address).toBe('http://shared/fhir');
    expect(service.activeEnvironment().name).toContain('Shared HAPI');
  });

  it('falls back to personal when active workspace environment disappears', () => {
    service.setWorkspaceCatalog([
      {
        workspaceId: 'ws-1',
        workspaceName: 'Team Alpha',
        environments: [
          {
            id: 'env-1',
            workspaceId: 'ws-1',
            name: 'Shared HAPI',
            config: {
              evaluationServer: { address: 'http://shared/fhir' },
              dataEndpoint: { address: '' },
              terminologyEndpoint: { address: '' },
              contentEndpoint: { address: '' },
            },
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          },
        ],
      },
    ]);
    service.setActiveWorkspaceEnvironment('ws-1', 'env-1');
    service.setWorkspaceCatalog([
      {
        workspaceId: 'ws-1',
        workspaceName: 'Team Alpha',
        environments: [],
      },
    ]);
    expect(service.activeEnvironmentSource()).toBe('personal');
    expect(service.activeEnvironment().id).toBe(BUILT_IN_ENVIRONMENT_ID);
  });

  it('resolves effective addresses for a non-active environment', () => {
    const copy = service.duplicateEnvironment(BUILT_IN_ENVIRONMENT_ID)!;
    service.updateEnvironment({
      ...copy,
      evaluationServer: { address: 'http://other/eval' },
      dataEndpoint: { address: '' },
      terminologyEndpoint: { address: 'http://other/term' },
      contentEndpoint: { address: '' }
    });
    const resolved = service.environments().find(e => e.id === copy.id)!;
    expect(service.getEffectiveAddressForRoleOnEnvironment(resolved, 'data')).toBe('http://other/eval');
    expect(service.getEffectiveAddressForRoleOnEnvironment(resolved, 'terminology')).toBe(
      'http://other/term'
    );
    // Active env still uses built-in defaults / prior addresses
    expect(service.getEffectiveAddressForRole('data')).not.toBe('http://other/eval');
  });

  it('resolves publish target keys for personal and workspace environments', () => {
    const copy = service.duplicateEnvironment(BUILT_IN_ENVIRONMENT_ID)!;
    service.setWorkspaceCatalog([
      {
        workspaceId: 'ws-1',
        workspaceName: 'Team Alpha',
        environments: [
          {
            id: 'env-1',
            workspaceId: 'ws-1',
            name: 'Shared HAPI',
            config: {
              evaluationServer: { address: 'http://shared/fhir' },
              dataEndpoint: { address: 'http://shared/data' },
              terminologyEndpoint: { address: '' },
              contentEndpoint: { address: '' },
            },
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          },
        ],
      },
    ]);

    const personal = service.resolveEnvironmentByPublishKey(`personal:${copy.id}`);
    expect(personal?.id).toBe(copy.id);

    const workspace = service.resolveEnvironmentByPublishKey('ws:ws-1:env-1');
    expect(workspace?.evaluationServer.address).toBe('http://shared/fhir');
    expect(workspace?.dataEndpoint.address).toBe('http://shared/data');

    expect(service.resolveEnvironmentByPublishKey('personal:missing')).toBeNull();
    expect(service.isPublishTargetKeyActive(`personal:${BUILT_IN_ENVIRONMENT_ID}`)).toBe(true);
    expect(service.isPublishTargetKeyActive(`personal:${copy.id}`)).toBe(false);
  });

  it('lists personal and workspace export publish targets', () => {
    service.setWorkspaceCatalog([
      {
        workspaceId: 'ws-1',
        workspaceName: 'Team Alpha',
        environments: [
          {
            id: 'env-1',
            workspaceId: 'ws-1',
            name: 'Shared HAPI',
            config: {
              evaluationServer: { address: 'http://shared/fhir' },
              dataEndpoint: { address: '' },
              terminologyEndpoint: { address: '' },
              contentEndpoint: { address: '' },
            },
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          },
        ],
      },
    ]);
    const options = service.listExportPublishTargetOptions();
    expect(options.some(o => o.key === `personal:${BUILT_IN_ENVIRONMENT_ID}` && o.group === 'personal')).toBe(
      true
    );
    expect(options.some(o => o.key === 'ws:ws-1:env-1' && o.group === 'workspace')).toBe(true);
  });
});

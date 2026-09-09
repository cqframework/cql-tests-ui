// Author: Preston Lee

import { test, expect } from '@playwright/test';
import type { CqlEnvironment, UserSettingsDto } from '@cql-studio/core';

const settings: UserSettingsDto = {
  experimental: false, developer: false, themePreferred: 'light', validateSchema: true,
  runnerApiBaseUrl: '', runnerFhirBaseUrl: '', defaultTestResultsIndexUrl: '',
  fhirPackageRegistryBaseUrl: '', vsacFhirBaseUrl: '', vsacApiUsername: '', vsacApiPassword: '',
  aiProvider: 'ollama', ollamaBaseUrl: '', ollamaModel: '', openaiModel: '',
  compatibleProviderName: '', compatibleProviderBaseUrl: '', compatibleProviderModel: '',
  searxngBaseUrl: '', enableAiAssistant: true, autoApplyCodeEdits: false, enableAiCodePrediction: false,
};

test('default settings are readable and copies retain drafts until a successful save', async ({ page }) => {
  let environments: CqlEnvironment[] = [];
  const updates: CqlEnvironment[] = [];
  let rejectSave = true;
  await page.route('**/configuration.js', route => route.fulfill({
    contentType: 'application/javascript',
    body: 'window.CQL_STUDIO_SERVER_BASE_URL = "http://localhost:3003"; window.CQL_STUDIO_EVALUATION_SERVER_URL = "http://localhost:8080/fhir";',
  }));
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname;
    const method = route.request().method();
    if (path === '/api/auth/session') {
      return route.fulfill({ json: { enabled: true, user: { id: 'settings-test-user', email: 'test@example.test', displayName: 'Settings test' } } });
    }
    if (path === '/api/users/me/settings') return route.fulfill({ json: settings });
    if (path === '/api/users/me/environments' && method === 'GET') return route.fulfill({ json: environments });
    if (path === '/api/users/me/environments' && method === 'POST') {
      const copy = { ...route.request().postDataJSON() as CqlEnvironment, id: 'editable-copy', builtIn: false };
      environments = [...environments, copy];
      return route.fulfill({ status: 201, json: copy });
    }
    if (path === '/api/users/me/environments/editable-copy' && method === 'PATCH') {
      const updated = route.request().postDataJSON() as CqlEnvironment;
      updates.push(updated);
      if (rejectSave) return route.fulfill({ status: 503, json: { error: 'Save temporarily unavailable' } });
      environments = [updated];
      return route.fulfill({ json: updated });
    }
    return route.fulfill({ json: [] });
  });
  await page.route('**/fhir/**', route => route.fulfill({ json: { resourceType: 'CapabilityStatement', fhirVersion: '4.0.1', rest: [] } }));
  await page.goto('/settings?section=environments');
  await expect(page.locator('#settings-environment-readonly')).toContainText('read-only');
  await expect(page.locator('#settings-environments input')).toHaveCount(0);
  await expect(page.locator('#settings-data-endpoint-address')).toHaveText('http://localhost:8080/fhir');
  await expect(page.locator('#save-settings-btn')).toHaveCount(0);

  for (const width of [1280, 768, 375]) {
    await page.setViewportSize({ width, height: 900 });
    expect(await page.locator('#settings').evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    if (width === 1280 || width === 375) {
      await page.screenshot({ path: `/tmp/cql-settings-default-${width}.png`, fullPage: true });
    }
  }

  await page.setViewportSize({ width: 1280, height: 900 });
  await page.locator('#settings-environment-duplicate').click();
  await expect(page.locator('input#settings-data-endpoint-address')).toBeEnabled();
  await page.locator('input#settings-environment-name').fill('Local FHIR');
  await page.locator('#settings-data-endpoint-address').fill('http://localhost:8080/fhir');
  await page.locator('#settings-data-endpoint-headers summary').click();
  await page.locator('#settings-data-endpoint-add-header').click();
  await expect(page.locator('#settings-data-endpoint-header-0')).toBeVisible();
  await page.locator('#settings-data-endpoint-header-0').fill('X-Tenant: test');
  expect(updates).toHaveLength(0);
  await expect(page.locator('#settings-environment-set-active')).toBeDisabled();

  await page.locator('#settings-environment-default').click();
  await page.locator('#settings-environment-editable-copy').click();
  await expect(page.locator('input#settings-environment-name')).toHaveValue('Local FHIR');
  await expect(page.locator('#settings-data-endpoint-header-0')).toHaveValue('X-Tenant: test');

  await page.locator('#settings-environment-save').click();
  await expect(page.locator('#settings-environment-save-error')).toHaveText('Save temporarily unavailable');
  await expect(page.locator('#settings-data-endpoint-address')).toHaveValue('http://localhost:8080/fhir');
  await expect(page.locator('#settings-environment-save-status')).toHaveText('Unsaved changes');

  rejectSave = false;
  await page.locator('#settings-environment-save').click();
  await expect(page.locator('#settings-environment-save-status')).toHaveText('All changes saved');
  expect(updates.at(-1)?.dataEndpoint.headers).toEqual(['X-Tenant: test']);
  await expect(page.locator('#settings-environment-set-active')).toBeEnabled();
  await page.locator('#settings-environment-set-active').click();
  await expect(page.locator('#settings-environment-editable-copy')).toContainText('Active');

  await page.reload();
  await page.locator('#settings-environment-editable-copy').click();
  await expect(page.locator('input#settings-environment-name')).toHaveValue('Local FHIR');
  await expect(page.locator('#settings-data-endpoint-header-0')).toHaveValue('X-Tenant: test');
});

// Author: Preston Lee

import { expect, test } from '@playwright/test';

const studioOrigin = `http://localhost:${process.env['PLAYWRIGHT_PORT'] ?? '4200'}`;

test.describe('OpenCode browser integration', () => {
  test.beforeEach(async ({ page }) => {
    await page.route('**/configuration.js', route => route.fulfill({ contentType: 'application/javascript', body: 'window.CQL_STUDIO_SERVER_BASE_URL = "http://localhost:3003";' }));
    await page.route('**/api/auth/session', route => route.fulfill({ json: { enabled: true, user: { id: 'opencode-test-user', email: 'test@example.test', displayName: 'OpenCode test' } } }));
    await page.route('**/api/users/me/**', route => route.fulfill({ status: 404, json: {} }));
    await page.route('**/api/workspaces**', route => route.fulfill({ json: [] }));
  });
  test('offers opt-in Ollama CQL predictions and accepts them with Tab', async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem('cql_tests_ui_settings', JSON.stringify({
        settingsVersion: 2,
        enableAiAssistant: true,
        enableAiCodePrediction: true,
        serverBaseUrl: 'http://localhost:3003',
        ollamaBaseUrl: 'http://ollama.test:11434',
        ollamaModel: 'qwen3.8:27b-mlx',
        environments: [],
        activeEnvironmentId: 'default',
        activeEnvironmentSource: 'personal',
      }));
    });
    const cors = {
      'access-control-allow-origin': studioOrigin,
      'access-control-allow-credentials': 'true',
      'access-control-allow-headers': 'content-type,x-ollama-base-url',
      'access-control-allow-methods': 'GET,POST,OPTIONS',
    };
    await page.route('http://localhost:3003/api/ollama/generate', async route => {
      if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
      await route.fulfill({
        status: 200,
        headers: cors,
        contentType: 'application/json',
        body: JSON.stringify({ response: 'define PredictedByOllama: true' }),
      });
    });
    await page.route('http://localhost:3003/api/opencode/sessions', route => route.fulfill({
      status: 200, headers: cors, contentType: 'application/json', body: '[]',
    }));
    await page.route('http://localhost:8080/fhir/**', route => {
      if (new URL(route.request().url()).pathname.endsWith('/Library/PredictionVerify')) {
        return route.fulfill({
          status: 404,
          contentType: 'application/fhir+json',
          body: JSON.stringify({ resourceType: 'OperationOutcome', issue: [{ severity: 'error', code: 'not-found' }] }),
        });
      }
      return route.fulfill({
        status: 200,
        contentType: 'application/fhir+json',
        body: JSON.stringify({ resourceType: 'Bundle', type: 'searchset', total: 0, entry: [] }),
      });
    });

    await page.goto('/ide');
    await page.getByRole('button', { name: 'Create New Library' }).click();
    await page.locator('#new-library-title-input').fill('PredictionVerify');
    await page.locator('#new-library-modal-submit').click();
    const editor = page.locator('.cm-content');
    await editor.click();
    await editor.press('End');
    await editor.press('Enter');
    const prediction = page.locator('.cm-ai-prediction');
    await expect(prediction).toContainText('define PredictedByOllama: true');
    await editor.press('Tab');
    await expect(prediction).toHaveCount(0);
    await expect(editor).toContainText('define PredictedByOllama: true');
  });

  test('supports sessions, slash commands, file references, activity, reasoning, and reattachment', async ({ page }) => {
    let created = false;
    let fhirSaved = false;
    let questionAnswered = false;
    let attachmentUploaded = false;
    let activeFileSync: Record<string, unknown> | null = null;
    let promptRequest: Record<string, unknown> | null = null;
    let attachmentPromptIds: unknown[] | null = null;
    const now = new Date().toISOString();
    const session = {
      id: 'browser-session-1',
      openCodeSessionId: 'sdk-session-1',
      title: 'BrowserOpenCode in CQL Studio',
      status: 'idle',
      activeLibraryId: 'BrowserOpenCode',
      activeFile: 'libraries/BrowserOpenCode.cql',
      createdAt: now,
      updatedAt: now,
      lastActivityAt: now,
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      model: 'qwen3.8:27b-mlx',
      reasoningEnabled: false,
    };
    const commands = [
      { name: 'validate', description: 'Validate CQL', source: 'cql-studio', acceptsArguments: false },
      { name: 'review', description: 'Review CQL', source: 'cql-studio', acceptsArguments: false },
      { name: 'context', description: 'Show active CQL Studio endpoints and capabilities', source: 'cql-studio', acceptsArguments: false },
      { name: 'fhir', description: 'Read or search the configured FHIR environment', source: 'cql-studio', acceptsArguments: true },
      { name: 'research', description: 'Research a topic with web search and safe fetching', source: 'cql-studio', acceptsArguments: true },
      { name: 'terminology', description: 'Research ValueSets, CodeSystems, and expansions', source: 'cql-studio', acceptsArguments: true },
    ];

    await page.addInitScript(() => {
      const endpoint = { address: 'http://localhost:8080/fhir' };
      localStorage.setItem('cql_tests_ui_settings', JSON.stringify({
        settingsVersion: 2,
        enableAiAssistant: true,
        serverBaseUrl: 'http://localhost:3003',
        ollamaBaseUrl: 'http://ollama.test:11434',
        ollamaModel: 'qwen3.8:27b-mlx',
        environments: [
          {
            id: 'default',
            name: 'Default Environment',
            builtIn: true,
            evaluationServer: endpoint,
            dataEndpoint: endpoint,
            terminologyEndpoint: endpoint,
            contentEndpoint: endpoint,
          },
          {
            id: 'secondary',
            name: 'Secondary Environment',
            evaluationServer: endpoint,
            dataEndpoint: endpoint,
            terminologyEndpoint: endpoint,
            contentEndpoint: endpoint,
          },
        ],
        activeEnvironmentId: 'default',
        activeEnvironmentSource: 'personal',
      }));
    });

    await page.route('http://localhost:8080/fhir/**', route => {
      if (route.request().method() === 'POST' || route.request().method() === 'PUT') {
        fhirSaved = true;
        const resource = route.request().postDataJSON() as Record<string, unknown>;
        return route.fulfill({
          status: 200,
          contentType: 'application/fhir+json',
          body: JSON.stringify({ ...resource, id: resource['id'] || 'BrowserOpenCode', meta: { versionId: '1' } }),
        });
      }
      if (new URL(route.request().url()).pathname.endsWith('/Library/BrowserOpenCode')) {
        return route.fulfill({
          status: 404,
          contentType: 'application/fhir+json',
          body: JSON.stringify({ resourceType: 'OperationOutcome', issue: [{ severity: 'error', code: 'not-found' }] }),
        });
      }
      return route.fulfill({
        status: 200,
        contentType: 'application/fhir+json',
        body: JSON.stringify({ resourceType: 'Bundle', type: 'searchset', total: 0, entry: [] }),
      });
    });

    await page.route('http://localhost:3003/api/opencode/**', async route => {
      const request = route.request();
      const url = new URL(request.url());
      const path = url.pathname;
      const cors = {
        'access-control-allow-origin': studioOrigin,
        'access-control-allow-credentials': 'true',
      };
      if (request.method() === 'OPTIONS') {
        await route.fulfill({ status: 204, headers: { ...cors, 'access-control-allow-headers': 'content-type', 'access-control-allow-methods': 'GET,POST,PUT,DELETE' } });
      } else if (path.endsWith('/sessions') && request.method() === 'GET') {
        await route.fulfill({ status: 200, headers: cors, contentType: 'application/json', body: JSON.stringify(created ? [session] : []) });
      } else if (path.endsWith('/sessions') && request.method() === 'POST') {
        created = true;
        await route.fulfill({ status: 201, headers: cors, contentType: 'application/json', body: JSON.stringify(session) });
      } else if (path.endsWith('/commands') && request.method() === 'GET') {
        await route.fulfill({ status: 200, headers: cors, contentType: 'application/json', body: JSON.stringify(commands) });
      } else if (path.endsWith('/files')) {
        await route.fulfill({ status: 200, headers: cors, contentType: 'application/json', body: JSON.stringify([
          { path: 'libraries/BrowserOpenCode.cql', libraryId: 'BrowserOpenCode', name: 'BrowserOpenCode.cql', writable: true },
          { path: 'dependencies/FHIRHelpers.cql', libraryId: 'FHIRHelpers', name: 'FHIRHelpers.cql', writable: false },
        ]) });
      } else if (path.endsWith('/state')) {
        await route.fulfill({ status: 200, headers: cors, contentType: 'application/json', body: JSON.stringify({
          session,
          messages: [],
          diffs: [{
            file: 'libraries/BrowserOpenCode.cql',
            libraryId: 'BrowserOpenCode',
            before: "library BrowserOpenCode version '1.0.0'\nusing FHIR version '4.0.1'\ncontext Patient\n",
            after: "library BrowserOpenCode version '1.0.0'\nusing FHIR version '4.0.1'\ncontext Patient\ndefine Answer: 42\n",
            additions: 1,
            deletions: 0,
          }],
          attachments: attachmentUploaded ? [{
            id: 'attachment-1',
            name: 'context.md',
            mimeType: 'text/markdown',
            size: 20,
            path: 'attachments/attachment-1-context.md',
            converted: false,
            createdAt: now,
          }] : [],
          commands,
          validation: { valid: true, diagnostics: [], checkedAt: now },
          permissions: [],
          questions: [],
          lastEventId: 8,
        }) });
      } else if (path.endsWith('/diff') && request.method() === 'GET') {
        await route.fulfill({ status: 200, headers: cors, contentType: 'application/json', body: JSON.stringify([{
          file: 'libraries/BrowserOpenCode.cql',
          libraryId: 'BrowserOpenCode',
          before: "library BrowserOpenCode version '1.0.0'\nusing FHIR version '4.0.1'\ncontext Patient\n",
          after: "library BrowserOpenCode version '1.0.0'\nusing FHIR version '4.0.1'\ncontext Patient\ndefine Answer: 42\n",
          additions: 1,
          deletions: 0,
        }]) });
      } else if (path.endsWith('/validate') && request.method() === 'POST') {
        await route.fulfill({ status: 200, headers: cors, contentType: 'application/json', body: JSON.stringify({ valid: true, diagnostics: [], checkedAt: now }) });
      } else if (path.endsWith('/active-file') && request.method() === 'PUT') {
        activeFileSync = request.postDataJSON() as Record<string, unknown>;
        await route.fulfill({ status: 204, headers: cors });
      } else if (path.endsWith('/prompt') && request.method() === 'POST') {
        promptRequest = request.postDataJSON() as Record<string, unknown>;
        attachmentPromptIds = (promptRequest['attachments'] as unknown[]) ?? [];
        await route.fulfill({ status: 202, headers: cors, contentType: 'application/json', body: JSON.stringify({ accepted: true }) });
      } else if (path.endsWith('/attachments') && request.method() === 'POST') {
        attachmentUploaded = true;
        await route.fulfill({
          status: 201,
          headers: cors,
          contentType: 'application/json',
          body: JSON.stringify({
            id: 'attachment-1',
            name: 'context.md',
            mimeType: 'text/markdown',
            size: 20,
            path: 'attachments/attachment-1-context.md',
            converted: false,
            createdAt: now,
          }),
        });
      } else if (path.includes('/questions/') && request.method() === 'POST') {
        questionAnswered = true;
        await route.fulfill({ status: 200, headers: cors, contentType: 'application/json', body: JSON.stringify({ accepted: true }) });
      } else if (path.endsWith('/events')) {
        const frames = [
          { id: 1, sessionId: session.id, emittedAt: now, event: { type: 'message.updated', properties: { info: { id: 'assistant-1', role: 'assistant' } } } },
          {
            id: 2,
            sessionId: session.id,
            emittedAt: now,
            event: {
              type: 'message.part.updated',
              properties: {
                part: {
                  id: 'tool-1',
                  messageID: 'assistant-1',
                  type: 'tool',
                  tool: 'cql_validate',
                  state: {
                    status: 'completed',
                    title: 'Validate CQL',
                    input: {},
                    output: '{"valid":true}',
                    time: { start: Date.now() - 100, end: Date.now() },
                  },
                },
              },
            },
          },
          {
            id: 3,
            sessionId: session.id,
            emittedAt: now,
            event: {
              type: 'message.part.updated',
              properties: {
                part: {
                  id: 'reasoning-1',
                  messageID: 'assistant-1',
                  type: 'reasoning',
                  text: 'Checking the library and dependencies.',
                  time: { start: Date.now() - 50, end: Date.now() },
                },
              },
            },
          },
          { id: 4, sessionId: session.id, emittedAt: now, event: { type: 'message.updated', properties: { info: { id: 'assistant-final', role: 'assistant' } } } },
          {
            id: 5,
            sessionId: session.id,
            emittedAt: now,
            event: {
              type: 'message.part.updated',
              properties: { part: { id: 'final-text', messageID: 'assistant-final', type: 'text', text: 'Final validation summary.' } },
            },
          },
          { id: 6, sessionId: session.id, emittedAt: now, event: { type: 'session.idle', properties: { sessionID: session.openCodeSessionId } } },
          { id: 7, sessionId: session.id, emittedAt: now, event: { type: 'cql.validation.updated', properties: { valid: true, diagnostics: [], checkedAt: now } } },
          ...(!questionAnswered ? [{
            id: 8,
            sessionId: session.id,
            emittedAt: now,
            event: {
              type: 'question.asked',
              properties: {
                id: 'question-1',
                sessionID: session.openCodeSessionId,
                questions: [{
                  header: 'Review scope',
                  question: 'Review terminology too?',
                  options: [
                    { label: 'Yes', description: 'Include terminology review' },
                    { label: 'No', description: 'Only review CQL structure' },
                  ],
                }],
              },
            },
          }] : []),
        ];
        await route.fulfill({
          status: 200,
          headers: { ...cors, 'content-type': 'text/event-stream', 'cache-control': 'no-cache' },
          body: frames.map(frame => `id: ${frame.id}\ndata: ${JSON.stringify(frame)}\n\n`).join(''),
        });
      } else {
        await route.fulfill({ status: 202, headers: cors, contentType: 'application/json', body: JSON.stringify({ accepted: true }) });
      }
    });

    await page.goto('/ide');
    await page.getByRole('button', { name: 'Create New Library' }).click();
    await page.locator('#new-library-title-input').fill('BrowserOpenCode');
    await page.locator('#new-library-modal-submit').click();

    await expect(page.getByRole('button', { name: 'Start OpenCode' })).toBeVisible();
    await page.getByRole('button', { name: 'Start OpenCode' }).click();
    await expect(page.getByText('qwen3.8:27b-mlx')).toBeVisible();
    await expect(page.getByText('Validate CQL', { exact: true })).toBeVisible();
    await expect(page.getByText('Review terminology too?')).toBeVisible();
    await page.locator('.question-option').filter({ hasText: 'Include terminology review' }).click();
    await page.getByRole('button', { name: 'Answer' }).click();
    await expect.poll(() => questionAnswered).toBe(true);

    const composer = page.locator('.composer textarea');
    await page.locator('input[type="file"]').setInputFiles({ name: 'context.md', mimeType: 'text/markdown', buffer: Buffer.from('# Attached context') });
    await expect(page.getByText('context.md', { exact: true })).toBeVisible();
    await composer.fill('/');
    await expect(page.locator('.suggestion-menu').getByText('/validate')).toBeVisible();
    await composer.fill('/help');
    await page.getByRole('button', { name: /Send/ }).click();
    const helpCard = page.locator('.help-card');
    await expect(helpCard.getByText('Commands and references')).toBeVisible();
    await expect(helpCard.getByText('/validate')).toBeVisible();
    await expect(helpCard.getByText('/context')).toBeVisible();
    await expect(helpCard.getByText('/research')).toBeVisible();
    await expect(helpCard.getByText('Commands and references')).toBeInViewport();
    await helpCard.getByRole('button', { name: 'Close command help' }).click();
    await composer.fill('@FHIR');
    const fhirHelpersSuggestion = page.locator('.suggestion-menu').getByText('@dependencies/FHIRHelpers.cql');
    await expect(fhirHelpersSuggestion).toBeVisible();
    await fhirHelpersSuggestion.click();

    await page.getByLabel('Reasoning').check();
    await page.getByTitle('Reasoning details').click();
    await expect(page.getByText('Checking the library and dependencies.')).toBeVisible();
    await expect(page.getByText('Final validation summary.')).toBeVisible();
    const chronologicalItems = await page.locator('.messages > .activity-card, .messages > .message').allTextContents();
    const finalMessageIndex = chronologicalItems.findIndex(text => text.includes('Final validation summary.'));
    expect(chronologicalItems.findIndex(text => text.includes('Validate CQL'))).toBeLessThan(finalMessageIndex);
    expect(chronologicalItems.findIndex(text => text.includes('Step completed'))).toBeLessThan(finalMessageIndex);
    expect(finalMessageIndex).toBe(chronologicalItems.length - 1);

    await expect(page.getByRole('button', { name: 'Apply & save' })).toBeEnabled();
    await page.getByRole('button', { name: 'Apply & save' }).click();
    await expect.poll(() => fhirSaved).toBe(true);
    await expect(page.locator('#opencode-save-BrowserOpenCode')).toHaveCount(0);

    await page.locator('.cm-content').click();
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+i' : 'Control+i');
    await expect(page.getByText('Inline edit', { exact: true })).toBeVisible();
    await composer.fill('make this expression easier to read');
    await page.getByRole('button', { name: /Send/ }).click();
    await expect.poll(() => activeFileSync).not.toBeNull();
    await expect.poll(() => promptRequest).not.toBeNull();
    expect(activeFileSync?.['content']).toContain('library BrowserOpenCode');
    expect(promptRequest?.['editorContext']).toMatchObject({
      file: 'libraries/BrowserOpenCode.cql',
      mode: 'inline',
      documentRevision: 0,
    });
    expect(attachmentPromptIds).toEqual(['attachment-1']);

    await page.reload();
    await expect(page.getByText('qwen3.8:27b-mlx')).toBeVisible();

    await page.locator('#environment-switcher').click();
    await page.locator('#environment-switcher-secondary').click();
    await expect(page.locator('#opencode-environment-stale')).toContainText('Environment changed.');
    await expect(page.locator('.composer textarea')).toBeDisabled();
    await expect(page.getByTitle('Attach context files')).toBeDisabled();
  });
});

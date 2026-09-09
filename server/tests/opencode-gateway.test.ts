// Author: Preston Lee

import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import express from 'express';
import type { Server } from 'node:http';
import type { ServerEnv } from '../src/config/env.js';
import { createOpenCodeGateway } from '../src/opencode/gateway.js';

function listen(app: express.Express): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
    server.on('error', reject);
  });
}

function baseUrl(server: Server): string {
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

test('gateway strips browser-only context and retains trusted local Workspace origin', async t => {
  let runnerInput: Record<string, unknown> | undefined;
  let promptInput: Record<string, unknown> | undefined;
  const runnerSession = {
    id: 'runner-session',
    openCodeSessionId: 'opencode-session',
    title: 'Gateway test',
    status: 'idle' as const,
    activeLibraryId: 'library-1',
    activeFile: 'libraries/Test.cql',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    lastActivityAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    model: 'ollama/test',
    reasoningEnabled: false,
  };

  const runner = express();
  runner.use(express.json({ limit: '20mb' }));
  runner.delete('/sessions', (_req, res) => res.status(204).send());
  runner.post('/sessions', (req, res) => {
    runnerInput = req.body as Record<string, unknown>;
    res.status(201).json(runnerSession);
  });
  runner.get('/sessions/runner-session/state', (_req, res) => {
    res.json({
      session: runnerSession,
      messages: [],
      diffs: [],
      attachments: [],
      commands: [],
      validation: null,
      permissions: [],
      questions: [],
      lastEventId: 0,
    });
  });
  runner.post('/sessions/runner-session/prompt', (req, res) => {
    promptInput = req.body as Record<string, unknown>;
    res.status(202).json({ accepted: true });
  });
  runner.delete('/sessions/runner-session', (_req, res) => res.status(204).send());
  const runnerServer = await listen(runner);
  t.after(() => runnerServer.close());

  const env: ServerEnv = {
    port: 3003,
    nodeEnv: 'development',
    logLevel: 'silent',
    corsOrigin: 'http://localhost:4200',
    uiBaseUrl: 'http://localhost:4200',
    ssoIssuerUrl: '',
    ssoClientId: '',
    ssoClientSecret: '',
    ssoClientSecretPrevious: [],
    ssoRedirectUrl: '',
    ssoScopes: 'openid profile email',
    sessionSecret: '',
    sessionSecrets: [],
    databaseUrl: '',
    opencodeEnabled: true,
    opencodeRunnerUrl: baseUrl(runnerServer),
    opencodeRunnerToken: 'test-runner-token',
    opencodeToolBridgeUrl: 'http://127.0.0.1:3003/api/opencode/tool-bridge',
    opencodeSessionIdleMs: 60_000,
    opencodeCleanupIntervalMs: 60_000,
    opencodeMaxSessionsPerUser: 0,
    opencodeMaxSessionsGlobal: 0,
    cqlAssetsDirectory: undefined,
    cqlAssetsUrl: 'http://localhost:4200/cql',
  };

  const gateway = express();
  gateway.use(express.json({ limit: '20mb' }));
  gateway.use('/api/opencode', createOpenCodeGateway(env));
  const gatewayServer = await listen(gateway);
  t.after(() => gatewayServer.close());

  const origin = {
    workspaceId: 'workspace-1',
    workspaceName: 'Quality Workspace',
    resourceReferenceId: 'reference-1',
    role: 'EDITOR' as const,
  };
  const createResponse = await fetch(`${baseUrl(gatewayServer)}/api/opencode/sessions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      provider: { type: 'ollama', model: 'test', baseUrl: 'http://localhost:11434' },
      ollamaBaseUrl: 'http://localhost:11434',
      ollamaModel: 'test',
      activeLibrary: {
        id: 'library-1',
        name: 'Test',
        cqlContent: "library Test version '1.0.0'",
        workspaceOrigin: origin,
      },
      dependencies: [],
      environment: { id: 'environment-1', name: 'Test' },
      toolContext: { vsacApiPassword: 'secret' },
      toolBridge: { baseUrl: 'http://attacker.invalid', capability: 'attacker' },
      resume: { sessionId: 'attacker', createdAt: new Date().toISOString(), messages: ['attacker'] },
    }),
  });
  assert.equal(createResponse.status, 201);
  const created = await createResponse.json() as typeof runnerSession & { workspaceOrigin?: typeof origin };
  assert.deepEqual(created.workspaceOrigin, origin);

  assert.ok(runnerInput);
  assert.equal('environment' in runnerInput, false);
  assert.equal('toolContext' in runnerInput, false);
  assert.equal('resume' in runnerInput, false);
  const activeLibrary = runnerInput['activeLibrary'] as Record<string, unknown>;
  assert.equal('workspaceOrigin' in activeLibrary, false);
  const bridge = runnerInput['toolBridge'] as { baseUrl: string; capability: string };
  assert.equal(bridge.baseUrl, env.opencodeToolBridgeUrl);
  assert.notEqual(bridge.capability, 'attacker');
  assert.ok(bridge.capability.length > 20);

  const stateResponse = await fetch(
    `${baseUrl(gatewayServer)}/api/opencode/sessions/runner-session/state`
  );
  assert.equal(stateResponse.status, 200);
  const state = await stateResponse.json() as { session: { workspaceOrigin?: typeof origin } };
  assert.deepEqual(state.session.workspaceOrigin, origin);

  const promptResponse = await fetch(
    `${baseUrl(gatewayServer)}/api/opencode/sessions/runner-session/prompt`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        message: 'Fix the Problems errors',
        ideDiagnostics: {
          libraryId: 'library-1',
          documentRevision: 3,
          diagnostics: [{ severity: 'error', message: 'Syntax error at define', line: 14 }],
        },
      }),
    }
  );
  assert.equal(promptResponse.status, 202);
  assert.deepEqual(promptInput?.['ideDiagnostics'], {
    libraryId: 'library-1',
    documentRevision: 3,
    diagnostics: [{ severity: 'error', message: 'Syntax error at define', line: 14 }],
  });

  const archiveResponse = await fetch(
    `${baseUrl(gatewayServer)}/api/opencode/sessions/runner-session/archive`,
    { method: 'POST' }
  );
  assert.equal(archiveResponse.status, 204);
});

test('gateway DELETE /sessions removes every live session owned by the caller', async t => {
  const deletedRunnerIds: string[] = [];
  const runnerSession = {
    id: 'runner-session-purge',
    openCodeSessionId: 'opencode-session-purge',
    title: 'Purge test',
    status: 'idle' as const,
    activeLibraryId: 'library-1',
    activeFile: 'libraries/Test.cql',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    lastActivityAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    model: 'ollama/test',
    reasoningEnabled: false,
  };

  const runner = express();
  runner.use(express.json({ limit: '20mb' }));
  runner.delete('/sessions', (_req, res) => res.status(204).send());
  runner.post('/sessions', (_req, res) => res.status(201).json(runnerSession));
  runner.delete('/sessions/:id', (req, res) => {
    deletedRunnerIds.push(req.params.id);
    res.status(204).send();
  });
  const runnerServer = await listen(runner);
  t.after(() => runnerServer.close());

  const env: ServerEnv = {
    port: 3003,
    nodeEnv: 'development',
    logLevel: 'silent',
    corsOrigin: 'http://localhost:4200',
    uiBaseUrl: 'http://localhost:4200',
    ssoIssuerUrl: '',
    ssoClientId: '',
    ssoClientSecret: '',
    ssoClientSecretPrevious: [],
    ssoRedirectUrl: '',
    ssoScopes: 'openid profile email',
    sessionSecret: '',
    sessionSecrets: [],
    databaseUrl: '',
    opencodeEnabled: true,
    opencodeRunnerUrl: baseUrl(runnerServer),
    opencodeRunnerToken: 'test-runner-token',
    opencodeToolBridgeUrl: 'http://127.0.0.1:3003/api/opencode/tool-bridge',
    opencodeSessionIdleMs: 60_000,
    opencodeCleanupIntervalMs: 60_000,
    opencodeMaxSessionsPerUser: 0,
    opencodeMaxSessionsGlobal: 0,
    cqlAssetsDirectory: undefined,
    cqlAssetsUrl: 'http://localhost:4200/cql',
  };

  const gateway = express();
  gateway.use(express.json({ limit: '20mb' }));
  gateway.use('/api/opencode', createOpenCodeGateway(env));
  const gatewayServer = await listen(gateway);
  t.after(() => gatewayServer.close());

  const createResponse = await fetch(`${baseUrl(gatewayServer)}/api/opencode/sessions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      provider: { type: 'ollama', model: 'test', baseUrl: 'http://localhost:11434' },
      ollamaBaseUrl: 'http://localhost:11434',
      ollamaModel: 'test',
      activeLibrary: {
        id: 'library-1',
        name: 'Test',
        cqlContent: "library Test version '1.0.0'",
      },
      dependencies: [],
    }),
  });
  assert.equal(createResponse.status, 201);

  const deleteResponse = await fetch(`${baseUrl(gatewayServer)}/api/opencode/sessions`, {
    method: 'DELETE',
  });
  assert.equal(deleteResponse.status, 200);
  assert.deepEqual(await deleteResponse.json(), { deleted: 1 });
  assert.deepEqual(deletedRunnerIds, ['runner-session-purge']);

  const listAfter = await fetch(`${baseUrl(gatewayServer)}/api/opencode/sessions`);
  assert.equal(listAfter.status, 200);
  assert.deepEqual(await listAfter.json(), []);
});

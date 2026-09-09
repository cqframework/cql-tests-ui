// Author: Preston Lee

import assert from 'node:assert/strict';
import test from 'node:test';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { MCPToolNames, OpenCodeFileToolNames, openCodeFileTools } from '@cql-studio/core';
import type { OpenCodeFileOperation } from '@cql-studio/core';
import { OpenCodeRuntime } from '../src/runtime.js';
import { loadEnv } from '../src/config/env.js';

// Uses the installed OpenCode executable and its real provider/MCP APIs, with a deterministic local provider.
test('real OpenCode edits multiple files and pauses creation/rename for IDE acknowledgement', { timeout: 120_000 }, async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'opencode-api-'));
  const originalXdg = { data: process.env.XDG_DATA_HOME, cache: process.env.XDG_CACHE_HOME, config: process.env.XDG_CONFIG_HOME };
  process.env.XDG_DATA_HOME = path.join(root, 'data');
  process.env.XDG_CACHE_HOME = path.join(root, 'cache');
  process.env.XDG_CONFIG_HOME = path.join(root, 'config');
  let runtime: OpenCodeRuntime | undefined;
  let sessionId = '';
  let step = 0;
  let phase = 'edit';
  const approvals: string[] = [];
  const app = express();
  app.use(express.json({ limit: '20mb' }));
  app.get('/tools', (_req, res) => res.json([
    ...openCodeFileTools,
    { name: MCPToolNames.CQL_VALIDATE, description: 'Validate CQL', parameters: { type: 'object', properties: {} } },
  ]));
  app.post('/execute', async (req, res, next) => {
    try {
      if (req.body.name === MCPToolNames.CQL_VALIDATE) return void res.json({ valid: true, diagnostics: [], checkedAt: new Date().toISOString() });
      res.json(await runtime!.requestFileOperation(sessionId, req.body.name, req.body.arguments));
    } catch (error) { next(error); }
  });
  app.post('/v1/chat/completions', (req, res) => {
    const tools = req.body.tools as Array<{ function: { name: string } }>;
    const actions = phase === 'edit' ? [
      { name: 'read', args: { filePath: 'libraries/Main.cql' } },
      { name: 'read', args: { filePath: 'libraries/Other.cql' } },
      { name: 'edit', args: { filePath: 'libraries/Main.cql', oldString: 'Value: 1', newString: 'Value: 2' } },
      { name: 'edit', args: { filePath: 'libraries/Other.cql', oldString: 'Value: 1', newString: 'Value: 3' } },
    ] : [
      { name: OpenCodeFileToolNames.CREATE, args: { name: 'Shared', content: 'library Shared\ndefine Value: 4' } },
      { name: OpenCodeFileToolNames.RENAME, args: { file: 'libraries/Other.cql', name: 'Renamed', content: 'library Renamed\ndefine Value: 1' } },
    ];
    const action = actions[step++];
    const tool = action && tools.find(tool => tool.function.name === action.name || tool.function.name.endsWith(`_${action.name}`));
    if (action && !tool) return void res.status(500).json({ error: { message: `Missing tool ${action.name}` } });
    res.setHeader('content-type', 'text/event-stream');
    const delta = action ? { role: 'assistant', tool_calls: [{ index: 0, id: `call-${phase}-${step}`, type: 'function', function: { name: tool!.function.name, arguments: JSON.stringify(action.args) } }] } : { role: 'assistant', content: 'Finished.' };
    for (const chunk of [
      { id: `chat-${step}`, object: 'chat.completion.chunk', created: 1, model: 'test', choices: [{ index: 0, delta, finish_reason: null }] },
      { id: `chat-${step}`, object: 'chat.completion.chunk', created: 1, model: 'test', choices: [{ index: 0, delta: {}, finish_reason: action ? 'tool_calls' : 'stop' }] },
    ]) res.write(`data: ${JSON.stringify(chunk)}\n\n`);
    res.end('data: [DONE]\n\n');
  });
  const server = await new Promise<ReturnType<typeof app.listen>>((resolve, reject) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
    server.on('error', reject);
  });
  t.after(async () => {
    if (runtime) {
      await runtime.removeAll();
      runtime['server']?.server.close();
      if (runtime['cleanupTimer']) clearInterval(runtime['cleanupTimer']);
    }
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    for (const [name, value] of [['XDG_DATA_HOME', originalXdg.data], ['XDG_CACHE_HOME', originalXdg.cache], ['XDG_CONFIG_HOME', originalXdg.config]]) {
      if (value === undefined) delete process.env[name!]; else process.env[name!] = value;
    }
    await rm(root, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  runtime = new OpenCodeRuntime({ ...loadEnv(), internalPort: 0, workspaceRoot: path.join(root, 'workspaces'), mcpBridgeBin: path.resolve('dist/mcp-bridge.js'), providerStallMs: 30_000 });
  await runtime.initialize();
  const session = await runtime.create({ ollamaBaseUrl: base, ollamaModel: 'test',
    provider: { type: 'openai-compatible', name: 'test', model: 'test', baseUrl: base },
    activeLibrary: { id: 'main-id', name: 'Main', cqlContent: 'library Main\ndefine Value: 1' },
    libraries: [{ id: 'other-id', name: 'Other', cqlContent: 'library Other\ndefine Value: 1' }],
    toolBridge: { baseUrl: base, capability: 'test' },
  });
  sessionId = session.id;
  const changed: string[] = [];
  const run = async () => {
    const completed = Promise.withResolvers<void>();
    const unsubscribe = runtime!.subscribe(sessionId, envelope => {
      const event = envelope.event;
      if (event.type === 'cql.workspace.changed') changed.push(String(event.properties['libraryId']));
      if (event.type === 'runner.error' || event.type === 'session.error') completed.reject(new Error(JSON.stringify(event.properties)));
      if (event.type === 'permission.asked' && event.properties['metadata']) {
        const operation = (event.properties['metadata'] as { operation: OpenCodeFileOperation }).operation;
        assert.ok(operation);
        approvals.push(operation.kind);
        // Represents the IDE's completed Library save; only then acknowledge to resume the tool.
        void runtime!.permission(sessionId, String(event.properties['id']), 'once').catch(completed.reject);
      }
      if (event.type === 'session.idle' && step >= (phase === 'edit' ? 5 : 3)) completed.resolve();
    }, runtime!.get(sessionId).nextEventId - 1);
    try {
      await runtime!.prompt(sessionId, { message: phase === 'edit' ? 'Edit Main and Other.' : 'Create Shared and rename Other to Renamed.' });
      await completed.promise;
    } finally { unsubscribe(); }
  };
  await run();
  assert.ok(changed.includes('main-id') && changed.includes('other-id'));
  const diffs = await runtime.diff(sessionId);
  assert.deepEqual(diffs.map(diff => diff.libraryId).sort(), ['main-id', 'other-id']);
  await runtime.syncActiveFile(sessionId, { libraryId: 'main-id', content: diffs.find(diff => diff.libraryId === 'main-id')!.after, documentRevision: 0 });
  await runtime.syncActiveFile(sessionId, { libraryId: 'other-id', content: diffs.find(diff => diff.libraryId === 'other-id')!.before, documentRevision: 0 });
  assert.equal((await runtime.diff(sessionId)).length, 0);
  phase = 'operations'; step = 0;
  await run();
  assert.deepEqual(approvals, ['create', 'rename']);
  const files = await runtime.files(sessionId, '', 100);
  assert.ok(files.some(file => file.path === 'libraries/Shared.cql'));
  assert.equal(files.find(file => file.path === 'libraries/Renamed.cql')?.libraryId, 'other-id');
});

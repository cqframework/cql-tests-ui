// Author: Preston Lee

import './load-env.js';
import express from 'express';
import pino from 'pino';
import type { Request, Response, NextFunction } from 'express';
import { timingSafeEqual } from 'node:crypto';
import type { CreateOpenCodeSessionRequest, OpenCodePermissionResponse, OpenCodePromptRequest } from '@cql-studio/core';
import { normalizeOpenCodeError, OpenCodeError } from '@cql-studio/core';
import { loadEnv } from './config/env.js';
import { exitCodeForFatal } from './fatal.js';
import { configureOpenCodeLogger, openCodeLogger } from './logger.js';
import { OpenCodeRuntime } from './runtime.js';

let env: ReturnType<typeof loadEnv>;
try {
  env = loadEnv();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(exitCodeForFatal(error));
}
const app = express();
const runtime = new OpenCodeRuntime(env);
const token = env.runnerToken;
configureOpenCodeLogger(pino({
  level: env.logLevel,
  redact: {
    paths: [
      '*.authorization',
      '*.cookie',
      '*.capability',
      '*.prompt',
      '*.cqlContent',
      '*.toolOutput',
      '*.password',
      '*.token',
      '*.headers.authorization',
    ],
    censor: '[REDACTED]',
  },
}).child({ service: 'opencode-runner' }));
function validToken(candidate: string | undefined): boolean {
  if (!candidate) return false;
  const expected = Buffer.from(token);
  const actual = Buffer.from(candidate);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

app.use(express.json({ limit: '20mb' }));
app.use((req, res, next) => {
  if (req.path === '/health') return next();
  if (!validToken(req.header('x-opencode-runner-token'))) {
    res.status(401).json({ code: 'UNAUTHORIZED', message: 'Unauthorized', retryable: false });
    return;
  }
  next();
});

function asyncHandler(fn: (req: Request, res: Response) => Promise<void>) {
  return (req: Request, res: Response, next: NextFunction): void => {
    void fn(req, res).catch(next);
  };
}

app.get('/health', (_req, res) => res.json(runtime.health()));
app.get('/sessions', (_req, res) => res.json(runtime.list()));

app.post('/sessions', asyncHandler(async (req, res) => {
  const input = req.body as CreateOpenCodeSessionRequest;
  const provider = input?.provider;
  const validProviderType = !provider || provider.type === 'ollama' || provider.type === 'openai' || provider.type === 'openai-compatible';
  if (!input?.activeLibrary?.id || !input.activeLibrary.cqlContent?.trim()) {
    throw new OpenCodeError('INVALID_SESSION', 'An active CQL library with non-empty CQL content is required', 400, false);
  }
  if (!validProviderType) {
    throw new OpenCodeError('INVALID_PROVIDER', 'The AI provider type is not supported', 400, false);
  }
  if (!provider && (!input.ollamaBaseUrl || !input.ollamaModel)) {
    throw new OpenCodeError('INVALID_PROVIDER', 'Ollama base URL and model are required', 400, false);
  }
  if (provider && !provider.model?.trim()) {
    throw new OpenCodeError('INVALID_PROVIDER', 'An AI provider model is required', 400, false);
  }
  if (provider && provider.type !== 'openai' && !provider.baseUrl?.trim()) {
    throw new OpenCodeError('INVALID_PROVIDER', `${provider.type} base URL is required`, 400, false);
  }
  res.status(201).json(await runtime.create(input));
}));

app.get('/sessions/:id', (req, res) => res.json(runtime.get(req.params.id).dto));
app.get('/sessions/:id/state', asyncHandler(async (req, res) => {
  res.json(await runtime.state(req.params.id));
}));
app.get('/sessions/:id/messages', asyncHandler(async (req, res) => {
  res.json(await runtime.messages(req.params.id));
}));
app.get('/sessions/:id/diff', asyncHandler(async (req, res) => {
  res.json(await runtime.diff(req.params.id));
}));
app.post('/sessions/:id/attachments', asyncHandler(async (req, res) => {
  const name = typeof req.body?.name === 'string' ? req.body.name : '';
  const mimeType = typeof req.body?.mimeType === 'string' ? req.body.mimeType : undefined;
  const data = typeof req.body?.data === 'string' ? req.body.data : '';
  res.status(201).json(await runtime.addAttachment(req.params.id, { name, mimeType, data }));
}));
app.delete('/sessions/:id/attachments/:attachmentId', asyncHandler(async (req, res) => {
  await runtime.removeAttachment(req.params.id, req.params.attachmentId);
  res.status(204).send();
}));
app.put('/sessions/:id/active-file', asyncHandler(async (req, res) => {
  const content = typeof req.body?.content === 'string' ? req.body.content : null;
  const documentRevision = Number(req.body?.documentRevision);
  if (content === null || !Number.isFinite(documentRevision) || documentRevision < 0) {
    throw new OpenCodeError('INVALID_ACTIVE_FILE', 'content and a non-negative documentRevision are required', 400, false);
  }
  await runtime.syncActiveFile(req.params.id, { content, documentRevision });
  res.status(204).send();
}));
app.get('/sessions/:id/commands', asyncHandler(async (req, res) => {
  res.json(await runtime.commands(req.params.id));
}));
app.get('/sessions/:id/files', asyncHandler(async (req, res) => {
  res.json(await runtime.files(req.params.id, String(req.query.q ?? ''), Number(req.query.limit) || 30));
}));
app.post('/sessions/:id/commands/:command', asyncHandler(async (req, res) => {
  await runtime.executeCommand(
    req.params.id,
    req.params.command,
    typeof req.body?.arguments === 'string' ? req.body.arguments : '',
    Boolean(req.body?.reasoning)
  );
  res.status(202).json({ accepted: true });
}));
app.post('/sessions/:id/validate', asyncHandler(async (req, res) => {
  res.json(await runtime.validate(req.params.id));
}));

app.post('/sessions/:id/prompt', asyncHandler(async (req, res) => {
  const message = typeof req.body?.message === 'string' ? req.body.message.trim() : '';
  if (!message) {
    throw new OpenCodeError('INVALID_PROMPT', 'message is required', 400, false);
  }
  await runtime.prompt(req.params.id, {
    message,
    agent: req.body?.agent === 'plan' ? 'plan' : 'build',
    references: Array.isArray(req.body?.references) ? req.body.references.filter((item: unknown) => typeof item === 'string') : [],
    attachments: Array.isArray(req.body?.attachments) ? req.body.attachments.filter((item: unknown) => typeof item === 'string') : [],
    reasoning: Boolean(req.body?.reasoning),
    editorContext: req.body?.editorContext && typeof req.body.editorContext === 'object' ? {
      file: String(req.body.editorContext.file ?? ''),
      selectedText: String(req.body.editorContext.selectedText ?? ''),
      startLine: Number(req.body.editorContext.startLine) || 1,
      startColumn: Number(req.body.editorContext.startColumn) || 0,
      endLine: Number(req.body.editorContext.endLine) || 1,
      endColumn: Number(req.body.editorContext.endColumn) || 0,
      documentRevision: Math.max(0, Number(req.body.editorContext.documentRevision) || 0),
      mode: req.body.editorContext.mode === 'inline' ? 'inline' : 'selection',
    } : undefined,
    ideDiagnostics: req.body?.ideDiagnostics && typeof req.body.ideDiagnostics === 'object' ? {
      libraryId: String(req.body.ideDiagnostics.libraryId ?? ''),
      documentRevision: Math.max(0, Number(req.body.ideDiagnostics.documentRevision) || 0),
      diagnostics: Array.isArray(req.body.ideDiagnostics.diagnostics)
        ? req.body.ideDiagnostics.diagnostics.slice(0, 100).flatMap((item: unknown) => {
            if (!item || typeof item !== 'object') return [];
            const value = item as Record<string, unknown>;
            const severity = value['severity'];
            const message = typeof value['message'] === 'string' ? value['message'].trim().slice(0, 2_000) : '';
            if (!message || !['error', 'warning', 'info'].includes(String(severity))) return [];
            const line = Number(value['line']);
            const column = Number(value['column']);
            return [{
              severity: severity as 'error' | 'warning' | 'info',
              message,
              ...(typeof value['file'] === 'string' ? { file: value['file'].slice(0, 500) } : {}),
              ...(Number.isFinite(line) && line >= 1 ? { line: Math.trunc(line) } : {}),
              ...(Number.isFinite(column) && column >= 0 ? { column: Math.trunc(column) } : {}),
            }];
          })
        : [],
    } : undefined,
  } satisfies OpenCodePromptRequest);
  res.status(202).json({ accepted: true });
}));
app.post('/sessions/:id/model', asyncHandler(async (req, res) => {
  const provider = req.body?.provider;
  const model = typeof req.body?.model === 'string' ? req.body.model : '';
  await runtime.switchModel(req.params.id, { provider, model });
  res.status(204).send();
}));

app.post('/sessions/:id/abort', asyncHandler(async (req, res) => {
  await runtime.abort(req.params.id);
  res.json({ aborted: true });
}));

app.post('/sessions/:id/permissions/:permissionId', asyncHandler(async (req, res) => {
  const response = req.body?.response as OpenCodePermissionResponse;
  if (!['once', 'always', 'reject'].includes(response)) {
    throw new OpenCodeError('INVALID_PERMISSION_RESPONSE', 'response must be once, always, or reject', 400, false);
  }
  await runtime.permission(req.params.id, req.params.permissionId, response);
  res.json({ accepted: true });
}));

app.post('/sessions/:id/questions/:requestId', asyncHandler(async (req, res) => {
  const answers = req.body?.answers;
  if (!Array.isArray(answers) || !answers.every(answer => Array.isArray(answer) && answer.every(item => typeof item === 'string'))) {
    throw new OpenCodeError('INVALID_QUESTION_RESPONSE', 'answers must be an array of string arrays', 400, false);
  }
  await runtime.answerQuestion(req.params.id, req.params.requestId, answers);
  res.json({ accepted: true });
}));

app.delete('/sessions/:id/questions/:requestId', asyncHandler(async (req, res) => {
  await runtime.rejectQuestion(req.params.id, req.params.requestId);
  res.status(204).send();
}));

app.get('/sessions/:id/events', (req, res, next) => {
  try {
    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();
    const lastEventId = Number(req.get('last-event-id') ?? req.query.after ?? 0) || 0;
    const unsubscribe = runtime.subscribe(req.params.id, envelope => {
      res.write(`id: ${envelope.id}\n`);
      res.write(`data: ${JSON.stringify(envelope)}\n\n`);
    }, lastEventId);
    const heartbeat = setInterval(() => res.write(': heartbeat\n\n'), 15_000);
    req.on('close', () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
  } catch (error) {
    next(error);
  }
});

app.delete('/sessions/:id', asyncHandler(async (req, res) => {
  await runtime.remove(req.params.id);
  res.status(204).send();
}));
app.delete('/sessions', asyncHandler(async (_req, res) => {
  await runtime.removeAll();
  res.status(204).send();
}));

app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
  const normalized = normalizeOpenCodeError(error);
  openCodeLogger.error({ operation: 'runner.request', code: normalized.code, status: normalized.status, err: normalized }, normalized.message);
  res.status(normalized.status).json(normalized.toBody());
});

await runtime.initialize();
app.listen(env.runnerPort, '127.0.0.1', () => {
  openCodeLogger.info({ operation: 'runner.listen', port: env.runnerPort }, 'CQL Studio OpenCode runner listening');
});

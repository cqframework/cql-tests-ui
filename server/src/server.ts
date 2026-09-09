// Author: Preston Lee

import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import { pinoHttp } from 'pino-http';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
import { loadEnv } from './config/env.js';
import { createCorsOptions } from './config/cors.js';
import { createLogger, logger } from './logger.js';
import { applyPendingMigrations } from './db/migrate.js';
import { mcpRouter } from './mcp/index.js';
import { ollamaProxyRouter } from './ollama/proxy.js';
import { vsacFhirProxyRouter, vsacSiteProxyRouter } from './vsac/proxy.js';
import { createAuthRouter } from './auth/routes.js';
import { createTeamRouter } from './team/routes.js';
import { createActivityRouter, createWorkspaceRouter } from './workspace/routes.js';
import { createOpenCodeGateway } from './opencode/gateway.js';
import { OpenCodeError } from '@cql-studio/core';
import { configureOpenCodeLogger } from './opencode/logger.js';
import { createUserSettingsRouter } from './user/routes.js';

// Package-local values take precedence when .env exists. Variables omitted by
// the file remain available from the parent shell environment.
const localEnvFile = fileURLToPath(new URL('../.env', import.meta.url));
if (existsSync(localEnvFile)) {
  Object.assign(process.env, parseEnv(readFileSync(localEnvFile, 'utf8')));
}

async function main(): Promise<void> {
  const env = loadEnv();
  configureOpenCodeLogger(createLogger(env));
  const isDev = env.nodeEnv === 'development';

  await applyPendingMigrations(env);

  const app = express();

  app.use(cors(createCorsOptions(env)));
  app.use(express.urlencoded({ extended: true }));
  app.use(cookieParser());
  app.use(pinoHttp({ logger }));

  if (env.opencodeEnabled) {
    app.use(
      '/api/opencode',
      express.json({ limit: '20mb' }),
      createOpenCodeGateway(env)
    );
  }
  app.use(express.json({ limit: '2mb' }));

  app.get('/health', (_req, res) => {
    res.json({
      status: 'ok',
      timestamp: new Date().toISOString(),
      ssoEnabled: true,
      opencodeEnabled: env.opencodeEnabled,
    });
  });

  app.use('/', mcpRouter);
  app.use('/api/ollama', ollamaProxyRouter);
  app.use('/api/vsac/fhir', vsacFhirProxyRouter);
  app.use('/api/vsac/site', vsacSiteProxyRouter);
  app.use('/api/auth', createAuthRouter(env));
  app.use('/api/teams', createTeamRouter(env));
  app.use('/api/workspaces', createWorkspaceRouter(env));
  app.use('/api/activity', createActivityRouter(env));
  app.use('/api/users', createUserSettingsRouter(env));

  app.use((err: Error, req: express.Request, res: express.Response, _next: express.NextFunction) => {
    if (err instanceof OpenCodeError) {
      logger.error(
        {
          method: req.method,
          path: req.path,
          status: err.status,
          code: err.code,
          err: isDev ? err : undefined,
        },
        'OpenCode request failed'
      );
      if (!res.headersSent) res.status(err.status).json(err.toBody());
      return;
    }
    const oauthErr = err as Error & { error?: string; error_description?: string };
    const oauthDetail =
      oauthErr.error
        ? `${oauthErr.error}${oauthErr.error_description ? `: ${oauthErr.error_description}` : ''}`
        : '';
    const message = oauthDetail || err?.message || 'Internal server error';
    logger.error(
      {
        method: req.method,
        path: req.path,
        err: isDev ? err : undefined,
        message,
      },
      'Request error'
    );
    if (!res.headersSent) {
      res.status(oauthErr.error === 'access_denied' ? 403 : 500).json({
        error: message,
        ...(oauthErr.error && { oauthError: oauthErr.error }),
        ...(oauthErr.error_description && { oauthErrorDescription: oauthErr.error_description }),
      });
    }
  });

  app.use((req, res) => {
    logger.warn({ method: req.method, path: req.path }, 'Not found');
    res.status(404).json({ error: 'Not found' });
  });

  app.listen(env.port, () => {
    logger.info(
      {
        port: env.port,
        nodeEnv: env.nodeEnv,
        sso: 'enabled',
        uiBaseUrl: env.uiBaseUrl,
        corsOrigin: `${env.corsOrigin} (credentials)`,
        opencode: env.opencodeEnabled ? 'enabled' : 'disabled',
      },
      'CQL Studio Server listening'
    );
  });
}

main().catch((err) => {
  // loadEnv may fail before createLogger; ensure the message is visible
  if (logger.level === 'silent') {
    logger.level = 'error';
  }
  logger.error(
    { err: err instanceof Error ? err : undefined, message: err instanceof Error ? err.message : err },
    '[startup] Fatal error'
  );
  process.exit(1);
});

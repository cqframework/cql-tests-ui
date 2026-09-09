// Author: Preston Lee

import { OpenCodeExitCode, OpenCodeFatalError } from '../fatal.js';

export const PINO_LOG_LEVELS = [
  'fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent',
] as const;

export type PinoLogLevel = (typeof PINO_LOG_LEVELS)[number];
export const DEFAULT_RUNNER_TOKEN = 'cql-studio-opencode-development-only';

export interface OpenCodeEnv {
  nodeEnv: string;
  logLevel: PinoLogLevel;
  runnerHost: string;
  runnerPort: number;
  runnerToken: string;
  internalPort: number;
  sessionIdleMs: number;
  cleanupIntervalMs: number;
  providerStallMs: number;
  rewriteLocalhost: boolean;
  workspaceRoot: string;
  mcpBridgeBin?: string;
  markitdownBin?: string;
}

function configError(message: string): never {
  throw new OpenCodeFatalError(message, OpenCodeExitCode.CONFIG);
}

function required(name: string, value: string | undefined): string {
  const trimmed = value?.trim() ?? '';
  if (!trimmed) configError(`${name} is required`);
  return trimmed;
}

function parseLogLevel(raw: string | undefined): PinoLogLevel {
  const level = (raw?.trim() || 'info').toLowerCase();
  if (!(PINO_LOG_LEVELS as readonly string[]).includes(level)) {
    configError(`CQL_STUDIO_OPENCODE_LOG_LEVEL must be one of: ${PINO_LOG_LEVELS.join(', ')} (got "${raw}")`);
  }
  return level as PinoLogLevel;
}

function positiveInteger(name: string, raw: string | undefined, fallback: number): number {
  if (raw === undefined || !raw.trim()) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) configError(`${name} must be a positive integer`);
  return value;
}

function requiredPort(name: string, raw: string | undefined): number {
  const value = Number(required(name, raw));
  if (!Number.isSafeInteger(value) || value <= 0 || value > 65_535) {
    configError(`${name} must be an integer between 1 and 65535`);
  }
  return value;
}

function parseBoolean(name: string, raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined || !raw.trim()) return fallback;
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  configError(`${name} must be true or false`);
}

export function loadEnv(source: NodeJS.ProcessEnv = process.env): OpenCodeEnv {
  const nodeEnv = source.CQL_STUDIO_OPENCODE_NODE_ENV?.trim() || 'development';
  const runnerToken = source.CQL_STUDIO_OPENCODE_RUNNER_TOKEN?.trim() || DEFAULT_RUNNER_TOKEN;
  if (
    nodeEnv !== 'development' &&
    (runnerToken === DEFAULT_RUNNER_TOKEN || Buffer.byteLength(runnerToken) < 32)
  ) {
    configError(
      'CQL_STUDIO_OPENCODE_RUNNER_TOKEN must be a non-default secret of at least 32 bytes when CQL_STUDIO_OPENCODE_NODE_ENV is not development'
    );
  }

  const runnerHost = required('CQL_STUDIO_OPENCODE_RUNNER_HOST', source.CQL_STUDIO_OPENCODE_RUNNER_HOST);
  const runnerPort = requiredPort('CQL_STUDIO_OPENCODE_RUNNER_PORT', source.CQL_STUDIO_OPENCODE_RUNNER_PORT);
  const internalPort = requiredPort('CQL_STUDIO_OPENCODE_INTERNAL_PORT', source.CQL_STUDIO_OPENCODE_INTERNAL_PORT);
  if (runnerPort === internalPort) {
    configError(`CQL_STUDIO_OPENCODE_RUNNER_PORT and CQL_STUDIO_OPENCODE_INTERNAL_PORT must differ (both are ${runnerPort})`);
  }

  return {
    nodeEnv,
    logLevel: parseLogLevel(source.CQL_STUDIO_OPENCODE_LOG_LEVEL),
    runnerHost,
    runnerPort,
    runnerToken,
    internalPort,
    sessionIdleMs: positiveInteger('CQL_STUDIO_OPENCODE_SESSION_IDLE_MS', source.CQL_STUDIO_OPENCODE_SESSION_IDLE_MS, 3_600_000),
    cleanupIntervalMs: positiveInteger('CQL_STUDIO_OPENCODE_CLEANUP_INTERVAL_MS', source.CQL_STUDIO_OPENCODE_CLEANUP_INTERVAL_MS, 60_000),
    providerStallMs: positiveInteger('CQL_STUDIO_OPENCODE_PROVIDER_STALL_MS', source.CQL_STUDIO_OPENCODE_PROVIDER_STALL_MS, 180_000),
    rewriteLocalhost: parseBoolean('CQL_STUDIO_OPENCODE_RUNNER_REWRITE_LOCALHOST', source.CQL_STUDIO_OPENCODE_RUNNER_REWRITE_LOCALHOST, false),
    workspaceRoot: source.CQL_STUDIO_OPENCODE_WORKSPACE_ROOT?.trim() || './workspaces',
    mcpBridgeBin: source.CQL_STUDIO_OPENCODE_MCP_BRIDGE_BIN?.trim() || undefined,
    markitdownBin: source.CQL_STUDIO_OPENCODE_MARKITDOWN_BIN?.trim() || undefined,
  };
}

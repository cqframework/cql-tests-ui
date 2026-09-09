// Author: Preston Lee

import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_RUNNER_TOKEN, loadEnv } from '../src/config/env.js';
import { OpenCodeFatalError } from '../src/fatal.js';

const development = (): NodeJS.ProcessEnv => ({ CQL_STUDIO_OPENCODE_NODE_ENV: 'development' });

test('uses host-safe OpenCode defaults', () => {
  const env = loadEnv(development());
  assert.equal(env.runnerPort, 4097);
  assert.equal(env.internalPort, 4096);
  assert.equal(env.runnerToken, DEFAULT_RUNNER_TOKEN);
  assert.equal(env.workspaceRoot, './workspaces');
  assert.equal(env.rewriteLocalhost, false);
  assert.equal(env.providerStallMs, 180_000);
});

test('validates ports and durations', () => {
  assert.throws(
    () => loadEnv({ ...development(), CQL_STUDIO_OPENCODE_RUNNER_PORT: '4096', CQL_STUDIO_OPENCODE_INTERNAL_PORT: '4096' }),
    OpenCodeFatalError
  );
  assert.throws(
    () => loadEnv({ ...development(), CQL_STUDIO_OPENCODE_SESSION_IDLE_MS: '0' }),
    OpenCodeFatalError
  );
  assert.throws(
    () => loadEnv({ ...development(), CQL_STUDIO_OPENCODE_RUNNER_REWRITE_LOCALHOST: 'yes' }),
    OpenCodeFatalError
  );
});

test('requires a non-default production token', () => {
  assert.throws(
    () => loadEnv({ CQL_STUDIO_OPENCODE_NODE_ENV: 'production' }),
    /non-default secret/
  );
  assert.equal(loadEnv({
    CQL_STUDIO_OPENCODE_NODE_ENV: 'production',
    CQL_STUDIO_OPENCODE_RUNNER_TOKEN: 'a-production-runner-token-over-32-bytes',
  }).runnerToken, 'a-production-runner-token-over-32-bytes');
});

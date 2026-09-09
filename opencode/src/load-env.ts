// Author: Preston Lee

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';

// Package-local values take precedence when .env exists. Variables omitted by
// the file remain available from the parent shell environment.
const localEnvFile = fileURLToPath(new URL('../.env', import.meta.url));
if (existsSync(localEnvFile)) {
  Object.assign(process.env, parseEnv(readFileSync(localEnvFile, 'utf8')));
}

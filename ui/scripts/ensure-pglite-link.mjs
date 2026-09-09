// Author: Preston Lee
//
// npm workspaces hoist @electric-sql/pglite to the repo-root node_modules.
// Angular's asset pipeline requires input paths under ui/, and forbids
// ../node_modules. Symlink the hoisted package into ui/node_modules so the
// original angular.json entries (node_modules/@electric-sql/pglite/dist → /pglite/)
// keep working without copying multi-MB WASM/FS binaries into public/.

import { existsSync, lstatSync, mkdirSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const uiRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const target = join(uiRoot, '..', 'node_modules', '@electric-sql', 'pglite');
const linkPath = join(uiRoot, 'node_modules', '@electric-sql', 'pglite');

if (!existsSync(target)) {
  console.error(
    `ensure-pglite-link: missing ${target}. Run npm install from the repo root.`,
  );
  process.exit(1);
}

mkdirSync(dirname(linkPath), { recursive: true });

if (existsSync(linkPath) || isSymlink(linkPath)) {
  try {
    if (isSymlink(linkPath) && realpathSync(linkPath) === realpathSync(target)) {
      process.exit(0);
    }
  } catch {
    // fall through and recreate
  }
  rmSync(linkPath, { recursive: true, force: true });
}

const linkType = process.platform === 'win32' ? 'junction' : 'dir';
symlinkSync(relative(dirname(linkPath), target), linkPath, linkType);
console.log(`ensure-pglite-link: ${linkPath} → ${target}`);

function isSymlink(path) {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

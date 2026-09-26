// ──────────────────────────────────────────────
// Where things live, in one place
// ──────────────────────────────────────────────
//
// The repository root (package.json, manifest.json, data/) is two levels up
// from src/proxy/. Every module that needs a path on disk asks here instead of
// counting '..' itself, so moving a file never silently points it elsewhere.

import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Repository root: package.json, manifest.json, data/, launcher/. */
export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Runtime data (stats, caches, debug dumps). Local only, never committed. */
export const DATA_DIR = join(ROOT, 'data');

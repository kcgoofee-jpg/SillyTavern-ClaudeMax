#!/usr/bin/env node
// Run the Claude CLI bundled inside the Agent SDK (no global install needed):
//   npm run login     → claude auth login
//   npm run auth      → claude auth status
// Honors CLAUDE_SUBSCRIPTION_CLAUDE_PATH like the proxy does.

import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);

function bundledCli() {
    if (process.env.CLAUDE_SUBSCRIPTION_CLAUDE_PATH) return process.env.CLAUDE_SUBSCRIPTION_CLAUDE_PATH;
    const pkg = `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}`;
    try {
        const dir = dirname(require.resolve(`${pkg}/package.json`));
        return join(dir, process.platform === 'win32' ? 'claude.exe' : 'claude');
    } catch {
        console.error(`找不到 ${pkg} — 请在本目录运行 npm install（不要加 --omit=optional）。`);
        process.exit(1);
    }
}

const result = spawnSync(bundledCli(), process.argv.slice(2), { stdio: 'inherit' });
process.exit(result.status ?? 1);

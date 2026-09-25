// ──────────────────────────────────────────────
// SillyTavern Server Plugin — Claude (Subscription) Proxy v2
// ──────────────────────────────────────────────
//
// Exposes an OpenAI-compatible chat-completions API backed by the local
// Claude Agent SDK, billing against an Anthropic Pro/Max subscription. The
// chat endpoints run on a *separate* HTTP listener (default 127.0.0.1:8901)
// so they sit outside SillyTavern's CSRF middleware — see lib/listener.js.
//
// v2 additions:
//   • Companion UI extension ("Claude Max") is auto-installed/updated into
//     SillyTavern's third-party extensions on startup — it provides one-click
//     connection (no URL typing), Claude-native reasoning-effort control
//     (low/medium/high/xhigh/max), thinking display, and a quota meter.
//   • Fable 5.1 / Opus 5 / explicit "(1M context)" model variants.
//   • Synthetic-session resume (real multi-turn context + prompt caching).
//   • OAuth auto-refresh, rate-limit retries, Extra-Usage fallback.
//
// Env overrides:
//   CLAUDE_SUBSCRIPTION_PORT=8901       listener port
//   CLAUDE_SUBSCRIPTION_HOST=127.0.0.1  listener host
//   CLAUDE_SUBSCRIPTION_USE_RESUME=0    force the v1 transcript-fold path
//   CLAUDE_SUBSCRIPTION_MAX_TURNS=N     SDK maxTurns override (default 1)
//   CLAUDE_SUBSCRIPTION_CLAUDE_PATH=…   explicit claude executable
//   CLAUDE_SUBSCRIPTION_NO_UI_INSTALL=1 skip the UI-extension auto-install

import express from 'express';
import { cpSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { handleStatus } from './lib/status.js';
import { handleQuota } from './lib/oauth.js';
import { handleStats } from './lib/usage-stats.js';
import { handleDebugLast } from './lib/debug-dump.js';
import { startStandaloneListener, stopStandaloneListener, probeExistingProxy, portInUseMessage } from './lib/listener.js';

const DEFAULT_PORT = 8901;
const DEFAULT_HOST = '127.0.0.1';
const UI_EXTENSION_DIR_NAME = 'SillyTavern-ClaudeMax';

export const info = {
    id: 'claude-subscription',
    name: 'Claude (Subscription) Proxy',
    description:
        'Routes chat through the local Claude Agent SDK so it bills against your Anthropic Pro / Max ' +
        'subscription instead of an sk-ant-* API key. Fable 5.1 / Opus 5 / 1M context / reasoning ' +
        'effort / thinking display / quota meter. Pairs with the auto-installed "Claude Max" UI extension.',
};

/** true if dotted version a is strictly newer than b (numeric compare). */
function isNewerVersion(a, b) {
    const pa = String(a).split('.').map((n) => parseInt(n, 10) || 0);
    const pb = String(b).split('.').map((n) => parseInt(n, 10) || 0);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
        const x = pa[i] ?? 0;
        const y = pb[i] ?? 0;
        if (x !== y) return x > y;
    }
    return false;
}

// The UI extension lives at the REPO ROOT (manifest.json + index.js +
// style.css) so the repo can ALSO be installed directly through
// SillyTavern's "Install extension" dialog, which requires a root
// manifest.json. Only these files make up the extension.
const UI_EXTENSION_FILES = ['manifest.json', 'index.js', 'style.css', 'lib/chat-check.js', 'lib/preset-reco.js', 'lib/lore-constant.js', 'lib/card-audit.js'];

/**
 * Install or update the companion UI extension into SillyTavern's
 * third-party extensions directory. The plugin runs in-process inside
 * SillyTavern (plugins/<id>/), so the public directory is two levels up.
 * Version-gated: only copies when missing or strictly older — a manually
 * updated (newer) extension is never downgraded.
 *
 * If the user already installed the repo through SillyTavern's "Install
 * extension" dialog (a full clone in third-party, git-managed and updated
 * by ST itself), the auto-install stands down — the extension's runtime
 * window-guard would dedupe anyway, but skipping avoids a confusing
 * second copy.
 */
function installUiExtension() {
    if (/^(1|true|yes|on)$/i.test(process.env.CLAUDE_SUBSCRIPTION_NO_UI_INSTALL ?? '')) return;

    try {
        const here = dirname(fileURLToPath(import.meta.url));
        if (!existsSync(join(here, 'manifest.json'))) return;

        // plugins/<id>/ normally sits two levels under the ST root, but Node
        // resolves symlinks for ESM — a symlinked dev checkout reports its
        // real path. ST always runs with its root as cwd, so try that too.
        const stRoot = [resolve(here, '..', '..'), process.cwd()]
            .find((root) => existsSync(join(root, 'public', 'scripts', 'extensions')));
        const thirdParty = stRoot ? join(stRoot, 'public', 'scripts', 'extensions', 'third-party') : null;
        if (!thirdParty || !existsSync(thirdParty)) {
            console.warn(`[${info.id}] SillyTavern third-party extension dir not found — install the UI extension manually (see README).`);
            return;
        }

        // Dialog-installed clone present? It's git-managed by ST — let it own
        // the extension and skip the auto-copy.
        // Old repo name first, then the current one. A git clone at the
        // auto-install target (the repo is now named SillyTavern-ClaudeMax
        // too) is ST-managed — never copy files over it.
        const dialogClones = ['SillyTavern-ClaudeSubscription', UI_EXTENSION_DIR_NAME].flatMap((name) => [
            join(thirdParty, name),
            join(stRoot, 'data', 'default-user', 'extensions', name),
        ]);
        if (dialogClones.some((dir) => existsSync(join(dir, 'manifest.json')) && (existsSync(join(dir, '.git')) || !dir.endsWith(UI_EXTENSION_DIR_NAME)))) {
            console.log(`[${info.id}] UI extension already installed via SillyTavern's extension installer — auto-install skipped`);
            return;
        }

        const target = join(thirdParty, UI_EXTENSION_DIR_NAME);
        const srcVersion = JSON.parse(readFileSync(join(here, 'manifest.json'), 'utf8')).version ?? '0.0.0';
        let installedVersion = null;
        if (existsSync(join(target, 'manifest.json'))) {
            try {
                installedVersion = JSON.parse(readFileSync(join(target, 'manifest.json'), 'utf8')).version ?? '0.0.0';
            } catch { /* corrupted manifest → reinstall */ }
        }

        if (installedVersion !== null && !isNewerVersion(srcVersion, installedVersion)) return;

        mkdirSync(target, { recursive: true });
        for (const file of UI_EXTENSION_FILES) {
            mkdirSync(dirname(join(target, file)), { recursive: true });
            cpSync(join(here, file), join(target, file));
        }
        console.log(
            `[${info.id}] ${installedVersion ? `updated UI extension ${installedVersion} → ${srcVersion}` : `installed UI extension v${srcVersion}`} ` +
            `at public/scripts/extensions/third-party/${UI_EXTENSION_DIR_NAME} (hard-refresh the browser to load it)`,
        );
    } catch (err) {
        console.warn(`[${info.id}] UI extension auto-install failed:`, err instanceof Error ? err.message : err);
    }
}

export async function init(router) {
    // SillyTavern-mounted routes (GET is CSRF-exempt): /status for browser
    // health checks, /quota so the UI extension can read quota SAME-ORIGIN —
    // a direct browser fetch to 127.0.0.1:8901 resolves to the CLIENT device
    // and fails whenever SillyTavern is browsed from a phone/another PC.
    router.use(express.json({ limit: '50mb' }));
    router.get('/status', handleStatus);
    router.get('/quota', handleQuota);
    router.get('/stats', handleStats);
    router.get('/debug', handleDebugLast);

    installUiExtension();

    const port = parseInt(process.env.CLAUDE_SUBSCRIPTION_PORT, 10) || DEFAULT_PORT;
    const host = process.env.CLAUDE_SUBSCRIPTION_HOST || DEFAULT_HOST;

    // Probe first: on macOS a standalone proxy bound to 0.0.0.0 does not stop
    // us binding 127.0.0.1 on the same port, and then local requests would go
    // to this copy while the phone talks to the other (seen live: two proxies
    // on 8901, the one inside SillyTavern running older code).
    if (await probeExistingProxy({ port, host })) {
        console.log(`[${info.id}] reusing the standalone proxy already running at http://${host}:${port}/v1 (npm start / launcher)`);
        return;
    }
    try {
        await startStandaloneListener({ port, host });
        console.log(
            `[${info.id}] initialised — endpoint http://${host}:${port}/v1 ` +
            '(use the "Claude Max" panel in the Extensions drawer to connect)',
        );
    } catch (err) {
        if (err?.code === 'EADDRINUSE' && await probeExistingProxy({ port, host })) {
            console.log(`[${info.id}] reusing the standalone proxy already running at http://${host}:${port}/v1 (npm start)`);
            return;
        }
        if (err?.code === 'EADDRINUSE') console.error(portInUseMessage(port));
        console.error(
            `[${info.id}] failed to start standalone listener — chat completions will not work. ` +
            'Status endpoint on /api/plugins/claude-subscription/status remains available.',
            err,
        );
    }
}

export async function exit() {
    await stopStandaloneListener();
    console.log(`[${info.id}] shut down`);
}

export default { info, init, exit };

// ──────────────────────────────────────────────
// Standalone HTTP listener (separate from SillyTavern's Express app)
// ──────────────────────────────────────────────
//
// SillyTavern wraps its entire Express app in CSRF protection
// (server-main.js — csrfSync mounted before plugins load). When SillyTavern's
// chat-completions backend issues a server-side outbound fetch to whatever
// URL the user put in "Custom Endpoint", that loopback request has no CSRF
// token and gets a 403 Forbidden — even if the URL points at one of our own
// /api/plugins routes. The clean fix is a separate port outside SillyTavern's
// middleware stack.
//
// GET routes carry permissive CORS so the companion UI extension (running on
// the SillyTavern browser origin) can read /status and /v1/usage/quota
// directly. The listener binds 127.0.0.1 by default; POST /v1/chat/completions
// is only ever called server-side by SillyTavern itself.

import express from 'express';

import { handleChatCompletions, rejectEmbeddings } from './chat.js';
import { listModelsHandler } from './models.js';
import { handleStatus } from './status.js';
import { handleQuota } from './oauth.js';
import { handleStats } from './usage-stats.js';
import { handleDebugLast } from './debug-dump.js';

let serverInstance = null;

// Reflect only loopback origins — a wildcard would let ANY web page the user
// visits read subscription/billing data off these unauthenticated GETs.
// TauriTavern's WebView serves the UI from tauri://localhost (macOS/Linux)
// or http(s)://tauri.localhost (Windows/Android).
const LOOPBACK_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i;
const TAURI_ORIGIN = /^(tauri:\/\/localhost|https?:\/\/tauri\.localhost)$/i;

export function isAllowedOrigin(origin) {
    return !!origin && (LOOPBACK_ORIGIN.test(origin) || TAURI_ORIGIN.test(origin));
}

function allowCorsGet(req, res, next) {
    const origin = req.headers.origin;
    if (isAllowedOrigin(origin)) {
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Vary', 'Origin');
    }
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    next();
}

export function startStandaloneListener({ port, host }) {
    if (serverInstance) return Promise.resolve(serverInstance);

    const app = express();
    app.use(express.json({ limit: '100mb' }));

    app.get('/status', allowCorsGet, handleStatus);
    app.get('/v1/models', allowCorsGet, listModelsHandler);
    app.get('/v1/usage/quota', allowCorsGet, handleQuota);
    app.get('/v1/usage/stats', allowCorsGet, handleStats);
    app.get('/v1/debug/last', allowCorsGet, handleDebugLast);
    app.options(['/status', '/v1/models', '/v1/usage/quota', '/v1/usage/stats', '/v1/debug/last'], allowCorsGet, (_req, res) => res.sendStatus(204));
    app.post('/v1/chat/completions', handleChatCompletions);
    app.post('/v1/embeddings', rejectEmbeddings);

    return new Promise((resolve, reject) => {
        const server = app.listen(port, host, () => {
            serverInstance = server;
            console.log(
                `[claude-subscription] standalone listener: http://${host}:${port}/v1 ` +
                '(the companion UI extension configures SillyTavern automatically)',
            );
            resolve(server);
        });

        server.on('error', (err) => {
            // EADDRINUSE is reported by the caller — the plugin may reuse a
            // standalone proxy already listening there.
            if (!err || err.code !== 'EADDRINUSE') {
                console.error('[claude-subscription] listener error:', err);
            }
            reject(err);
        });
    });
}

export function portInUseMessage(port) {
    return `[claude-subscription] port ${port} is already in use. Set ` +
        'CLAUDE_SUBSCRIPTION_PORT to a free port and restart — then update ' +
        '"Endpoint (advanced)" in the Claude Max panel to match.';
}

/** Is the process on host:port our own proxy? (standalone `npm start`) */
export async function probeExistingProxy({ port, host }) {
    try {
        const res = await fetch(`http://${host.includes(':') ? `[${host}]` : host}:${port}/status`, { signal: AbortSignal.timeout(3000) });
        const body = await res.json();
        return body?.plugin === 'claude-subscription';
    } catch {
        return false;
    }
}

export function stopStandaloneListener() {
    if (!serverInstance) return Promise.resolve();
    return new Promise((resolve) => {
        serverInstance.close(() => {
            serverInstance = null;
            resolve();
        });
    });
}

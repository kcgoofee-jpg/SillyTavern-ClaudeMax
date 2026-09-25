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

// DNS rebinding guard: a web page on evil.example can point its own name at
// 127.0.0.1 and then talk to this unauthenticated proxy as "same origin" —
// spending the subscription or reading /v1/debug/last. Browsers always send
// the name they looked up as Host, so only accept loopback names, the bind
// host itself, IP literals when bound to every interface (LAN use), and
// whatever CLAUDE_SUBSCRIPTION_ALLOWED_HOSTS lists.
const LOOPBACK_HOST = /^(localhost|127\.\d+\.\d+\.\d+|\[::1\]|tauri\.localhost)$/i;
const IP_LITERAL = /^(\d+\.\d+\.\d+\.\d+|\[[0-9a-f:.]+\])$/i;

export function isAllowedHost(hostHeader, bindHost, extra = process.env.CLAUDE_SUBSCRIPTION_ALLOWED_HOSTS) {
    if (!hostHeader) return true; // HTTP/1.0 clients; a browser always sends Host
    const name = String(hostHeader).replace(/:\d+$/, '').toLowerCase();
    if (LOOPBACK_HOST.test(name)) return true;
    const bind = String(bindHost ?? '').toLowerCase();
    if (name === bind || `[${bind}]` === name) return true;
    if ((bind === '0.0.0.0' || bind === '::') && IP_LITERAL.test(name)) return true;
    return String(extra ?? '').split(',').map((h) => h.trim().toLowerCase()).filter(Boolean).includes(name);
}

function guardHost(bindHost) {
    return (req, res, next) => {
        if (isAllowedHost(req.headers.host, bindHost)) return next();
        res.status(403).json({ error: { message: `Host "${req.headers.host}" is not allowed. Add it to CLAUDE_SUBSCRIPTION_ALLOWED_HOSTS if this is intended.` } });
    };
}

// Chat is called server-side by SillyTavern / TauriTavern (no Origin header).
// A browser page from another origin always sends one — refuse it.
function guardPostOrigin(req, res, next) {
    const origin = req.headers.origin;
    if (!origin || isAllowedOrigin(origin)) return next();
    res.status(403).json({ error: { message: `Origin ${origin} is not allowed.` } });
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
    app.disable('x-powered-by');
    app.use(guardHost(host));
    app.use(express.json({ limit: '100mb' }));

    app.get('/status', allowCorsGet, handleStatus);
    app.get('/v1/models', allowCorsGet, listModelsHandler);
    app.get('/v1/usage/quota', allowCorsGet, handleQuota);
    app.get('/v1/usage/stats', allowCorsGet, handleStats);
    app.get('/v1/debug/last', allowCorsGet, handleDebugLast);
    app.options(['/status', '/v1/models', '/v1/usage/quota', '/v1/usage/stats', '/v1/debug/last'], allowCorsGet, (_req, res) => res.sendStatus(204));
    app.post('/v1/chat/completions', guardPostOrigin, handleChatCompletions);
    app.post('/v1/embeddings', guardPostOrigin, rejectEmbeddings);

    return new Promise((resolve, reject) => {
        const server = app.listen(port, host, () => {
            serverInstance = server;
            if (host === '0.0.0.0' || host === '::') {
                console.warn('[claude-subscription] listening on every network interface: anyone on this network can use your subscription through the proxy. Bind 127.0.0.1 unless you need LAN access.');
            }
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

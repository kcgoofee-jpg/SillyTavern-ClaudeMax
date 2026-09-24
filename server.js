#!/usr/bin/env node
// ──────────────────────────────────────────────
// Standalone entry — run the proxy without SillyTavern
// ──────────────────────────────────────────────
//
// TauriTavern (and any other OpenAI-compatible frontend) has no Node server
// plugins, so the proxy runs as its own process:
//
//   npm start            (or: node server.js)
//
// Same env overrides as the plugin (CLAUDE_SUBSCRIPTION_PORT / _HOST / …).
// If SillyTavern with the server plugin starts later, the plugin detects
// this listener on the port and reuses it instead of failing.

import { startStandaloneListener, stopStandaloneListener, portInUseMessage } from './lib/listener.js';
import { credentialSummary } from './lib/oauth.js';

const TAG = '[claude-subscription]';
const port = parseInt(process.env.CLAUDE_SUBSCRIPTION_PORT, 10) || 8901;
const host = process.env.CLAUDE_SUBSCRIPTION_HOST || '127.0.0.1';

try {
    await startStandaloneListener({ port, host });
} catch (err) {
    if (err?.code === 'EADDRINUSE') console.error(portInUseMessage(port));
    process.exit(1);
}

const cred = credentialSummary();
if (cred.present) {
    console.log(`${TAG} 已找到订阅凭据（来源: ${cred.source}，类型: ${cred.subscriptionType}${cred.expired ? '，access token 已过期，下次对话时 CLI 会自动刷新' : ''}）`);
} else {
    console.warn(`${TAG} 未找到订阅凭据 — 请先在扩展目录运行 npm run login 登录订阅账号（或设置 CLAUDE_CODE_OAUTH_TOKEN）`);
}
console.log(`${TAG} 在酒馆里把 Custom (OpenAI-compatible) 端点设为 http://${host}:${port}/v1，或使用 Claude Max 面板一键连接。Ctrl+C 退出。`);

let stopping = false;
async function shutdown(signal) {
    if (stopping) return;
    stopping = true;
    console.log(`${TAG} ${signal} — shutting down`);
    await stopStandaloneListener();
    process.exit(0);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

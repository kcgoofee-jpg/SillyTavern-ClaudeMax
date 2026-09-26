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
import { networkInterfaces } from 'node:os';

import { credentialSummary } from './lib/oauth.js';
import { markStandalone } from './lib/control.js';
import { flushSweeps, sweepLeftovers } from './lib/session-store.js';

const TAG = '[claude-subscription]';
const port = parseInt(process.env.CLAUDE_SUBSCRIPTION_PORT, 10) || 8901;
const host = process.env.CLAUDE_SUBSCRIPTION_HOST || '127.0.0.1';

// A stray rejected promise must not take the proxy (and every reply being
// written) down: log it and keep serving.
process.on('unhandledRejection', (reason) => {
    console.error(`${TAG} 未处理的异步错误（代理继续运行）：`, reason instanceof Error ? reason.stack ?? reason.message : reason);
});

// This process owns the port: the phone's「重启代理」may stop and restart it.
markStandalone();

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
if (host === '0.0.0.0' || host === '::') {
    // Listening on every interface: 0.0.0.0 is not an address anyone can connect to.
    // Skip VPN/TUN (198.18/15) and link-local addresses; the phone can't reach those.
    const lan = Object.values(networkInterfaces()).flat()
        .filter((i) => i && i.family === 'IPv4' && !i.internal && !/^(198\.1[89]|169\.254)\./.test(i.address))
        .map((i) => `http://${i.address}:${port}/v1`);
    console.log(`${TAG} 本机端点 http://127.0.0.1:${port}/v1；局域网设备用 ${lan.join('、') || '（没有局域网地址，检查 Wi-Fi）'}。Ctrl+C 退出。`);
} else {
    console.log(`${TAG} 在酒馆里把 Custom (OpenAI-compatible) 端点设为 http://${host}:${port}/v1，或使用 Claude Max 面板一键连接。Ctrl+C 退出。`);
}

// Roleplay transcripts a crash or kill left on disk (see lib/session-store.js).
try {
    const swept = sweepLeftovers();
    if (swept.transcripts || swept.tempDirs) console.log(`${TAG} 清理了上次遗留的 ${swept.transcripts} 份会话记录、${swept.tempDirs} 个临时目录`);
} catch { /* best effort */ }

let stopping = false;
async function shutdown(signal) {
    if (stopping) return;
    stopping = true;
    console.log(`${TAG} ${signal} — shutting down`);
    // Delete this run's last transcripts before exiting (their timers would never fire).
    const flush = () => Promise.race([flushSweeps(), new Promise((r) => setTimeout(r, 5000).unref())]);
    await flush();
    await stopStandaloneListener();
    await flush(); // replies that were still running when the signal came
    process.exit(0);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

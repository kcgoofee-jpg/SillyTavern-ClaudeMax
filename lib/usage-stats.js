// ──────────────────────────────────────────────
// Per-request usage log + aggregates
// ──────────────────────────────────────────────
//
// Every chat request appends ONE metadata line to data/usage.jsonl (model,
// timing, token counts, outcome — never message content) and prints a
// one-line summary to the console. /v1/usage/stats aggregates today and the
// last 7 days for the Claude Max panel: request count, tokens, average
// latency, prompt-cache hit rate, and the most recent failure.

import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { explainError } from './errors-zh.js';
import { explainCache } from './cache-diag.js';

const PLUGIN_TAG = '[claude-subscription]';
const MAX_FILE_BYTES = 5 * 1024 * 1024;
const WINDOW_MS = 7 * 24 * 3600 * 1000;

export function statsFilePath() {
    if (process.env.CLAUDE_SUBSCRIPTION_STATS_FILE) return process.env.CLAUDE_SUBSCRIPTION_STATS_FILE;
    const here = dirname(fileURLToPath(import.meta.url));
    return join(here, '..', 'data', 'usage.jsonl');
}

let entries = null; // last 7 days, oldest first

function load() {
    if (entries) return entries;
    entries = [];
    const path = statsFilePath();
    if (!existsSync(path)) return entries;
    const cutoff = Date.now() - WINDOW_MS;
    try {
        for (const line of readFileSync(path, 'utf8').split('\n')) {
            if (!line.trim()) continue;
            try {
                const e = JSON.parse(line);
                if (e.at >= cutoff) entries.push(e);
            } catch { /* skip corrupt line */ }
        }
    } catch (err) {
        console.warn(`${PLUGIN_TAG} could not read usage stats:`, err instanceof Error ? err.message : err);
    }
    return entries;
}

function persist(entry) {
    const path = statsFilePath();
    try {
        mkdirSync(dirname(path), { recursive: true });
        if (existsSync(path) && statSync(path).size > MAX_FILE_BYTES) {
            renameSync(path, `${path}.old`);
        }
        appendFileSync(path, JSON.stringify(entry) + '\n');
    } catch (err) {
        console.warn(`${PLUGIN_TAG} could not write usage stats:`, err instanceof Error ? err.message : err);
    }
}

/** Role layout of the incoming messages, run-length encoded — e.g.
 *  "S34 A1 S2 U1 A1 U1" (S=system, U=user, A=assistant). Metadata only. */
export function promptShape(messages) {
    const runs = [];
    for (const m of messages ?? []) {
        const r = { system: 'S', user: 'U', assistant: 'A', tool: 'T' }[m?.role] ?? '?';
        const last = runs[runs.length - 1];
        if (last && last[0] === r) last[1] += 1;
        else runs.push([r, 1]);
    }
    const parts = runs.map(([r, n]) => `${r}${n}`);
    return parts.length > 16 ? `${parts.slice(0, 8).join(' ')} … ${parts.slice(-6).join(' ')}` : parts.join(' ');
}

const k = (n) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : String(n));
const sec = (ms) => `${(ms / 1000).toFixed(1)}s`;

/** Console line, e.g.
 *  ✓ claude-opus-4-6[1m] · resume · 248.1s（首字 3.2s）· 输入 1.2k + 缓存读 45k + 缓存写 2k · 输出 9.8k · 思考 0 字 */
export function formatLogLine(e) {
    const head = e.ok ? '✓' : '✗';
    const parts = [`${head} ${e.model}`, e.path ?? '-', `${sec(e.durationMs)}${e.ttftMs != null ? `（首字 ${sec(e.ttftMs)}）` : ''}`];
    if (e.ok) {
        parts.push(`输入 ${k(e.inputTokens)} + 缓存读 ${k(e.cacheReadTokens)} + 缓存写 ${k(e.cacheCreationTokens)}`);
        parts.push(`输出 ${k(e.outputTokens)}`);
        parts.push(`思考 ${e.reasoningChars} 字`);
        if (e.finish && e.finish !== 'stop') parts.push(e.finish);
    } else {
        parts.push(`${e.errorCode}：${e.errorRaw}`);
    }
    return `${PLUGIN_TAG} ${parts.join(' · ')}`;
}

/**
 * @param {{ model: string, path?: string, stream: boolean, startedAt: number,
 *   firstTokenAt?: number|null, usage?: object|null, textChars: number,
 *   reasoningChars: number, finish?: string, clientClosed?: boolean,
 *   error?: string|null }} r
 */
export function recordRequest(r) {
    const now = Date.now();
    const u = r.usage ?? {};
    const failure = r.error ? explainError(r.error) : null;
    const entry = {
        at: now,
        model: r.model,
        effort: r.effort ?? null,
        placement: r.placement ?? null,
        path: r.path ?? null,
        stream: !!r.stream,
        ok: !failure,
        durationMs: now - r.startedAt,
        ttftMs: r.firstTokenAt ? r.firstTokenAt - r.startedAt : null,
        inputTokens: u.input_tokens ?? 0,
        outputTokens: u.output_tokens ?? 0,
        cacheReadTokens: u.cache_read_input_tokens ?? 0,
        cacheCreationTokens: u.cache_creation_input_tokens ?? 0,
        textChars: r.textChars ?? 0,
        reasoningChars: r.reasoningChars ?? 0,
        finish: r.clientClosed ? 'client_closed' : (r.finish ?? null),
        shape: r.shape ?? null,
        cacheDiag: r.cacheDiag ?? null,
    };
    if (failure) {
        entry.errorCode = failure.code;
        entry.errorRaw = failure.raw.slice(0, 500);
    }
    load().push(entry);
    persist(entry);
    console.log(formatLogLine(entry));
    return entry;
}

function aggregate(list) {
    const ok = list.filter((e) => e.ok);
    const sum = (key) => ok.reduce((n, e) => n + (e[key] ?? 0), 0);
    const input = sum('inputTokens');
    const cacheRead = sum('cacheReadTokens');
    const cacheWrite = sum('cacheCreationTokens');
    const promptTotal = input + cacheRead + cacheWrite;
    const timed = ok.filter((e) => e.durationMs > 0);
    const ttft = ok.filter((e) => e.ttftMs != null);
    const models = {};
    for (const e of ok) models[e.model] = (models[e.model] ?? 0) + 1;
    return {
        requests: list.length,
        succeeded: ok.length,
        failed: list.length - ok.length,
        inputTokens: input,
        outputTokens: sum('outputTokens'),
        cacheReadTokens: cacheRead,
        cacheCreationTokens: cacheWrite,
        cacheHitRate: promptTotal > 0 ? cacheRead / promptTotal : null,
        avgDurationMs: timed.length ? Math.round(timed.reduce((n, e) => n + e.durationMs, 0) / timed.length) : null,
        avgTtftMs: ttft.length ? Math.round(ttft.reduce((n, e) => n + e.ttftMs, 0) / ttft.length) : null,
        withReasoning: ok.filter((e) => e.reasoningChars > 0).length,
        models,
    };
}

export function summarizeStats(now = Date.now()) {
    const all = load();
    const cutoff = now - WINDOW_MS;
    while (all.length && all[0].at < cutoff) all.shift();
    const startOfDay = new Date(now);
    startOfDay.setHours(0, 0, 0, 0);
    const today = all.filter((e) => e.at >= startOfDay.getTime());
    const lastFailure = [...all].reverse().find((e) => !e.ok) ?? null;
    const lastRequest = all.length ? all[all.length - 1] : null;
    let lastError = null;
    if (lastFailure) {
        const ex = explainError(lastFailure.errorRaw);
        lastError = { at: lastFailure.at, model: lastFailure.model, code: lastFailure.errorCode, message: ex.message, hint: ex.hint, raw: lastFailure.errorRaw };
    }
    const prevRequest = all.length > 1 ? all[all.length - 2] : null;
    const lastCache = explainCache(lastRequest, prevRequest);
    return { today: aggregate(today), week: aggregate(all), lastRequest, lastCache, lastError };
}

export function handleStats(_req, res) {
    res.json({ ok: true, ...summarizeStats() });
}

/** Test seam. */
export function __resetStatsForTesting() {
    entries = null;
}

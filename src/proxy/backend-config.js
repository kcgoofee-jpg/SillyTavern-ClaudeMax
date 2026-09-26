// ──────────────────────────────────────────────
// Which backend the proxy runs chats on (subscription, API key, Bedrock,
// Vertex, Anthropic-compatible gateway, OpenRouter)
// ──────────────────────────────────────────────
//
// The Claude Code CLI picks its backend from its environment (checked in the
// bundled CLI of claude-agent-sdk 0.3.281 and the Claude Code docs):
//   API key     ANTHROPIC_API_KEY
//   Bedrock     CLAUDE_CODE_USE_BEDROCK=1, AWS_REGION, and AWS credentials:
//               AWS_BEARER_TOKEN_BEDROCK, or AWS_PROFILE, or
//               AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY (/ AWS_SESSION_TOKEN),
//               or whatever the default AWS chain finds
//   Vertex      CLAUDE_CODE_USE_VERTEX=1, CLOUD_ML_REGION,
//               ANTHROPIC_VERTEX_PROJECT_ID, Google ADC (gcloud auth
//               application-default login or GOOGLE_APPLICATION_CREDENTIALS)
//   Gateway     ANTHROPIC_BASE_URL + ANTHROPIC_AUTH_TOKEN (Bearer), with
//               ANTHROPIC_API_KEY empty — OpenRouter documents exactly this
//               for Claude Code (base https://openrouter.ai/api).
// Model ids differ per backend; src/shared/backends.js maps them and
// env.js pins them through ANTHROPIC_DEFAULT_<TIER>_MODEL.
//
// Config lives on the proxy host only: data/backend.json (mode 0600, under
// data/ which is never committed). CLAUDE_SUBSCRIPTION_BACKEND* env vars
// override the file. Secrets are never logged and never sent back to the
// panel — the view says only whether each one is set.
//
// Each request spawns its own CLI process with the env built here, so a
// switch applies from the next request; replies being written keep the
// backend they started with. There is no long-lived child to restart.

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { BACKENDS, BACKEND_LABELS, isApiBilled, normalizeBackend } from '../shared/backends.js';
import { busyCount } from './control.js';
import { DATA_DIR } from './paths.js';

// field → { secret, env override }
export const FIELDS = {
    apikey: {
        apiKey: { secret: true, env: 'CLAUDE_SUBSCRIPTION_API_KEY' },
    },
    bedrock: {
        region: { env: 'CLAUDE_SUBSCRIPTION_AWS_REGION' },
        profile: { env: 'CLAUDE_SUBSCRIPTION_AWS_PROFILE' },
        bearerToken: { secret: true, env: 'CLAUDE_SUBSCRIPTION_BEDROCK_TOKEN' },
        accessKeyId: { secret: true, env: 'CLAUDE_SUBSCRIPTION_AWS_ACCESS_KEY_ID' },
        secretAccessKey: { secret: true, env: 'CLAUDE_SUBSCRIPTION_AWS_SECRET_ACCESS_KEY' },
        sessionToken: { secret: true, env: 'CLAUDE_SUBSCRIPTION_AWS_SESSION_TOKEN' },
        prefix: { env: 'CLAUDE_SUBSCRIPTION_BEDROCK_PREFIX' },
    },
    vertex: {
        projectId: { env: 'CLAUDE_SUBSCRIPTION_VERTEX_PROJECT' },
        region: { env: 'CLAUDE_SUBSCRIPTION_VERTEX_REGION' },
        credentialsFile: { env: 'CLAUDE_SUBSCRIPTION_VERTEX_CREDENTIALS' },
    },
    gateway: {
        baseUrl: { env: 'CLAUDE_SUBSCRIPTION_GATEWAY_URL' },
        authToken: { secret: true, env: 'CLAUDE_SUBSCRIPTION_GATEWAY_TOKEN' },
    },
    openrouter: {
        authToken: { secret: true, env: 'CLAUDE_SUBSCRIPTION_OPENROUTER_KEY' },
    },
};

export const OPENROUTER_BASE_URL = 'https://openrouter.ai/api';

export function backendFilePath() {
    return process.env.CLAUDE_SUBSCRIPTION_BACKEND_FILE || join(DATA_DIR, 'backend.json');
}

let cache = null; // { mtimeMs, path, data }

function readFileConfig(path = backendFilePath()) {
    try {
        if (!existsSync(path)) return {};
        const mtimeMs = statSync(path).mtimeMs;
        if (cache && cache.path === path && cache.mtimeMs === mtimeMs) return cache.data;
        const data = JSON.parse(readFileSync(path, 'utf8'));
        cache = { path, mtimeMs, data: data && typeof data === 'object' ? data : {} };
        return cache.data;
    } catch {
        // Never print the file: it holds keys.
        console.warn('[claude-subscription] data/backend.json 读不了（格式不对？），先按订阅运行');
        return {};
    }
}

/**
 * Effective config: file, then env overrides.
 * @returns {{ backend: string, source: 'env'|'file'|'default', fields: Record<string, Record<string,string>>, envFields: string[] }}
 */
export function resolveBackendConfig({ env = process.env, file = readFileConfig() } = {}) {
    const fields = {};
    const envFields = [];
    for (const [b, defs] of Object.entries(FIELDS)) {
        fields[b] = {};
        for (const [name, def] of Object.entries(defs)) {
            const fromEnv = String(env[def.env] ?? '').trim();
            const fromFile = typeof file?.[b]?.[name] === 'string' ? file[b][name].trim() : '';
            if (fromEnv) envFields.push(`${b}.${name}`);
            fields[b][name] = fromEnv || fromFile;
        }
    }
    const envBackend = String(env.CLAUDE_SUBSCRIPTION_BACKEND ?? '').trim();
    let backend; let source;
    if (BACKENDS.includes(envBackend)) { backend = envBackend; source = 'env'; }
    else if (BACKENDS.includes(file?.backend)) { backend = file.backend; source = 'file'; }
    else { backend = 'subscription'; source = 'default'; }
    return { backend, source, fields, envFields };
}

/** What a backend still needs before it can run; [] when ready. */
export function missingFields(backend, f) {
    const miss = [];
    if (backend === 'apikey' && !/^sk-ant-/i.test(f.apikey.apiKey)) miss.push('apikey.apiKey');
    if (backend === 'bedrock' && !f.bedrock.region) miss.push('bedrock.region');
    if (backend === 'bedrock' && !!f.bedrock.accessKeyId !== !!f.bedrock.secretAccessKey) miss.push(f.bedrock.accessKeyId ? 'bedrock.secretAccessKey' : 'bedrock.accessKeyId');
    if (backend === 'vertex') {
        if (!f.vertex.projectId) miss.push('vertex.projectId');
        if (!f.vertex.region) miss.push('vertex.region');
    }
    if (backend === 'gateway') {
        if (!isValidBaseUrl(f.gateway.baseUrl)) miss.push('gateway.baseUrl');
        if (!f.gateway.authToken) miss.push('gateway.authToken');
    }
    if (backend === 'openrouter' && !f.openrouter.authToken) miss.push('openrouter.authToken');
    return miss;
}

/** https anywhere; plain http only to this machine (a local gateway). */
export function isValidBaseUrl(url) {
    try {
        const u = new URL(String(url));
        if (u.protocol === 'https:') return true;
        return u.protocol === 'http:' && /^(localhost|127\.\d+\.\d+\.\d+|\[::1\])$/i.test(u.hostname);
    } catch {
        return false;
    }
}

// Every env var that could send the CLI somewhere else. Scrubbed before a
// backend adds its own, so a stray shell export can never flip billing or
// hand one service's key to another.
const PROVIDER_ENV = [
    'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_MODEL',
    'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY', 'CLAUDE_CODE_USE_GATEWAY',
    'CLAUDE_CODE_USE_MANTLE', 'CLAUDE_CODE_USE_ANTHROPIC_AWS', 'CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD',
    'ANTHROPIC_BEDROCK_BASE_URL', 'ANTHROPIC_VERTEX_BASE_URL', 'AWS_BEARER_TOKEN_BEDROCK',
    'CLAUDE_CODE_SKIP_BEDROCK_AUTH', 'CLAUDE_CODE_SKIP_VERTEX_AUTH', 'ANTHROPIC_CUSTOM_HEADERS',
];
export const SCRUBBED_ENV = PROVIDER_ENV;

/**
 * The env changes one backend needs: `set` is added, `unset` removed (after
 * the common scrub). Pure: no process.env access.
 */
export function backendEnv(backend, f) {
    const set = {};
    const unset = [];
    switch (backend) {
        case 'apikey':
            set.ANTHROPIC_API_KEY = f.apikey.apiKey;
            break;
        case 'bedrock': {
            const b = f.bedrock;
            set.CLAUDE_CODE_USE_BEDROCK = '1';
            set.AWS_REGION = b.region;
            if (b.bearerToken) set.AWS_BEARER_TOKEN_BEDROCK = b.bearerToken;
            if (b.profile) set.AWS_PROFILE = b.profile;
            if (b.accessKeyId && b.secretAccessKey) {
                set.AWS_ACCESS_KEY_ID = b.accessKeyId;
                set.AWS_SECRET_ACCESS_KEY = b.secretAccessKey;
                if (b.sessionToken) set.AWS_SESSION_TOKEN = b.sessionToken;
                else unset.push('AWS_SESSION_TOKEN');
            }
            // The subscription login must not ride along.
            unset.push('CLAUDE_CODE_OAUTH_TOKEN');
            break;
        }
        case 'vertex':
            set.CLAUDE_CODE_USE_VERTEX = '1';
            set.CLOUD_ML_REGION = f.vertex.region;
            set.ANTHROPIC_VERTEX_PROJECT_ID = f.vertex.projectId;
            if (f.vertex.credentialsFile) set.GOOGLE_APPLICATION_CREDENTIALS = f.vertex.credentialsFile;
            unset.push('CLAUDE_CODE_OAUTH_TOKEN');
            break;
        case 'gateway':
        case 'openrouter':
            set.ANTHROPIC_BASE_URL = backend === 'openrouter' ? OPENROUTER_BASE_URL : f.gateway.baseUrl.replace(/\/+$/, '');
            set.ANTHROPIC_AUTH_TOKEN = backend === 'openrouter' ? f.openrouter.authToken : f.gateway.authToken;
            // Empty on purpose (OpenRouter's Claude Code guide): a set x-api-key
            // is treated as a direct-Anthropic credential.
            set.ANTHROPIC_API_KEY = '';
            // A gateway must never receive the claude.ai login token.
            unset.push('CLAUDE_CODE_OAUTH_TOKEN');
            break;
        default:
            break;
    }
    return { set, unset };
}

/** For the panel and /status: no secret values, only whether each is set. */
export function publicView(cfg = resolveBackendConfig()) {
    const fields = {};
    for (const [b, defs] of Object.entries(FIELDS)) {
        fields[b] = {};
        for (const [name, def] of Object.entries(defs)) {
            const v = cfg.fields[b][name];
            fields[b][name] = def.secret ? { set: !!v } : { value: v };
            if (cfg.envFields.includes(`${b}.${name}`)) fields[b][name].fromEnv = true;
        }
    }
    return {
        backend: cfg.backend,
        label: BACKEND_LABELS[cfg.backend],
        apiBilled: isApiBilled(cfg.backend),
        source: cfg.source,
        missing: missingFields(cfg.backend, cfg.fields),
        backends: BACKENDS.map((id) => ({ id, label: BACKEND_LABELS[id] })),
        fields,
    };
}

/**
 * Apply a panel update to the stored file config. Pure.
 * body: { backend?, fields?: { <backend>: { <name>: string } }, clear?: ['bedrock.bearerToken', ...] }
 * An empty or missing secret keeps the stored one (the panel never has it);
 * `clear` removes one. Returns { next } or { error }.
 */
export function applyUpdate(current, body) {
    const next = JSON.parse(JSON.stringify(current ?? {}));
    if (body?.backend !== undefined) {
        if (!BACKENDS.includes(body.backend)) return { error: `没有这个后端：${String(body.backend).slice(0, 40)}` };
        next.backend = body.backend;
    }
    for (const [b, vals] of Object.entries(body?.fields ?? {})) {
        if (!Object.hasOwn(FIELDS, b) || !vals || typeof vals !== 'object') continue;
        for (const [name, raw] of Object.entries(vals)) {
            if (!Object.hasOwn(FIELDS[b], name) || typeof raw !== 'string') continue;
            const v = raw.trim();
            if (v.length > 4096) return { error: `${b}.${name} 太长` };
            if (FIELDS[b][name].secret && !v) continue;
            next[b] ??= {};
            if (v) next[b][name] = v; else delete next[b][name];
        }
    }
    for (const key of Array.isArray(body?.clear) ? body.clear : []) {
        const [b, name] = String(key).split('.');
        if (Object.hasOwn(FIELDS, b) && Object.hasOwn(FIELDS[b], name) && next[b]) delete next[b][name];
    }
    return { next };
}

function writeFileConfig(data, path = backendFilePath()) {
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, path);
    cache = null;
}

// ── HTTP ──

export function handleBackendGet(_req, res) {
    res.json({ ok: true, ...publicView() });
}

export function handleBackendPost(req, res) {
    const current = readFileConfig();
    const { next, error } = applyUpdate(current, req.body);
    if (error) return res.status(400).json({ ok: false, message: error });
    const cfg = resolveBackendConfig({ file: next });
    const missing = missingFields(cfg.backend, cfg.fields);
    if (missing.length) {
        return res.status(400).json({ ok: false, missing, message: `${BACKEND_LABELS[cfg.backend]} 还缺：${missing.map((m) => m.split('.')[1]).join('、')}` });
    }
    try {
        writeFileConfig(next);
    } catch (err) {
        return res.status(500).json({ ok: false, message: `保存失败：${err instanceof Error ? err.code ?? 'error' : 'error'}` });
    }
    const busy = busyCount();
    const envNote = cfg.source === 'env' ? '（环境变量 CLAUDE_SUBSCRIPTION_BACKEND 优先，面板选的不生效）' : '';
    console.log(`[claude-subscription] 后端改为 ${BACKEND_LABELS[cfg.backend]}${envNote}`);
    res.json({
        ok: true,
        message: busy > 0 ? `已保存。正在写的 ${busy} 条回复仍用原来的后端，下一条起用 ${BACKEND_LABELS[cfg.backend]}。${envNote}` : `已保存，下一条回复起用 ${BACKEND_LABELS[cfg.backend]}。${envNote}`,
        ...publicView(cfg),
    });
}

/** Test seam. */
export function __resetBackendCache() {
    cache = null;
}

// ──────────────────────────────────────────────
// Proxy backends: names, model ids per backend, cost estimate
// ──────────────────────────────────────────────
//
// Pure functions shared by the proxy (env / usage stats) and the panel
// (labels). Which env vars select a backend is decided in
// src/proxy/backend-config.js; this file only knows names and numbers.
//
// Model ids per backend come from the bundled Claude Code CLI's own model
// table (claude-agent-sdk 0.3.281: entries like
//   first_party:"claude-opus-4-6", bedrock:"us.anthropic.claude-opus-4-6-v1",
//   vertex:"claude-opus-4-6"
// and dated snapshots such as vertex:"claude-haiku-4-5@20251001"). The CLI
// has no Bedrock/Vertex id for claude-mythos-*: those models only exist on
// the first-party API.

export const BACKENDS = ['subscription', 'apikey', 'bedrock', 'vertex', 'gateway', 'openrouter'];

export const BACKEND_LABELS = {
    subscription: '订阅（Claude 登录）',
    apikey: 'Anthropic API 密钥',
    bedrock: 'AWS Bedrock',
    vertex: 'Google Vertex AI',
    gateway: 'Anthropic 兼容网关',
    openrouter: 'OpenRouter',
};

/** Billed per token (everything except the subscription). */
export function isApiBilled(backend) {
    return BACKENDS.includes(backend) && backend !== 'subscription';
}

export function normalizeBackend(value) {
    return BACKENDS.includes(value) ? value : 'subscription';
}

// Dated snapshots: the CLI table uses these ids on Bedrock / Vertex.
const BEDROCK_IDS = {
    'claude-opus-4-6': 'anthropic.claude-opus-4-6-v1',
    'claude-opus-4-5': 'anthropic.claude-opus-4-5-20251101-v1:0',
    'claude-sonnet-4-5': 'anthropic.claude-sonnet-4-5-20250929-v1:0',
    'claude-haiku-4-5': 'anthropic.claude-haiku-4-5-20251001-v1:0',
};
const VERTEX_IDS = {
    'claude-opus-4-5': 'claude-opus-4-5@20251101',
    'claude-sonnet-4-5': 'claude-sonnet-4-5@20250929',
    'claude-haiku-4-5': 'claude-haiku-4-5@20251001',
};
const FIRST_PARTY_ONLY = /^claude-mythos/;

/** Bedrock cross-region inference profile prefix for an AWS region
 *  (us-east-1 → us, eu-west-1 → eu, ap-northeast-1 → apac). */
export function bedrockPrefix(region, override) {
    if (['us', 'eu', 'apac', 'global'].includes(override)) return override;
    const r = String(region ?? '').toLowerCase();
    if (r.startsWith('eu-')) return 'eu';
    if (r.startsWith('ap-')) return 'apac';
    return 'us';
}

/**
 * The id a backend expects for a first-party model id (no [1m] suffix).
 * Returns null when the backend does not offer the model.
 * @param {string} backend
 * @param {string} baseId e.g. 'claude-opus-4-6'
 * @param {{ region?: string, prefix?: string }} [opts] Bedrock region / prefix override
 */
export function mapModelId(backend, baseId, opts = {}) {
    const id = String(baseId ?? '').trim();
    if (!id) return null;
    switch (backend) {
        case 'bedrock': {
            if (FIRST_PARTY_ONLY.test(id)) return null;
            // Already a Bedrock id / ARN (from a user pin): leave it alone.
            if (/(^|\.)anthropic\.|^arn:/.test(id)) return id;
            return `${bedrockPrefix(opts.region, opts.prefix)}.${BEDROCK_IDS[id] ?? `anthropic.${id}`}`;
        }
        case 'vertex':
            if (FIRST_PARTY_ONLY.test(id)) return null;
            return VERTEX_IDS[id] ?? id;
        case 'openrouter':
            // OpenRouter slugs: anthropic/claude-opus-4.6 (dot before the minor version).
            if (id.includes('/')) return id;
            return `anthropic/${id.replace(/-(\d+)-(\d+)$/, '-$1.$2')}`;
        default:
            // subscription, API key, generic gateway: first-party ids.
            return id;
    }
}

// ── Cost estimate ──
// USD per million tokens, Anthropic first-party list prices as of
// 2026-06-24 (Anthropic model/pricing table, cached in the claude-api
// reference). Cache writes: 5-minute 1.25× input, 1-hour 2× input; cache
// reads 0.1× input unless the price list says otherwise (Opus 5.5 $0.20,
// Fable 5.1 $0.25). Bedrock / Vertex / OpenRouter bill through their own
// price lists, which usually match or sit close to these — the panel labels
// every figure 估算 (estimate), never an invoice.
export const PRICES_AS_OF = '2026-06-24';
const PRICES = {
    'claude-fable-5-1': { input: 10, output: 50, cacheRead: 0.25 },
    'claude-fable-5': { input: 10, output: 50 },
    'claude-mythos-5-1': { input: 10, output: 50 },
    'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.2 },
    'claude-opus-5': { input: 5, output: 25 },
    'claude-opus-4-8': { input: 5, output: 25 },
    'claude-opus-4-7': { input: 5, output: 25 },
    'claude-opus-4-6': { input: 5, output: 25 },
    'claude-opus-4-5': { input: 5, output: 25 },
    'claude-sonnet-5': { input: 2, output: 10 },
    'claude-sonnet-4-6': { input: 3, output: 15 },
    'claude-sonnet-4-5': { input: 3, output: 15 },
    'claude-haiku-4-5': { input: 1, output: 5 },
};

/** Price row for a model id (first-party, with or without [1m]); null if unknown. */
export function priceFor(model) {
    const id = String(model ?? '').toLowerCase().replace(/\[1m\]$/, '').replace(/\./g, '-');
    const p = PRICES[id];
    if (!p) return null;
    return { input: p.input, output: p.output, cacheRead: p.cacheRead ?? p.input * 0.1 };
}

/**
 * Estimated USD for one request's token counts; null when the model has no
 * price row or the backend is the subscription (no per-token bill).
 * @param {{ model: string, inputTokens?: number, outputTokens?: number,
 *   cacheReadTokens?: number, cacheCreationTokens?: number }} e
 * @param {string} backend
 * @param {{ cacheTtl?: '5m'|'1h' }} [opts] how cache writes were billed
 */
export function estimateCostUsd(e, backend, opts = {}) {
    if (!isApiBilled(backend)) return null;
    const p = priceFor(e?.model);
    if (!p) return null;
    const writeMult = opts.cacheTtl === '1h' ? 2 : 1.25;
    const usd = ((e.inputTokens ?? 0) * p.input
        + (e.outputTokens ?? 0) * p.output
        + (e.cacheReadTokens ?? 0) * p.cacheRead
        + (e.cacheCreationTokens ?? 0) * p.input * writeMult) / 1e6;
    return Math.round(usd * 1e6) / 1e6;
}

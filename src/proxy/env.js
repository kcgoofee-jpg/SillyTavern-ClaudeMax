// ──────────────────────────────────────────────
// SDK subprocess environment builder
// ──────────────────────────────────────────────
//
// The Claude Code CLI resolves auth and model aliases from its environment.
// Getting this env exactly right is what keeps subscription billing working:
//
//   • ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN / ANTHROPIC_BASE_URL are
//     SCRUBBED unless the caller explicitly opted into API billing —
//     any stray key in SillyTavern's process env would silently flip
//     billing off the subscription (Meridian scrubs identically). The
//     proxy's own CLAUDE_SUBSCRIPTION_* settings are dropped too.
//   • ANTHROPIC_DEFAULT_<TIER>_MODEL pins resolve tier aliases (and the
//     [1m] alias forms) to exact versions — request pins win over both
//     canonical defaults and inherited shell env.
//   • CLAUDE_CODE_MAX_OUTPUT_TOKENS carries SillyTavern's "Max response
//     length" to the CLI (the SDK has no per-query output cap option).
//   • ENABLE_CLAUDEAI_MCP_SERVERS=false kills claude.ai account connectors
//     (Notion/Gmail/etc.) that would otherwise reach the model
//     (Marinara's isolation hardening).
//   • CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 — every request here is a
//     fresh session, and without it the CLI sends the message to a model to
//     generate an `ai-title` for each one (observed in the session
//     transcript), i.e. an extra call per chat message. Per the Claude Code
//     docs it also turns off auto-updates, telemetry and error reporting,
//     which a one-shot RP subprocess doesn't need.
//   • CLAUDE_CODE_DISABLE_AUTO_MEMORY=1 — settingSources:[] does NOT stop
//     the CLI from injecting the cwd project's auto-memory index into the
//     context (verified with a probe prompt); this does.

import { backendEnv, SCRUBBED_ENV } from './backend-config.js';

// API credentials, base URLs and provider switches (Bedrock / Vertex / …):
// see backend-config.js. The chosen backend adds back only its own.
const SCRUB_KEYS = SCRUBBED_ENV;

/**
 * @param {object} args
 * @param {Record<string,string>} args.envPins ANTHROPIC_DEFAULT_* pins from parseModelRequest
 * @param {number|undefined} args.maxTokens
 * @param {string|null} args.apiKey explicit sk-ant-* API-billing opt-in (or null for subscription)
 * @param {{ backend: string, fields: object }|null} [args.backend] resolved backend config (backend-config.js); null = subscription
 * @returns {Record<string,string|undefined>}
 */
export function buildSubprocessEnv({ envPins, maxTokens, apiKey, backend = null }) {
    const env = { ...process.env };
    for (const key of SCRUB_KEYS) delete env[key];
    // The proxy's own settings (LAN access key, file paths, …) are none of
    // the CLI's business — it reads only ANTHROPIC_* / CLAUDE_CODE_* / CLAUDE_CONFIG_DIR.
    for (const key of Object.keys(env)) if (key.startsWith('CLAUDE_SUBSCRIPTION_')) delete env[key];
    // Dev only: route the CLI through a local request tap (scripts/api_tap) to see what it really sends.
    if (process.env.CLAUDE_SUBSCRIPTION_DEV_BASE_URL) env.ANTHROPIC_BASE_URL = process.env.CLAUDE_SUBSCRIPTION_DEV_BASE_URL;

    // Request pins win over inherited shell env (the picked model version IS
    // the request's meaning; a stale shell pin must not redirect it).
    Object.assign(env, envPins);

    env.ENABLE_CLAUDEAI_MCP_SERVERS = 'false';
    env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1';
    env.CLAUDE_CODE_DISABLE_AUTO_MEMORY = '1';
    // When a reply is stopped mid-way by a safety stop, the CLI would retry
    // the turn on another model and expect the client to retract the partial
    // it already received. A streamed reply can't be retracted in
    // SillyTavern: the two outputs end up spliced into one message (an
    // unclosed HTML card swallowing the rest) and the reply silently comes
    // from a different model. Stop at the refusal instead; the proxy reports
    // it. CLAUDE_SUBSCRIPTION_REFUSAL_FALLBACK=on restores the CLI default.
    if (!/^(1|true|on|yes)$/i.test(process.env.CLAUDE_SUBSCRIPTION_REFUSAL_FALLBACK ?? '')) {
        env.CLAUDE_CODE_DISABLE_REFUSAL_FALLBACK = '1';
    }

    if (maxTokens) {
        env.CLAUDE_CODE_MAX_OUTPUT_TOKENS = String(maxTokens);
    }

    const chosen = backend?.backend ?? 'subscription';
    if (chosen !== 'subscription') {
        const { set, unset } = backendEnv(chosen, backend.fields);
        for (const key of unset) delete env[key];
        Object.assign(env, set);
        if (chosen === 'apikey') env.CLAUDE_CODE_PROMPT_CACHE_TTL ??= '1h'; // same reason as below
        return env;
    }

    if (apiKey) {
        // Opt-in API-billing fallback — overrides subscription auth.
        env.ANTHROPIC_API_KEY = apiKey;
        // On a subscription the CLI already caches the conversation for 1 hour; with an API key it
        // falls back to 5 minutes, and roleplay turns are often further apart than that (measured:
        // cache reads still hit after 12–25 min on the subscription). 1h writes cost 2x base instead
        // of 1.25x, reads 0.1x. An explicit CLAUDE_CODE_PROMPT_CACHE_TTL in the environment wins.
        env.CLAUDE_CODE_PROMPT_CACHE_TTL ??= '1h';
    }

    return env;
}

/** Only forward genuine Anthropic API keys (sk-ant-*). SillyTavern always
 *  sends `Authorization: Bearer <key>` for Custom sources, even placeholders,
 *  so anything else is treated as "no key" to keep subscription auth intact. */
export function pickApiKeyFromAuthHeader(req) {
    const auth = req.get('authorization') || '';
    const match = auth.match(/^Bearer\s+(.+)$/i);
    if (!match) return null;
    const key = match[1].trim();
    if (!/^sk-ant-/i.test(key)) return null;
    return key;
}

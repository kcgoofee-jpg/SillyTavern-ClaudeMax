// ──────────────────────────────────────────────
// Per-request settings extraction
// ──────────────────────────────────────────────
//
// The companion UI extension injects a `claude_subscription` object into the
// request body via SillyTavern's `custom_include_body` channel — the only
// per-request path that survives ST's backend unconditionally (its native
// reasoning_effort field is dropped for non-OpenAI model IDs at
// src/endpoints/backends/chat-completions.js:2507-2513, and its "Maximum"
// dropdown value is downgraded to "high" client-side before that).
//
// Direct API users (curl, other frontends) can send the same object, or the
// standard OpenAI `reasoning_effort` field, or nothing at all.

export const VALID_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
const VALID_THINKING = ['off', 'adaptive', 'on'];

/** Gate effort to the SDK's closed vocabulary; anything else → undefined
 *  (model default) instead of erroring the whole request. Case-sensitive on
 *  purpose — the SDK wants lowercase. */
export function normalizeEffort(value) {
    return VALID_EFFORTS.includes(value) ? value : undefined;
}

/**
 * @param {object} body OpenAI chat completions request body
 * @returns {{
 *   effort: string|undefined,
 *   thinking: 'off'|'adaptive'|'on',
 *   thinkingBudget: number|undefined,
 *   showReasoning: boolean,
 *   identityMode: boolean,
 *   useResume: boolean,
 *   systemPlacement: 'inline'|'hoist',
 *   auxiliary: boolean,
 *   maxTokens: number|undefined,
 *   stops: string[],
 * }}
 */
export function extractSettings(body) {
    const fromPanel = !!(body.claude_subscription && typeof body.claude_subscription === 'object');
    const ns = fromPanel ? body.claude_subscription : {};
    // No panel settings and no effort field: an auxiliary caller (a preset
    // helper's "API" mode such as 嘤嘤札记, another extension's summary call)
    // rather than the main chat. Those want a quick answer — thinking first
    // just adds seconds — so they default to thinking OFF. Adaptive-only
    // models still think (they cannot turn it off).
    // CLAUDE_SUBSCRIPTION_AUX_THINKING=adaptive restores the old default.
    const auxiliary = !fromPanel && body.reasoning_effort === undefined && body.reasoning?.effort === undefined;

    const effort = normalizeEffort(ns.effort)
        ?? normalizeEffort(body.reasoning_effort)
        ?? normalizeEffort(body.reasoning?.effort);

    // Default adaptive: the model decides when to think (and adaptive-only
    // families always think regardless).
    const auxDefault = VALID_THINKING.includes(process.env.CLAUDE_SUBSCRIPTION_AUX_THINKING) ? process.env.CLAUDE_SUBSCRIPTION_AUX_THINKING : 'off';
    const thinking = VALID_THINKING.includes(ns.thinking) ? ns.thinking : (auxiliary ? auxDefault : 'adaptive');

    const thinkingBudget = Number.isFinite(ns.thinking_budget) && ns.thinking_budget > 0
        ? Math.floor(ns.thinking_budget)
        : undefined;

    const maxTokens = Number.isFinite(body.max_tokens) && body.max_tokens > 0
        ? Math.floor(body.max_tokens)
        : (Number.isFinite(body.max_completion_tokens) && body.max_completion_tokens > 0
            ? Math.floor(body.max_completion_tokens)
            : undefined);

    let stops = [];
    if (Array.isArray(body.stop)) stops = body.stop.filter((s) => typeof s === 'string' && s.length > 0);
    else if (typeof body.stop === 'string' && body.stop.length > 0) stops = [body.stop];
    // Anthropic caps stop sequences at 4 upstream; we enforce client-side
    // anyway, but keep the list sane.
    stops = stops.slice(0, 16);

    return {
        effort,
        thinking,
        thinkingBudget,
        showReasoning: ns.show_reasoning !== false, // default ON — ST renders reasoning_content natively
        identityMode: ns.identity_mode === true,     // claude_code preset + append (self-ID fix, coding framing)
        useResume: ns.use_resume !== false,          // synthetic-session resume (fold fallback when off/failed)
        // Depth-injected system messages stay in place as user turns (like
        // SillyTavern's own Claude converter) unless explicitly hoisted.
        systemPlacement: ns.system_placement === 'hoist' ? 'hoist' : 'inline',
        // Dev tool: save the last full request (system prompt + messages) locally.
        debugDump: ns.debug_dump === true,
        // Experimental: move a preset's post-history block in front (tail-block.js).
        tailBlock: ns.tail_block === 'front' ? 'front' : 'off',
        auxiliary,
        maxTokens,
        stops,
    };
}

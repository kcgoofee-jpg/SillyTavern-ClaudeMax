// ──────────────────────────────────────────────
// /v1/chat/completions handler — v2 orchestrator
// ──────────────────────────────────────────────
//
// Accepts an OpenAI Chat Completions request, runs it through the local
// Claude Agent SDK, and emits OpenAI-format SSE chunks (or a single JSON
// response when stream=false).
//
// v2 pipeline per request:
//   1. Parse model ([1m] variants → tier alias + env pin), settings
//      (effort / thinking / stops / max_tokens from the request body, with
//      the companion UI extension's `claude_subscription` namespace).
//   2. System messages → SDK systemPrompt (plain client string by default —
//      the roleplay path; optional claude_code-preset "identity mode").
//   3. Prior turns → synthetic Claude Code JSONL session, replayed through a
//      one-shot SessionStore + `resume` so the model sees REAL multi-turn
//      context (role fidelity + prompt caching). Trailing-assistant prefill
//      becomes a continuation instruction. Falls back to the v1 transcript
//      fold on any resume-path failure.
//   4. Query with the roleplay isolation recipe: tools:[], skills:[],
//      settingSources:[], bypassPermissions + explicit opt-in, no MCP.
//   5. Stream translation: text deltas → delta.content (with server-side
//      stop-sequence enforcement — the SDK has none), thinking deltas →
//      delta.reasoning_content (SillyTavern renders these natively).
//   6. Resilience ladder (from Meridian, retries only before first output):
//      expired token → out-of-band OAuth refresh + one retry;
//      [1m] Extra-Usage failure → strip to base model + 1h cooldown + retry;
//      rate limit → up to 2 retries with 1s/2s backoff.
//   7. Privacy sweep: best-effort delete of the live-turn transcript the CLI
//      wrote under ~/.claude/projects (roleplay text shouldn't persist).

import { randomUUID } from 'node:crypto';

import { loadSdk } from './sdk-loader.js';
import { renderTranscript } from './transcript.js';
import { extractSettings } from './settings.js';
import { parseModelRequest, isExtendedContextKnownUnavailable, recordExtendedContextUnavailable } from './models.js';
import { buildSubprocessEnv, pickApiKeyFromAuthHeader } from './env.js';
import { buildSystemPrompt, extractSystemText } from './system-prompt.js';
import { assembleEntries, splitHistoryForResume, currentToSdkUserMessage, singleMessageStream, SDK_VERSION } from './jsonl-entries.js';
import { ResumeSessionStore, resumeScratchCwd, sweepSessionTranscript } from './session-store.js';
import { createTurnCollector, replayTurn, sentTextFor } from './turn-capture.js';
import { StopScanner } from './stops.js';
import { makeCompletionId, writeSse, chunkShell, roleChunk, contentChunk, reasoningChunk, finishChunk, errorEvent, toOpenAiUsage } from './sse.js';
import { isExpiredTokenError, isRateLimitError, isExtraUsageRequiredError, isStaleSessionError, refreshOAuthToken } from './oauth.js';
import { formatErrorForUser } from './errors-zh.js';
import { recordRequest, promptShape } from './usage-stats.js';
import { inlineLateSystemMessages } from './system-placement.js';
import { moveTailBlockToFront } from './tail-block.js';
import { diagnoseCache, describeDiag } from './cache-diag.js';
import { extractVolatileBlocks, foldTrailingInjections, injectBlocks, injectedTextFor, loreTarget, newLoreOnly, rememberInjected } from './lore-tail.js';
import { dumpRequest } from './debug-dump.js';

const PLUGIN_TAG = '[claude-subscription]';
const MAX_RATE_LIMIT_RETRIES = 2;
// Below this max_tokens, the CLI's derived thinking budget violates the
// API's >= 1024 floor on non-adaptive models (verified live).
const MIN_MAX_TOKENS_FOR_THINKING = 2048;
// Absolute deadline for non-streaming queries (no heartbeat exists between
// init and the finished assistant message, so idle-based detection is
// impossible; this only reaps a truly hung subprocess).
const NONSTREAM_DEADLINE_MS = 10 * 60 * 1000;
// No real upstream message for this long → abort (downstream keep-alives can
// mask a hung subprocess forever otherwise). Meridian uses the same figure.
const UPSTREAM_IDLE_MS = 90000;

const envFlag = (name, fallback) => {
    const v = process.env[name];
    if (v === undefined || v === '') return fallback;
    return !/^(0|false|no|off)$/i.test(v);
};

function buildSdkOptions({ modelInfo, oneMActive, settings, systemText, abortController, stream, env, resume, boundary }) {
    const options = {
        abortController,
        model: oneMActive ? modelInfo.sdkModel : modelInfo.baseId,
        systemPrompt: buildSystemPrompt(systemText, settings.identityMode, settings.systemSplitAt, boundary),
        includePartialMessages: stream,
        env,

        // Roleplay isolation recipe — SillyTavern owns the conversation
        // surface; nothing from the host machine may leak into the context:
        tools: [],                    // no built-in agent tools (0.2.x enforces this)
        skills: [],                   // no skills
        settingSources: [],           // no ~/.claude settings, CLAUDE.md, hooks, output styles
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true, // required with bypassPermissions on 0.2.x

        // maxTurns: 1 is safe with tools:[] (no tool round-trips) and is what
        // Marinara ships in production on this SDK line. Overridable because
        // v1 removed it over thinking-steps-consume-turns (their PR #294).
        maxTurns: Number(process.env.CLAUDE_SUBSCRIPTION_MAX_TURNS) || 1,

        // Deliver the chat text as written: no `@path` file expansion (a
        // roleplay line containing "@notes.txt" would otherwise pull a local
        // file into the prompt), no slash-command dispatch, and none of the
        // CLI's turn-start reminders, which the model kept noticing and
        // "skipping as irrelevant" in its thinking. CLI ≥ 2.1.248.
        verbatimPrompts: envFlag('CLAUDE_SUBSCRIPTION_VERBATIM', true),
    };

    if (process.env.CLAUDE_SUBSCRIPTION_CLAUDE_PATH) {
        options.pathToClaudeCodeExecutable = process.env.CLAUDE_SUBSCRIPTION_CLAUDE_PATH;
    }

    // Thinking / effort. ALWAYS set thinking explicitly — omitting it lets
    // the CLI auto-enable thinking with a budget derived from
    // CLAUDE_CODE_MAX_OUTPUT_TOKENS, which 400s below ~2048 max tokens
    // ("thinking.enabled.budget_tokens: Input should be >= 1024", verified
    // live). Rules:
    //   • Adaptive-only families (Opus 4.7+, Fable) natively adapt; no
    //     budget field is ever sent — safe at any max_tokens. Always adaptive.
    //   • Other models translate adaptive/enabled into a budgeted request;
    //     with max_tokens set below MIN_MAX_TOKENS_FOR_THINKING the budget
    //     is illegal, so thinking is forced off (raise SillyTavern's "Max
    //     response length" to re-enable).
    // `display` controls whether thinking CONTENT is emitted at all: without
    // it the CLI streams only a signature and delivers an EMPTY thinking
    // block (verified live on 0.2.141) — 'summarized' streams real
    // thinking_delta events; 'omitted' saves the bandwidth when the user
    // hides reasoning.
    const display = settings.showReasoning ? 'summarized' : 'omitted';
    if (modelInfo.adaptiveOnly) {
        options.thinking = { type: 'adaptive', display };
    } else if (modelInfo.noBudget) {
        // Sonnet 5: budget_tokens 400s, so "on" becomes adaptive; no budget
        // is ever sent, so the max_tokens floor doesn't apply.
        options.thinking = settings.thinking === 'off'
            ? { type: 'disabled' }
            : { type: 'adaptive', display };
    } else {
        const wantsThinking = settings.thinking === 'adaptive' || settings.thinking === 'on';
        const roomForThinking = !settings.maxTokens || settings.maxTokens >= MIN_MAX_TOKENS_FOR_THINKING;
        if (wantsThinking && roomForThinking) {
            if (settings.thinking === 'on') {
                const budget = settings.thinkingBudget
                    ? Math.max(1024, Math.min(settings.thinkingBudget, (settings.maxTokens ?? Infinity) - 512))
                    : undefined;
                options.thinking = budget
                    ? { type: 'enabled', budgetTokens: budget, display }
                    : { type: 'enabled', display };
            } else {
                options.thinking = { type: 'adaptive', display };
            }
        } else {
            if (wantsThinking && !roomForThinking) {
                console.log(`${PLUGIN_TAG} thinking disabled: max_tokens ${settings.maxTokens} < ${MIN_MAX_TOKENS_FOR_THINKING} (raise Max response length in SillyTavern to enable thinking on ${modelInfo.baseId})`);
            }
            options.thinking = { type: 'disabled' };
        }
    }
    if (settings.effort) {
        options.effort = settings.effort;
    }

    // Always run the subprocess in the scratch bucket so any live-turn
    // transcript that escapes the best-effort sweep lands in the plugin's
    // own project dir instead of intermingling with the user's real
    // `claude` sessions for SillyTavern's working directory.
    try {
        options.cwd = resume ? resume.cwd : resumeScratchCwd();
    } catch { /* unwritable scratch dir — fall back to process cwd */ }

    if (resume) {
        options.resume = resume.sessionId;
        options.sessionStore = resume.store;
    }

    return options;
}

/**
 * Build the query configuration. Tries the resume path; falls back to the
 * v1 transcript fold when disabled or when scratch-dir setup fails.
 */
function buildQueryConfig({ messages: rawMessages, modelInfo, oneMActive, settings, abortController, stream, env, sdk }) {
    const messages = settings.systemPlacement === 'inline' ? inlineLateSystemMessages(rawMessages) : rawMessages;
    const systemText = extractSystemText(messages);

    if (settings.useResume && envFlag('CLAUDE_SUBSCRIPTION_USE_RESUME', true)) {
        try {
            const cwd = resumeScratchCwd();
            const sessionId = randomUUID();
            const split = splitHistoryForResume(messages);
            const meta = {
                sessionId,
                cwd,
                version: SDK_VERSION,
                gitBranch: '',
                permissionMode: 'bypassPermissions',
            };
            const entries = assembleEntries(split.history, meta, modelInfo.baseId, { replay: envFlag('CLAUDE_SUBSCRIPTION_TURN_REPLAY', true) ? replayTurn : null });
            // Empty entry lists make the SDK reject the resume with "No
            // conversation found" — first turns can't resume.
            if (entries.length > 0) {
                const prompt = singleMessageStream(currentToSdkUserMessage(split.current));
                const collector = createTurnCollector(typeof split.current?.content === 'string' ? split.current.content : null, settings.captureKey);
                const resume = { sessionId, store: new ResumeSessionStore(sessionId, entries, collector.onAppend), cwd };
                const options = buildSdkOptions({ modelInfo, oneMActive, settings, systemText, abortController, stream, env, resume, boundary: sdk?.SYSTEM_PROMPT_DYNAMIC_BOUNDARY });
                return { prompt, options, path: 'resume', sessionId, shape: split.shape };
            }
            // No replayable history, but a string fold would drop image
            // blocks — use streaming-input mode without resume so images
            // survive turn one.
            const hasImages = Array.isArray(split.current?.content)
                && split.current.content.some((p) => p?.type === 'image_url');
            if (hasImages) {
                const prompt = singleMessageStream(currentToSdkUserMessage(split.current));
                const options = buildSdkOptions({ modelInfo, oneMActive, settings, systemText, abortController, stream, env, resume: null, boundary: sdk?.SYSTEM_PROMPT_DYNAMIC_BOUNDARY });
                return { prompt, options, path: 'stream-input', sessionId: null, shape: split.shape };
            }
        } catch (err) {
            console.warn(`${PLUGIN_TAG} resume path unavailable, folding transcript:`, err instanceof Error ? err.message : err);
        }
    }

    // Fold fallback: renderTranscript extracts the same system text we
    // already have in systemText (its systemPrompt return is redundant here)
    // and folds the non-system turns into a labelled string prompt.
    const { prompt } = renderTranscript(messages);
    const options = buildSdkOptions({ modelInfo, oneMActive, settings, systemText, abortController, stream, env, resume: null, boundary: sdk?.SYSTEM_PROMPT_DYNAMIC_BOUNDARY });
    return { prompt, options, path: 'fold', sessionId: null, shape: 'fold' };
}

/**
 * Run one SDK query attempt, normalizing SDK messages into simple events:
 *   { kind: 'text', text }        visible output delta (stream only)
 *   { kind: 'reasoning', text }   thinking delta (stream only)
 *   { kind: 'blocks', blocks }    full assistant content (non-stream)
 *   { kind: 'done', usage, stopReason }  success terminator
 *   { kind: 'refusal', fallback, category }  the model stopped with stop_reason "refusal"
 * Throws Error with .sdkErrorText on failure (classified by the caller).
 */
/** Served-model guard: refuse to silently substitute another model for an
 *  explicit Fable request. If Anthropic gates/disables Fable (it has been
 *  toggled off before), the CLI can resolve the request to its default Opus
 *  instead — a silent style/capability switch mid-roleplay is exactly what
 *  the user must NOT get. Checked against the resolved model on the init
 *  message (before any output) and each main-thread assistant message. */
export function assertServedModel(guardTier, servedModel, requestedModel) {
    if (guardTier !== 'fable') return;
    const served = String(servedModel ?? '').toLowerCase();
    // '<synthetic>' is the CLI's own error/notice message (auth failure,
    // API error, limit hit) — not a substitution. Let the error path report
    // the real cause instead of masking it as a guard violation.
    if (!served || served === '<synthetic>') return;
    if (!served.includes('fable') && !served.includes('mythos')) {
        const err = new Error(
            `Model substitution refused: you requested ${requestedModel} but the upstream resolved to ` +
            `${servedModel}. Fable may be temporarily unavailable on your plan — pick another model ` +
            'explicitly instead of being silently switched. (served-model guard)',
        );
        err.sdkErrorText = 'served-model-guard';
        err.noRetry = true;
        throw err;
    }
}

async function* runQuery({ sdk, prompt, options, stream, guardTier, requestedModel, timing = {} }) {
    let idleTimer = null;
    const abort = options.abortController;
    // Idle guard: with includePartialMessages (stream) the SDK emits a
    // steady message flow, so per-message re-arming detects a hung upstream.
    // With stream=false NOTHING arrives between init and the finished
    // assistant message — a healthy long generation (xhigh + long RP reply)
    // easily exceeds 90s — so non-stream gets one long absolute deadline
    // instead. Idle aborts are tagged on the controller so the caller can
    // distinguish them from client-close / stop-sequence aborts.
    const idleMs = stream ? UPSTREAM_IDLE_MS : NONSTREAM_DEADLINE_MS;
    const fireIdleAbort = () => {
        console.warn(`${PLUGIN_TAG} upstream ${stream ? 'idle' : 'deadline exceeded'} after ${idleMs}ms — aborting query`);
        abort.idleAbort = true;
        abort.abort();
    };
    const armIdleGuard = () => {
        if (!stream) return; // absolute deadline armed once below
        if (idleTimer) clearTimeout(idleTimer);
        idleTimer = setTimeout(fireIdleAbort, idleMs);
        idleTimer.unref?.();
    };

    idleTimer = setTimeout(fireIdleAbort, idleMs);
    idleTimer.unref?.();
    try {
        timing.queryAt ??= Date.now();
        const handle = sdk.query({ prompt, options });
        for await (const message of handle) {
            armIdleGuard();

            // A safety stop mid-reply: the text so far is kept but the reply
            // is cut off. With a fallback configured the CLI retries the
            // turn on another model — the reply then comes from that model.
            if (message.type === 'system' && (message.subtype === 'model_refusal_no_fallback' || message.subtype === 'model_refusal_fallback')) {
                yield { kind: 'refusal', fallback: message.subtype === 'model_refusal_fallback' ? message.fallback_model ?? '?' : null, category: message.api_refusal_category ?? null };
                continue;
            }
            if (message.type === 'system' && message.subtype === 'init') {
                timing.initAt ??= Date.now();
                // Resolved model is known BEFORE any generation — the guard
                // fires here so a substituted request dies with zero output.
                assertServedModel(guardTier, message.model, requestedModel);
                if (message.session_id) {
                    // The CLI-minted session id — needed to privacy-sweep the
                    // live-turn transcript on the fold/stream-input paths
                    // where no pre-minted resume sessionId exists.
                    yield { kind: 'session', id: message.session_id };
                }
            } else if (message.type === 'stream_event') {
                const event = message.event;
                if (event?.type === 'message_start') timing.messageStartAt ??= Date.now();
                if (event?.type === 'content_block_delta') timing.firstDeltaAt ??= Date.now();
                // parent_tool_use_id != null would be subagent traffic; with
                // tools:[] there are no subagents, but filter defensively.
                if (message.parent_tool_use_id) continue;
                if (event?.type === 'content_block_delta' && event.delta) {
                    if (event.delta.type === 'text_delta' && event.delta.text) {
                        yield { kind: 'text', text: event.delta.text };
                    } else if (event.delta.type === 'thinking_delta' && event.delta.thinking) {
                        yield { kind: 'reasoning', text: event.delta.thinking };
                    }
                }
            } else if (message.type === 'assistant') {
                // Belt-and-suspenders served-model check on the actual reply
                // (main thread only — parent_tool_use_id filters bookkeeping
                // side-channels like the SDK's Haiku title generator).
                if (!message.parent_tool_use_id) {
                    assertServedModel(guardTier, message.message?.model, requestedModel);
                }
                // Assistant-level errors (auth failures, API 4xx) surface here
                // with the useful text in the content blocks, not in the enum —
                // extract both so the retry ladder can classify them.
                if (message.error) {
                    const blocks = message.message?.content ?? [];
                    const text = blocks
                        .filter((b) => b.type === 'text' && b.text)
                        .map((b) => b.text)
                        .join(' ');
                    const err = new Error(text || `assistant error: ${message.error}`);
                    err.sdkErrorText = `${message.error} ${text}`;
                    throw err;
                }
                if (!stream) {
                    yield { kind: 'blocks', blocks: message.message?.content ?? [] };
                } else {
                    // Streamed thinking arrives as a COMPLETE block on the
                    // assistant message, not as thinking_delta events — the
                    // CLI's summarized-thinking display only streams a
                    // signature_delta (verified live on 0.2.141 + Fable).
                    // The thinking-block assistant message lands before the
                    // text deltas start, so emitting here still renders ahead
                    // of the reply in SillyTavern.
                    for (const block of message.message?.content ?? []) {
                        if (block.type === 'thinking' && block.thinking) {
                            yield { kind: 'reasoning-block', text: block.thinking };
                        }
                    }
                }
            } else if (message.type === 'result') {
                if (message.subtype === 'success') {
                    yield { kind: 'done', usage: message.usage ?? null, stopReason: message.stop_reason ?? null };
                    return;
                }
                const detail = (message.errors ?? []).join('; ');
                const err = new Error(`Claude (Subscription) request failed (${message.subtype})${detail ? ' — ' + detail : ''}`);
                err.sdkErrorText = `${message.subtype} ${detail}`;
                throw err;
            }
            // Everything else (system/init, status, rate_limit events, ...)
            // is bookkeeping; prompt_suggestion can arrive after result but
            // we return at result.
        }
        // Generator ended without a result message.
        yield { kind: 'done', usage: null };
    } finally {
        if (idleTimer) clearTimeout(idleTimer);
    }
}

export async function handleChatCompletions(req, res) {
    const body = req.body || {};
    let messages = body.messages;
    const requestedModel = body.model;

    if (!Array.isArray(messages) || messages.length === 0 || !requestedModel) {
        return res.status(400).json({
            error: { message: 'messages[] (non-empty) and model are required', type: 'invalid_request_error' },
        });
    }

    const wantStream = body.stream !== false;
    const settings = extractSettings(body);
    if (settings.tailBlock === 'front') {
        const { messages: reordered, moved } = moveTailBlockToFront(messages);
        if (moved) {
            messages = reordered;
            console.log(`${PLUGIN_TAG} 预设后置条目提前：${moved} 条移到对话最前（每轮相同的后置块）`);
        }
    }
    const apiKey = pickApiKeyFromAuthHeader(req);
    const modelInfo = parseModelRequest(requestedModel);

    let sdk;
    try {
        sdk = await loadSdk();
    } catch (err) {
        return res.status(500).json({
            error: { message: err instanceof Error ? err.message : String(err), type: 'sdk_unavailable' },
        });
    }

    const startedAt = Date.now();
    const shape = promptShape(messages);
    let cacheDiag = null;
    // Background calls (another extension's tag writer, a summary) are not
    // turns of the conversation: keep them out of the per-chat cache memory
    // and the lore-tail learning.
    if (!settings.auxiliary) try {
        const placed = settings.systemPlacement === 'inline' ? inlineLateSystemMessages(messages) : messages;
        const history = placed.filter((m) => m?.role !== 'system');
        cacheDiag = diagnoseCache(extractSystemText(placed), history);
        console.log(`${PLUGIN_TAG} ${describeDiag(cacheDiag)}`);
        settings.systemSplitAt = cacheDiag?.splitAt ?? null;
        let sent = placed;
        if (settings.loreTail || settings.foldTail) {
            const volatile = settings.loreTail ? cacheDiag?.volatileTags ?? [] : [];
            const systemText = extractSystemText(placed) ?? '';
            const { system, blocks } = volatile.length ? extractVolatileBlocks(systemText, volatile) : { system: systemText, blocks: [] };
            const rawTarget = loreTarget(history);
            const rawLast = history.findLastIndex((m) => m?.role === 'user');
            // Earlier player messages that carried lore go out again as they
            // were sent (turn captures replay the current-turn ones).
            const restored = history.map((m, i) => {
                if (i === rawTarget || m?.role !== 'user' || typeof m.content !== 'string' || sentTextFor(m.content)) return m;
                const was = injectedTextFor(m.content);
                return was ? { ...m, content: was } : m;
            });
            const earlierOf = (list, upTo) => list.slice(0, Math.max(0, upTo))
                .filter((m) => m?.role === 'user' && typeof m.content === 'string')
                .map((m) => sentTextFor(m.content) ?? m.content);
            const fold = settings.foldTail ? foldTrailingInjections(restored, earlierOf(restored, rawTarget)) : { history: restored, folded: 0, repeated: 0 };
            const target = loreTarget(fold.history);
            const lastUser = fold.history.findLastIndex((m) => m?.role === 'user');
            const fresh = blocks.length ? newLoreOnly(blocks, earlierOf(fold.history, target)) : [];
            const withLore = injectBlocks(fold.history, fresh);
            if (blocks.length || fold.folded || restored.some((m, i) => m !== history[i])) {
                sent = [{ role: 'system', content: system }, ...withLore];
                messages = sent;
                // Next turn these messages come back as ST has them (no lore,
                // injections separate): file them under that text so they
                // are sent again exactly as they went out.
                if (target >= 0 && target !== lastUser) rememberInjected(history[rawTarget].content, withLore[target].content);
                const key = history[fold.folded ? rawTarget : rawLast]?.content;
                if (typeof key === 'string') settings.captureKey = key;
            }
            if (fold.folded) {
                console.log(`${PLUGIN_TAG} 你发言后面的 ${fold.folded} 条注入（角色卡深度 0 条目）接在发言末尾一起发${fold.repeated ? `，其中 ${fold.repeated} 段与之前一字不差，改为一句说明` : ''}`);
            }
            if (blocks.length) {
                cacheDiag.loreMoved = blocks.map((b) => b.tag);
                const n = (list) => list.reduce((k, b) => k + b.text.length, 0).toLocaleString();
                console.log(`${PLUGIN_TAG} 每轮变化的 ${blocks.map((b) => `<${b.tag}>`).join('、')} 移出系统提示词（${n(blocks)} 字），本轮新增 ${n(fresh)} 字放在消息开头，之前给过的不再重复`);
            }
        }
        if (settings.debugDump) dumpRequest({ model: requestedModel, settings, raw: body.messages, placed: sent, cacheDiag });
    } catch (err) {
        console.warn(`${PLUGIN_TAG} cache diagnostics failed:`, err instanceof Error ? err.message : err);
    }
    let firstTokenAt = null;
    // Where the time to first token goes (M-opt #4): proxy + CLI start-up,
    // CLI → API until the response starts, then the first content delta.
    const timing = {};
    let lastPath = null;
    const completionId = makeCompletionId();
    const created = Math.floor(Date.now() / 1000);
    const shell = chunkShell(completionId, created, modelInfo.requested);

    // Stream state shared across retry attempts.
    let didYieldContent = false;
    let sseStarted = false;
    let usage = null;
    let finishReason = 'stop';
    let refusal = null;
    let collectedText = '';
    let collectedReasoning = '';
    const sweepIds = [];

    const startSse = () => {
        firstTokenAt ??= Date.now();
        if (sseStarted) return;
        sseStarted = true;
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        if (typeof res.flushHeaders === 'function') res.flushHeaders();
        writeSse(res, roleChunk(shell));
    };

    // Fresh AbortController per attempt — an aborted controller (idle guard,
    // failed attempt) must never poison the retry. Client disconnect aborts
    // whichever attempt is current.
    let abortController = null;
    let clientClosed = false;
    const onClientClose = () => {
        clientClosed = true;
        abortController?.abort();
    };
    req.on('close', onClientClose);

    // Retry ladder state.
    let oneMActive = modelInfo.oneM && !isExtendedContextKnownUnavailable();
    let didTokenRefresh = false;
    let rateLimitRetries = 0;

    try {
        // eslint-disable-next-line no-constant-condition
        while (true) {
            if (clientClosed) break;
            abortController = new AbortController();
            const env = buildSubprocessEnv({ envPins: modelInfo.envPins, maxTokens: settings.maxTokens, apiKey });
            const cfg = buildQueryConfig({
                messages, modelInfo, oneMActive, settings,
                abortController, stream: wantStream, env, sdk,
            });
            if (cfg.sessionId) sweepIds.push(cfg.sessionId);
            lastPath = cfg.path;

            try {
                let stopMatched = false;
                let sawReasoningDeltas = false;
                // Per-attempt scanner — a shared one would leak held-back
                // text from a failed attempt into the retry's output.
                const scanner = new StopScanner(settings.stops);

                for await (const ev of runQuery({
                    sdk, prompt: cfg.prompt, options: cfg.options, stream: wantStream,
                    guardTier: modelInfo.tier, requestedModel: modelInfo.requested, timing,
                })) {
                    if (ev.kind === 'session') {
                        // CLI-minted session id (fold / stream-input paths)
                        // so the privacy sweep covers their transcripts too.
                        if (!sweepIds.includes(ev.id)) sweepIds.push(ev.id);
                    } else if (ev.kind === 'text') {
                        const { emit, matched } = scanner.feed(ev.text);
                        if (emit) {
                            didYieldContent = true;
                            if (wantStream) {
                                startSse();
                                writeSse(res, contentChunk(shell, emit));
                            }
                            collectedText += emit;
                        }
                        if (matched) {
                            stopMatched = true;
                            finishReason = 'stop';
                            abortController.abort();
                            break;
                        }
                    } else if (ev.kind === 'reasoning') {
                        if (!settings.showReasoning) continue;
                        didYieldContent = true;
                        sawReasoningDeltas = true;
                        if (wantStream) {
                            startSse();
                            writeSse(res, reasoningChunk(shell, ev.text));
                        }
                        collectedReasoning += ev.text;
                    } else if (ev.kind === 'reasoning-block') {
                        // Complete thinking block from the assistant message.
                        // Skip if raw deltas already streamed it (older CLIs).
                        if (!settings.showReasoning || sawReasoningDeltas) continue;
                        didYieldContent = true;
                        if (wantStream) {
                            startSse();
                            writeSse(res, reasoningChunk(shell, ev.text));
                        }
                        collectedReasoning += ev.text;
                    } else if (ev.kind === 'blocks') {
                        for (const block of ev.blocks) {
                            if (block.type === 'text' && block.text) {
                                const { emit, matched } = scanner.feed(block.text);
                                if (emit) collectedText += emit;
                                if (matched) { stopMatched = true; break; }
                            } else if (block.type === 'thinking' && block.thinking && settings.showReasoning) {
                                collectedReasoning += block.thinking;
                            }
                        }
                        if (collectedText || collectedReasoning) {
                            didYieldContent = true;
                            firstTokenAt ??= Date.now();
                        }
                    } else if (ev.kind === 'refusal') {
                        refusal = { fallback: ev.fallback, category: ev.category };
                    } else if (ev.kind === 'done') {
                        usage = ev.usage;
                        if (ev.stopReason === 'refusal') refusal ??= { fallback: null, category: null };
                        if (ev.stopReason === 'max_tokens') finishReason = 'length';
                    }
                }

                if (!stopMatched) {
                    const tail = scanner.flush();
                    if (tail) {
                        didYieldContent = true;
                        if (wantStream) {
                            startSse();
                            writeSse(res, contentChunk(shell, tail));
                        }
                        collectedText += tail;
                    }
                }
                break; // success
            } catch (err) {
                const errText = err?.sdkErrorText ?? (err instanceof Error ? err.message : String(err));

                // Guard violations (served-model) are terminal by design —
                // never retried into a different model.
                if (err?.noRetry) throw err;

                // Client went away / stop-sequence abort → not an error.
                // Idle-guard aborts are excluded: a hang after partial output
                // must surface as an error, not a clean finish.
                if (abortController.signal.aborted && didYieldContent && !abortController.idleAbort) break;
                if (clientClosed) break;

                // Never retry into a stream that already has content.
                if (!didYieldContent) {
                    if (oneMActive && isExtraUsageRequiredError(errText)) {
                        console.warn(`${PLUGIN_TAG} 1M context unavailable (Extra Usage) — retrying on base model, cooldown 1h`);
                        recordExtendedContextUnavailable();
                        oneMActive = false;
                        continue;
                    }
                    if (isExpiredTokenError(errText) && !didTokenRefresh) {
                        didTokenRefresh = true;
                        console.warn(`${PLUGIN_TAG} auth expired — attempting OAuth refresh + one retry`);
                        const refreshed = await refreshOAuthToken();
                        if (refreshed) continue;
                    }
                    if (isRateLimitError(errText) && rateLimitRetries < MAX_RATE_LIMIT_RETRIES) {
                        rateLimitRetries += 1;
                        if (oneMActive) {
                            // 1M quota is a separate bucket — drop to base, no cooldown.
                            oneMActive = false;
                        }
                        const delay = 1000 * rateLimitRetries;
                        console.warn(`${PLUGIN_TAG} rate limited — retry ${rateLimitRetries}/${MAX_RATE_LIMIT_RETRIES} in ${delay}ms`);
                        await new Promise((r) => setTimeout(r, delay));
                        continue;
                    }
                    if (isStaleSessionError(errText) && cfg.path === 'resume') {
                        console.warn(`${PLUGIN_TAG} stale resume session — retrying via transcript fold`);
                        settings.useResume = false;
                        continue;
                    }
                }
                throw err;
            }
        }
    } catch (err) {
        const raw = err instanceof Error ? err.message : String(err);
        recordRequest({
            model: modelInfo.requested, effort: settings.effort ?? null, placement: settings.systemPlacement, auxiliary: settings.auxiliary, purpose: settings.purpose, timing, path: lastPath, stream: wantStream, startedAt, firstTokenAt, shape, cacheDiag,
            usage, textChars: collectedText.length, reasoningChars: collectedReasoning.length,
            error: err?.sdkErrorText === 'served-model-guard' ? `served-model guard: ${raw}` : raw,
        });
        const message = formatErrorForUser(err?.sdkErrorText === 'served-model-guard' ? `served-model guard: ${raw}` : raw);
        if (wantStream && sseStarted) {
            writeSse(res, errorEvent(message));
            res.write('data: [DONE]\n\n');
            return res.end();
        }
        return res.status(500).json({ error: { message, type: 'server_error' } });
    } finally {
        req.off('close', onClientClose);
        for (const id of sweepIds) sweepSessionTranscript(loadSdk, id);
    }

    // What the panel should tell the user about this turn (it shows a toast).
    const notices = [];
    if (modelInfo.oneM && !oneMActive) notices.push('no-1m');
    if (refusal) notices.push(refusal.fallback ? `fallback:${refusal.fallback}` : 'refusal');
    if (refusal) {
        finishReason = 'content_filter';
        console.warn(`${PLUGIN_TAG} ⚠ 回复被 Claude 的安全机制中途截断（stop_reason: refusal${refusal.category ? `，类别 ${refusal.category}` : ''}）${refusal.fallback ? `，CLI 已改用 ${refusal.fallback} 重试，这条回复来自该模型` : '，保留了截断前的文字'}`);
    }

    recordRequest({
        model: modelInfo.requested, effort: settings.effort ?? null, placement: settings.systemPlacement, auxiliary: settings.auxiliary, purpose: settings.purpose, timing, path: lastPath, stream: wantStream, startedAt, firstTokenAt, shape, cacheDiag,
        usage, textChars: collectedText.length, reasoningChars: collectedReasoning.length,
        finish: finishReason, clientClosed, notices,
    });

    const openAiUsage = toOpenAiUsage(usage);

    if (wantStream) {
        startSse(); // ensure headers even for instant empty results
        writeSse(res, finishChunk(shell, finishReason, openAiUsage));
        res.write('data: [DONE]\n\n');
        return res.end();
    }

    const message = { role: 'assistant', content: collectedText };
    if (collectedReasoning) message.reasoning_content = collectedReasoning;
    const response = {
        id: completionId,
        object: 'chat.completion',
        created,
        model: modelInfo.requested,
        choices: [{ index: 0, message, finish_reason: finishReason }],
    };
    if (openAiUsage) response.usage = openAiUsage;
    return res.json(response);
}

// Embeddings are not supported on the subscription path.
export function rejectEmbeddings(_req, res) {
    return res.status(501).json({
        error: {
            message: 'The Claude (Subscription) proxy does not support embeddings. ' +
                'Configure a separate embedding source (OpenAI, Google, or local).',
            type: 'not_supported',
        },
    });
}

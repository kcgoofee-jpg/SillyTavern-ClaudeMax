// ──────────────────────────────────────────────
// Turn capture: replay each past user turn exactly as the CLI sent it
// ──────────────────────────────────────────────
//
// The CLI appends its per-turn context (environment, model, date, session
// info) to the CURRENT user message as system-reminder blocks, and records
// them as `attachment` entries after that user entry in the session
// transcript. Next turn that message is history; our synthetic transcript
// used to replay it WITHOUT those attachments, so its bytes changed and the
// prompt cache — whose only message breakpoint is the end of the previous
// request — could never read any of the conversation back: every turn
// re-wrote the whole history (verified live: identical history, system
// prompt read, history always re-written).
//
// Real Claude Code sessions don't have this problem because the transcript
// keeps the attachments. So do the same: the SessionStore's append() hands
// us every entry the CLI writes; keep the current user entry plus its
// attachments IN MEMORY (never on disk), keyed by the user text, and splice
// them back in when that message shows up in a later request's history.

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const MAX_TURNS = 400;
const captures = new Map(); // key → entries[] (user entry + its attachments)

const keyOf = (text) => createHash('sha1').update(String(text)).digest('hex');

function entryText(entry) {
    const c = entry?.message?.content;
    if (typeof c === 'string') return c;
    if (Array.isArray(c)) return c.filter((b) => b?.type === 'text').map((b) => b.text).join('\n');
    return '';
}

/**
 * Per-request collector for SessionStore.append(). Picks the user entry
 * whose text is the current prompt and the attachment entries that follow
 * it, up to the first assistant entry.
 *
 * `keyText` is what this message will look like in NEXT turn's history when
 * the proxy changed it before sending (lore-tail.js puts moving world info
 * on top of it): the capture is filed under that text, so next turn replays
 * the message exactly as it was sent and the cached prefix still matches.
 */
export function createTurnCollector(currentText, keyText = currentText, model = null) {
    let collecting = null;
    let done = false;
    return {
        onAppend(entries) {
            if (done) return;
            for (const e of entries ?? []) {
                if (done) break;
                if (!collecting) {
                    if (e?.type === 'user' && entryText(e) === currentText) collecting = [e];
                    continue;
                }
                if (e?.type === 'attachment') {
                    collecting.push(e);
                } else if (e?.type === 'assistant' || e?.type === 'user') {
                    remember(keyText ?? currentText, collecting);
                    const context = collecting.filter((x) => x?.type === 'attachment');
                    if (model && context.length) pinContext(model, context);
                    done = true;
                }
            }
        },
    };
}

function remember(text, entries) {
    const key = keyOf(text);
    captures.delete(key);
    captures.set(key, entries.map((e) => JSON.parse(JSON.stringify(e))));
    while (captures.size > MAX_TURNS) captures.delete(captures.keys().next().value);
}

/**
 * Captured entries for a past user message, re-chained into the new
 * transcript (parentUuid / sessionId / cwd rewritten). Null when unknown —
 * e.g. the first turn after a proxy restart; the caller then falls back to
 * a synthetic user entry and that one turn misses the cache.
 */
export function replayTurn(text, parentUuid, meta, { userOnly = false } = {}) {
    const found = captures.get(keyOf(text));
    if (!found) return null;
    let parent = parentUuid;
    return (userOnly ? found.filter((e) => e?.type !== 'attachment') : found).map((e) => {
        const copy = { ...JSON.parse(JSON.stringify(e)), parentUuid: parent, sessionId: meta.sessionId, cwd: meta.cwd };
        parent = copy.uuid;
        return copy;
    });
}

/** The text a past user message was actually sent with (null if unknown). */
export function sentTextFor(text) {
    const found = captures.get(keyOf(text));
    return found ? entryText(found[0]) : null;
}

// ── Context pin ──
//
// The CLI adds its per-session context (environment, model, date, account)
// as attachments to the current message only when the transcript it resumes
// has none. On the first request after a restart that is the LAST message of
// the request (a trailing system message); from the next request on the same
// text is mid-conversation and the API renders it differently — so the
// second turn after every restart re-wrote the whole history (seen with a
// request tap: identical bytes, cache read = system prompt only). Pinning a
// copy of that context right after the first transcript entry, in every
// request, keeps the structure the same from the first turn on; the CLI then
// adds nothing at the end. Kept per model (the model attachment names it) in
// data/ — account/environment details, no chat text.

const pins = new Map(); // model → attachment entries
let pinsLoaded = false;

function pinFile() {
    if (process.env.CLAUDE_SUBSCRIPTION_CONTEXT_PIN_FILE) return process.env.CLAUDE_SUBSCRIPTION_CONTEXT_PIN_FILE;
    if (process.env.NODE_TEST_CONTEXT) return null;
    return join(dirname(fileURLToPath(import.meta.url)), '..', 'data', 'cli-context.json');
}

function loadPins() {
    if (pinsLoaded) return;
    pinsLoaded = true;
    const f = pinFile();
    if (!f) return;
    try {
        for (const [model, entries] of Object.entries(JSON.parse(readFileSync(f, 'utf8')))) {
            if (Array.isArray(entries) && entries.length) pins.set(model, entries);
        }
    } catch { /* none yet */ }
}

export function pinContext(model, entries) {
    loadPins();
    if (pins.has(model)) return; // keep the first one: changing it would change every request
    pins.set(model, entries.map((e) => JSON.parse(JSON.stringify(e))));
    const f = pinFile();
    if (!f) return;
    try {
        mkdirSync(dirname(f), { recursive: true });
        writeFileSync(f, JSON.stringify(Object.fromEntries(pins)));
    } catch { /* memory only */ }
}

export function hasPinnedContext(model) {
    loadPins();
    return pins.has(model);
}

/** The pinned context for this model, re-chained after `parentUuid`; null if none yet. */
export function pinnedContext(model, parentUuid, meta) {
    loadPins();
    const found = pins.get(model);
    if (!found) return null;
    let parent = parentUuid;
    return found.map((e) => {
        const copy = { ...JSON.parse(JSON.stringify(e)), parentUuid: parent, sessionId: meta.sessionId, cwd: meta.cwd };
        parent = copy.uuid;
        return copy;
    });
}

/** Test seam. */
export function __resetTurnCaptures() {
    captures.clear();
    pins.clear();
    pinsLoaded = true;
}

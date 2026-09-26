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
// attachments IN MEMORY (never on disk), keyed by the user text AND the reply
// it answers, and splice them back in when that message shows up in a later
// request's history. The text alone is not enough: a player who types 「继续」
// three times in one chat sends three different messages (each with its own
// lore and context), and the same 「继续」 in another chat must never pick up
// this chat's lore. The reply before a message is the same every time that
// message is replayed, survives the oldest turns being trimmed off, and
// differs between chats.

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DATA_DIR } from './paths.js';

const MAX_TURNS = 400;
const captures = new Map(); // key → { entries: user entry + its attachments, contextPinned }

/** Memory key of a player message: its text plus the reply it answers (see above). */
export function turnKey(text, context = '') {
    return createHash('sha1').update(`${context ?? ''}\u0000${text}`).digest('hex');
}

function contentText(c) {
    if (typeof c === 'string') return c;
    if (Array.isArray(c)) return c.filter((b) => b?.type === 'text').map((b) => b.text).join('\n');
    return '';
}

function entryText(entry) {
    return contentText(entry?.message?.content);
}

/**
 * The reply a message at `index` answers: the text of the last non-blank
 * assistant message before it ('' if none). The proxy never changes
 * assistant messages, so this is the same in every request that contains the
 * message, whatever was done to the user messages around it.
 * @param {Array<{role: string, content: any}>} list
 */
export function replyBefore(list, index) {
    for (let j = Math.min(index, list?.length ?? 0) - 1; j >= 0; j--) {
        const m = list[j];
        if (m?.role !== 'assistant') continue;
        const t = contentText(m.content);
        if (t.trim()) return t;
    }
    return '';
}

/** replyBefore for every index of `list`, in one pass. */
export function repliesBefore(list) {
    const out = [];
    let last = '';
    for (const m of list ?? []) {
        out.push(last);
        if (m?.role === 'assistant') {
            const t = contentText(m.content);
            if (t.trim()) last = t;
        }
    }
    return out;
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
export function createTurnCollector(currentText, keyText = currentText, model = null, context = '') {
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
                    const attachments = collecting.filter((x) => x?.type === 'attachment');
                    // The first context the CLI adds becomes the pin. Anything it
                    // adds once a pin exists (the new date after midnight) is part
                    // of this turn only and stays with it on replay.
                    const becomesPin = !!model && attachments.length > 0 && !hasPinnedContext(model);
                    if (becomesPin) pinContext(model, attachments);
                    remember(keyText ?? currentText, context, collecting, becomesPin);
                    done = true;
                }
            }
        },
    };
}

function remember(text, context, entries, contextPinned) {
    const key = turnKey(text, context);
    captures.delete(key);
    captures.set(key, { entries: entries.map((e) => JSON.parse(JSON.stringify(e))), contextPinned });
    while (captures.size > MAX_TURNS) captures.delete(captures.keys().next().value);
}

/**
 * Captured entries for a past user message, re-chained into the new
 * transcript (parentUuid / sessionId / cwd rewritten). Null when unknown —
 * e.g. the first turn after a proxy restart; the caller then falls back to
 * a synthetic user entry and that one turn misses the cache.
 */
/**
 * `pinOn`: the request carries the pinned context — a turn whose attachments
 * BECAME that pin is replayed without them (they are already there, after the
 * first entry). Attachments the CLI added while a pin existed (e.g. the date
 * after midnight) are kept: they were sent with that turn, and the CLI looks
 * for the latest date in the transcript — without it the CLI would add the
 * date again to every new message and the previous one would change.
 * `context`: the reply this message answers (replyBefore).
 */
export function replayTurn(text, parentUuid, meta, { pinOn = false, context = '' } = {}) {
    const found = captures.get(turnKey(text, context));
    if (!found) return null;
    let parent = parentUuid;
    const list = pinOn && found.contextPinned ? found.entries.filter((e) => e?.type !== 'attachment') : found.entries;
    return list.map((e) => {
        const copy = { ...JSON.parse(JSON.stringify(e)), parentUuid: parent, sessionId: meta.sessionId, cwd: meta.cwd };
        parent = copy.uuid;
        return copy;
    });
}

/** The text a past user message was actually sent with (null if unknown). */
export function sentTextFor(text, context = '') {
    const found = captures.get(turnKey(text, context));
    return found ? entryText(found.entries[0]) : null;
}

/**
 * The replay/pin callbacks for assembleEntries. `pinKey` null = no pin.
 * @returns {{ replay: Function|null, pinned: Function|null, pinOn: boolean }}
 */
export function historyReplay(pinKey, { replay = true } = {}) {
    const pinOn = !!pinKey && hasPinnedContext(pinKey);
    return {
        pinOn,
        replay: replay ? (text, parent, meta, context) => replayTurn(text, parent, meta, { pinOn, context }) : null,
        pinned: pinOn ? (parent, meta) => pinnedContext(pinKey, parent, meta) : null,
    };
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
    const env = process.env.CLAUDE_SUBSCRIPTION_CONTEXT_PIN_FILE;
    if (env) return /^off$/i.test(env) ? null : env; // 'off': memory only, like CACHE_MEMORY_FILE
    if (process.env.NODE_TEST_CONTEXT) return null;
    return join(DATA_DIR, 'cli-context.json');
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
    if (pins.has(model)) return; // keep the first one: changing it would change every request (later changes ride on their turn, see replayTurn)
    pins.set(model, entries.map((e) => JSON.parse(JSON.stringify(e))));
    const f = pinFile();
    if (!f) return;
    try {
        mkdirSync(dirname(f), { recursive: true });
        writeFileSync(f, JSON.stringify(Object.fromEntries(pins)), { mode: 0o600 }); // account details
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

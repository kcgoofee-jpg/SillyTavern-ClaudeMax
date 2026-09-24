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
 */
export function createTurnCollector(currentText) {
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
                    remember(currentText, collecting);
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
export function replayTurn(text, parentUuid, meta) {
    const found = captures.get(keyOf(text));
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
}

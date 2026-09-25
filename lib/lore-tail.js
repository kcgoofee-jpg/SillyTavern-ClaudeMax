// ──────────────────────────────────────────────
// Volatile system-prompt blocks → the current turn
// ──────────────────────────────────────────────
//
// Keyword-triggered world info changes the system prompt almost every turn,
// and Claude's cache is a prefix: one changed byte in the system prompt and
// the whole chat history after it is written to the cache again (measured:
// ~110k tokens per turn on a long chat, 42 of 150 turns in one day).
//
// cache-diag.js learns, per chat, which tagged block keeps changing
// (<world_info>, <Lore>, …). Here that block's content leaves the system
// prompt — a fixed one-line placeholder stays in its place — and is put at
// the top of the current user message. The system prompt and every earlier
// turn are then byte-identical to last turn and read back from the cache;
// only the last exchange is written again. The lore also ends up next to
// the turn it was triggered for.

export const PLACEHOLDER_NOTE = '（这部分内容随剧情每轮变化，已移到最新一条消息开头的同名块里。）';
export const TAIL_NOTE = '（以上是本轮按剧情触发的设定资料，来自系统设定，不是用户的发言。）';

/** Outermost `<tag …>…</tag>` spans (same-name nesting counted). */
function blockSpans(text, tag) {
    const esc = tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`<(/?)${esc}(?:\\s[^<>]*)?>`, 'g');
    const spans = [];
    let depth = 0;
    let start = -1;
    let innerStart = -1;
    let m;
    while ((m = re.exec(text))) {
        if (!m[1]) {
            if (m[0].endsWith('/>')) continue;
            if (depth === 0) { start = m.index; innerStart = m.index + m[0].length; }
            depth++;
        } else if (depth > 0) {
            depth--;
            if (depth === 0) spans.push({ start, innerStart, innerEnd: m.index, end: m.index + m[0].length });
        }
    }
    return spans;
}

/**
 * @param {string} system
 * @param {string[]} tags  tag names, without brackets
 * @param {{ maxShare?: number }} [opts]  skip a block larger than this share of the prompt
 * @returns {{ system: string, blocks: {tag: string, text: string}[] }}
 */
export function extractVolatileBlocks(system, tags, { maxShare = 0.4 } = {}) {
    let out = system ?? '';
    const blocks = [];
    for (const tag of tags ?? []) {
        const spans = blockSpans(out, tag);
        const inner = spans.map((s) => out.slice(s.innerStart, s.innerEnd).trim());
        const size = inner.reduce((n, t) => n + t.length, 0);
        if (!spans.length || !size || size > maxShare * out.length) continue;
        // Replace back to front so earlier offsets stay valid.
        for (let i = spans.length - 1; i >= 0; i--) {
            const s = spans[i];
            out = `${out.slice(0, s.innerStart)}\n${PLACEHOLDER_NOTE}\n${out.slice(s.innerEnd)}`;
        }
        blocks.push({ tag, text: inner.filter(Boolean).join('\n\n') });
    }
    return { system: out, blocks };
}

function prefixContent(content, prefix) {
    if (typeof content === 'string') return `${prefix}\n\n${content}`;
    if (Array.isArray(content)) return [{ type: 'text', text: prefix }, ...content];
    return prefix;
}

/**
 * Which user message the lore goes on: the first of the trailing run of user
 * messages. A card's depth-0 user-role world info (MVU update rules, …) is
 * appended after the player's message and is gone from next turn's history;
 * lore put there would have to be sent in full every turn. The player's
 * message stays, so its lore stays in the cached history and only new lines
 * are added next turn.
 * @param {Array<{role: string}>} history non-system messages
 */
export function loreTarget(history) {
    let idx = history.findLastIndex((m) => m?.role === 'user');
    while (idx > 0 && history[idx - 1]?.role === 'user') idx--;
    return idx;
}

/**
 * Put the extracted blocks at the top of the player's latest message
 * (see loreTarget; before a trailing assistant prefill, if any).
 * @param {Array<{role: string, content: any}>} history non-system messages
 */
export function injectBlocks(history, blocks) {
    if (!blocks.length) return history;
    const idx = loreTarget(history);
    if (idx < 0) return history;
    const prefix = `${blocks.map((b) => `<${b.tag}>\n${b.text}\n</${b.tag}>`).join('\n\n')}\n${TAIL_NOTE}`;
    const out = history.slice();
    out[idx] = { ...out[idx], content: prefixContent(out[idx].content, prefix) };
    return out;
}

/**
 * Drop lore lines the model has already been given in an earlier turn (those
 * turns are replayed as sent, so their lore is still in the history). Keeps
 * the history growing only by lore that is actually new. Very short lines
 * (separators, bare headings) are kept so an entry doesn't lose its frame.
 * @param {{tag: string, text: string}[]} blocks
 * @param {string[]} earlierTexts  earlier user messages as sent
 */
export const REPEAT_NOTE = '（这段与之前某轮随发言给出的内容完全相同，不再重复，以那里为准。）';
const MIN_REPEAT_CHARS = 200;

/**
 * Fold a card's depth-0 user-role injections (the messages after the
 * player's) into the player's message. The CLI's message-level cache point
 * sits on the last message; while that is an injection that is gone next
 * turn, no earlier cache entry ever matches and the whole chat history is
 * written again every turn (measured: ~39k tokens per turn on 母畜庄园).
 * Folded, the player's message is last, is replayed as sent next turn, and
 * the history stays cached. An injection section ('---'-separated) already
 * given verbatim in an earlier turn is replaced by a one-line note, so fixed
 * rules are not repeated every turn; changing ones (variable state) are kept.
 * @param {Array<{role: string, content: any}>} history non-system messages
 * @param {string[]} earlierTexts earlier player messages as sent
 * @returns {{ history: Array, folded: number, repeated: number }}
 */
export function foldTrailingInjections(history, earlierTexts = []) {
    const target = loreTarget(history);
    const last = history.findLastIndex((m) => m?.role === 'user');
    if (target < 0 || target === last) return { history, folded: 0, repeated: 0 };
    const run = history.slice(target, last + 1);
    if (run.some((m) => typeof m.content !== 'string')) return { history, folded: 0, repeated: 0 };
    const seen = earlierTexts.join('\n');
    let repeated = 0;
    const extra = run.slice(1).map((m) => m.content.split(/\n(?=---\s*\n)/).map((part) => {
        const t = part.trim();
        if (t.length >= MIN_REPEAT_CHARS && seen.includes(t)) { repeated++; return REPEAT_NOTE; }
        return part;
    }).join('\n'));
    const out = history.slice(0, target);
    out.push({ ...history[target], content: [history[target].content, ...extra].join('\n\n') });
    out.push(...history.slice(last + 1));
    return { history: out, folded: run.length - 1, repeated };
}

// Messages the lore was put on that are not the SDK's current turn (the
// player's message when an injection follows it): next turn ST sends them
// back without the lore, so they are re-sent the way they went out. In memory
// only, like turn captures; after a restart one turn is written again.
const injected = new Map();
const MAX_INJECTED = 200;

/** Remember how a history message was sent with lore on it. */
export function rememberInjected(raw, sent) {
    if (typeof raw !== 'string' || typeof sent !== 'string') return;
    injected.delete(raw);
    injected.set(raw, sent);
    while (injected.size > MAX_INJECTED) injected.delete(injected.keys().next().value);
}

/** The text a history message was sent with, if lore was put on it. */
export function injectedTextFor(raw) {
    return typeof raw === 'string' ? injected.get(raw) ?? null : null;
}

/** Test seam. */
export function __resetInjected() {
    injected.clear();
}

export function newLoreOnly(blocks, earlierTexts) {
    const seen = new Set();
    for (const t of earlierTexts) for (const line of String(t).split('\n')) {
        const k = line.trim();
        if (k.length >= 4) seen.add(k);
    }
    const out = [];
    for (const b of blocks) {
        const lines = b.text.split('\n').filter((l) => l.trim().length < 4 || !seen.has(l.trim()));
        if (lines.some((l) => l.trim().length >= 4)) out.push({ tag: b.tag, text: lines.join('\n').trim() });
    }
    return out;
}

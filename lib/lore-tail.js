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
 * Put the extracted blocks at the top of the last user message (before a
 * trailing assistant prefill, if any).
 * @param {Array<{role: string, content: any}>} history non-system messages
 */
export function injectBlocks(history, blocks) {
    if (!blocks.length) return history;
    const idx = history.findLastIndex((m) => m?.role === 'user');
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

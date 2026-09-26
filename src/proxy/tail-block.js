// ──────────────────────────────────────────────
// Presets that put their rules AFTER the chat history (opt-in, experimental)
// ──────────────────────────────────────────────
//
// Presets like Ny or 图灵 place a large block of entries after the chat
// history: [preset] [history…, current input] [rules block]. Every turn the
// history grows in front of that block, so the previous request's last
// message (where the CLI's only message-level cache point sits) is never a
// prefix of the next request — the whole conversation is re-cached each
// turn (measured: ~65k tokens written per turn on 图灵).
//
// With `tail_block: 'front'` the proxy compares consecutive requests of the
// same chat, finds the trailing run of messages that is byte-identical to
// last turn's (the preset's post-history block) and moves it in front of the
// conversation, right after the leading system messages. Contents, roles
// and their order are unchanged; a trailing assistant prefill stays last.
// Off by default: it changes where the preset author put those rules.
// Remembered per chat IN MEMORY only (never on disk).

import { createHash } from 'node:crypto';

import { contentToText } from './system-prompt.js';

const MAX_CHATS = 6;
const MIN_BLOCK_CHARS = 300; // below this there is nothing worth moving
const previous = new Map(); // chatKey → string[] (serialized raw messages)

const ser = (m) => `${m?.role}\u0000${contentToText(m?.content)}`;
const hash = (s) => createHash('sha1').update(s).digest('hex').slice(0, 12);

/** Same chat across turns: everything up to the first non-system message, plus its first paragraph. */
function chatKeyOf(messages) {
    const i = messages.findIndex((m) => m?.role !== 'system');
    const head = messages.slice(0, Math.max(0, i)).map(ser);
    const first = i >= 0 ? contentToText(messages[i]?.content).split('\n\n')[0].slice(0, 200) : '';
    // The system block alone is shared by every chat with the same preset +
    // card, so also key on the first few non-system messages.
    const more = messages.filter((m) => m?.role !== 'system').slice(0, 3).map((m) => contentToText(m?.content).slice(0, 120));
    return hash([...head, first, ...more].join('\u0001'));
}

/**
 * @param {Array} messages raw OpenAI messages
 * @returns {{ messages: Array, moved: number }}  moved = messages relocated (0 when nothing to do)
 */
export function moveTailBlockToFront(messages) {
    const key = chatKeyOf(messages);
    const cur = messages.map(ser);
    const prev = previous.get(key);
    previous.delete(key);
    previous.set(key, cur);
    while (previous.size > MAX_CHATS) previous.delete(previous.keys().next().value);
    if (!prev || prev.length >= cur.length) return { messages, moved: 0 }; // first turn, or a swipe / regenerate

    // Longest identical suffix between this turn and the last one.
    let n = 0;
    while (n < prev.length && n < cur.length && prev[prev.length - 1 - n] === cur[cur.length - 1 - n]) n++;
    let end = messages.length;
    let start = end - n;
    // The same input sent twice in a row ("继续") would also match: a
    // message whose text already occurs earlier in the conversation is chat
    // content, not a preset entry — keep it (and anything before it) in place.
    const earlier = new Set(cur.slice(0, start));
    while (start < end && earlier.has(cur[start])) start++;
    // A trailing assistant message is a prefill: it must stay last.
    while (end > start && messages[end - 1]?.role === 'assistant') end--;
    // Leading system messages of the block would just join the system prompt
    // anyway; only a block that contains user/assistant turns is worth it.
    const block = messages.slice(start, end);
    const chars = block.reduce((t, m) => t + contentToText(m?.content).length, 0);
    const lastUser = messages.slice(0, start).findLastIndex((m) => m?.role === 'user');
    if (!block.length || chars < MIN_BLOCK_CHARS || lastUser < 0) return { messages, moved: 0 };

    const lead = messages.findIndex((m) => m?.role !== 'system');
    const out = [...messages.slice(0, lead), ...block, ...messages.slice(lead, start), ...messages.slice(end)];
    return { messages: out, moved: block.length };
}

/** Test seam. */
export function __resetTailBlock() {
    previous.clear();
}

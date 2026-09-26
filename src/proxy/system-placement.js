// ──────────────────────────────────────────────
// Where mid-conversation system messages go
// ──────────────────────────────────────────────
//
// SillyTavern sends depth-injected prompts (preset entries "at depth N",
// world info at depth, Author's Note) as role:system messages INSIDE the
// chat history. Hoisting all of them into the top-level system prompt
// (the old behavior) has two costs:
//   • the preset author placed them near the end on purpose — a style
//     reminder two messages from the end works much better than the same
//     text buried at the top;
//   • whenever one of them changes (a keyword-triggered lore entry comes or
//     goes), the system prompt changes and Claude's prompt cache misses for
//     the ENTIRE conversation.
//
// 'inline': every system message BEFORE the first real user message is part
// of the preset/card block and goes to the system prompt (so the whole
// block is cached); assistant messages inside that block (fake
// acknowledgements many presets use, the greeting) stay in history order.
// System messages after the first user message are depth injections: they
// become user text, merged into the neighboring user turn so roles still
// alternate — the same thing SillyTavern's own Claude converter does. Those
// deeper than the last reply are moved up to the current turn (see below).

import { contentToText } from './system-prompt.js';

function asParts(content) {
    if (Array.isArray(content)) return content;
    const text = typeof content === 'string' ? content : '';
    return text ? [{ type: 'text', text }] : [];
}

function mergeContent(a, b) {
    if (typeof a === 'string' && typeof b === 'string') {
        if (!a) return b;
        if (!b) return a;
        return `${a}\n\n${b}`;
    }
    return [...asParts(a), ...asParts(b)];
}

/**
 * @param {Array<{role: string, content: any}>} messages OpenAI messages
 * @returns {Array} new array: leading system block, then history with
 *   later system messages folded into user turns
 */
export function inlineLateSystemMessages(messages) {
    const firstUser = messages.findIndex((m) => m?.role === 'user' && contentToText(m.content).trim());
    const lead = firstUser < 0 ? messages.length : firstUser;
    const preamble = messages.slice(0, lead);
    const head = preamble.filter((m) => m?.role === 'system');
    const early = preamble.filter((m) => m?.role !== 'system' && contentToText(m.content).trim());
    const rest = [...early, ...messages.slice(lead)];
    if (head.length === preamble.length && !rest.some((m) => m?.role === 'system')) return messages;

    // System messages after the final assistant turn (continue / prefill)
    // must not become the "current user message" — that would drop the
    // prefill. Move them in front of that assistant turn instead.
    const lastNonSystem = rest.findLastIndex((m) => m?.role !== 'system');
    const ordered = rest.slice();
    if (lastNonSystem >= 0 && rest[lastNonSystem].role === 'assistant' && lastNonSystem < rest.length - 1) {
        const trailingSystem = ordered.splice(lastNonSystem + 1);
        ordered.splice(lastNonSystem, 0, ...trailingSystem);
    }

    // A deeper injection (depth ≥ 3: before an earlier assistant reply) would
    // be merged into an OLD user turn — and next turn it has moved on, so that
    // old turn's text changes and the prompt cache misses from there to the
    // end, every turn (measured on 母畜庄园: MVU's depth-4 format rules).
    // Put those next to the current turn instead: still near the end, and
    // the history before it stays byte-identical.
    const lastUser = ordered.findLastIndex((m) => m?.role === 'user');
    const lastReply = lastUser > 0 ? ordered.slice(0, lastUser).findLastIndex((m) => m?.role === 'assistant') : -1;
    if (lastReply > 0) {
        const deep = [];
        for (let i = lastReply - 1; i >= 0; i--) {
            if (ordered[i]?.role === 'system') deep.unshift(...ordered.splice(i, 1));
        }
        if (deep.length) {
            // Right after the last reply: deeper ones stay ahead of shallower ones.
            const u = ordered.findLastIndex((m) => m?.role === 'user');
            const r = ordered.slice(0, u).findLastIndex((m) => m?.role === 'assistant');
            ordered.splice(r + 1, 0, ...deep);
        }
    }

    const out = [];
    for (const m of ordered) {
        const converted = m?.role === 'system'
            ? { role: 'user', content: contentToText(m.content) }
            : m;
        if (converted.role === 'system') continue;
        const prev = out[out.length - 1];
        if (prev && prev.role === 'user' && converted.role === 'user') {
            out[out.length - 1] = { ...prev, content: mergeContent(prev.content, converted.content) };
        } else {
            out.push(converted);
        }
    }
    return [...head, ...out];
}


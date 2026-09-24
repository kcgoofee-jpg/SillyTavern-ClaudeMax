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
// become user text in place, merged into the neighboring user turn so roles
// still alternate — the same thing SillyTavern's own Claude converter does.
//
// 'tail' (opt-in): the same, except every depth injection is moved to the
// END of the last user turn instead of its depth position. A depth-N
// injection moves one message further down every turn, so in place it
// changes the history from that point on and the prompt cache has to
// rewrite everything after it; at the end, older messages stay
// byte-identical turn after turn. Costs the author's chosen depth (the
// reminder lands right before the reply instead of N messages earlier).

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
export function inlineLateSystemMessages(messages, { tail = false } = {}) {
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

    const out = [];
    const tailParts = [];
    for (const m of ordered) {
        if (tail && m?.role === 'system') {
            const text = contentToText(m.content);
            if (text.trim()) tailParts.push(text);
            continue;
        }
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
    if (tailParts.length) {
        const lastUser = out.findLastIndex((m) => m.role === 'user');
        if (lastUser >= 0) {
            out[lastUser] = { ...out[lastUser], content: mergeContent(out[lastUser].content, tailParts.join('\n\n')) };
        } else {
            out.push({ role: 'user', content: tailParts.join('\n\n') });
        }
    }
    return [...head, ...out];
}

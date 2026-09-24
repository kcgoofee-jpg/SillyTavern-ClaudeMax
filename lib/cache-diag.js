// ──────────────────────────────────────────────
// Prompt-cache diagnostics: what changed since the previous turn?
// ──────────────────────────────────────────────
//
// Claude's prompt cache is a prefix match: system prompt first, then the
// messages. If anything in the system prompt differs from the previous turn
// (a keyword-triggered world-info entry, a {{random}} macro, a summary that
// is rewritten every turn), the WHOLE request is re-written to the cache and
// nothing is read back — slower first token, more quota.
//
// For each conversation we keep the previous turn's system prompt and
// history IN MEMORY ONLY (a handful of recent chats, never written to disk)
// and report where the new request first diverges. The report carries
// offsets and the nearest enclosing tag / heading name — structure from the
// preset or card, not chat text.

import { createHash } from 'node:crypto';

import { contentToText } from './system-prompt.js';

const MAX_CHATS = 6;
const previous = new Map(); // chatKey → { system, history: string[] }

const hash = (s) => createHash('sha1').update(s).digest('hex').slice(0, 12);

/** Same chat across turns: the opening of the conversation doesn't change. */
function chatKeyOf(history) {
    return hash(history.slice(0, 2).join('\u0000'));
}

function firstDiff(a, b) {
    const n = Math.min(a.length, b.length);
    let i = 0;
    while (i < n && a.charCodeAt(i) === b.charCodeAt(i)) i++;
    return i === n && a.length === b.length ? -1 : i;
}

/** Innermost unclosed tag (or the last heading line) before `offset`. */
export function nearestLabel(text, offset) {
    const before = text.slice(Math.max(0, offset - 60000), offset);
    const stack = [];
    const tagRe = /<(\/?)([A-Za-z_一-鿿][\w一-鿿:-]{0,40})(?:\s[^<>]*)?>/g;
    let m;
    while ((m = tagRe.exec(before))) {
        const [, close, name] = m;
        if (close) {
            const idx = stack.lastIndexOf(name);
            if (idx >= 0) stack.length = idx;
        } else if (!m[0].endsWith('/>')) {
            stack.push(name);
        }
    }
    if (stack.length) return `<${stack[stack.length - 1]}>`;
    const headings = [...before.matchAll(/(?:^|\n)[ \t]*((?:#{1,4}[ \t]*|【)[^\n]{1,24})/g)];
    return headings.length ? headings[headings.length - 1][1].trim() : null;
}

/**
 * @param {string} systemText  the system prompt as sent to Claude
 * @param {Array} history      non-system messages (history + current turn)
 * @returns {object|null} diagnosis, or null on the first turn of a chat
 */
export function diagnoseCache(systemText, history) {
    const system = systemText ?? '';
    const texts = history.map((m) => `${m.role}:${contentToText(m.content)}`);
    const key = chatKeyOf(texts);
    const prev = previous.get(key);

    previous.delete(key);
    previous.set(key, { system, history: texts });
    while (previous.size > MAX_CHATS) previous.delete(previous.keys().next().value);

    if (!prev) return { firstTurn: true, systemChars: system.length };

    const diffAt = firstDiff(prev.system, system);
    // History that existed last turn (minus the previous current message,
    // which is normally replaced by the reply + new input) should be stable.
    const comparable = Math.max(0, prev.history.length - 1);
    let historyDiffAt = -1;
    for (let i = 0; i < comparable && i < texts.length; i++) {
        if (prev.history[i] !== texts[i]) { historyDiffAt = i; break; }
    }
    return {
        firstTurn: false,
        systemChars: system.length,
        systemChanged: diffAt >= 0,
        systemDiffAt: diffAt >= 0 ? diffAt : null,
        systemDiffLabel: diffAt >= 0 ? nearestLabel(system, diffAt) : null,
        historyDiffAt: historyDiffAt >= 0 ? historyDiffAt : null,
        historyLen: texts.length,
    };
}

/** One human-readable line for the proxy log. */
export function describeDiag(d) {
    if (!d) return null;
    if (d.firstTurn) return `缓存诊断：本聊天第一轮（系统提示词 ${d.systemChars.toLocaleString()} 字），下一轮开始对比`;
    const parts = [];
    if (d.systemChanged) {
        parts.push(`系统提示词与上一轮不同，从第 ${d.systemDiffAt.toLocaleString()} / ${d.systemChars.toLocaleString()} 字开始` +
            (d.systemDiffLabel ? `（位于 ${d.systemDiffLabel} 内）` : '') + ' → 整段缓存失效');
    } else {
        parts.push('系统提示词与上一轮相同');
    }
    if (d.historyDiffAt !== null) {
        parts.push(`聊天记录从第 ${d.historyDiffAt + 1} / ${d.historyLen} 条开始与上一轮不同（正则改写旧楼层、删改消息或 swipe 会造成）`);
    }
    return `缓存诊断：${parts.join('；')}`;
}

/** Test seam. */
export function __resetCacheDiag() {
    previous.clear();
}

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
// Below this the static part isn't worth a cache breakpoint (Opus 5.5's
// minimum cacheable prompt is 512 tokens; ~1500 CJK characters is safely above).
const MIN_STATIC_CHARS = 1500;
// How many recent turns decide the split point (see diagnoseCache).
const SPLIT_WINDOW = 3;
const previous = new Map(); // chatKey → { system, history: string[], splitAt: number|null, cuts: (number|null)[] }

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

function openTags(text, offset) {
    const base = Math.max(0, offset - 60000);
    const before = text.slice(base, offset);
    const stack = [];
    const tagRe = /<(\/?)([A-Za-z_一-鿿][\w一-鿿:-]{0,40})(?:\s[^<>]*)?>/g;
    let m;
    while ((m = tagRe.exec(before))) {
        const [, close, name] = m;
        if (close) {
            const idx = stack.findLastIndex((t) => t.name === name);
            if (idx >= 0) stack.length = idx;
        } else if (!m[0].endsWith('/>')) {
            stack.push({ name, at: base + m.index });
        }
    }
    return stack;
}

/** Innermost unclosed tag (or the last heading line) before `offset`. */
export function nearestLabel(text, offset) {
    const stack = openTags(text, offset);
    if (stack.length) return `<${stack[stack.length - 1].name}>`;
    const before = text.slice(Math.max(0, offset - 60000), offset);
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

    const diffAt = prev ? firstDiff(prev.system, system) : -1;

    // Split point for the system prompt: the start of the enclosing tag (or
    // line) where it changed, taken as the EARLIEST such point over the last
    // SPLIT_WINDOW turns. Parts that change every turn keep the split in
    // place (so the static part stays byte-identical and hits the cache); a
    // one-off early edit — the user flipping a preset toggle — only pulls the
    // split forward for a few turns instead of pinning it there for good.
    const recent = (prev?.cuts ?? []).slice(-(SPLIT_WINDOW - 1));
    if (diffAt >= 0) {
        // Snap to the start of the innermost enclosing tag: a keyword-triggered
        // section (<world_info>) reorders from turn to turn, so the first
        // differing byte wanders around inside it and a line-based split
        // would creep earlier each turn — each move costing a full miss.
        const tags = openTags(system, diffAt);
        const tagStart = tags.length ? tags[tags.length - 1].at : diffAt;
        recent.push(system.lastIndexOf('\n', tagStart - 1) + 1);
    } else if (prev) {
        recent.push(null); // unchanged turn: no new constraint
    }
    const cutPoints = recent.filter((c) => c !== null);
    let splitAt = cutPoints.length ? Math.min(...cutPoints) : (prev?.splitAt ?? null);
    if (splitAt !== null && (splitAt < MIN_STATIC_CHARS || splitAt > system.length)) splitAt = null;

    previous.delete(key);
    previous.set(key, { system, history: texts, splitAt, cuts: recent });
    while (previous.size > MAX_CHATS) previous.delete(previous.keys().next().value);

    if (!prev) return { chat: key, firstTurn: true, systemChars: system.length, splitAt: null };

    // History that existed last turn (minus the previous current message,
    // which is normally replaced by the reply + new input) should be stable.
    const comparable = Math.max(0, prev.history.length - 1);
    let historyDiffAt = -1;
    for (let i = 0; i < comparable && i < texts.length; i++) {
        if (prev.history[i] !== texts[i]) { historyDiffAt = i; break; }
    }
    return {
        chat: key, // hash of the chat's opening two messages — groups turns per chat in reports, carries no text
        firstTurn: false,
        systemChars: system.length,
        systemChanged: diffAt >= 0,
        systemDiffAt: diffAt >= 0 ? diffAt : null,
        systemDiffLabel: diffAt >= 0 ? nearestLabel(system, diffAt) : null,
        historyDiffAt: historyDiffAt >= 0 ? historyDiffAt : null,
        historyLen: texts.length,
        splitAt,
    };
}

/** One human-readable line for the proxy log. */
export function describeDiag(d) {
    if (!d) return null;
    if (d.firstTurn) return `缓存诊断：本聊天第一轮（系统提示词 ${d.systemChars.toLocaleString()} 字），下一轮开始对比`;
    const parts = [];
    if (d.systemChanged) {
        const covered = d.splitAt && d.splitAt <= d.systemDiffAt;
        parts.push(`系统提示词与上一轮不同，从第 ${d.systemDiffAt.toLocaleString()} / ${d.systemChars.toLocaleString()} 字开始` +
            (d.systemDiffLabel ? `（位于 ${d.systemDiffLabel} 内）` : '') +
            (covered ? '' : ' → 这一轮整段缓存失效'));
    } else {
        parts.push('系统提示词与上一轮相同');
    }
    if (d.splitAt) {
        parts.push(`已切分：前 ${d.splitAt.toLocaleString()} 字作为固定段单独缓存，之后的部分每轮重写`);
    }
    if (d.historyDiffAt !== null) {
        parts.push(`聊天记录从第 ${d.historyDiffAt + 1} / ${d.historyLen} 条开始与上一轮不同（正则改写旧楼层、删改消息或 swipe 会造成）`);
    }
    return `缓存诊断：${parts.join('；')}`;
}

const k = (n) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

/**
 * Plain-Chinese explanation of one recorded request's cache outcome, for the
 * panel. `entry` / `prevEntry` are usage-stats records (prevEntry: the
 * request before it, if any).
 * @returns {{ read: number, wrote: number, hitPct: number, headline: string, reasons: string[] } | null}
 */
export function explainCache(entry, prevEntry = null) {
    if (!entry?.ok) return null;
    const read = entry.cacheReadTokens ?? 0;
    const wrote = entry.cacheCreationTokens ?? 0;
    const total = read + wrote + (entry.inputTokens ?? 0);
    const hitPct = total ? Math.round((read / total) * 100) : 0;
    const d = entry.cacheDiag;
    const reasons = [];
    if (!d || d.firstTurn) {
        reasons.push('本聊天的第一轮（或代理刚重启）：整段写入缓存，下一轮起才能读取。');
    } else {
        if (d.systemChanged) {
            const where = `第 ${d.systemDiffAt.toLocaleString()} 字${d.systemDiffLabel ? `（${d.systemDiffLabel} 内）` : ''}`;
            reasons.push(d.splitAt && d.splitAt <= d.systemDiffAt
                ? `系统提示词从${where}起和上一轮不同；前 ${d.splitAt.toLocaleString()} 字已单独缓存，只重写后面的部分。`
                : `系统提示词在${where}就变了，这一处之后全部重写。常见原因：改了预设开关或角色卡、世界书按关键词触发、随机宏。一次性的改动过 3 轮会自动恢复。`);
        }
        if (d.historyDiffAt !== null && d.historyDiffAt !== undefined) {
            reasons.push(`聊天记录从第 ${d.historyDiffAt + 1} / ${d.historyLen} 条起和上一轮不同，之后全部重写。常见原因：预设正则按楼层改写旧消息（如「5 楼外只发摘要」），或删改、重新生成了消息。`);
        }
        if (prevEntry?.ok && prevEntry.effort !== undefined && entry.effort !== undefined && prevEntry.effort !== entry.effort) {
            reasons.push('思考深度和上一轮不同：换思考深度会让整段缓存作废。');
        }
        if (prevEntry && prevEntry.model !== entry.model) {
            reasons.push('模型和上一轮不同：缓存按模型分开，换模型要重新写入。');
        }
        if (!reasons.length) {
            reasons.push(read > 0
                ? '系统提示词和聊天记录都和上一轮一致，只写入了新增的内容。'
                : '内容和上一轮一致却没读到缓存：可能距离上一轮超过 1 小时，缓存已过期。');
        }
    }
    return { read, wrote, hitPct, headline: `读取缓存 ${k(read)} · 重新写入 ${k(wrote)} · 命中 ${hitPct}%`, reasons };
}

/** Test seam. */
export function __resetCacheDiag() {
    previous.clear();
}

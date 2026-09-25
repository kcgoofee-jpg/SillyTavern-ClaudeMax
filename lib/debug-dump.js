// ──────────────────────────────────────────────
// Dev tool: save the last full request to data/debug/
// ──────────────────────────────────────────────
//
// Off by default (panel → 高级设置 → 调试). When on, every chat request
// writes what was actually sent — the system prompt exactly as Claude gets
// it and the message history after placement — to data/debug/
// last-request.json (the previous one is kept as previous-request.json), plus
// the system prompt as plain text for easy diffing. Local files only.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { extractSystemText } from './system-prompt.js';

const PLUGIN_TAG = '[claude-subscription]';

export function debugDir() {
    return join(dirname(fileURLToPath(import.meta.url)), '..', 'data', 'debug');
}

/** The transcript the CLI resumes from (what really goes out as history), for diffing two turns. */
export function dumpEntries(entries) {
    try {
        const dir = debugDir();
        mkdirSync(dir, { recursive: true });
        if (existsSync(join(dir, 'last-entries.json'))) renameSync(join(dir, 'last-entries.json'), join(dir, 'previous-entries.json'));
        writeFileSync(join(dir, 'last-entries.json'), JSON.stringify(entries.map((e) => ({ type: e.type, message: e.message, attachment: e.attachment, isMeta: e.isMeta })), null, 1));
    } catch { /* debug only */ }
}

export function dumpRequest({ model, settings, raw, placed, cacheDiag }) {
    try {
        const dir = debugDir();
        mkdirSync(dir, { recursive: true });
        for (const [cur, prev] of [['last-request.json', 'previous-request.json'], ['last-system.txt', 'previous-system.txt']]) {
            if (existsSync(join(dir, cur))) renameSync(join(dir, cur), join(dir, prev));
        }
        const system = extractSystemText(placed) ?? '';
        const splitAt = settings.systemSplitAt;
        writeFileSync(join(dir, 'last-system.txt'), splitAt ? `${system.slice(0, splitAt)}\n\n======== 缓存分界（以上为固定段）========\n\n${system.slice(splitAt)}` : system);
        writeFileSync(join(dir, 'last-request.json'), JSON.stringify({
            at: new Date().toISOString(),
            model,
            settings: { effort: settings.effort, thinking: settings.thinking, systemPlacement: settings.systemPlacement, systemSplitAt: splitAt },
            cacheDiag,
            rawRoles: raw.map((m) => m.role),
            system,
            messages: placed.filter((m) => m?.role !== 'system'),
        }, null, 2));
        console.log(`${PLUGIN_TAG} 调试：已保存完整请求到 ${dir}`);
    } catch (err) {
        console.warn(`${PLUGIN_TAG} debug dump failed:`, err instanceof Error ? err.message : err);
    }
}

/** GET handler for the panel's "实际发给模型的内容" viewer. Serves the last dump
 *  only — nothing exists (404) unless the debug switch was on. */
export function handleDebugLast(_req, res) {
    try {
        const dir = debugDir();
        const req = JSON.parse(readFileSync(join(dir, 'last-request.json'), 'utf8'));
        const systemMarked = readFileSync(join(dir, 'last-system.txt'), 'utf8');
        res.json({ ok: true, at: req.at, model: req.model, settings: req.settings, cacheDiag: req.cacheDiag, systemMarked, messages: req.messages });
    } catch {
        res.status(404).json({ ok: false, error: '还没有保存的请求：先在高级设置里打开「调试：保存最近一次完整请求」，再聊一轮。' });
    }
}

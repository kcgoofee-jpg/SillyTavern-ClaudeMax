// ──────────────────────────────────────────────
// Reply check-up (M4): the chat_report.py checks, shared by the panel
// ──────────────────────────────────────────────
//
// Pure functions, no Node or browser APIs — imported by the UI panel
// (index.js) and by the tests. Every check looks at ONE assistant reply
// (plus the previous one for repeats / status jumps).

const DEFAULT_BANNED = ['嘴角微挑', '嘴角上扬', '嘴角勾起', '似笑非笑', '眼角余光', '指节泛白', '呼吸一滞',
    '倒吸一口凉气', '喉结微滚', '浑身一震', '身子一僵', '瞳孔骤缩', '眸色一沉', '邪魅一笑'];

/** Banned phrases from the preset's 禁词 entries: every ‘…’ list, split on 、，, */
export function bannedFromPrompts(prompts) {
    const words = new Set();
    for (const p of prompts ?? []) {
        if (!String(p?.name ?? '').includes('禁词')) continue;
        // 「用‘语气、声音…’给台词贴标签」only bans a usage, not the words
        const text = String(p.content ?? '').split('\n').filter((l) => !l.includes('贴')).join('\n');
        for (const [, chunk] of text.matchAll(/‘([^’]{2,200})’/g)) {
            for (const w of chunk.split(/[、，,]/)) {
                const t = w.trim();
                if (t.length >= 2 && t.length <= 12 && !/[AB]/.test(t)) words.add(t);
            }
        }
    }
    return words.size ? [...words].sort() : DEFAULT_BANNED;
}

/** Word-count range from a {{setvar::word_count::[大于X小于Y]}} entry, or null. */
export function wordRangeFromPrompts(prompts) {
    for (const p of prompts ?? []) {
        const m = String(p?.content ?? '').match(/word_count::\s*\[?大于\s*(\d+)\s*小于\s*(\d+)/);
        if (m) return [Number(m[1]), Number(m[2])];
    }
    return null;
}

/** True when an ENABLED preset entry asks for second-person narration (e.g. Ny「👤第二人称user视角」). */
export function secondPersonFromPreset(preset) {
    const orders = preset?.prompt_order ?? [];
    const order = orders.reduce((best, o) => ((o?.order?.length ?? 0) > (best?.order?.length ?? 0) ? o : best), null)?.order ?? [];
    const enabled = new Set(order.filter((it) => it.enabled).map((it) => it.identifier));
    return (preset?.prompts ?? []).some((p) => enabled.has(p.identifier) && /第二人称/.test(p.name ?? ''));
}

const stripTags = (s) => s.replace(/<[^>]+>/g, '');

export function bodyOf(mes) {
    const m = mes.match(/<content>([\s\S]*?)<\/content>/);
    let body = m ? m[1] : mes.replace(/<(div|style|details|branches|status|meow_FM)[\s\S]*/, '');
    body = body.replace(/<!--[\s\S]*?-->/g, '');
    return stripTags(body).trim();
}

/** Narration only: drop quoted dialogue. */
export function narrationOnly(text) {
    return text.replace(/[“"「『'‘][^”"」』'’]{0,400}[”"」』'’]/g, '');
}

function longRepeats(a, b, n = 14) {
    const hits = new Set();
    for (let i = 0; i + n < b.length; i++) {
        const seg = b.slice(i, i + n);
        if (seg.trim() && a.includes(seg)) hits.add(seg);
    }
    const merged = [];
    for (const h of [...hits].sort()) if (!merged.some((m) => m.includes(h))) merged.push(h);
    return merged;
}

/** Numbers from a <status> block ("名称: 数值" / "名称 数值"), e.g. {生命: 96, 饥饿: 80, 苏念念: 12}. */
export function statusNumbers(mes) {
    const m = mes.match(/<status>([\s\S]*?)<\/status>/);
    if (!m) return null;
    const out = {};
    for (const [, name, val] of m[1].matchAll(/([一-鿿A-Za-z]{1,6})[:：]?\s*(\d+)(?=\s*(?:\/|\||$|\n|❤))/gm)) {
        if (!(name in out)) out[name] = Number(val);
    }
    return out;
}

/** Names of gauge-style values ("当前/上限", e.g. 生命 96/100) — the ones a jump check makes sense for. */
function gaugeNames(mes) {
    const m = mes.match(/<status>([\s\S]*?)<\/status>/);
    return new Set(m ? [...m[1].matchAll(/([一-鿿A-Za-z]{1,6})[:：]?\s*\d+\s*\//g)].map((x) => x[1]) : []);
}

const OPTION_RE = /^\s*(?:[*_#>-]+\s*)?[（(【[]?([A-Ja-j])[）)】\]]?\s*[.．、,，:：\-—]\s*(.*\S)\s*$/;

/**
 * @param {object} a
 * @param {string} a.mes        this reply
 * @param {string} [a.prevMes]  the previous assistant reply
 * @param {[number, number]} [a.words]  word-count range
 * @param {string[]} [a.banned]
 * @param {string[]} [a.leaks]  hidden-setting keywords that must not appear yet
 * @param {boolean} [a.secondPerson]  the preset asks for second person — skip the「你」check
 * @param {number} [a.statusJump]  flag a gauge (当前/上限) that moves more than this in one reply (default 40)
 * @returns {{ chars: number, issues: {code: string, text: string}[] }}
 */
export function checkReply({ mes, prevMes = null, words = null, banned = DEFAULT_BANNED, leaks = [], statusJump = 40, secondPerson = false }) {
    const issues = [];
    const add = (code, text) => issues.push({ code, text });
    const body = bodyOf(mes);
    const narr = narrationOnly(body);
    const chars = body.replace(/\s/g, '').length;

    if (words) {
        const [lo, hi] = words;
        if (chars > hi * 1.15) add('length', `正文 ${chars} 字，超出设定上限 ${hi}`);
        else if (chars < lo * 0.85) add('length', `正文 ${chars} 字，不足设定下限 ${lo}`);
    }
    const you = (narr.match(/你/g) ?? []).length;
    if (you >= 5 && !secondPerson) add('person', `旁白里出现「你」${you} 次，可能变成了第二人称`);
    const hit = banned.filter((w) => body.includes(w));
    if (hit.length) add('banned', `禁词：${hit.join('、')}`);
    const dashes = (body.match(/—/g) ?? []).length;
    if (dashes) add('dash', `破折号 ${dashes} 个`);
    const neg = narr.match(/(?:不是|并非)[^，。！？\n]{1,18}[，,](?:而)?是/g) ?? [];
    if (neg.length) add('notbut', `旁白「不是A，是B」句式 ${neg.length} 处，如「${neg[0].slice(0, 20)}」`);

    const branches = mes.match(/<branches>([\s\S]*?)<\/branches>/);
    if (branches) {
        const opts = new Map();
        for (const line of branches[1].split('\n')) {
            const m = line.match(OPTION_RE);
            if (m && !opts.has(m[1].toUpperCase())) opts.set(m[1].toUpperCase(), m[2]);
        }
        if (opts.size < 10) add('options', `选项只有 ${opts.size} 个（应为 A–J）`);
        const unlabeled = [...opts.values()].filter((t) => !/^\s*[[【][^\]】]{1,24}[\]】]/.test(t)).length;
        if (opts.size && unlabeled === opts.size) add('labels', '选项都没有 [路线标签]');
        else if (unlabeled) add('labels', `${unlabeled} 个选项缺 [路线标签]`);
    }

    const leak = leaks.filter((w) => w && body.includes(w));
    if (leak.length) add('leak', `疑似泄露隐藏设定：${leak.join('、')}`);

    if (prevMes) {
        const rep = longRepeats(bodyOf(prevMes), body);
        if (rep.length) add('repeat', `和上一条重复 ${rep.length} 段，如「${rep[0].slice(0, 16)}」`);
        const a = statusNumbers(prevMes), b = statusNumbers(mes);
        if (a && b) {
            const gauges = gaugeNames(mes);
            const jumps = Object.keys(b).filter((key) => gauges.has(key) && key in a && Math.abs(b[key] - a[key]) > statusJump)
                .map((key) => `${key} ${a[key]}→${b[key]}`);
            if (jumps.length) add('status', `状态数值一轮内跳变：${jumps.join('，')}`);
        }
    }
    return { chars, issues };
}

// ──────────────────────────────────────────────
// Character-card audit: minors and youth-coded content
// ──────────────────────────────────────────────
//
// A card, its lorebook, its scripts or the user's persona that puts a minor
// (or a character written to read as one) next to sexual content makes
// Claude spend the start of EVERY reply's thinking on an age check (seen
// live: 1–2 paragraphs per turn), makes it soften scenes, and is exactly
// what Anthropic's usage policy forbids outright. Content can hide in
// places a user never looks: a constant "roster" entry, the data block of
// a gallery script, a status-bar regex.
//
// Some cards dodge the check on purpose: an entry tells the model to write
// ages with look-alike symbols (「І2️⃣岁」 = 12, Cyrillic І / keycap 2), and the
// card's own roster uses them too. Those symbols are folded back to digits
// before the age rules run, and the instruction itself is a finding.
//
// Pure functions (no DOM, no SillyTavern) so the panel and the dev tool
// (tavern/scripts/check_card.py) share one rule set. Runs locally; nothing
// leaves the machine.

// Look-alike digits seen in cards (Cyrillic / Cherokee / Armenian letters,
// full-width digits). Keycap marks (U+FE0F U+20E3) after a digit are dropped.
const LOOKALIKE_DIGITS = {
    'О': '0', 'о': '0', 'Ο': '0', 'І': '1', 'Ӏ': '1', 'ӏ': '1', 'З': '3', 'з': '3', 'Ꮞ': '4', 'Ꮟ': '4',
    'Ƽ': '5', 'б': '6', 'Ȣ': '8', 'ȣ': '8', 'զ': '9',
};
for (let d = 0; d <= 9; d++) LOOKALIKE_DIGITS[String.fromCharCode(0xFF10 + d)] = String(d);
const LOOKALIKE_RE = new RegExp(`[${Object.keys(LOOKALIKE_DIGITS).join('')}]|[\uFE0F\u20E3]`, 'g');
// A run of digits / look-alikes / keycaps that contains at least one disguised character.
const DISGUISED_RUN = new RegExp(`(?:[0-9${Object.keys(LOOKALIKE_DIGITS).join('')}][\uFE0F\u20E3]*){1,3}`, 'g');

/**
 * Fold disguised digits back, but only in a run next to 岁 / 年龄 (Cyrillic prose is left alone).
 * `at` is the first run that used a real disguise (letters or keycaps; full-width digits are
 * ordinary Chinese typing, folded but not reported), or -1.
 */
export function unmaskDigits(text) {
    let at = -1;
    const out = text.replace(DISGUISED_RUN, (run, index) => {
        if (!/[^0-9]/.test(run)) return run;
        const around = text.slice(Math.max(0, index - 6), index) + text.slice(index + run.length, index + run.length + 2);
        if (!/岁|歲|年龄|age/i.test(around)) return run;
        if (at < 0 && /[^0-9\uFF10-\uFF19]/.test(run)) at = index;
        return run.replace(LOOKALIKE_RE, (c) => LOOKALIKE_DIGITS[c] ?? '');
    });
    return { text: out, at };
}

// 十二 / 十五 / 九 → 12 / 15 / 9 (ages only need 1–99).
const CN_DIGITS = { 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
function cnNumber(s) {
    if (/^\d+$/.test(s)) return Number(s);
    const [tens, ones] = s.includes('十') ? s.split('十') : ['', s];
    return (s.includes('十') ? (tens ? CN_DIGITS[tens] : 1) * 10 : 0) + (ones ? CN_DIGITS[ones] ?? NaN : 0);
}
const CN = '一二两三四五六七八九十百千万';
const NUM = `(\\d{1,2}(?!\\d)|(?:[一二两三四五六七八九]?十[一二三四五六七八九]?|[一二两三四五六七八九])(?![${CN}]))`;

const RULES = [
    {
        code: 'minor-age', level: 'high', text: '人物年龄设定不满 18 岁',
        // (?!\d): 「年龄: 1000」「age: 120」 are not 10 / 12. Chinese numerals need 岁 after them.
        re: new RegExp(`(?:年龄|\\bage)\\s*["']?\\s*[:：]\\s*["']?\\s*(?:(\\d{1,2})(?!\\d)|${NUM}(?=\\s*[岁歲]))\\s*(?:岁|歲)?`, 'gi'),
        keep: (m) => cnNumber(m[1] ?? m[2]) < 18,
    },
    {
        // 「年龄：化形后约莫十四五岁」「外表约14岁」「看起来十二三岁」: approximate ages and ranges
        // after a word that describes age or looks. Numerals can't sit in the gap, so
        // 「大约二十五岁」 is 25, never 5 / 15.
        code: 'minor-age', level: 'high', text: '人物年龄设定不满 18 岁',
        re: new RegExp(`(?:年龄|年方|外表|外貌|看起来|看上去|化形|化作|约莫|大约|约)[^，。,;；\\n\\d${CN}]{0,8}?`
            + `(?:(\\d{1,2})(?!\\d)(?:\\s*[-~～到至]\\s*\\d{1,2})?|(十[一二三四五六七八九]?|[一二三四五六七八九])[一二三四五六七八九]?)\\s*[岁歲]`, 'g'),
        keep: (m) => cnNumber(m[1] ?? m[2]) < 18,
    },
    {
        code: 'minor-relative', level: 'high', text: '出现未成年的子女或亲属',
        // No digits in the gap, so 「女儿今年120岁」 can't start the number mid-way.
        re: new RegExp(`(?:女儿|儿子|孩子|妹妹|弟弟|侄女|外甥女)[^，。,;；\\n\\d${CN}]{0,10}?${NUM}\\s*岁`, 'g'),
        keep: (m) => cnNumber(m[1]) < 18,
    },
    {
        code: 'age-disguised', level: 'high', text: '年龄数字被换成形似符号（专门躲检查）', once: true,
        re: /(?:年龄[^\n]{0,12}(?:替换|替代符号|不用阿拉伯数字|不得出现阿拉伯数字))|(?:数字[^\n]{0,6}替换[^\n]{0,20}年龄)/g,
    },
    {
        code: 'minor-word', level: 'high', text: '出现指向未成年人的词',
        re: /未成年|萝莉|幼女|正太|小学生|初中生|幼童|男童|女童|童女|loli|shota|初[一二三]学生|[一二三四五六]年级小学生|小学[一二三四五六]年级|从小学开始|自小学开始/gi,
        // A rule that keeps minors OUT ("未成年角色一律不适用…") is the opposite of a finding.
        keep: (m, text) => !(m[0] === '正太' && notShota(text, m.index))
            && !/禁止|不得|一律不|不适用|不做|不写|排除|不能|严禁/.test(sentenceAt(text, m.index)),
    },
    {
        code: 'age-unlimited', level: 'high', text: '年龄写成不设限',
        re: /年龄[^\n]{0,8}(?:无限制|不限|不设上下限|没有限制)/g,
    },
    {
        code: 'youth-coded', level: 'mid', text: '幼态化描写（成年人物也会被当成疑似未成年）',
        re: /幼态|婴儿肥|童颜|少女粉|JK制服|发育迟缓|稚嫩的身体|孩子般的身体/g,
    },
];

// 「正太」 inside other words: 真正/反正/公正… + 太 (too), 正 + 太阳/太平.
const ZHENG_WORDS = '真反公端纯修改纠方立摆刚严校订更';
function notShota(text, index) {
    const prev = text[index - 1];
    return (!!prev && ZHENG_WORDS.includes(prev)) || /^[阳平]/.test(text.slice(index + 2, index + 3));
}

function sentenceAt(text, index) {
    const start = Math.max(text.lastIndexOf('。', index), text.lastIndexOf('\n', index)) + 1;
    const ends = [text.indexOf('。', index), text.indexOf('\n', index)].filter((i) => i >= 0);
    return text.slice(start, ends.length ? Math.min(...ends) : text.length);
}

function snippet(text, index, length) {
    const start = Math.max(0, index - 24);
    const end = Math.min(text.length, index + length + 24);
    return `${start > 0 ? '…' : ''}${text.slice(start, end).replace(/\s+/g, ' ')}${end < text.length ? '…' : ''}`;
}

/**
 * @param {{where: string, text: string, disabled?: boolean}[]} items
 * @returns {{level: 'high'|'mid', code: string, text: string, where: string, snippet: string, disabled: boolean}[]}
 */
export function auditTexts(items) {
    const out = [];
    for (const item of items) {
        const raw = String(item?.text ?? '');
        if (!raw) continue;
        const { text, at } = unmaskDigits(raw);
        if (at >= 0) {
            out.push({
                level: 'high', code: 'age-disguised', text: '年龄数字被换成形似符号（专门躲检查）', where: item.where,
                snippet: snippet(raw, at, 4), disabled: !!item.disabled,
            });
        }
        const seen = [];   // [code, start, end]: two rules can hit the same words (年龄: 14岁)
        for (const rule of RULES) {
            rule.re.lastIndex = 0;
            let m;
            while ((m = rule.re.exec(text))) {
                if (rule.keep && !rule.keep(m, text)) continue;
                const end = m.index + m[0].length;
                if (seen.some(([c, s, e]) => c === rule.code && m.index < e && end > s)) continue;
                seen.push([rule.code, m.index, end]);
                out.push({
                    level: rule.level, code: rule.code, text: rule.text, where: item.where,
                    snippet: snippet(text, m.index, m[0].length), disabled: !!item.disabled,
                });
                if (rule.once) break;   // one instruction, often reworded twice in the same entry
            }
        }
    }
    const rank = { high: 0, mid: 1 };
    return out.sort((a, b) => rank[a.level] - rank[b.level] || Number(a.disabled) - Number(b.disabled));
}

/** Everything a character card carries, as {where, text} items. `card` is a V2/V3 card object or its `data`. */
export function cardItems(card) {
    const d = card?.data ?? card ?? {};
    const items = [];
    const push = (where, text, disabled = false) => { if (text) items.push({ where, text: String(text), disabled }); };
    for (const f of ['description', 'personality', 'scenario', 'first_mes', 'mes_example', 'system_prompt', 'post_history_instructions', 'creator_notes']) {
        push(`角色卡·${f}`, d[f]);
    }
    (d.alternate_greetings ?? []).forEach((g, i) => push(`开场白 #${i + 1}`, g));
    for (const e of d.character_book?.entries ?? []) push(`内嵌世界书·${e.comment || e.name || e.id}`, e.content, e.enabled === false);
    const ext = d.extensions ?? {};
    for (const r of ext.regex_scripts ?? []) push(`正则·${r.scriptName}`, `${r.findRegex ?? ''}\n${r.replaceString ?? ''}`, !!r.disabled);
    for (const s of ext.tavern_helper?.scripts ?? []) {
        push(`脚本·${s.name}`, s.content, s.enabled === false);
        if (s.data) push(`脚本数据·${s.name}`, JSON.stringify(s.data));
    }
    if (ext.depth_prompt?.prompt) push('角色注释（深度提示）', ext.depth_prompt.prompt);
    return items;
}

/** A lorebook file ({entries: {...}}) as items. */
export function worldItems(book, bookName = '世界书') {
    return Object.values(book?.entries ?? {}).map((e) => ({
        where: `${bookName}·${e.comment || (e.key ?? []).join('/') || e.uid}`,
        text: e.content,
        disabled: !!e.disable,
    }));
}

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
// Pure functions (no DOM, no SillyTavern) so the panel and the dev tool
// (tavern/scripts/check_card.py) share one rule set. Runs locally; nothing
// leaves the machine.

const RULES = [
    {
        code: 'minor-age', level: 'high', text: '人物年龄设定不满 18 岁',
        re: /(?:年龄|\bage)\s*["']?\s*[:：]\s*["']?\s*(\d{1,2})\s*(?:岁|歲)?/gi,
        keep: (m) => Number(m[1]) < 18,
    },
    {
        code: 'minor-relative', level: 'high', text: '出现未成年的子女或亲属',
        re: /(?:女儿|儿子|孩子|妹妹|弟弟|侄女|外甥女)[^，。,;；\n]{0,10}?(\d{1,2})\s*岁/g,
        keep: (m) => Number(m[1]) < 18,
    },
    {
        code: 'minor-word', level: 'high', text: '出现指向未成年人的词',
        re: /未成年|萝莉|幼女|正太|小学生|初中生|幼童|男童|女童|童女|loli|shota/gi,
        // A rule that keeps minors OUT ("未成年角色一律不适用…") is the opposite of a finding.
        keep: (m, text) => !/禁止|不得|一律不|不适用|不做|不写|排除|不能|严禁/.test(sentenceAt(text, m.index)),
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
        const text = String(item?.text ?? '');
        if (!text) continue;
        for (const rule of RULES) {
            rule.re.lastIndex = 0;
            let m;
            while ((m = rule.re.exec(text))) {
                if (rule.keep && !rule.keep(m, text)) continue;
                out.push({
                    level: rule.level, code: rule.code, text: rule.text, where: item.where,
                    snippet: snippet(text, m.index, m[0].length), disabled: !!item.disabled,
                });
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

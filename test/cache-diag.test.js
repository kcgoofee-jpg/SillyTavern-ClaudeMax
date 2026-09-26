import test from 'node:test';
import assert from 'node:assert/strict';

import { diagnoseCache, describeDiag, nearestLabel, explainCache, __resetCacheDiag } from '../src/proxy/cache-diag.js';

const U = (content) => ({ role: 'user', content });
const A = (content) => ({ role: 'assistant', content });

test('first turn, then a stable system prompt', () => {
    __resetCacheDiag();
    assert.equal(diagnoseCache('<preset>rules</preset>', [A('hi'), U('u1')]).firstTurn, true);
    const d = diagnoseCache('<preset>rules</preset>', [A('hi'), U('u1'), A('a1'), U('u2')]);
    assert.equal(d.systemChanged, false);
    assert.equal(d.historyDiffAt, null);
    assert.match(describeDiag(d), /系统提示词与上一轮相同/);
});

test('reports where the system prompt changed and the enclosing tag', () => {
    __resetCacheDiag();
    diagnoseCache('<preset>rules</preset><world_info>雪山</world_info>', [A('hi'), U('u1')]);
    const d = diagnoseCache('<preset>rules</preset><world_info>沙漠</world_info>', [A('hi'), U('u1'), A('a1'), U('u2')]);
    assert.equal(d.systemChanged, true);
    assert.equal(d.systemDiffAt, '<preset>rules</preset><world_info>'.length);
    assert.equal(d.systemDiffLabel, '<world_info>');
    assert.match(describeDiag(d), /整段缓存失效/);
});

test('history rewritten by regex is reported', () => {
    __resetCacheDiag();
    diagnoseCache('sys', [A('hi'), U('u1'), A('long reply'), U('u2')]);
    const d = diagnoseCache('sys', [A('hi'), U('u1'), A('summary only'), U('u2'), A('a2'), U('u3')]);
    assert.equal(d.historyDiffAt, 2);
});

test('separate chats do not interfere', () => {
    __resetCacheDiag();
    diagnoseCache('sys A', [A('greeting A'), U('x')]);
    assert.equal(diagnoseCache('sys B', [A('greeting B'), U('y')]).firstTurn, true);
});

test('nearestLabel names tags, but never quotes a heading (prompt text) — only its kind', () => {
    const t = '# 世界设定\n北境很冷';
    assert.equal(nearestLabel(t, t.length - 1), '世界书标题段落');
    const u = '## 小美的秘密日记\n内容';
    assert.equal(nearestLabel(u, u.length - 1), '某个标题段落');
    assert.equal(nearestLabel('<rules>abc', 8), '<rules>');
});

test('split point settles at the start of the enclosing tag and only moves earlier', () => {
    __resetCacheDiag();
    const head = '规则'.repeat(1000) + '\n';           // 2001 chars, stable
    const sys = (wi, tail = '尾部规则') => `${head}<Lore>\n${wi}\n</Lore>\n${tail}`;
    const h = [A('greeting'), U('u1')];
    assert.equal(diagnoseCache(sys('雪山'), h).splitAt, null);
    const d2 = diagnoseCache(sys('沙漠'), [...h, A('a1'), U('u2')]);
    assert.equal(d2.splitAt, head.length);          // snapped to the <Lore> line
    const d3 = diagnoseCache(sys('森林'), [...h, A('a1'), U('u2'), A('a2'), U('u3')]);
    assert.equal(d3.splitAt, d2.splitAt);           // stable → static part is byte-identical
    const d4 = diagnoseCache(sys('森林', '新尾部'), [...h, A('a1'), U('u2'), A('a2'), U('u3'), A('a3'), U('u4')]);
    assert.equal(d4.splitAt, d2.splitAt);           // a later change doesn't move it
});

test('a diff wandering inside one tagged section keeps the same split', () => {
    __resetCacheDiag();
    const head = '规则'.repeat(1000) + '\n';
    const sys = (...lines) => `${head}<world_info>\n${lines.join('\n')}\n</world_info>`;
    const h = [A('greeting'), U('u1')];
    diagnoseCache(sys('甲', '乙', '丙'), h);
    const d2 = diagnoseCache(sys('甲', '乙', '丁'), [...h, A('a1'), U('u2')]);
    const d3 = diagnoseCache(sys('甲', '戊'), [...h, A('a1'), U('u2'), A('a2'), U('u3')]);
    assert.equal(d2.splitAt, head.length);
    assert.equal(d3.splitAt, head.length);
});

test('a one-off early edit stops pinning the split after a few turns', () => {
    __resetCacheDiag();
    const a = '规则'.repeat(1000) + '\n';
    const b = '设定'.repeat(1000) + '\n';
    const sys = (toggle, wi) => `${a}${toggle}\n${b}<world_info>\n${wi}\n</world_info>`;
    let h = [A('greeting'), U('u1')];
    const turn = (toggle, wi) => { const d = diagnoseCache(sys(toggle, wi), h); h = [...h, A('a'), U('u')]; return d; };
    turn('开关甲', '雪山');
    const wiStart = (a + '开关甲\n' + b).length;
    assert.equal(turn('开关甲', '沙漠').splitAt, wiStart);
    assert.equal(turn('开关乙', '森林').splitAt, a.length);     // user flipped a toggle: split pulled forward
    turn('开关乙', '海边');
    turn('开关乙', '草原');
    assert.equal(turn('开关乙', '雪原').splitAt, wiStart);      // edit is 3 turns old: back behind the toggles
});

test('switching presets (most of the prompt replaced) resets the split instead of pinning it early', () => {
    __resetCacheDiag();
    const head = '开头'.repeat(1500) + '\n';
    const presetA = Array.from({ length: 300 }, (_, i) => `通用规则${i}：`.padEnd(60, '甲')).join('\n') + '\n';
    const presetB = Array.from({ length: 400 }, (_, i) => `庄园规则${i}：`.padEnd(60, '乙')).join('\n') + '\n';
    const sys = (preset, wi) => `${head}${preset}<world_info>\n${wi}\n</world_info>`;
    let h = [A('greeting'), U('u1')];
    const turn = (preset, wi) => { const d = diagnoseCache(sys(preset, wi), h); h = [...h, A('a'), U('u')]; return d; };
    turn(presetA, '雪山');
    const switched = turn(presetB, '雪山');
    assert.equal(switched.rewrite, true);
    assert.equal(switched.splitAt, null);                       // not pinned at the start of the preset
    assert.match(describeDiag(switched), /换了预设/);
    const next = turn(presetB, '沙漠');
    assert.equal(next.splitAt, (head + presetB).length);        // learned from the new prompt right away
});

test('no split when the change is too close to the start', () => {
    __resetCacheDiag();
    diagnoseCache('A\n' + 'x'.repeat(5000), [A('g'), U('u')]);
    assert.equal(diagnoseCache('B\n' + 'x'.repeat(5000), [A('g'), U('u'), A('a'), U('v')]).splitAt, null);
});

test('explainCache: split-covered change, history rewrite, effort switch', () => {
    const e = (over) => ({ ok: true, model: 'm', effort: 'high', inputTokens: 2, cacheReadTokens: 30000, cacheCreationTokens: 10000, ...over });
    const c = explainCache(e({ cacheDiag: { firstTurn: false, systemChanged: true, systemDiffAt: 36000, systemDiffLabel: '<world_info>', splitAt: 35000, historyDiffAt: 5, historyLen: 12 } }), e({}));
    assert.equal(c.hitPct, 75);
    assert.match(c.reasons[0], /前 35,000 字已单独缓存/);
    assert.match(c.reasons.join('\n'), /第 6 \/ 12 条/);
    assert.match(c.reasons.join('\n'), /世界书条目改成常驻/);
    const sw = explainCache(e({ cacheReadTokens: 0, cacheDiag: { firstTurn: false, systemChanged: false, historyDiffAt: null } }), e({ effort: 'medium' }));
    assert.match(sw.reasons.join(), /思考深度/);
    assert.match(explainCache(e({ cacheDiag: { firstTurn: true } })).reasons[0], /第一轮/);
    assert.equal(explainCache({ ok: false }), null);
});

test('two chats with the same card greeting are kept apart', () => {
    __resetCacheDiag();
    const sys = '规则'.repeat(1000);
    const open = [A('三人XX ack'), A('greeting')];
    diagnoseCache(sys, [...open, U('问她们有没有系统')]);
    const other = diagnoseCache(sys, [...open, U('先去溪边')]);
    assert.equal(other.firstTurn, true);
    assert.notEqual(other.chat, diagnoseCache(sys, [...open, U('问她们有没有系统'), A('a'), U('u2')]).chat);
});

test('chat key survives an injection dropping off the first user message', () => {
    __resetCacheDiag();
    const sys = '规则'.repeat(1000);
    diagnoseCache(sys, [A('greeting'), U('问她们有没有系统\n\n【文风提醒】')]);
    assert.equal(diagnoseCache(sys, [A('greeting'), U('问她们有没有系统'), A('a1'), U('u2\n\n【文风提醒】')]).firstTurn, false);
});

test('explainCache flags history that stopped caching although nothing changed', () => {
    const diag = { chat: 'c1', firstTurn: false, systemChanged: false, historyDiffAt: null, historyLen: 9 };
    const prev = { ok: true, model: 'm', cacheReadTokens: 47000, cacheCreationTokens: 4000, cacheDiag: { chat: 'c1' } };
    const broken = explainCache({ ok: true, model: 'm', cacheReadTokens: 26000, cacheCreationTokens: 28000, cacheDiag: diag }, prev);
    assert.match(broken.reasons.join(), /逐轮还原/);
    const healthy = explainCache({ ok: true, model: 'm', cacheReadTokens: 51000, cacheCreationTokens: 2500, cacheDiag: diag }, prev);
    assert.doesNotMatch(healthy.reasons.join(), /逐轮还原/);
});

test('equivalentTokens uses list-price ratios', async () => {
    const { equivalentTokens } = await import('../src/proxy/cache-diag.js');
    assert.equal(equivalentTokens({ inputTokens: 2, cacheReadTokens: 50000, cacheCreationTokens: 2800, outputTokens: 5000 }), 2 + 5000 + 3500 + 25000);
});

test('a reroll (same conversation sent again) is marked', () => {
    __resetCacheDiag();
    const sys = '规则'.repeat(3000);
    const h = [{ role: 'user', content: '开始' }, { role: 'assistant', content: '好' }, { role: 'user', content: '推门' }];
    diagnoseCache(sys, h);
    assert.equal(diagnoseCache(sys, h).reroll, true);
    assert.equal(diagnoseCache(sys, [...h, { role: 'assistant', content: '门开了' }, { role: 'user', content: '进去' }]).reroll, undefined);
});

test('what was learned about a chat survives a restart (tags and split only)', async () => {
    const { mkdtempSync, readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { tmpdir } = await import('node:os');
    const file = join(mkdtempSync(join(tmpdir(), 'cm-')), 'mem.json');
    process.env.CLAUDE_SUBSCRIPTION_CACHE_MEMORY_FILE = file;
    try {
        __resetCacheDiag();
        const rules = '规则'.repeat(2000);
        const sys = (wi) => `<rules>${rules}</rules>\n<world_info>${wi}</world_info>`;
        const h = (n) => [{ role: 'user', content: '开始' }, ...Array.from({ length: n }, (_, i) => ({ role: i % 2 ? 'user' : 'assistant', content: `第${i}句` }))];
        diagnoseCache(sys('甲'), h(1));
        assert.deepEqual(diagnoseCache(sys('乙'), h(3)).volatileTags, ['world_info']);
        const saved = readFileSync(file, 'utf8');
        assert.ok(!saved.includes('第') && !saved.includes('规则'), 'no chat or prompt text on disk');
        __resetCacheDiag(); // "restart"
        const first = diagnoseCache(sys('丙'), h(5));
        assert.equal(first.firstTurn, true);
        assert.equal(first.remembered, true);
        assert.deepEqual(first.volatileTags, ['world_info']);
    } finally {
        delete process.env.CLAUDE_SUBSCRIPTION_CACHE_MEMORY_FILE;
        __resetCacheDiag();
    }
});

test('with the lore moved out, a change inside it sets no split and later changes do not move it', () => {
    __resetCacheDiag();
    const head = '规则'.repeat(1000) + '\n';
    const sys = (wi, tail = '尾部') => `${head}<Lore>\n${wi}\n</Lore>\n${tail}`;
    const h = [A('greeting'), U('u1')];
    const opts = { moveVolatile: true };
    diagnoseCache(sys('雪山'), h, opts);
    const d2 = diagnoseCache(sys('沙漠'), [...h, A('a1'), U('u2')], opts);
    assert.deepEqual(d2.volatileTags, ['Lore']);
    assert.equal(d2.splitAt, null);                 // only the moved block changed: nothing to split
    const d3 = diagnoseCache(sys('森林', '尾部改了'), [...h, A('a1'), U('u2'), A('a2'), U('u3')], opts);
    assert.ok(d3.splitAt > head.length);            // split after the placeholder, where the sent prompt changed
    const d4 = diagnoseCache(sys('城市', '尾部改了'), [...h, A('a1'), U('u2'), A('a2'), U('u3'), A('a3'), U('u4')], opts);
    assert.equal(d4.splitAt, d3.splitAt);           // lore changing every turn never moves it
});

test('with lore moving on, a new chat treats the world info wrappers as volatile from the first turn', () => {
    __resetCacheDiag();
    const sys = (w, l) => `<preset>${'r'.repeat(3000)}</preset><Lore>${l}</Lore><world_info>${w}</world_info><end>x</end>`;
    const first = diagnoseCache(sys('雪山', '甲'), [A('greet-lore'), U('u1')], { moveVolatile: true });
    assert.equal(first.firstTurn, true);
    assert.deepEqual([...first.volatileTags].sort(), ['Lore', 'world_info']);
    assert.match(describeDiag(first), /一开始就移到消息里/);
    // Both blocks change next turn: the prompt as sent is unchanged, so no split.
    const d = diagnoseCache(sys('沙漠', '乙'), [A('greet-lore'), U('u1'), A('a1'), U('u2')], { moveVolatile: true });
    assert.equal(d.splitAt, null);
});

test('without lore moving, a new chat learns nothing up front', () => {
    __resetCacheDiag();
    const first = diagnoseCache('<Lore>a</Lore>', [A('greet-plain'), U('u1')]);
    assert.deepEqual(first.volatileTags, []);
});

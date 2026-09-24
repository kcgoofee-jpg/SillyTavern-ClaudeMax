import test from 'node:test';
import assert from 'node:assert/strict';

import { diagnoseCache, describeDiag, nearestLabel, explainCache, __resetCacheDiag } from '../lib/cache-diag.js';

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

test('nearestLabel falls back to a heading', () => {
    const t = '# 世界设定\n北境很冷';
    assert.equal(nearestLabel(t, t.length - 1), '# 世界设定');
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
    assert.match(c.reasons[1], /第 6 \/ 12 条/);
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

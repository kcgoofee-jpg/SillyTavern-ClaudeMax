import test from 'node:test';
import assert from 'node:assert/strict';

import { diagnoseCache, describeDiag, nearestLabel, __resetCacheDiag } from '../lib/cache-diag.js';

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

test('split point settles at the start of the first line that changes and only moves earlier', () => {
    __resetCacheDiag();
    const head = '规则'.repeat(1000) + '\n';           // 2001 chars, stable
    const sys = (wi, tail = '尾部规则') => `${head}<Lore>\n${wi}\n</Lore>\n${tail}`;
    const h = [A('greeting'), U('u1')];
    assert.equal(diagnoseCache(sys('雪山'), h).splitAt, null);
    const d2 = diagnoseCache(sys('沙漠'), [...h, A('a1'), U('u2')]);
    assert.equal(d2.splitAt, head.length + '<Lore>\n'.length);
    const d3 = diagnoseCache(sys('森林'), [...h, A('a1'), U('u2'), A('a2'), U('u3')]);
    assert.equal(d3.splitAt, d2.splitAt);           // stable → static part is byte-identical
    const d4 = diagnoseCache(sys('森林', '新尾部'), [...h, A('a1'), U('u2'), A('a2'), U('u3'), A('a3'), U('u4')]);
    assert.equal(d4.splitAt, d2.splitAt);           // a later change doesn't move it
});

test('no split when the change is too close to the start', () => {
    __resetCacheDiag();
    diagnoseCache('A\n' + 'x'.repeat(5000), [A('g'), U('u')]);
    assert.equal(diagnoseCache('B\n' + 'x'.repeat(5000), [A('g'), U('u'), A('a'), U('v')]).splitAt, null);
});

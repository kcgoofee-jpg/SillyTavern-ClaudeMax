import test from 'node:test';
import assert from 'node:assert/strict';

import { extractVolatileBlocks, injectBlocks, PLACEHOLDER_NOTE, TAIL_NOTE } from '../lib/lore-tail.js';
import { diagnoseCache, __resetCacheDiag } from '../lib/cache-diag.js';

const rules = '规则'.repeat(2000);

test('extract: block content leaves, a fixed placeholder stays', () => {
    const a = `<rules>${rules}</rules>\n<world_info>\n条目甲\n</world_info>\n<end>尾</end>`;
    const b = `<rules>${rules}</rules>\n<world_info>\n条目乙\n条目丙\n</world_info>\n<end>尾</end>`;
    const ra = extractVolatileBlocks(a, ['world_info']);
    const rb = extractVolatileBlocks(b, ['world_info']);
    assert.equal(ra.system, rb.system);
    assert.ok(ra.system.includes(PLACEHOLDER_NOTE));
    assert.deepEqual(rb.blocks, [{ tag: 'world_info', text: '条目乙\n条目丙' }]);
});

test('extract: a block that is most of the prompt is left alone', () => {
    const r = extractVolatileBlocks(`<world_info>${rules}</world_info>短`, ['world_info']);
    assert.equal(r.blocks.length, 0);
});

test('inject: goes on top of the last user message, before a prefill', () => {
    const h = [
        { role: 'assistant', content: '开场' },
        { role: 'user', content: '我推门' },
        { role: 'assistant', content: '（预填' },
    ];
    const out = injectBlocks(h, [{ tag: 'world_info', text: '门后是地窖' }]);
    assert.equal(out[1].content, `<world_info>\n门后是地窖\n</world_info>\n${TAIL_NOTE}\n\n我推门`);
    assert.equal(out[2].content, '（预填');
    assert.equal(h[1].content, '我推门');
});

test('diag learns a world-info tag after one change, others after two', () => {
    __resetCacheDiag();
    const hist = (n) => [{ role: 'user', content: '开始' }, ...Array.from({ length: n }, (_, i) => ({ role: i % 2 ? 'user' : 'assistant', content: `第${i}句` }))];
    const sys = (wi, other) => `<rules>${rules}</rules>\n<world_info>${wi}</world_info>\n<status>${other}</status>`;
    assert.deepEqual(diagnoseCache(sys('甲', 'x'), hist(1)).volatileTags, []);
    assert.deepEqual(diagnoseCache(sys('乙', 'x'), hist(3)).volatileTags, ['world_info']);
    assert.deepEqual(diagnoseCache(sys('乙', 'y'), hist(5)).volatileTags, ['world_info']);
    assert.deepEqual(diagnoseCache(sys('乙', 'z'), hist(7)).volatileTags, ['world_info', 'status']);
});

import { newLoreOnly } from '../lib/lore-tail.js';
import { createTurnCollector, sentTextFor, __resetTurnCaptures } from '../lib/turn-capture.js';

test('newLoreOnly: lines already given in earlier turns are not repeated', () => {
    const earlier = ['<world_info>\n地窖在木屋北侧\n</world_info>\n我推门'];
    const out = newLoreOnly([{ tag: 'world_info', text: '地窖在木屋北侧\n溪水向东流' }], earlier);
    assert.deepEqual(out, [{ tag: 'world_info', text: '溪水向东流' }]);
    assert.deepEqual(newLoreOnly([{ tag: 'world_info', text: '地窖在木屋北侧' }], earlier), []);
});

test('collector files the sent message under the text ST sends next turn', () => {
    __resetTurnCaptures();
    const sent = '<world_info>\n甲\n</world_info>\n\n我推门';
    const c = createTurnCollector(sent, '我推门');
    c.onAppend([{ type: 'user', uuid: 'u1', message: { role: 'user', content: sent } }, { type: 'assistant', uuid: 'a1' }]);
    assert.equal(sentTextFor('我推门'), sent);
    assert.equal(sentTextFor(sent), null);
});

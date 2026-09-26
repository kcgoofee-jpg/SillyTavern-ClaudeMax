import test from 'node:test';
import assert from 'node:assert/strict';

import { moveTailBlockToFront, __resetTailBlock } from '../lib/tail-block.js';

const S = (c) => ({ role: 'system', content: c });
const U = (c) => ({ role: 'user', content: c });
const A = (c) => ({ role: 'assistant', content: c });
const RULES = [S('<Order>'), U('防抢话：' + '规则'.repeat(200)), A('明白'), U('字数：宽松'), S('</Order>')];
const turn = (history) => [S('main'), U('真实感'), A('greeting'), ...history, ...RULES];

test('the identical post-history block moves in front of the conversation', () => {
    __resetTailBlock();
    assert.equal(moveTailBlockToFront(turn([U('去溪边')])).moved, 0);             // first turn: nothing to compare
    const { messages, moved } = moveTailBlockToFront(turn([U('去溪边'), A('好'), U('开箱')]));
    assert.equal(moved, RULES.length);
    assert.deepEqual(messages.slice(0, 1 + RULES.length), [S('main'), ...RULES]);
    assert.deepEqual(messages.at(-1), U('开箱'));                                  // the current input is last again
});

test('a repeated input is not mistaken for part of the block', () => {
    __resetTailBlock();
    moveTailBlockToFront(turn([U('继续')]));
    const { messages } = moveTailBlockToFront(turn([U('继续'), A('好'), U('继续')]));
    assert.deepEqual(messages.at(-1), U('继续'));
    assert.equal(messages.filter((m) => m.content === '继续').length, 2);
});

test('a trailing assistant prefill stays last; swipes do nothing', () => {
    __resetTailBlock();
    const withPrefill = (h) => [...turn(h), A('■')];
    moveTailBlockToFront(withPrefill([U('a')]));
    const { messages } = moveTailBlockToFront(withPrefill([U('a'), A('x'), U('b')]));
    assert.deepEqual(messages.at(-1), A('■'));
    assert.deepEqual(messages.at(-2), U('b'));
    __resetTailBlock();
    moveTailBlockToFront(turn([U('a'), A('x'), U('b')]));
    assert.equal(moveTailBlockToFront(turn([U('a'), A('x'), U('b')])).moved, 0);   // same length: swipe / regenerate
});

test('null / malformed entries do not crash it', () => {
    __resetTailBlock();
    assert.doesNotThrow(() => moveTailBlockToFront([null, { role: 'user' }, S('x')]));
    assert.doesNotThrow(() => moveTailBlockToFront([S('main'), null, U('a')]));
});

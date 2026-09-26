import test from 'node:test';
import assert from 'node:assert/strict';

import { keepReply, keptReply, isValidSlot, trackGeneration, cancelReply, handleCancelReply, __resetKeptReplies } from '../lib/reply-keeper.js';
import { extractSettings } from '../lib/settings.js';

test('replies are kept per slot, in memory, and expire', () => {
    __resetKeptReplies();
    keepReply('abcdef0123456789', { text: '完整的回复', reasoning: '想法' });
    assert.equal(keptReply('abcdef0123456789').text, '完整的回复');
    assert.equal(keptReply('abcdef0123456789', Date.now() + 7 * 3600 * 1000), null);
    assert.equal(keptReply('abcdef0123456789'), null); // expired entry is dropped
});

test('only hex slots are accepted; the newest reply replaces the old one', () => {
    __resetKeptReplies();
    assert.equal(isValidSlot('../../etc'), false);
    keepReply('../../etc', { text: 'x' });
    assert.equal(keptReply('../../etc'), null);
    keepReply('00000000aaaaaaaa', { text: '第一次' });
    keepReply('00000000aaaaaaaa', { text: '重新生成' });
    assert.equal(keptReply('00000000aaaaaaaa').text, '重新生成');
});

test('the reply slot comes through the claude_subscription settings', () => {
    assert.equal(extractSettings({ claude_subscription: { reply_slot: 'abcdef0123456789' } }).replySlot, 'abcdef0123456789');
    assert.equal(extractSettings({ claude_subscription: { reply_slot: 'not hex!' } }).replySlot, null);
    assert.equal(extractSettings({}).replySlot, null);
});

test('cancel aborts what runs for the slot and drops its kept reply', () => {
    __resetKeptReplies();
    let aborted = 0;
    const untrack = trackGeneration('abcdef0123456789', () => { aborted++; });
    keepReply('abcdef0123456789', { text: '上一次的' });
    assert.equal(cancelReply('abcdef0123456789'), true);
    assert.equal(aborted, 1);
    assert.equal(keptReply('abcdef0123456789'), null);
    untrack();
    assert.equal(cancelReply('abcdef0123456789'), false, 'nothing running any more');
    assert.equal(cancelReply('not-a-slot'), false);
});

test('cancel route: validates the slot, answers {ok, cancelled}', () => {
    __resetKeptReplies();
    const res = () => { const r = { statusCode: 200 }; r.status = (c) => { r.statusCode = c; return r; }; r.json = (b) => { r.body = b; return r; }; return r; };
    const bad = res();
    handleCancelReply({ params: { slot: '../x' } }, bad);
    assert.equal(bad.statusCode, 400);
    const idle = res();
    handleCancelReply({ params: { slot: '0123456789abcdef' } }, idle);
    assert.deepEqual(idle.body, { ok: true, cancelled: false });
    trackGeneration('0123456789abcdef', () => {});
    const busy = res();
    handleCancelReply({ params: { slot: '0123456789abcdef' } }, busy);
    assert.deepEqual(busy.body, { ok: true, cancelled: true });
});

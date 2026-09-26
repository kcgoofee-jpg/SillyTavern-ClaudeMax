import test from 'node:test';
import assert from 'node:assert/strict';

import { keepReply, keptReply, isValidSlot, __resetKeptReplies } from '../lib/reply-keeper.js';
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

import test from 'node:test';
import assert from 'node:assert/strict';

import { extractSettings } from '../src/proxy/settings.js';

test('auxiliary callers (no panel settings, no effort) default to thinking off', () => {
    const s = extractSettings({ model: 'claude-haiku-4-5', messages: [] });
    assert.equal(s.auxiliary, true);
    assert.equal(s.thinking, 'off');
});

test('panel requests keep adaptive and are not auxiliary', () => {
    const s = extractSettings({ claude_subscription: { show_reasoning: true } });
    assert.equal(s.auxiliary, false);
    assert.equal(s.thinking, 'adaptive');
    assert.equal(extractSettings({ claude_subscription: { thinking: 'on' } }).thinking, 'on');
});

test('an explicit effort field means a deliberate caller: adaptive default', () => {
    const s = extractSettings({ reasoning_effort: 'high' });
    assert.equal(s.auxiliary, false);
    assert.equal(s.thinking, 'adaptive');
});

test('CLAUDE_SUBSCRIPTION_AUX_THINKING overrides the auxiliary default', () => {
    process.env.CLAUDE_SUBSCRIPTION_AUX_THINKING = 'adaptive';
    try {
        assert.equal(extractSettings({}).thinking, 'adaptive');
    } finally {
        delete process.env.CLAUDE_SUBSCRIPTION_AUX_THINKING;
    }
});

test('purpose: quiet from the panel marks a background call as auxiliary', () => {
    const s = extractSettings({ claude_subscription: { purpose: 'quiet', effort: 'low', thinking: 'adaptive' } });
    assert.equal(s.auxiliary, true);
    assert.equal(s.purpose, 'quiet');
    assert.equal(s.effort, 'low');
    const chat = extractSettings({ claude_subscription: { effort: 'high' } });
    assert.equal(chat.auxiliary, false);
    assert.equal(chat.purpose, 'chat');
});

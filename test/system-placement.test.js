import test from 'node:test';
import assert from 'node:assert/strict';

import { inlineLateSystemMessages } from '../src/proxy/system-placement.js';
import { extractSettings } from '../src/proxy/settings.js';

const S = (content) => ({ role: 'system', content });
const U = (content) => ({ role: 'user', content });
const A = (content) => ({ role: 'assistant', content });

test('leading system messages stay; depth-injected ones merge into the neighboring user turn', () => {
    const out = inlineLateSystemMessages([
        S('preset'), S('card'),
        A('greeting'),
        U('u1'), A('a1'),
        S('<style>文风</style>'),   // depth 2 injection
        U('u2'),
    ]);
    assert.deepEqual(out, [
        S('preset'), S('card'),
        A('greeting'),
        U('u1'), A('a1'),
        U('<style>文风</style>\n\nu2'),
    ]);
});

test('a deep injection moves up to the current turn so older turns never change', () => {
    const out = inlineLateSystemMessages([
        S('preset'),
        A('greeting'),
        U('u1'),
        S('<mvu>格式</mvu>'),     // depth 4: would merge into u1
        A('a1'), U('u2'), A('a2'),
        S('<style>文风</style>'), // depth 2
        U('u3'),
    ]);
    assert.deepEqual(out, [
        S('preset'),
        A('greeting'),
        U('u1'), A('a1'), U('u2'), A('a2'),
        U('<mvu>格式</mvu>\n\n<style>文风</style>\n\nu3'),
    ]);
});

test('system note after the last user message merges into it (depth 0)', () => {
    const out = inlineLateSystemMessages([S('sys'), U('hi'), S('author note')]);
    assert.deepEqual(out, [S('sys'), U('hi\n\nauthor note')]);
});

test('system note after a trailing assistant prefill moves before it', () => {
    const out = inlineLateSystemMessages([S('sys'), U('hi'), A('prefill'), S('note')]);
    assert.deepEqual(out, [S('sys'), U('hi\n\nnote'), A('prefill')]);
});

test('image content is preserved when merging', () => {
    const img = { type: 'image_url', image_url: { url: 'data:image/png;base64,xx' } };
    const out = inlineLateSystemMessages([S('sys'), U('hi'), A('a'), S('note'), U([{ type: 'text', text: 'look' }, img])]);
    assert.deepEqual(out[3].content, [{ type: 'text', text: 'note' }, { type: 'text', text: 'look' }, img]);
});

test('system messages around a fake assistant acknowledgement all go to the system prompt', () => {
    const out = inlineLateSystemMessages([
        S('team'), A('我们收到了这封信'), S('rules'), S('card'),
        { role: 'user', content: '' },          // empty prompt-manager slot
        A('greeting'), U('u1'),
    ]);
    assert.deepEqual(out, [S('team'), S('rules'), S('card'), A('我们收到了这封信'), A('greeting'), U('u1')]);
});

test('no late system messages → same array back', () => {
    const msgs = [S('sys'), U('hi')];
    assert.equal(inlineLateSystemMessages(msgs), msgs);
});

test('system_placement setting defaults to inline', () => {
    assert.equal(extractSettings({}).systemPlacement, 'inline');
    assert.equal(extractSettings({ claude_subscription: { system_placement: 'hoist' } }).systemPlacement, 'hoist');
});

test('buildSystemPrompt splits at the boundary only when asked', async () => {
    const { buildSystemPrompt } = await import('../src/proxy/system-prompt.js');
    assert.equal(buildSystemPrompt('abcdef', false), 'abcdef');
    assert.equal(buildSystemPrompt('abcdef', false, 3, null), 'abcdef');
    assert.deepEqual(buildSystemPrompt('abcdef', false, 3, 'B'), { type: 'custom', prompt: ['abc', 'B', 'def'], snapshot: false });
    assert.equal(buildSystemPrompt('abcdef', false, 6, 'B'), 'abcdef');
});


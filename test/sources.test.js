import test from 'node:test';
import assert from 'node:assert/strict';

import { canonicalModel, isClaudeModel, openRouterId, sourceModelId, describeSource, cacheAdvice, CLAUDE_SOURCES } from '../src/shared/sources.js';

test('canonical id from every source spelling', () => {
    assert.equal(canonicalModel('claude-opus-4-6'), 'claude-opus-4-6');
    assert.equal(canonicalModel('claude-opus-4-6[1m]'), 'claude-opus-4-6');
    assert.equal(canonicalModel('anthropic/claude-opus-4.6'), 'claude-opus-4-6');
    assert.equal(canonicalModel('anthropic/claude-3.7-sonnet:thinking'), 'claude-3-7-sonnet');
    assert.equal(canonicalModel('claude-opus-4-5-20251101'), 'claude-opus-4-5');
    assert.equal(canonicalModel('claude-opus-4-6-thinking'), 'claude-opus-4-6');
    assert.equal(canonicalModel('us.anthropic.claude-opus-4-6-v1:0'), 'claude-opus-4-6');
    assert.equal(canonicalModel('gpt-4o'), null);
});

test('isClaudeModel', () => {
    assert.ok(isClaudeModel('anthropic/claude-opus-5.5'));
    assert.ok(isClaudeModel('claude-fable-5'));
    assert.ok(!isClaudeModel('openai/gpt-5'));
    assert.ok(!isClaudeModel(null));
});

test('OpenRouter spelling', () => {
    assert.equal(openRouterId('claude-opus-4-6'), 'anthropic/claude-opus-4.6');
    assert.equal(openRouterId('claude-opus-5-5'), 'anthropic/claude-opus-5.5');
    assert.equal(openRouterId('claude-opus-5'), 'anthropic/claude-opus-5');
});

test('sourceModelId picks from the loaded list, plainest variant first', () => {
    const or = ['anthropic/claude-opus-4.6:thinking', 'anthropic/claude-opus-4.6', 'openai/gpt-5'];
    assert.equal(sourceModelId('openrouter', 'claude-opus-4-6', or), 'anthropic/claude-opus-4.6');
    assert.equal(sourceModelId('cometapi', 'claude-opus-4-6', ['claude-opus-4-6-20260201', 'claude-opus-4-6-thinking']), 'claude-opus-4-6-20260201');
    // Loaded list without the model: not guessed.
    assert.equal(sourceModelId('openrouter', 'claude-opus-5-5', or), null);
    // No list yet.
    assert.equal(sourceModelId('openrouter', 'claude-opus-5-5', []), 'anthropic/claude-opus-5.5');
    assert.equal(sourceModelId('nanogpt', 'claude-opus-5-5', []), null);
    // Claude source: its static dropdown lags new models, so the canonical id is fine.
    assert.equal(sourceModelId('claude', 'claude-opus-5-5', ['claude-opus-4-6']), 'claude-opus-5-5');
    assert.equal(sourceModelId('claude', 'claude-opus-4-6', ['claude-opus-4-6']), 'claude-opus-4-6');
});

test('describeSource: where and billing', () => {
    assert.deepEqual(describeSource({ source: 'custom', model: 'claude-opus-4-6', ours: true }), { kind: 'ours', where: '本机代理', billing: '订阅' });
    assert.equal(describeSource({ source: 'claude', model: 'claude-opus-4-6' }).billing, 'API 密钥');
    assert.equal(describeSource({ source: 'claude', model: 'claude-opus-4-6', reverseProxy: 'https://x' }).billing, '中转');
    assert.equal(describeSource({ source: 'openrouter', model: 'anthropic/claude-opus-4.6' }).billing, 'OpenRouter 额度');
    assert.equal(describeSource({ source: 'custom', model: 'claude-opus-4-6' }).where, '自定义地址');
    assert.equal(describeSource({ source: 'openrouter', model: 'openai/gpt-5' }), null);
    assert.equal(describeSource({ source: 'vertexai', model: 'claude-opus-4-6' }), null);
});

test('cacheAdvice follows what ST applies per source', () => {
    assert.ok(cacheAdvice('claude').yaml.includes('cachingAtDepth: 0'));
    assert.ok(cacheAdvice('openrouter').yaml.includes('extendedTTL: true'));
    assert.ok(!cacheAdvice('nanogpt').yaml.includes('cachingAtDepth'));
    assert.equal(cacheAdvice('aimlapi').yaml, null);
    assert.equal(cacheAdvice('custom').tone, 'warn');
    for (const meta of Object.values(CLAUDE_SOURCES)) assert.ok(meta.select || meta.input);
});

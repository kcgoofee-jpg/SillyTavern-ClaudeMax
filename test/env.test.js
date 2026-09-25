import test from 'node:test';
import assert from 'node:assert/strict';

import { buildSubprocessEnv } from '../lib/env.js';

test('buildSubprocessEnv disables non-essential CLI traffic (per-session ai-title calls)', () => {
    const env = buildSubprocessEnv({ envPins: {}, maxTokens: undefined, apiKey: null });
    assert.equal(env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC, '1');
    assert.equal(env.ENABLE_CLAUDEAI_MCP_SERVERS, 'false');
});

test('buildSubprocessEnv still scrubs stray API credentials for subscription auth', () => {
    const saved = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = 'sk-ant-stray';
    try {
        const env = buildSubprocessEnv({ envPins: {}, maxTokens: undefined, apiKey: null });
        assert.equal(env.ANTHROPIC_API_KEY, undefined);
    } finally {
        if (saved === undefined) delete process.env.ANTHROPIC_API_KEY;
        else process.env.ANTHROPIC_API_KEY = saved;
    }
});

test('refusal fallback to another model is off unless asked for (a streamed partial cannot be retracted)', () => {
    const saved = process.env.CLAUDE_SUBSCRIPTION_REFUSAL_FALLBACK;
    delete process.env.CLAUDE_SUBSCRIPTION_REFUSAL_FALLBACK;
    assert.equal(buildSubprocessEnv({ envPins: {}, maxTokens: undefined, apiKey: null }).CLAUDE_CODE_DISABLE_REFUSAL_FALLBACK, '1');
    process.env.CLAUDE_SUBSCRIPTION_REFUSAL_FALLBACK = 'on';
    assert.equal(buildSubprocessEnv({ envPins: {}, maxTokens: undefined, apiKey: null }).CLAUDE_CODE_DISABLE_REFUSAL_FALLBACK, undefined);
    if (saved === undefined) delete process.env.CLAUDE_SUBSCRIPTION_REFUSAL_FALLBACK; else process.env.CLAUDE_SUBSCRIPTION_REFUSAL_FALLBACK = saved;
});

import test from 'node:test';
import assert from 'node:assert/strict';

import { buildSubprocessEnv } from '../src/proxy/env.js';

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

test('the proxy\'s own CLAUDE_SUBSCRIPTION_* settings never reach the CLI', () => {
    process.env.CLAUDE_SUBSCRIPTION_LAN_KEY = 'secret-lan-key';
    try {
        const env = buildSubprocessEnv({ envPins: {}, maxTokens: undefined, apiKey: null });
        assert.deepEqual(Object.keys(env).filter((k) => k.startsWith('CLAUDE_SUBSCRIPTION_')), []);
        assert.equal(process.env.CLAUDE_SUBSCRIPTION_LAN_KEY, 'secret-lan-key', 'the proxy keeps its own copy');
    } finally {
        delete process.env.CLAUDE_SUBSCRIPTION_LAN_KEY;
    }
});

test('API-key mode asks the CLI for a 1-hour prompt cache; subscription mode is left alone', () => {
    const sub = buildSubprocessEnv({ envPins: {}, maxTokens: undefined, apiKey: null });
    assert.equal(sub.CLAUDE_CODE_PROMPT_CACHE_TTL, process.env.CLAUDE_CODE_PROMPT_CACHE_TTL);
    const api = buildSubprocessEnv({ envPins: {}, maxTokens: undefined, apiKey: 'sk-ant-test' });
    assert.equal(api.ANTHROPIC_API_KEY, 'sk-ant-test');
    assert.equal(api.CLAUDE_CODE_PROMPT_CACHE_TTL, process.env.CLAUDE_CODE_PROMPT_CACHE_TTL ?? '1h');
});

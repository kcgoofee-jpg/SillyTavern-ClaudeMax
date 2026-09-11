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

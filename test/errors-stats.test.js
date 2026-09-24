import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { explainError, formatErrorForUser } from '../lib/errors-zh.js';
import { assertServedModel } from '../lib/chat.js';

test('common upstream errors get Chinese explanations', () => {
    assert.equal(explainError('Not logged in · Please run /login').code, 'not_logged_in');
    assert.equal(explainError('Claude AI usage limit reached|1790000000').code, 'usage_limit');
    assert.equal(explainError('API Error: 529 {"type":"overloaded_error"}').code, 'overloaded');
    assert.equal(explainError('prompt is too long: 1200000 tokens > 1000000 maximum').code, 'prompt_too_long');
    assert.equal(explainError('Extra usage is required for 1M context').code, 'extra_usage');
    assert.equal(explainError('something odd').code, 'unknown');
    const text = formatErrorForUser('Not logged in · Please run /login');
    assert.match(text, /^【Claude Max】Claude 订阅未登录/);
    assert.match(text, /原始错误：Not logged in/);
});

test('served-model guard ignores the CLI synthetic error message', () => {
    assert.doesNotThrow(() => assertServedModel('fable', '<synthetic>', 'claude-fable-5'));
    assert.doesNotThrow(() => assertServedModel('fable', 'claude-fable-5', 'claude-fable-5'));
    assert.doesNotThrow(() => assertServedModel('opus', 'claude-sonnet-4-6', 'claude-opus-5'));
    assert.throws(() => assertServedModel('fable', 'claude-opus-5', 'claude-fable-5'), /served-model guard/);
});

test('usage stats record metadata only and aggregate today / week', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cm-stats-'));
    process.env.CLAUDE_SUBSCRIPTION_STATS_FILE = join(dir, 'usage.jsonl');
    const stats = await import('../lib/usage-stats.js');
    stats.__resetStatsForTesting();
    const log = console.log;
    console.log = () => {};
    try {
        const t0 = Date.now() - 10000;
        stats.recordRequest({
            model: 'claude-opus-5', path: 'resume', stream: true, startedAt: t0, firstTokenAt: t0 + 2000,
            usage: { input_tokens: 100, output_tokens: 900, cache_read_input_tokens: 800, cache_creation_input_tokens: 100 },
            textChars: 3000, reasoningChars: 50, finish: 'stop',
        });
        stats.recordRequest({ model: 'claude-fable-5', path: 'resume', stream: true, startedAt: t0, textChars: 0, reasoningChars: 0, error: 'Not logged in' });
    } finally {
        console.log = log;
    }
    const s = stats.summarizeStats();
    assert.equal(s.today.requests, 2);
    assert.equal(s.today.failed, 1);
    assert.equal(s.today.outputTokens, 900);
    assert.equal(s.today.cacheHitRate, 0.8);
    assert.equal(s.today.withReasoning, 1);
    assert.equal(s.lastError.code, 'not_logged_in');
    const file = readFileSync(process.env.CLAUDE_SUBSCRIPTION_STATS_FILE, 'utf8');
    assert.equal(file.trim().split('\n').length, 2);
    assert.ok(!/mes|content/.test(file), 'no message content persisted');
    delete process.env.CLAUDE_SUBSCRIPTION_STATS_FILE;
});

test('Opus 5.5 safeguard refusals are recognized', () => {
    const raw = "API Error: Opus 5.5 (1M context)'s safeguards flagged this message (https://www.anthropic.com/legal/aup). Details: `[reasoning_extraction]` Request ID: req_x";
    assert.equal(explainError(raw).code, 'reasoning_extraction');
    assert.equal(explainError("safeguards flagged this message Details: `[cyber]`").code, 'safeguards');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { explainError, formatErrorForUser } from '../src/proxy/errors-zh.js';
import { assertServedModel } from '../src/proxy/chat.js';

test('common upstream errors get Chinese explanations', () => {
    assert.equal(explainError('Not logged in · Please run /login').code, 'not_logged_in');
    assert.equal(explainError('Claude AI usage limit reached|1790000000').code, 'usage_limit');
    assert.equal(explainError('API Error: 529 {"type":"overloaded_error"}').code, 'overloaded');
    assert.equal(explainError('prompt is too long: 1200000 tokens > 1000000 maximum').code, 'prompt_too_long');
    assert.equal(explainError('Extra usage is required for 1M context').code, 'extra_usage');
    assert.equal(explainError('something odd').code, 'unknown');
    const text = formatErrorForUser('Not logged in · Please run /login');
    assert.match(text, /^【CCST】Claude 订阅未登录/);
    assert.match(text, /原始错误：Not logged in/);
});

test('served-model guard ignores the CLI synthetic error message', () => {
    assert.doesNotThrow(() => assertServedModel('fable', '<synthetic>', 'claude-fable-5'));
    assert.doesNotThrow(() => assertServedModel('fable', 'claude-fable-5', 'claude-fable-5'));
    assert.doesNotThrow(() => assertServedModel('opus', 'claude-sonnet-4-6', 'claude-opus-5'));
    assert.throws(() => assertServedModel('fable', 'claude-opus-5', 'claude-fable-5'), /served-model guard/);
});

test('usage stats record metadata only and aggregate today / week', async () => {
    const { diagnoseCache, __resetCacheDiag } = await import('../src/proxy/cache-diag.js');
    __resetCacheDiag();
    // A real diagnosis whose change sits under a heading: the heading is prompt text.
    const sys = (x) => `${'规则'.repeat(900)}\n## 小美的秘密日记\n${x}`;
    diagnoseCache(sys('甲'), [{ role: 'assistant', content: 'mes 开场' }, { role: 'user', content: 'content 一' }]);
    const diag = diagnoseCache(sys('乙'), [{ role: 'assistant', content: 'mes 开场' }, { role: 'user', content: 'content 一' }, { role: 'assistant', content: '回' }, { role: 'user', content: '二' }]);
    assert.equal(diag.systemChanged, true);
    const dir = mkdtempSync(join(tmpdir(), 'cm-stats-'));
    process.env.CLAUDE_SUBSCRIPTION_STATS_FILE = join(dir, 'usage.jsonl');
    const stats = await import('../src/proxy/usage-stats.js');
    stats.__resetStatsForTesting();
    const log = console.log;
    console.log = () => {};
    try {
        const t0 = Date.now() - 10000;
        stats.recordRequest({
            model: 'claude-opus-5', path: 'resume', stream: true, startedAt: t0, firstTokenAt: t0 + 2000, cacheDiag: diag,
            usage: { input_tokens: 100, output_tokens: 900, cache_read_input_tokens: 800, cache_creation_input_tokens: 100 },
            textChars: 3000, reasoningChars: 50, finish: 'stop',
        });
        stats.recordRequest({ model: 'claude-fable-5', path: 'resume', stream: true, startedAt: t0, textChars: 0, reasoningChars: 0, error: 'Not logged in' });
        // A background call (another extension's image-tag request) after the reply.
        stats.recordRequest({ model: 'claude-haiku-4-5', path: 'resume', stream: false, startedAt: t0, auxiliary: true, purpose: 'quiet',
            usage: { input_tokens: 5, output_tokens: 40 }, textChars: 80, reasoningChars: 0 });
    } finally {
        console.log = log;
    }
    const s = stats.summarizeStats();
    assert.equal(s.today.requests, 2);
    assert.equal(s.today.failed, 1);
    assert.equal(s.today.outputTokens, 900);
    assert.equal(s.today.cacheHitRate, 0.8);
    assert.equal(s.lastError.code, 'not_logged_in');
    assert.equal(s.background.today.requests, 1, 'background calls counted apart');
    assert.equal(s.lastRequest.model, 'claude-fable-5', 'the last-turn card ignores background calls');
    const file = readFileSync(process.env.CLAUDE_SUBSCRIPTION_STATS_FILE, 'utf8');
    assert.equal(file.trim().split('\n').length, 3);
    assert.ok(!/mes|content|秘密日记|小美|规则|开场/.test(file), 'no message or prompt text persisted, cache diagnosis included');
    assert.match(file, /"cacheDiag":\{/);
    delete process.env.CLAUDE_SUBSCRIPTION_STATS_FILE;
});

test('Opus 5.5 safeguard refusals are recognized', () => {
    const raw = "API Error: Opus 5.5 (1M context)'s safeguards flagged this message (https://www.anthropic.com/legal/aup). Details: `[reasoning_extraction]` Request ID: req_x";
    assert.equal(explainError(raw).code, 'reasoning_extraction');
    assert.equal(explainError("safeguards flagged this message Details: `[cyber]`").code, 'safeguards');
});

test('promptShape run-length encodes roles without content', async () => {
    const { promptShape } = await import('../src/proxy/usage-stats.js');
    const S = { role: 'system', content: 'x' }, U = { role: 'user', content: 'y' }, A = { role: 'assistant', content: 'z' };
    assert.equal(promptShape([S, S, S, A, S, U, A, U]), 'S3 A1 S1 U1 A1 U1');
});

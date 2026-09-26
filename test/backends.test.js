import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, statSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { mapModelId, bedrockPrefix, estimateCostUsd, priceFor, isApiBilled } from '../src/shared/backends.js';
import { resolveBackendConfig, missingFields, backendEnv, publicView, applyUpdate, isValidBaseUrl, handleBackendPost, __resetBackendCache } from '../src/proxy/backend-config.js';
import { buildSubprocessEnv } from '../src/proxy/env.js';
import { withBackendModels } from '../src/proxy/chat.js';
import { parseModelRequest } from '../src/proxy/models.js';

const cfg = (backend, fields = {}) => resolveBackendConfig({ env: {}, file: { backend, ...fields } });

test('model ids per backend follow the bundled CLI table', () => {
    assert.equal(mapModelId('bedrock', 'claude-opus-5', { region: 'us-east-1' }), 'us.anthropic.claude-opus-5');
    assert.equal(mapModelId('bedrock', 'claude-opus-4-6', { region: 'eu-central-1' }), 'eu.anthropic.claude-opus-4-6-v1');
    assert.equal(mapModelId('bedrock', 'claude-haiku-4-5', { region: 'ap-northeast-1' }), 'apac.anthropic.claude-haiku-4-5-20251001-v1:0');
    assert.equal(mapModelId('bedrock', 'claude-sonnet-5', { region: 'us-west-2', prefix: 'global' }), 'global.anthropic.claude-sonnet-5');
    assert.equal(mapModelId('bedrock', 'claude-mythos-5-1'), null);
    assert.equal(mapModelId('vertex', 'claude-opus-4-5'), 'claude-opus-4-5@20251101');
    assert.equal(mapModelId('vertex', 'claude-fable-5-1'), 'claude-fable-5-1');
    assert.equal(mapModelId('openrouter', 'claude-opus-4-6'), 'anthropic/claude-opus-4.6');
    assert.equal(mapModelId('openrouter', 'claude-opus-5'), 'anthropic/claude-opus-5');
    assert.equal(mapModelId('gateway', 'claude-opus-5'), 'claude-opus-5');
    assert.equal(bedrockPrefix('ca-central-1'), 'us');
});

test('a Bedrock request pins every tier to Bedrock ids and keeps the first-party id for the cache layout', () => {
    const info = withBackendModels(parseModelRequest('claude-opus-4-8[1m]'), cfg('bedrock', { bedrock: { region: 'us-east-1' } }));
    assert.equal(info.baseId, 'claude-opus-4-8');
    assert.equal(info.callModel, 'us.anthropic.claude-opus-4-8');
    assert.equal(info.sdkModel, 'opus[1m]');
    assert.equal(info.envPins.ANTHROPIC_DEFAULT_OPUS_MODEL, 'us.anthropic.claude-opus-4-8');
    assert.equal(info.envPins.ANTHROPIC_DEFAULT_HAIKU_MODEL, 'us.anthropic.claude-haiku-4-5-20251001-v1:0');
    assert.equal(withBackendModels(parseModelRequest('claude-opus-5'), cfg('subscription')).callModel, undefined);
});

test('backend env: each credential goes only to its own variables', () => {
    const f = cfg('bedrock', { bedrock: { region: 'us-east-1', bearerToken: 'bedrock-tok' } }).fields;
    assert.deepEqual(backendEnv('bedrock', f).set, { CLAUDE_CODE_USE_BEDROCK: '1', AWS_REGION: 'us-east-1', AWS_BEARER_TOKEN_BEDROCK: 'bedrock-tok' });
    const v = cfg('vertex', { vertex: { projectId: 'p', region: 'global' } }).fields;
    assert.deepEqual(backendEnv('vertex', v).set, { CLAUDE_CODE_USE_VERTEX: '1', CLOUD_ML_REGION: 'global', ANTHROPIC_VERTEX_PROJECT_ID: 'p' });
    const o = cfg('openrouter', { openrouter: { authToken: 'sk-or-x' } }).fields;
    assert.deepEqual(backendEnv('openrouter', o).set, { ANTHROPIC_BASE_URL: 'https://openrouter.ai/api', ANTHROPIC_AUTH_TOKEN: 'sk-or-x', ANTHROPIC_API_KEY: '' });
});

test('buildSubprocessEnv: a stray shell provider switch or key never survives, the chosen backend adds only its own', () => {
    const saved = { ...process.env };
    process.env.CLAUDE_CODE_USE_VERTEX = '1';
    process.env.ANTHROPIC_API_KEY = 'sk-ant-stray';
    process.env.AWS_BEARER_TOKEN_BEDROCK = 'stray';
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'oauth-stray';
    try {
        const sub = buildSubprocessEnv({ envPins: {}, apiKey: null, backend: cfg('subscription') });
        assert.equal(sub.CLAUDE_CODE_USE_VERTEX, undefined);
        assert.equal(sub.ANTHROPIC_API_KEY, undefined);
        assert.equal(sub.AWS_BEARER_TOKEN_BEDROCK, undefined);
        const gw = buildSubprocessEnv({ envPins: {}, apiKey: null, backend: cfg('gateway', { gateway: { baseUrl: 'https://gw.example/', authToken: 'gw-tok' } }) });
        assert.equal(gw.ANTHROPIC_BASE_URL, 'https://gw.example');
        assert.equal(gw.ANTHROPIC_AUTH_TOKEN, 'gw-tok');
        assert.equal(gw.ANTHROPIC_API_KEY, '');
        assert.equal(gw.CLAUDE_CODE_OAUTH_TOKEN, undefined, 'the claude.ai token never reaches a gateway');
        assert.equal(gw.CLAUDE_CODE_USE_VERTEX, undefined);
        assert.equal(gw.CLAUDE_CODE_DISABLE_REFUSAL_FALLBACK, '1', 'no refusal-based model fallback on any backend');
        const api = buildSubprocessEnv({ envPins: {}, apiKey: null, backend: cfg('apikey', { apikey: { apiKey: 'sk-ant-file' } }) });
        assert.equal(api.ANTHROPIC_API_KEY, 'sk-ant-file');
        assert.equal(api.ANTHROPIC_BASE_URL, undefined);
    } finally {
        for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
        Object.assign(process.env, saved);
    }
});

test('env vars override the file; missing fields block a switch', () => {
    const c = resolveBackendConfig({ env: { CLAUDE_SUBSCRIPTION_BACKEND: 'vertex', CLAUDE_SUBSCRIPTION_VERTEX_PROJECT: 'envp' }, file: { backend: 'apikey', vertex: { projectId: 'filep', region: 'global' } } });
    assert.equal(c.backend, 'vertex');
    assert.equal(c.source, 'env');
    assert.equal(c.fields.vertex.projectId, 'envp');
    assert.deepEqual(missingFields('vertex', c.fields), []);
    assert.deepEqual(missingFields('apikey', cfg('apikey', { apikey: { apiKey: 'nope' } }).fields), ['apikey.apiKey']);
    assert.ok(missingFields('gateway', cfg('gateway', { gateway: { baseUrl: 'http://evil.example', authToken: 't' } }).fields).includes('gateway.baseUrl'));
    assert.equal(isValidBaseUrl('http://127.0.0.1:4000'), true);
    assert.equal(resolveBackendConfig({ env: {}, file: {} }).backend, 'subscription');
});

test('the public view never carries a secret value', () => {
    const view = publicView(cfg('bedrock', { bedrock: { region: 'us-east-1', bearerToken: 'SECRET-1', secretAccessKey: 'SECRET-2', accessKeyId: 'SECRET-3' }, apikey: { apiKey: 'sk-ant-SECRET-4' } }));
    const text = JSON.stringify(view);
    for (const s of ['SECRET-1', 'SECRET-2', 'SECRET-3', 'SECRET-4']) assert.ok(!text.includes(s), s);
    assert.deepEqual(view.fields.bedrock.bearerToken, { set: true });
    assert.deepEqual(view.fields.bedrock.region, { value: 'us-east-1' });
    assert.equal(view.apiBilled, true);
});

test('applyUpdate: an empty secret keeps the stored one, clear removes it, unknown keys are ignored', () => {
    const cur = { backend: 'bedrock', bedrock: { region: 'us-east-1', bearerToken: 'keep' } };
    const { next } = applyUpdate(cur, { backend: 'bedrock', fields: { bedrock: { bearerToken: '', region: 'eu-west-1', evil: 'x' }, __proto__: { a: 1 } } });
    assert.equal(next.bedrock.bearerToken, 'keep');
    assert.equal(next.bedrock.region, 'eu-west-1');
    assert.equal(next.bedrock.evil, undefined);
    assert.equal(applyUpdate(next, { clear: ['bedrock.bearerToken'] }).next.bedrock.bearerToken, undefined);
    assert.ok(applyUpdate(cur, { backend: 'nope' }).error);
});

test('POST /v1/backend stores the file 0600, refuses an incomplete backend, answers without secrets', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ccst-backend-'));
    const file = join(dir, 'backend.json');
    const savedFile = process.env.CLAUDE_SUBSCRIPTION_BACKEND_FILE;
    const savedB = process.env.CLAUDE_SUBSCRIPTION_BACKEND;
    process.env.CLAUDE_SUBSCRIPTION_BACKEND_FILE = file;
    delete process.env.CLAUDE_SUBSCRIPTION_BACKEND;
    __resetBackendCache();
    const call = (body) => {
        let status = 200; let out = null;
        const res = { status(c) { status = c; return this; }, json(o) { out = o; return this; } };
        const log = console.log; console.log = () => {};
        try { handleBackendPost({ body }, res); } finally { console.log = log; }
        return { status, out };
    };
    try {
        const bad = call({ backend: 'openrouter' });
        assert.equal(bad.status, 400);
        assert.equal(existsSync(file), false);
        const ok = call({ backend: 'openrouter', fields: { openrouter: { authToken: 'sk-or-SECRET' } } });
        assert.equal(ok.status, 200);
        assert.ok(!JSON.stringify(ok.out).includes('sk-or-SECRET'));
        assert.equal(statSync(file).mode & 0o777, 0o600);
        assert.equal(JSON.parse(readFileSync(file, 'utf8')).openrouter.authToken, 'sk-or-SECRET');
        assert.equal(resolveBackendConfig().backend, 'openrouter');
    } finally {
        if (savedFile === undefined) delete process.env.CLAUDE_SUBSCRIPTION_BACKEND_FILE; else process.env.CLAUDE_SUBSCRIPTION_BACKEND_FILE = savedFile;
        if (savedB !== undefined) process.env.CLAUDE_SUBSCRIPTION_BACKEND = savedB;
        __resetBackendCache();
    }
});

test('estimated cost: token counts × list price, none on the subscription', () => {
    const e = { model: 'claude-opus-5[1m]', inputTokens: 1_000_000, outputTokens: 100_000, cacheReadTokens: 1_000_000, cacheCreationTokens: 100_000 };
    // 5 + 2.5 + 0.5 + 0.1M × 5 × 1.25 = 0.625
    assert.equal(estimateCostUsd(e, 'bedrock'), 8.625);
    assert.equal(estimateCostUsd(e, 'apikey', { cacheTtl: '1h' }), 9);
    assert.equal(estimateCostUsd(e, 'subscription'), null);
    assert.equal(estimateCostUsd({ ...e, model: 'mystery' }, 'apikey'), null);
    assert.equal(priceFor('claude-opus-5-5').cacheRead, 0.2);
    assert.equal(isApiBilled('subscription'), false);
});

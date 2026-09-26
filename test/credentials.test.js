import test from 'node:test';
import assert from 'node:assert/strict';

import { loadCredentials } from '../src/proxy/oauth.js';

const FILE_CREDS = { claudeAiOauth: { accessToken: 'file-token', refreshToken: 'r' } };
const KEYCHAIN_CREDS = { claudeAiOauth: { accessToken: 'kc-token', subscriptionType: 'max' } };

const noFile = () => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); };
const noKeychain = () => { throw new Error('item not found'); };

test('CLAUDE_CODE_OAUTH_TOKEN wins over every other source', () => {
    const { source, creds } = loadCredentials({
        env: { CLAUDE_CODE_OAUTH_TOKEN: ' env-token ' },
        platform: 'darwin',
        readFile: () => JSON.stringify(FILE_CREDS),
        exec: () => JSON.stringify(KEYCHAIN_CREDS),
    });
    assert.equal(source, 'env');
    assert.equal(creds.claudeAiOauth.accessToken, 'env-token');
});

test('credentials file is used before the keychain', () => {
    const { source, creds } = loadCredentials({
        env: {},
        platform: 'darwin',
        readFile: () => JSON.stringify(FILE_CREDS),
        exec: () => { throw new Error('keychain should not be read'); },
    });
    assert.equal(source, 'file');
    assert.equal(creds.claudeAiOauth.accessToken, 'file-token');
});

test('macOS falls back to the "Claude Code-credentials" keychain item', () => {
    let called = null;
    const { source, creds } = loadCredentials({
        env: {},
        platform: 'darwin',
        readFile: noFile,
        exec: (cmd, args) => { called = [cmd, ...args]; return JSON.stringify(KEYCHAIN_CREDS) + '\n'; },
    });
    assert.equal(source, 'keychain');
    assert.equal(creds.claudeAiOauth.accessToken, 'kc-token');
    assert.deepEqual(called, ['security', 'find-generic-password', '-s', 'Claude Code-credentials', '-w']);
});

test('keychain is never consulted off macOS', () => {
    const { source, creds } = loadCredentials({
        env: {},
        platform: 'linux',
        readFile: noFile,
        exec: () => { throw new Error('keychain should not be read'); },
    });
    assert.equal(source, null);
    assert.equal(creds, null);
});

test('no credentials anywhere → null source', () => {
    const { source, creds } = loadCredentials({ env: {}, platform: 'darwin', readFile: noFile, exec: noKeychain });
    assert.equal(source, null);
    assert.equal(creds, null);
});

import { mkdtempSync, writeFileSync, statSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fetchQuota, loadCredentialsCached, __resetCredentialCache } from '../src/proxy/oauth.js';

test('"no credentials" is cached briefly (the keychain lookup blocks); file results never are', () => {
    __resetCredentialCache();
    let calls = 0;
    const none = () => { calls++; return { source: null, creds: null }; };
    loadCredentialsCached(none, 1000);
    loadCredentialsCached(none, 20000);
    assert.equal(calls, 1);
    loadCredentialsCached(none, 40000); // past the 30 s TTL
    assert.equal(calls, 2);
    __resetCredentialCache();
    let fileCalls = 0;
    const file = () => { fileCalls++; return { source: 'file', creds: {} }; };
    loadCredentialsCached(file, 1000);
    loadCredentialsCached(file, 1001);
    assert.equal(fileCalls, 2);
    __resetCredentialCache();
});

test('quota: a persistent 401 refreshes once and retries once — no loop; the new file is 0600', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cm-cred-'));
    const file = join(dir, '.credentials.json');
    writeFileSync(file, JSON.stringify({ claudeAiOauth: { accessToken: 'old', refreshToken: 'r1' } }));
    const saved = { cfg: process.env.CLAUDE_CONFIG_DIR, tok: process.env.CLAUDE_CODE_OAUTH_TOKEN, fetch: globalThis.fetch, log: console.log, warn: console.warn };
    process.env.CLAUDE_CONFIG_DIR = dir;
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    __resetCredentialCache();
    const calls = { usage: 0, token: 0 };
    globalThis.fetch = async (url) => {
        if (String(url).includes('/oauth/usage')) { calls.usage++; return new Response('{}', { status: 401 }); }
        calls.token++;
        return new Response(JSON.stringify({ access_token: 'new', refresh_token: 'r2', expires_in: 3600 }), { status: 200 });
    };
    console.log = () => {}; console.warn = () => {};
    try {
        assert.equal(await fetchQuota({ force: true }), null);
        assert.deepEqual(calls, { usage: 2, token: 1 });
        assert.equal(JSON.parse(readFileSync(file, 'utf8')).claudeAiOauth.refreshToken, 'r2');
        assert.equal(statSync(file).mode & 0o777, 0o600);
    } finally {
        globalThis.fetch = saved.fetch; console.log = saved.log; console.warn = saved.warn;
        if (saved.cfg === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = saved.cfg;
        if (saved.tok !== undefined) process.env.CLAUDE_CODE_OAUTH_TOKEN = saved.tok;
        __resetCredentialCache();
    }
});

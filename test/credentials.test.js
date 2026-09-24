import test from 'node:test';
import assert from 'node:assert/strict';

import { loadCredentials } from '../lib/oauth.js';

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

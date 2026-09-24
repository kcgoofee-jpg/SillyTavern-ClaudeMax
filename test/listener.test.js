import test from 'node:test';
import assert from 'node:assert/strict';

import { isAllowedOrigin } from '../lib/listener.js';

test('loopback origins are allowed (SillyTavern in a local browser)', () => {
    for (const o of ['http://127.0.0.1:8000', 'http://localhost:8000', 'https://localhost', 'http://[::1]:8000']) {
        assert.equal(isAllowedOrigin(o), true, o);
    }
});

test('TauriTavern WebView origins are allowed', () => {
    for (const o of ['tauri://localhost', 'http://tauri.localhost', 'https://tauri.localhost']) {
        assert.equal(isAllowedOrigin(o), true, o);
    }
});

test('other origins are rejected', () => {
    for (const o of [undefined, '', 'null', 'https://evil.com', 'http://localhost.evil.com', 'tauri://evil', 'http://tauri.localhost.evil.com']) {
        assert.equal(isAllowedOrigin(o), false, String(o));
    }
});

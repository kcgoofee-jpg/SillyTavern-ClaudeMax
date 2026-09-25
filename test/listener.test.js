import test from 'node:test';
import assert from 'node:assert/strict';

import { isAllowedOrigin, isAllowedHost } from '../lib/listener.js';

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

test('host guard: loopback names pass, rebinding names do not', () => {
    for (const h of ['127.0.0.1:8901', 'localhost:8901', '[::1]:8901', 'tauri.localhost', undefined]) {
        assert.equal(isAllowedHost(h, '127.0.0.1', ''), true, String(h));
    }
    for (const h of ['evil.example.com:8901', 'attacker.test', '192.168.1.5:8901']) {
        assert.equal(isAllowedHost(h, '127.0.0.1', ''), false, h);
    }
});

test('host guard: LAN binding accepts IP literals; extra names are opt-in', () => {
    assert.equal(isAllowedHost('192.168.1.5:8901', '0.0.0.0', ''), true);
    assert.equal(isAllowedHost('mac.local:8901', '0.0.0.0', ''), false);
    assert.equal(isAllowedHost('mac.local:8901', '0.0.0.0', 'mac.local, other'), true);
    assert.equal(isAllowedHost('myhost:8901', 'myhost', ''), true);
});

import { isLoopbackAddress, keyMatches } from '../lib/listener.js';

test('LAN access: loopback needs no key, others must match it exactly', () => {
    assert.equal(isLoopbackAddress('127.0.0.1'), true);
    assert.equal(isLoopbackAddress('::1'), true);
    assert.equal(isLoopbackAddress('::ffff:127.0.0.1'), true);
    assert.equal(isLoopbackAddress('192.168.31.20'), false);
    assert.equal(isLoopbackAddress('::ffff:192.168.31.20'), false);
    assert.equal(keyMatches('abc', 'abc'), true);
    assert.equal(keyMatches('abd', 'abc'), false);
    assert.equal(keyMatches('abc', ''), false);
    assert.equal(keyMatches(null, 'abc'), false);
});

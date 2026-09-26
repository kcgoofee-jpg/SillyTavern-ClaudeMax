import test from 'node:test';
import assert from 'node:assert/strict';

import { isLocalHost, isLoopbackUrl, cloudNeedsNote } from '../src/shared/host.js';

test('loopback, LAN and local names count as local', () => {
    for (const h of ['localhost', '127.0.0.1', '[::1]', '::1', '192.168.1.5', '10.0.0.2', '172.20.3.4',
        'macbook.local', 'tauri.localhost', '100.100.1.2', 'fd12:3456::1', 'fe80::1', '::ffff:192.168.0.9', '']) {
        assert.equal(isLocalHost(h), true, h);
    }
});

test('public hosts count as remote', () => {
    for (const h of ['st.example.com', '8.8.8.8', '172.32.0.1', '100.128.0.1', '2001:db8::1', '::ffff:8.8.8.8']) {
        assert.equal(isLocalHost(h), false, h);
    }
});

test('loopback endpoint detection', () => {
    assert.equal(isLoopbackUrl('http://127.0.0.1:8901/v1'), true);
    assert.equal(isLoopbackUrl('http://localhost:8901/v1'), true);
    assert.equal(isLoopbackUrl('http://192.168.1.5:8901/v1'), false);
    assert.equal(isLoopbackUrl('https://my-tunnel.example.com/v1'), false);
    assert.equal(isLoopbackUrl('not a url'), false);
});

test('cloud note only for a remote page with a loopback endpoint, never in TauriTavern', () => {
    const endpoint = 'http://127.0.0.1:8901/v1';
    assert.equal(cloudNeedsNote({ hostname: 'st.example.com', endpoint }), true);
    assert.equal(cloudNeedsNote({ hostname: '127.0.0.1', endpoint }), false);
    assert.equal(cloudNeedsNote({ hostname: '192.168.1.5', endpoint }), false);
    assert.equal(cloudNeedsNote({ hostname: 'st.example.com', endpoint: 'https://tunnel.example.com/v1' }), false);
    assert.equal(cloudNeedsNote({ hostname: 'st.example.com', endpoint, tauri: true }), false);
});

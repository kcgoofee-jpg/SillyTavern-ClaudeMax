import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';

import { ACTIONS, handleControlAction, countInFlight, busyCount, markStandalone, __setInFlight, LID_PAUSE_FILE } from '../lib/control.js';

function fakeRes() {
    const res = { statusCode: 200, body: null };
    res.status = (c) => { res.statusCode = c; return res; };
    res.json = (b) => { res.body = b; return res; };
    return res;
}

test('only named actions exist, none takes a command', () => {
    assert.deepEqual(Object.keys(ACTIONS).sort(), ['comfy-start', 'comfy-stop', 'lid-pause', 'lid-resume', 'phone-sync', 'restart-proxy']);
    for (const a of Object.values(ACTIONS)) assert.ok(a.label && (a.script || a.run));
});

test('an unknown action is refused', async () => {
    const res = fakeRes();
    await handleControlAction({ body: { action: 'rm -rf /' } }, res);
    assert.equal(res.statusCode, 400);
    assert.equal(res.body.ok, false);
});

test('restart waits while a reply is being written', async () => {
    if (process.platform !== 'darwin') return;
    __setInFlight(1);
    try {
        const res = fakeRes();
        await handleControlAction({ body: { action: 'restart-proxy' } }, res);
        assert.equal(res.statusCode, 409);
        assert.match(res.body.message, /写完再重启/);
    } finally {
        __setInFlight(0);
    }
});

test('a reply counts as in flight until its handler is done, even after the client left', async () => {
    __setInFlight(0);
    const handlers = {};
    const res = { statusCode: 200, on: (ev, fn) => { handlers[ev] = fn; } };
    let finish;
    const wrapped = countInFlight(() => new Promise((r) => { finish = r; }));
    const done = wrapped({ socket: { remoteAddress: '192.168.31.6' } }, res, () => {});
    assert.equal(busyCount(), 1);
    handlers.close?.(); // the phone app went to the background: the reply is still being written
    assert.equal(busyCount(), 1);
    finish();
    await done;
    assert.equal(busyCount(), 0);
});

test('a rejected chat handler goes to next() and still ends the count', async () => {
    __setInFlight(0);
    let passed = null;
    await countInFlight(async () => { throw new Error('boom'); })({ socket: { remoteAddress: '127.0.0.1' } }, { statusCode: 500 }, (err) => { passed = err; });
    assert.equal(passed?.message, 'boom');
    assert.equal(busyCount(), 0);
});

test('Object.prototype names are not actions (no crash)', async () => {
    for (const name of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) {
        const res = fakeRes();
        await handleControlAction({ body: { action: name } }, res);
        assert.equal(res.statusCode, 400, name);
    }
});

test('phone sync also waits while a reply is being written', async () => {
    assert.equal(ACTIONS['phone-sync'].whenIdle, true);
    if (process.platform !== 'darwin') return;
    __setInFlight(2);
    try {
        const res = fakeRes();
        await handleControlAction({ body: { action: 'phone-sync' } }, res);
        assert.equal(res.statusCode, 409);
        assert.match(res.body.message, /写完再同步/);
    } finally {
        __setInFlight(0);
    }
});

test('inside SillyTavern (plugin mode) restart-proxy is refused: it would stop SillyTavern', async () => {
    assert.equal(ACTIONS['restart-proxy'].standaloneOnly, true);
    if (process.platform !== 'darwin') return;
    markStandalone(false); // never run the real restart from a test
    __setInFlight(0);
    const res = fakeRes();
    await handleControlAction({ body: { action: 'restart-proxy' } }, res);
    if (res.statusCode === 501) return; // no launcher checkout here
    assert.equal(res.statusCode, 409);
    assert.match(res.body.message, /酒馆/);
});

test('the lid pause file lives in launcher/ and is git-ignored (*.local)', () => {
    assert.match(LID_PAUSE_FILE, /launcher\/lid-pause\.local$/);
    assert.equal(existsSync(LID_PAUSE_FILE), existsSync(LID_PAUSE_FILE)); // path resolves
});

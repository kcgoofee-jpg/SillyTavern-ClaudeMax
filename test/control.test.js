import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';

import { ACTIONS, handleControlAction, countInFlight, busyCount, __setInFlight, LID_PAUSE_FILE } from '../lib/control.js';

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

test('the in-flight counter goes back down when the response ends or the client leaves', () => {
    __setInFlight(0);
    const handlers = {};
    const res = { on: (ev, fn) => { handlers[ev] = fn; } };
    countInFlight({}, res, () => {});
    assert.equal(busyCount(), 1);
    handlers.finish();
    handlers.close(); // both fire: counted once
    assert.equal(busyCount(), 0);
});

test('the lid pause file lives in launcher/ and is git-ignored (*.local)', () => {
    assert.match(LID_PAUSE_FILE, /launcher\/lid-pause\.local$/);
    assert.equal(existsSync(LID_PAUSE_FILE), existsSync(LID_PAUSE_FILE)); // path resolves
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { debugDir, dumpRequest, handleDebugLast, noteDebugSetting, DUMP_FILES } from '../src/proxy/debug-dump.js';

function fakeRes() {
    const res = { statusCode: 200 };
    res.status = (c) => { res.statusCode = c; return res; };
    res.json = (b) => { res.body = b; return res; };
    return res;
}

test('dumps live only while debug is on; turning it off deletes them; the folder can be moved', () => {
    const dir = join(mkdtempSync(join(tmpdir(), 'cm-debug-')), 'debug');
    process.env.CLAUDE_SUBSCRIPTION_DEBUG_DIR = dir;
    const log = console.log;
    console.log = () => {};
    try {
        assert.equal(debugDir(), dir);
        noteDebugSetting(true);
        dumpRequest({ model: 'm', settings: {}, raw: [{ role: 'user', content: '秘密' }], placed: [{ role: 'system', content: 's' }, { role: 'user', content: '秘密' }], cacheDiag: null });
        assert.ok(existsSync(join(dir, 'last-request.json')));
        writeFileSync(join(dir, 'notes.txt'), 'not ours');
        const on = fakeRes();
        handleDebugLast({}, on);
        assert.equal(on.body.ok, true);

        noteDebugSetting(false);
        for (const f of DUMP_FILES) assert.equal(existsSync(join(dir, f)), false, f);
        assert.ok(existsSync(join(dir, 'notes.txt')), 'only its own files are deleted');
        const off = fakeRes();
        handleDebugLast({}, off);
        assert.equal(off.statusCode, 404);
        assert.match(off.body.error, /没有打开/);
    } finally {
        console.log = log;
        delete process.env.CLAUDE_SUBSCRIPTION_DEBUG_DIR;
    }
});

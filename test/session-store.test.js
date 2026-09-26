import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { sweepLeftovers, projectKeyFor, sweepSessionTranscript, flushSweeps } from '../src/proxy/session-store.js';

const UUID = (n) => `${String(n).repeat(8)}-1111-4111-8111-${String(n).repeat(12)}`;
const age = (p, ms) => { const t = (Date.now() - ms) / 1000; utimesSync(p, t, t); };

test('start-up sweep: old transcripts of the scratch project and our stale SDK temp dirs only', () => {
    const root = mkdtempSync(join(tmpdir(), 'cm-sweep-'));
    const scratch = join(root, 'scratch');
    mkdirSync(scratch);
    const key = projectKeyFor(scratch);
    const config = join(root, 'config');
    const project = join(config, 'projects', key);
    mkdirSync(project, { recursive: true });
    const oldT = join(project, `${UUID(1)}.jsonl`);
    const newT = join(project, `${UUID(2)}.jsonl`);
    const other = join(project, 'README');
    for (const f of [oldT, newT, other]) writeFileSync(f, 'x');
    age(oldT, 3600e3); age(other, 3600e3);

    const tmp = join(root, 'tmp');
    const ours = join(tmp, `claude-resume-${UUID(3)}`);
    const theirs = join(tmp, `claude-resume-${UUID(4)}`);
    const fresh = join(tmp, `claude-resume-${UUID(5)}`);
    const unrelated = join(tmp, 'claude-resume-notauuid');
    mkdirSync(join(ours, 'projects', key), { recursive: true });
    mkdirSync(join(theirs, 'projects', '-Users-someone-else'), { recursive: true });
    mkdirSync(join(fresh, 'projects', key), { recursive: true });
    mkdirSync(unrelated, { recursive: true });
    for (const d of [ours, theirs, unrelated]) age(d, 3600e3);

    const removed = sweepLeftovers({ tmp, configDir: config, scratch });
    assert.deepEqual(removed, { transcripts: 1, tempDirs: 1 });
    assert.equal(existsSync(oldT), false);
    assert.ok(existsSync(newT), 'a recent transcript may belong to a running reply');
    assert.ok(existsSync(other));
    assert.equal(existsSync(ours), false);
    assert.ok(existsSync(theirs), 'another SDK app\'s session');
    assert.ok(existsSync(fresh));
    assert.ok(existsSync(unrelated));
});

test('flushSweeps runs the pending transcript deletions now (shutdown)', async () => {
    const deleted = [];
    const loadSdk = async () => ({ deleteSession: async (id) => { deleted.push(id); } });
    sweepSessionTranscript(loadSdk, 'sess-a');
    sweepSessionTranscript(loadSdk, 'sess-b');
    await flushSweeps();
    assert.deepEqual(deleted.sort(), ['sess-a', 'sess-b']);
    await flushSweeps(); // nothing left, no double delete
    assert.equal(deleted.length, 2);
});

import test from 'node:test';
import assert from 'node:assert/strict';

import { createTurnCollector, replayTurn, hasPinnedContext, pinnedContext, __resetTurnCaptures } from '../lib/turn-capture.js';
import { assembleEntries } from '../lib/jsonl-entries.js';

const meta = { sessionId: 's2', cwd: '/tmp/x', version: 'v', gitBranch: '', permissionMode: 'bypassPermissions' };
const cliEntries = [
    { type: 'queue-operation' },
    { type: 'user', uuid: 'u1', parentUuid: 'p', sessionId: 's1', message: { role: 'user', content: '去溪边' } },
    { type: 'attachment', uuid: 'a1', parentUuid: 'u1', sessionId: 's1', attachment: { type: 'environment' }, rendered: 'env' },
    { type: 'attachment', uuid: 'a2', parentUuid: 'a1', sessionId: 's1', attachment: { type: 'date' }, rendered: 'date' },
    { type: 'assistant', uuid: 'r1', parentUuid: 'a2', message: { content: [{ type: 'text', text: '好' }] } },
];

test('collector keeps the current user entry and its attachments, replay re-chains them', () => {
    __resetTurnCaptures();
    const c = createTurnCollector('去溪边');
    c.onAppend(cliEntries.slice(0, 3));      // arrives in several append() calls
    c.onAppend(cliEntries.slice(3));
    const r = replayTurn('去溪边', 'prev', meta);
    assert.deepEqual(r.map((e) => e.type), ['user', 'attachment', 'attachment']);
    assert.equal(r[0].parentUuid, 'prev');
    assert.equal(r[1].parentUuid, 'u1');
    assert.ok(r.every((e) => e.sessionId === 's2' && e.cwd === '/tmp/x'));
    assert.equal(replayTurn('别的话', null, meta), null);
});

test('assembleEntries splices replayed turns and chains the next entry after them', () => {
    __resetTurnCaptures();
    const c = createTurnCollector('去溪边');
    c.onAppend(cliEntries);
    const entries = assembleEntries(
        [{ role: 'assistant', content: '开场' }, { role: 'user', content: '去溪边' }, { role: 'assistant', content: '好' }],
        meta, 'm', { replay: replayTurn });
    assert.deepEqual(entries.map((e) => e.type), ['assistant', 'user', 'attachment', 'attachment', 'assistant']);
    assert.equal(entries[4].parentUuid, 'a2');
    // without replay: plain synthetic entries, unchanged behavior
    assert.deepEqual(assembleEntries([{ role: 'user', content: '去溪边' }], meta, 'm').map((e) => e.type), ['user']);
});

test('the CLI context is pinned after the first entry and replayed turns lose their own copy', () => {
    __resetTurnCaptures();
    const c = createTurnCollector('去溪边', '去溪边', 'opus[1m]');
    c.onAppend(cliEntries);
    assert.equal(hasPinnedContext('opus[1m]'), true);
    assert.equal(hasPinnedContext('sonnet'), false);
    const history = [{ role: 'assistant', content: '开场' }, { role: 'user', content: '去溪边' }, { role: 'assistant', content: '好' }];
    const entries = assembleEntries(history, meta, 'm', {
        replay: (t, p, m) => replayTurn(t, p, m, { userOnly: true }),
        pinned: (p, m) => pinnedContext('opus[1m]', p, m),
    });
    // greeting, pinned context, then the replayed user turn WITHOUT its attachments
    assert.deepEqual(entries.map((e) => e.type), ['assistant', 'attachment', 'attachment', 'user', 'assistant']);
    assert.equal(entries[1].parentUuid, entries[0].uuid);
    assert.equal(entries[3].parentUuid, 'a2');
    // the first pin sticks: a later turn's context does not replace it
    const c2 = createTurnCollector('再走', '再走', 'opus[1m]');
    c2.onAppend([{ type: 'user', uuid: 'u9', message: { role: 'user', content: '再走' } },
        { type: 'attachment', uuid: 'a9', attachment: { type: 'date', date: '明天' } }, { type: 'assistant' }]);
    assert.deepEqual(pinnedContext('opus[1m]', null, meta).map((e) => e.uuid), ['a1', 'a2']);
});

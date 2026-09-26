import test from 'node:test';
import assert from 'node:assert/strict';

import { randomUUID } from 'node:crypto';

import { createTurnCollector, replayTurn, hasPinnedContext, pinnedContext, historyReplay, replyBefore, repliesBefore, sentTextFor, __resetTurnCaptures } from '../src/proxy/turn-capture.js';
import { assembleEntries } from '../src/proxy/jsonl-entries.js';

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
    const c2 = createTurnCollector('去溪边', '去溪边', null, '开场'); // answers the greeting
    c2.onAppend(cliEntries);
    const entries = assembleEntries(
        [{ role: 'assistant', content: '开场' }, { role: 'user', content: '去溪边' }, { role: 'assistant', content: '好' }],
        meta, 'm', { replay: historyReplay(null).replay });
    assert.deepEqual(entries.map((e) => e.type), ['assistant', 'user', 'attachment', 'attachment', 'assistant']);
    assert.equal(entries[4].parentUuid, 'a2');
    // without replay: plain synthetic entries, unchanged behavior
    assert.deepEqual(assembleEntries([{ role: 'user', content: '去溪边' }], meta, 'm').map((e) => e.type), ['user']);
});

test('the CLI context is pinned after the first entry and replayed turns lose their own copy', () => {
    __resetTurnCaptures();
    const c = createTurnCollector('去溪边', '去溪边', 'opus[1m]', '开场');
    c.onAppend(cliEntries);
    assert.equal(hasPinnedContext('opus[1m]'), true);
    assert.equal(hasPinnedContext('sonnet'), false);
    const history = [{ role: 'assistant', content: '开场' }, { role: 'user', content: '去溪边' }, { role: 'assistant', content: '好' }];
    const { replay, pinned } = historyReplay('opus[1m]');
    const entries = assembleEntries(history, meta, 'm', { replay, pinned });
    // greeting, pinned context, then the replayed user turn WITHOUT its attachments
    assert.deepEqual(entries.map((e) => e.type), ['assistant', 'attachment', 'attachment', 'user', 'assistant']);
    assert.equal(entries[1].parentUuid, entries[0].uuid);
    assert.equal(entries[3].parentUuid, 'a2');
    // The first pin sticks: a later turn's context (the next day's date)
    // does not replace it — it stays with the turn it came with.
    const c2 = createTurnCollector('再走', '再走', 'opus[1m]', '好');
    c2.onAppend([{ type: 'user', uuid: 'u9', message: { role: 'user', content: '再走' } },
        { type: 'attachment', uuid: 'a9', attachment: { type: 'date', date: '明天' } }, { type: 'assistant' }]);
    assert.deepEqual(pinnedContext('opus[1m]', null, meta).map((e) => e.uuid), ['a1', 'a2']);
    assert.deepEqual(replayTurn('再走', null, meta, { pinOn: true, context: '好' }).map((e) => e.uuid), ['u9', 'a9']);
});

test('replyBefore / repliesBefore: the last non-blank assistant message before each index', () => {
    const list = [{ role: 'assistant', content: '开场' }, { role: 'user', content: 'a' }, { role: 'assistant', content: '  ' },
        { role: 'user', content: 'b' }, { role: 'assistant', content: [{ type: 'text', text: '回' }] }, { role: 'user', content: 'c' }];
    assert.deepEqual(repliesBefore(list), ['', '开场', '开场', '开场', '开场', '回']);
    assert.deepEqual(list.map((_, i) => replyBefore(list, i)), repliesBefore(list));
    assert.equal(replyBefore(list, list.length), '回');
});

// ── What the API sees, turn after turn ──
// A stand-in for the CLI: on a transcript without its context it adds the
// full context to the current message; with it, only a new date when the
// latest date in the transcript is not today (the real CLI: findLast of the
// date attachment vs today's local date).
const PIN = 'model-x';
function fakeCli(transcript, sentText, today) {
    const hasContext = transcript.some((e) => e.type === 'attachment' && e.attachment?.type === 'environment');
    const lastDate = transcript.filter((e) => e.type === 'attachment' && e.attachment?.type === 'date').at(-1)?.attachment.date;
    const user = { type: 'user', uuid: randomUUID(), message: { role: 'user', content: sentText } };
    const atts = !hasContext
        ? [{ type: 'environment' }, { type: 'model', id: PIN }, { type: 'date', date: today }]
        : lastDate !== today ? [{ type: 'date', date: today, changed: true }] : [];
    let parent = user.uuid;
    const out = [user, ...atts.map((attachment) => {
        const e = { type: 'attachment', uuid: randomUUID(), parentUuid: parent, attachment };
        parent = e.uuid;
        return e;
    })];
    return { added: [...out, { type: 'assistant', uuid: randomUUID(), parentUuid: parent }], sent: out };
}
// Only what reaches the model: role, text, attachment payload — no uuids.
const wire = (e) => JSON.stringify([e.type, e.message?.content ?? null, e.attachment ?? null]);

/** One request: returns the wire form of everything the CLI sends. */
function request(history, raw, sentText, today) {
    const { replay, pinned } = historyReplay(PIN);
    const entries = assembleEntries(history, meta, 'm', { replay, pinned });
    const { added, sent } = fakeCli(entries, sentText, today);
    createTurnCollector(sentText, raw, PIN, replyBefore(history, history.length)).onAppend(added);
    return [...entries.map(wire), ...sent.map(wire)];
}

/** Play a chat; returns each request's wire form. Each turn's player text is
 *  sent with this turn's lore on top (as lore-tail does) but comes back raw. */
function play(greeting, turns) {
    const history = [{ role: 'assistant', content: greeting }];
    const requests = [];
    turns.forEach(([raw, today], i) => {
        requests.push(request(history, raw, `<lore>${greeting}:${i}</lore>\n\n${raw}`, today));
        history.push({ role: 'user', content: raw }, { role: 'assistant', content: `${greeting} 回复 ${i}` });
    });
    return requests;
}

const isPrefix = (a, b) => a.length <= b.length && a.every((x, i) => x === b[i]);

function seedPin(date) {
    __resetTurnCaptures();
    play('seed', [['hi', date]]); // the first-ever request creates the pin
    assert.equal(hasPinnedContext(PIN), true);
}

test('repeating 「继续」 in one chat: every request starts with the whole previous one', () => {
    seedPin('2026-09-26');
    const reqs = play('开场A', [['继续', '2026-09-26'], ['继续', '2026-09-26'], ['继续', '2026-09-26'], ['去溪边', '2026-09-26']]);
    for (let i = 1; i < reqs.length; i++) assert.ok(isPrefix(reqs[i - 1], reqs[i]), `turn ${i + 1} re-sends turn ${i} unchanged`);
    // each 「继续」 kept its own lore
    const sent = reqs.at(-1).filter((w) => w.includes('继续'));
    assert.deepEqual(sent.map((w) => JSON.parse(w)[1].split('</lore>')[0]), ['<lore>开场A:0', '<lore>开场A:1', '<lore>开场A:2']);
});

test('the same text in another chat never picks up this chat\'s capture or lore', () => {
    seedPin('2026-09-26');
    play('开场A', [['继续', '2026-09-26'], ['再来', '2026-09-26']]);
    assert.match(sentTextFor('继续', '开场A'), /<lore>开场A:0/);
    assert.equal(sentTextFor('继续', '开场B'), null);
    assert.equal(replayTurn('继续', null, meta, { pinOn: true, context: '开场B' }), null);
    const reqs = play('开场B', [['继续', '2026-09-26'], ['再来', '2026-09-26']]);
    assert.ok(isPrefix(reqs[0], reqs[1]));
    assert.ok(!reqs.flat().some((w) => w.includes('开场A')), 'nothing from chat A in chat B');
});

test('across midnight: no turn re-sends the previous one differently, and the pin never changes', () => {
    seedPin('2026-09-26');
    const pinBefore = JSON.stringify(pinnedContext(PIN, null, meta).map((e) => e.attachment));
    const reqs = play('开场C', [['一', '2026-09-26'], ['二', '2026-09-26'], ['三', '2026-09-27'], ['四', '2026-09-27'], ['五', '2026-09-27'], ['六', '2026-09-28']]);
    for (let i = 1; i < reqs.length; i++) assert.ok(isPrefix(reqs[i - 1], reqs[i]), `turn ${i + 1} re-sends turn ${i} unchanged`);
    // the CLI announced each new day once, on that day's first message
    assert.equal(reqs.at(-1).filter((w) => w.includes('"changed":true')).length, 2);
    assert.equal(JSON.stringify(pinnedContext(PIN, null, meta).map((e) => e.attachment)), pinBefore);
});

test('a new chat on a later day than the pin stays stable too', () => {
    seedPin('2026-09-26');
    const reqs = play('开场D', [['一', '2026-10-01'], ['二', '2026-10-01'], ['三', '2026-10-01']]);
    for (let i = 1; i < reqs.length; i++) assert.ok(isPrefix(reqs[i - 1], reqs[i]), `turn ${i + 1}`);
});

test('without a pin (first ever request) the next turns settle after one structural change', () => {
    __resetTurnCaptures();
    const reqs = play('开场E', [['一', '2026-09-26'], ['二', '2026-09-26'], ['三', '2026-09-26'], ['四', '2026-09-27'], ['五', '2026-09-27']]);
    for (let i = 2; i < reqs.length; i++) assert.ok(isPrefix(reqs[i - 1], reqs[i]), `turn ${i + 1}`);
});

test('CLAUDE_SUBSCRIPTION_CONTEXT_PIN_FILE=off keeps the pin in memory only', async () => {
    const saved = process.env.CLAUDE_SUBSCRIPTION_CONTEXT_PIN_FILE;
    process.env.CLAUDE_SUBSCRIPTION_CONTEXT_PIN_FILE = 'off';
    try {
        const mod = await import(`../src/proxy/turn-capture.js?off=${Date.now()}`);
        const { existsSync } = await import('node:fs');
        mod.pinContext('m-off', [{ type: 'attachment', uuid: 'x', attachment: { type: 'date', date: 'd' } }]);
        assert.equal(mod.hasPinnedContext('m-off'), true);
        assert.equal(existsSync('off'), false);
    } finally {
        if (saved === undefined) delete process.env.CLAUDE_SUBSCRIPTION_CONTEXT_PIN_FILE; else process.env.CLAUDE_SUBSCRIPTION_CONTEXT_PIN_FILE = saved;
    }
});

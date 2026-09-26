import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Everything this file writes goes to a temp dir.
const TMP = mkdtempSync(join(tmpdir(), 'cm-chat-'));
process.env.CLAUDE_SUBSCRIPTION_STATS_FILE = join(TMP, 'usage.jsonl');
process.env.CLAUDE_SUBSCRIPTION_DEBUG_DIR = join(TMP, 'debug');
process.env.CLAUDE_SUBSCRIPTION_SCRATCH_CWD = join(TMP, 'scratch');

const { watchClient, maxTurnsFrom, statusForError, handleChatCompletions } = await import('../src/proxy/chat.js');
const { cancelReply, keptReply, __resetKeptReplies } = await import('../src/proxy/reply-keeper.js');
const { __setSdkForTesting } = await import('../src/proxy/sdk-loader.js');
const { startStandaloneListener, stopStandaloneListener } = await import('../src/proxy/listener.js');
const { busyCount } = await import('../src/proxy/control.js');
const { __resetTurnCaptures } = await import('../src/proxy/turn-capture.js');

const SLOT = 'abcdef0123456789';
const quiet = (fn) => async (...a) => {
    const { log, warn } = console;
    console.log = () => {}; console.warn = () => {};
    try { return await fn(...a); } finally { console.log = log; console.warn = warn; }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(cond, ms = 3000) {
    const end = Date.now() + ms;
    while (!cond()) {
        if (Date.now() > end) throw new Error('timed out');
        await sleep(10);
    }
}

function fakeRes() {
    const res = new EventEmitter();
    res.writableFinished = false;
    res.write = () => true;
    res.end = () => res;
    return res;
}

test('watchClient: a client leaving with a reply slot keeps the reply going', quiet(() => {
    const res = fakeRes();
    const conn = watchClient(res, { keep: true, slot: SLOT });
    conn.controller = new AbortController();
    res.emit('close');
    assert.equal(conn.gone, true);
    assert.equal(conn.aborted, false);
    assert.equal(conn.controller.signal.aborted, false);
    conn.dispose();
}));

test('watchClient: without a slot the CLI is stopped; a finished response is not a disconnect', quiet(() => {
    const res = fakeRes();
    const conn = watchClient(res, { keep: false, slot: null });
    conn.controller = new AbortController();
    res.emit('close');
    assert.equal(conn.aborted, true);
    assert.equal(conn.controller.signal.aborted, true);
    const done = fakeRes();
    done.writableFinished = true;
    const c2 = watchClient(done, { keep: false, slot: null });
    done.emit('close');
    assert.equal(c2.aborted, false);
}));

test('watchClient: the panel\'s Stop cancels by slot, even while the client is still there', quiet(() => {
    const res = fakeRes();
    const conn = watchClient(res, { keep: true, slot: SLOT });
    conn.controller = new AbortController();
    assert.equal(cancelReply(SLOT), true);
    assert.equal(conn.cancelled, true);
    assert.equal(conn.controller.signal.aborted, true);
    conn.dispose();
    assert.equal(cancelReply(SLOT), false, 'unregistered after the request');
}));

test('MAX_TURNS is clamped to a whole number from 1 to 20', () => {
    assert.equal(maxTurnsFrom(undefined), 1);
    assert.equal(maxTurnsFrom('abc'), 1);
    assert.equal(maxTurnsFrom('-3'), 1);
    assert.equal(maxTurnsFrom('0'), 1);
    assert.equal(maxTurnsFrom('3.7'), 3);
    assert.equal(maxTurnsFrom('999'), 20);
});

test('upstream errors map to 429 / 401, the rest to 500', () => {
    assert.equal(statusForError('Claude AI usage limit reached|1790000000'), 429);
    assert.equal(statusForError('Not logged in · Please run /login'), 401);
    assert.equal(statusForError('something odd'), 500);
});

test('a null message entry is a 400, not a crash', async () => {
    const res = { statusCode: 200 };
    res.status = (c) => { res.statusCode = c; return res; };
    res.json = (b) => { res.body = b; return res; };
    await handleChatCompletions({ body: { model: 'claude-opus-5', messages: [null] } }, res);
    assert.equal(res.statusCode, 400);
});

// ── End to end over a real listener, with a fake SDK ──

let queries = [];
function fakeSdk({ parts = 8, delay = 25 } = {}) {
    return {
        query({ options }) {
            const q = { aborted: false, finished: false };
            queries.push(q);
            const signal = options.abortController.signal;
            signal.addEventListener('abort', () => { q.aborted = true; });
            return (async function* run() {
                yield { type: 'system', subtype: 'init', model: 'claude-opus-5', session_id: `s${queries.length}` };
                yield { type: 'stream_event', parent_tool_use_id: null, event: { type: 'message_start', message: { usage: { input_tokens: 7, cache_read_input_tokens: 100 } } } };
                for (let i = 0; i < parts; i++) {
                    await sleep(delay);
                    if (signal.aborted) throw new Error('aborted by user');
                    yield { type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_delta', delta: { type: 'text_delta', text: `第${i}段。` } } };
                    yield { type: 'stream_event', parent_tool_use_id: null, event: { type: 'message_delta', usage: { output_tokens: i + 1 } } };
                }
                q.finished = true;
                yield { type: 'result', subtype: 'success', usage: { input_tokens: 7, output_tokens: parts, cache_read_input_tokens: 100 }, stop_reason: 'end_turn' };
            })();
        },
    };
}

let base = null;
test('listener up', async () => {
    const server = await startStandaloneListener({ port: 0, host: '127.0.0.1' });
    base = `http://127.0.0.1:${server.address().port}`;
});

const chatBody = (extra = {}) => JSON.stringify({
    model: 'claude-opus-5', stream: true,
    messages: [{ role: 'user', content: '去溪边' }],
    claude_subscription: { effort: 'low', ...extra },
});

/** Start a streamed chat, read the first chunk, then drop the connection. */
async function startAndLeave(extra) {
    const ac = new AbortController();
    const res = await fetch(`${base}/v1/chat/completions`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: chatBody(extra), signal: ac.signal });
    const reader = res.body.getReader();
    await reader.read();
    ac.abort();
    await reader.read().catch(() => {});
}

test('client leaves, no slot: the CLI is stopped and the stats say client_closed', quiet(async () => {
    __setSdkForTesting(fakeSdk());
    queries = [];
    await startAndLeave({});
    await until(() => busyCount() === 0);
    assert.equal(queries[0].aborted, true);
    assert.equal(queries[0].finished, false);
    const last = readFileSync(process.env.CLAUDE_SUBSCRIPTION_STATS_FILE, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).at(-1);
    assert.equal(last.finish, 'client_closed');
    assert.equal(last.outputTokens > 0, true, 'usage from the stream events is kept');
}));

test('client leaves with a reply slot: the reply is finished, kept, and counted busy until then', quiet(async () => {
    __setSdkForTesting(fakeSdk());
    __resetKeptReplies();
    queries = [];
    await startAndLeave({ reply_slot: SLOT });
    assert.equal(busyCount(), 1, 'still writing after the client left');
    await until(() => busyCount() === 0);
    assert.equal(queries[0].aborted, false);
    assert.equal(queries[0].finished, true);
    assert.match(keptReply(SLOT)?.text ?? '', /第7段。$/);
    const last = readFileSync(process.env.CLAUDE_SUBSCRIPTION_STATS_FILE, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).at(-1);
    assert.deepEqual(last.notices, ['kept']);
}));

test('POST /v1/replies/:slot/cancel stops the kept-going reply and nothing is kept', quiet(async () => {
    __setSdkForTesting(fakeSdk({ parts: 40 }));
    __resetKeptReplies();
    queries = [];
    await startAndLeave({ reply_slot: SLOT });
    const r = await fetch(`${base}/v1/replies/${SLOT}/cancel`, { method: 'POST', headers: { Origin: 'http://127.0.0.1:8000' } });
    assert.deepEqual(await r.json(), { ok: true, cancelled: true });
    assert.equal(r.headers.get('access-control-allow-origin'), 'http://127.0.0.1:8000');
    await until(() => busyCount() === 0);
    assert.equal(queries[0].aborted, true);
    assert.equal(keptReply(SLOT), null);
    const again = await fetch(`${base}/v1/replies/${SLOT}/cancel`, { method: 'POST' });
    assert.deepEqual(await again.json(), { ok: true, cancelled: false });
}));

test('cancel route: CORS preflight for the panel, bad slot, foreign origin', async () => {
    const pre = await fetch(`${base}/v1/replies/${SLOT}/cancel`, { method: 'OPTIONS', headers: { Origin: 'http://localhost:8000', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'x-claude-max-key' } });
    assert.equal(pre.status, 204);
    assert.equal(pre.headers.get('access-control-allow-origin'), 'http://localhost:8000');
    assert.match(pre.headers.get('access-control-allow-methods'), /POST/);
    assert.match(pre.headers.get('access-control-allow-headers'), /X-Claude-Max-Key/);
    assert.equal((await fetch(`${base}/v1/replies/zz/cancel`, { method: 'POST' })).status, 400);
    assert.equal((await fetch(`${base}/v1/replies/${SLOT}/cancel`, { method: 'POST', headers: { Origin: 'https://evil.example' } })).status, 403);
});

test('bad JSON gets a JSON 400 from the error handler', async () => {
    const r = await fetch(`${base}/v1/chat/completions`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{nope' });
    assert.equal(r.status, 400);
    assert.ok((await r.json()).error.message);
});

test('dry run: the stand-in capture chains, and is found by text + the reply it answers', quiet(async () => {
    __setSdkForTesting(fakeSdk());
    __resetTurnCaptures();
    const turn = async (messages) => {
        const r = await fetch(`${base}/v1/chat/completions`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
            model: 'claude-opus-5', stream: false, messages,
            claude_subscription: { effort: 'low', debug_dump: true, dry_run: true, lore_tail: false, fold_tail: false },
        }) });
        assert.equal(r.status, 200);
        return JSON.parse(readFileSync(join(process.env.CLAUDE_SUBSCRIPTION_DEBUG_DIR, 'last-entries.json'), 'utf8'));
    };
    const sys = { role: 'system', content: '规则' };
    await turn([sys, { role: 'assistant', content: '开场' }, { role: 'user', content: '继续' }]);
    await turn([sys, { role: 'assistant', content: '开场' }, { role: 'user', content: '继续' }, { role: 'assistant', content: '回1' }, { role: 'user', content: '继续' }]);
    // Both 「继续」 are known now, each under its own reply; the uuids chain.
    const { historyReplay, sentTextFor } = await import('../src/proxy/turn-capture.js');
    assert.equal(sentTextFor('继续', '开场'), '继续');
    assert.equal(sentTextFor('继续', '回1'), '继续');
    const { assembleEntries } = await import('../src/proxy/jsonl-entries.js');
    const entries = assembleEntries([{ role: 'assistant', content: '开场' }, { role: 'user', content: '继续' }, { role: 'assistant', content: '回1' }, { role: 'user', content: '继续' }, { role: 'assistant', content: '回2' }],
        { sessionId: 's', cwd: '/x' }, 'm', { replay: historyReplay(null).replay });
    for (let i = 1; i < entries.length; i++) assert.ok(entries[i].parentUuid && entries[i].parentUuid === entries[i - 1].uuid, `entry ${i} chains`);
}));

test('listener down', async () => {
    __setSdkForTesting(null);
    await stopStandaloneListener();
});

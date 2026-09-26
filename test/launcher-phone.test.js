import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';

import { parsePhoneProbe, PHONE_PROBE, ago, clock, backendInfo } from '../launcher/core.mjs';
import {
    actionPhoneSync, askChoices, compareVersions, hubSyncArgs, parseBackups, parseLaunchctl, previewLines, questions,
    resultLines, versionNote, RESTORE_RC,
} from '../launcher/phone.mjs';

// phone_sync.py --plan-json 的样子（和 test/launcher/test_phone_sync.py 里 ChoiceTests 造出来的一致）
const PLAN = {
    ok: true, local: 'Mac TT', remote: '手机', counts: { local: 10, remote: 11 }, firstSync: false,
    guard: { module: true, restoring: false, pending: false },
    auto: { push: ['worlds/mac.json'], pull: ['worlds/phone.json'], ext: ['ST-BaiBai-Image'], tags: '标签：→ 手机 1 个，← Mac TT 0 个（1 / 0 张卡）' },
    ask: {
        chats: [{ rel: 'chats/Alice/c.jsonl', newer: 'remote', first: false, mtime: { local: 1, remote: 2 }, extra: { local: 1, remote: 2 } }],
        files: [],
        api: { newer: 'remote', preset: { local: 'P2', remote: 'P1' } },
        secrets: { local: 1, remote: 1 },
        upstream: [],
    },
    skip: [{ what: 'chats/A/x.jsonl', why: '文件名只差大小写，两边会互相覆盖（请改名）' }],
    nothing: false,
};
const clone = (o) => JSON.parse(JSON.stringify(o));

test('phone probe: one adb shell, root part is one su -c string; parsing needs the end marker', () => {
    assert.equal((PHONE_PROBE.match(/su -c '/g) ?? []).length, 1);
    assert.ok(!/kill-server/.test(PHONE_PROBE));
    const p = parsePhoneProbe('tt_pid=4978\r\ngen=1\r\nguard_version=1.9\r\nlast_backup=1790405374\r\nrestore_pending=1\r\nsu_ok=1\r\nprobe_end=1\r\n');
    assert.deepEqual({ ...p, guardLastBackup: +p.guardLastBackup }, {
        ttRunning: true, generating: true, root: true, guardVersion: '1.9', guardLastBackup: 1790405374000, restoring: false, restorePending: true,
    });
    assert.equal(parsePhoneProbe('tt_pid=\n'), null);
    assert.equal(parsePhoneProbe('tt_pid=\nprobe_end=1').ttRunning, false);
});

test('time words and backend short names', () => {
    const now = new Date(2026, 8, 26, 20, 10);
    assert.equal(ago(new Date(2026, 8, 26, 18, 5), now), '2 小时前');
    assert.equal(ago(new Date(2026, 8, 26, 20, 9, 50), now), '刚刚');
    assert.equal(clock(new Date(2026, 8, 26, 19, 40), now), '19:40');
    assert.equal(clock(new Date(2026, 8, 25, 9, 5), now), '09-25 09:05');
    assert.deepEqual(backendInfo({ backend: 'subscription', label: '订阅（Claude 登录）', missing: [] }), { id: 'subscription', label: '订阅', missing: [] });
    assert.equal(backendInfo(null, { backend: { id: 'bedrock', label: 'AWS Bedrock' } }).label, 'Bedrock');
    assert.equal(backendInfo(null, null), null);
});

test('preview: auto / ask / skip groups', () => {
    const qs = questions(PLAN, { phone: { running: true, generating: true }, macRunning: true });
    const lines = previewLines(PLAN, qs, ['扩展 → Mac TT：CCST']);
    assert.deepEqual(lines.filter((l) => /^\S/.test(l)), ['自动（只有一边改过，不用问）', '要你选', '跳过（判断不了，没动）']);
    const text = lines.join('\n');
    assert.match(text, /→ 手机 1 个：mac/);
    assert.match(text, /扩展 → Mac TT：CCST/);
    assert.match(text, /a 聊天「c」两边都改过（Mac TT 多 1 楼，手机 多 2 楼；手机的较新）/);
    assert.match(text, /API 和预设设置两边不一样/);
    assert.match(text, /要关掉手机上的 TT（在生成回复）和Mac 上的 TT/);
    assert.match(text, /文件名只差大小写/);
    // generating: the close question defaults to waiting
    assert.deepEqual(qs.at(-1).options, ['现在关', '等生成完再关', '取消']);
    assert.equal(qs.at(-1).def, 1);
});

test('choices: defaults keep both chats, skip API settings, merge keys; cancel returns null', async () => {
    const qs = questions(PLAN, { phone: { running: true, generating: false } });
    const all = await askChoices(qs, async (_q, _o, def) => def);
    assert.deepEqual(all, { files: { 'chats/Alice/c.jsonl': 'both' }, api: 'skip', secrets: 'merge', close: 'now' });
    const picks = [0, 1, 1, 0];
    const mine = await askChoices(qs, async () => picks.shift());
    assert.deepEqual(mine, { files: { 'chats/Alice/c.jsonl': 'local' }, api: 'remote', secrets: 'skip', close: 'now' });
    assert.equal(await askChoices(qs, async () => null), null);
    assert.equal(await askChoices(qs, async (q, o) => (/关掉/.test(q) ? o.length - 1 : 0)), null);   // 选了「取消」
});

test('many conflicting chats are asked once', async () => {
    const p = clone(PLAN);
    p.ask.chats = Array.from({ length: 7 }, (_, i) => ({ ...PLAN.ask.chats[0], rel: `chats/A/${i}.jsonl` }));
    p.ask.api = null; p.ask.secrets = null;
    const qs = questions(p, {});
    assert.equal(qs.length, 1);
    const c = await askChoices(qs, async () => 2);
    assert.equal(Object.values(c.files).every((v) => v === 'remote'), true);
});

test('restore pending must be confirmed; nothing to do asks nothing', () => {
    const p = clone(PLAN);
    p.guard.pending = true;
    const q = questions(p, {}).find((x) => /没做完/.test(x.text));
    assert.equal(q.def, q.cancel);   // 默认是取消
    assert.deepEqual(questions({ ...clone(PLAN), nothing: true, ask: { chats: [], files: [], api: null, secrets: null, upstream: [] } }, { phone: { running: true } }), []);
});

test('result list reports counts, deferred items and the verify pass', () => {
    const res = {
        push: { total: 3, done: 3 }, pull: { total: 1, done: 0 }, copies: ['chats/A/c [冲突副本·手机 09-26 2010].jsonl'],
        ext: { total: 1, failed: [] }, tags: '标签：→ 手机 1 个', api: null, secrets: null, endpoint: 'http://192.168.31.145:8901/v1',
        backups: '/b', verified: true, upstreamFixed: [], snapshot: 'ok tt-default-user-1.tar.gz', missing: ['worlds/p.json'], notes: ['1 个文件没同步成功'],
        deferred: ['API 和预设设置两边不一样，没动（你选了跳过）'],
    };
    const after = { ok: true, auto: { push: [], pull: ['worlds/p.json'] }, ask: { chats: [], files: [] } };
    const lines = resultLines(PLAN, res, after);
    const text = lines.map(([k, t]) => `${k} ${t}`).join('\n');
    assert.match(text, /ok TT 守护快照：tt-default-user-1\.tar\.gz/);
    assert.match(text, /ok → 手机 3\/3 个文件/);
    assert.match(text, /bad ← Mac TT 0\/1 个文件/);
    assert.match(text, /note 没动：API 和预设设置/);
    assert.match(text, /bad 核对：还有 1 个文件两边不一样/);
});

function fakeDeps(over = {}) {
    const calls = [];
    const d = {
        calls,
        hubProblem: () => null,
        connect: () => ({ adb: '/adb', serial: 'S', macIp: '' }),
        probe: () => ({ ttRunning: true, generating: false, root: true, guardVersion: '1.9', restoring: false, restorePending: false }),
        macRunning: () => false,
        busy: async () => 0,
        stRunning: async () => false,
        plan: () => { calls.push('plan'); return clone(PLAN); },
        sync: (args, choices) => { calls.push(['sync', choices]); return { rc: 0, result: { push: { total: 1, done: 1 }, pull: { total: 0, done: 0 }, copies: [], ext: { total: 0, failed: [] }, deferred: [], notes: [], missing: [] }, output: '' }; },
        macExtPreview: () => [],
        macExtUpdate: () => true,
        quitMac: () => { calls.push('quitMac'); return true; },
        openMac: () => { calls.push('openMac'); return true; },
        notifyPhone: () => {},
        stopPhone: () => { calls.push('stopPhone'); return true; },
        openPhone: () => { calls.push('openPhone'); return true; },
        sleep: async () => {},
        ...over,
    };
    return d;
}
const quiet = () => {
    const out = [];
    const r = { warn: 0, fail: 0, out };
    for (const k of ['banner', 'step', 'explain', 'ok', 'fix', 'head', 'line', 'summary']) r[k] = (t) => out.push(`${k} ${t ?? ''}`);
    r.warnLine = (t) => { r.warn++; out.push(`warn ${t}`); };
    r.failLine = (t) => { r.fail++; out.push(`fail ${t}`); };
    return r;
};
const CFG = { root: '/x/ext', stDir: '', syncHub: 'tt', macTTData: '/h/tt/data', proxyPort: 8901, lanKeyFile: '/nope', os: 'mac' };

test('sync flow: restore lock refuses before planning or closing anything', async () => {
    const d = fakeDeps({ probe: () => ({ ttRunning: true, restoring: true }) });
    const r = quiet();
    assert.equal(await actionPhoneSync({ cfg: CFG, reporter: r, choose: async () => 0 }, d), 2);
    assert.deepEqual(d.calls, []);
    assert.match(r.out.join('\n'), /正在恢复备份/);
});

test('sync flow: interactive choices go to phone_sync.py, TT closed then reopened', async () => {
    const d = fakeDeps();
    const r = quiet();
    const code = await actionPhoneSync({ cfg: CFG, reporter: r, choose: async (_q, _o, def) => def }, d);
    assert.equal(code, 0);
    assert.deepEqual(d.calls.map((c) => (Array.isArray(c) ? c[0] : c)), ['plan', 'stopPhone', 'sync', 'plan', 'openPhone']);
    assert.deepEqual(d.calls[2][1], { files: { 'chats/Alice/c.jsonl': 'both' }, api: 'skip', secrets: 'merge', close: 'now' });
    assert.match(r.out.join('\n'), /head 自动（只有一边改过，不用问）/);
});

test('sync flow: cancel changes nothing', async () => {
    const d = fakeDeps();
    assert.equal(await actionPhoneSync({ cfg: CFG, reporter: quiet(), choose: async () => null }, d), 2);
    assert.deepEqual(d.calls, ['plan']);
});

test('sync flow: non-interactive uses safe defaults (no choices), waits for the reply, refuses a pending restore', async () => {
    let busy = 2;
    const d = fakeDeps({ busy: async () => (busy-- > 0 ? 1 : 0) });
    assert.equal(await actionPhoneSync({ cfg: CFG, reporter: quiet(), auto: true }, d), 0);
    assert.equal(d.calls.find((c) => Array.isArray(c))[1], null);
    const p = clone(PLAN); p.guard.pending = true;
    const d2 = fakeDeps({ plan: () => p });
    assert.equal(await actionPhoneSync({ cfg: CFG, reporter: quiet() }, d2), 2);
    assert.ok(!d2.calls.includes('stopPhone'));
});

test('sync flow: already the same closes nothing', async () => {
    const d = fakeDeps({ plan: () => ({ ...clone(PLAN), nothing: true }) });
    const r = quiet();
    assert.equal(await actionPhoneSync({ cfg: CFG, reporter: r, choose: async () => 0 }, d), 0);
    assert.ok(!d.calls.includes('stopPhone'));
    assert.match(r.out.join('\n'), /两边已经一样/);
});

test('hub args match lib.zsh (TT hub, SillyTavern extensions when present)', () => {
    const a = hubSyncArgs({ ...CFG, stDir: '/st' }, (p) => p === join('/st', 'public', 'scripts', 'extensions', 'third-party'));
    assert.deepEqual(a.slice(0, 6), ['--st', join('/h/tt/data', 'default-user'), '--local-name', 'Mac TT', '--state', join('/x/ext', 'launcher', 'phone-sync-state-tt.local.json')]);
    assert.equal(a[a.indexOf('--ext-dir') + 1], join('/st', 'public', 'scripts', 'extensions', 'third-party'));
    assert.equal(a[a.indexOf('--backups') + 1], join('/x', 'backups'));
});

test('TT guard helpers: versions, launchctl, backups list, restore codes', () => {
    assert.equal(compareVersions('1.9', '1.10'), -1);
    assert.equal(compareVersions('1.9', '1.9.0'), 0);
    assert.match(versionNote('1.8', '1.9'), /有新版本 1\.9：在 KernelSU 里更新/);
    assert.match(versionNote('1.9', '1.9'), /已是最新/);
    assert.match(versionNote(null, '1.9'), /没装/);
    assert.deepEqual(parseLaunchctl('\tstate = not running\n\truns = 3\n\tlast exit code = 0\n'), { installed: true, running: false, lastExit: 0 });
    assert.deepEqual(parseLaunchctl('', false), { installed: false });
    assert.deepEqual(parseBackups('termux-st-20260926-163023.tar.gz 15596 ab\r\ntt-default-user-20260926-144934.tar.gz 46636 cd\r\ntt-x;rm -rf.tar.gz 1 x\n'),
        [{ name: 'tt-default-user-20260926-144934.tar.gz', kb: 46636 }]);
    assert.match(RESTORE_RC[3], /TT 还开着/);
    assert.match(RESTORE_RC[10], /电量/);
});

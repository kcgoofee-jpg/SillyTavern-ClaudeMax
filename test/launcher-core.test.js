import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';

import {
    classify, diagnoseText, loadConfig, parseConfig, parseLsofCwd, parseNetstat, parseTsv, readState, recentLog,
    restartRefusal, services, stopService,
} from '../launcher/core.mjs';
import { nodeAction } from '../launcher/menu.mjs';

const ROOT = join('/', 'x', 'tavern', 'extension');

test('parseConfig reads sh and ps1 forms, quotes, several per line, $HOME', () => {
    const sh = parseConfig('# 注释 PROXY_PORT=1\nexport ST_DIR="/a b/ST"\nST_PORT=8100 # 端口\nLOG_DIR=$HOME/logs\nSYNC_HUB=\'tt\'', '/home/u');
    assert.deepEqual(sh, { ST_DIR: '/a b/ST', ST_PORT: '8100', LOG_DIR: '/home/u/logs', SYNC_HUB: 'tt' });
    const ps = parseConfig("$ST_DIR = 'D:\\SillyTavern'; $PROXY_PORT = 9001\r\n$LOG_DIR = \"D:\\logs\"");
    assert.deepEqual(ps, { ST_DIR: 'D:\\SillyTavern', PROXY_PORT: '9001', LOG_DIR: 'D:\\logs' });
});

test('loadConfig: defaults, SillyTavern next to the repo, env port wins, ps1 on Windows', () => {
    const files = { [join(ROOT, 'launcher', 'config.local')]: 'ST_AUTOSTART=0\nPROXY_PORT=8950' };
    const exists = (p) => p === join('/', 'x', 'tavern', 'SillyTavern', 'server.js');
    const read = (f) => { if (f in files) return files[f]; throw new Error('ENOENT'); };
    const c = loadConfig({ root: ROOT, env: {}, os: 'mac', termux: false, exists, read, home: '/h' });
    assert.equal(c.stDir, join('/', 'x', 'tavern', 'SillyTavern'));
    assert.equal(c.stAutostart, false);
    assert.equal(c.proxyPort, 8950);
    assert.equal(c.logDir, join(ROOT, 'data', 'logs'));
    assert.equal(loadConfig({ root: ROOT, env: { PROXY_PORT: '7000' }, os: 'mac', termux: false, exists, read }).proxyPort, 7000);
    // Windows reads config.local.ps1 first
    files[join(ROOT, 'launcher', 'config.local.ps1')] = '$PROXY_PORT = 8960';
    assert.equal(loadConfig({ root: ROOT, env: {}, os: 'win', termux: false, exists, read }).proxyPort, 8960);
    // installed as a server plugin: SillyTavern/plugins/<repo>
    const plug = join('/', 'st', 'plugins', 'CCST');
    const c2 = loadConfig({ root: plug, env: {}, os: 'win', termux: false, exists: (p) => p === join('/', 'st', 'server.js'), read });
    assert.equal(c2.stDir, join('/', 'st'));
    // Termux: no SillyTavern management, logs in ~/.claude-max
    const t = loadConfig({ root: ROOT, env: {}, os: 'linux', termux: true, exists: () => true, read, home: '/data/home' });
    assert.equal(t.stDir, '');
    assert.equal(t.logDir, join('/data/home', '.claude-max'));
});

test('parseNetstat keeps only LISTENING rows on that exact port', () => {
    const out = [
        '  Proto  Local Address          Foreign Address        State           PID',
        '  TCP    0.0.0.0:8901           0.0.0.0:0              LISTENING       4242',
        '  TCP    [::]:8901              [::]:0                 LISTENING       4242',
        '  TCP    127.0.0.1:18901        0.0.0.0:0              LISTENING       99',
        '  TCP    127.0.0.1:8901         127.0.0.1:50000        ESTABLISHED     4242',
        '  TCP    127.0.0.1:50000        127.0.0.1:8901         ESTABLISHED     77',
    ].join('\r\n');
    assert.deepEqual(parseNetstat(out, 8901), [4242]);
    assert.deepEqual(parseNetstat(out, 18901), [99]);
});

test('parseLsofCwd and parseTsv', () => {
    assert.deepEqual(parseLsofCwd('p12\nfcwd\nn/a/b\np13\nfcwd\nn/c\n'), { 12: '/a/b', 13: '/c' });
    assert.deepEqual(parseTsv('a\t1\nb\t\nbad\n'), { a: '1', b: '' });
});

function fakeProc({ listeners, cwds = {}, names = {}, dies = 'TERM' }) {
    const alive = new Set(listeners ?? []);
    const killed = [];
    return {
        killed,
        listeners: () => (listeners === null ? null : [...alive].filter((p) => listeners.includes(p))),
        cwds: (pids) => Object.fromEntries(pids.filter((p) => cwds[p]).map((p) => [p, cwds[p]])),
        name: (p) => names[p] ?? '',
        alive: (p) => alive.has(p),
        kill: (p, sig) => { killed.push([p, sig]); if (dies === 'TERM' || sig === 'SIGKILL') alive.delete(p); return true; },
    };
}
const quiet = () => ({ warn: 0, fail: 0, ok() {}, explain() {}, warnLine() { this.warn++; }, failLine() { this.fail++; }, fix() {} });
const svc = { key: 'proxy', label: 'Claude 代理', dir: ROOT, port: 8901, pidFile: '/nope/proxy.pid' };

test('classify: ours by cwd, recorded PID or reported PID; everything else is foreign', () => {
    const proc = fakeProc({ listeners: [1, 2, 3, 4], cwds: { 1: join(ROOT, 'src'), 2: '/elsewhere', 3: ROOT + '-copy' } });
    const c = classify(svc, proc, { reportedPid: 4, pidFile: () => null });
    assert.deepEqual(c.ours.sort(), [1, 4]);
    assert.deepEqual(c.foreign.sort(), [2, 3]); // a sibling folder with the same prefix is not ours
    assert.deepEqual(classify(svc, proc, { pidFile: () => 2 }).ours.sort(), [1, 2]);
    // cannot list listeners (Termux without lsof): only trust the PID the proxy reports itself
    const blind = classify(svc, fakeProc({ listeners: null }), { reportedPid: 9, pidFile: () => 5 });
    assert.deepEqual(blind, { ours: [9], foreign: [], known: false });
});

test('stopService never touches a foreign process on the port', async () => {
    const proc = fakeProc({ listeners: [50], cwds: { 50: '/Applications/Other' }, names: { 50: 'Other' } });
    assert.equal(await stopService(svc, quiet(), proc, { wait: async () => {} }), true);
    assert.deepEqual(proc.killed, []);
});

test('stopService: TERM first, SIGKILL only if it will not exit', async () => {
    const polite = fakeProc({ listeners: [10], cwds: { 10: ROOT } });
    let marked = false;
    assert.equal(await stopService(svc, quiet(), polite, { wait: async () => {}, mark: () => { marked = true; } }), true);
    assert.deepEqual(polite.killed, [[10, 'SIGTERM']]);
    assert.ok(marked);
    const stubborn = fakeProc({ listeners: [11], cwds: { 11: ROOT }, dies: 'KILL' });
    const r = quiet();
    assert.equal(await stopService(svc, r, stubborn, { wait: async () => {} }), true);
    assert.deepEqual(stubborn.killed, [[11, 'SIGTERM'], [11, 'SIGKILL']]);
    assert.equal(r.warn, 1);
});

test('restart is refused while the proxy is writing a reply', () => {
    assert.equal(restartRefusal({ busy: 0 }), null);
    assert.equal(restartRefusal(null), null); // proxy down: nothing to interrupt
    assert.match(restartRefusal({ busy: 2 }), /2 条回复/);
});

test('log diagnosis only looks after the last launch / last good reply and ignores quota 429s', () => {
    const log = ['Error: Cannot find module x', '──── 由酒馆工具箱启动 ────', 'quota endpoint 429', 'ok'].join('\n');
    assert.deepEqual(diagnoseText(log), []);
    assert.equal(recentLog('a\n[x] ✓ done\nb'), 'b');
    const bad = diagnoseText('──── 由酒馆工具箱启动 ────\nError: listen EADDRINUSE: address already in use\nNot logged in · Please run /login');
    assert.deepEqual(bad.map((b) => b.reason), ['端口被占用，程序无法监听', 'Claude 订阅未登录或登录已失效']);
});

function jsonFetch(map) {
    return async (url) => {
        const hit = Object.entries(map).find(([k]) => new URL(url).pathname === k);
        if (!hit) throw new Error('ECONNREFUSED');
        return { ok: true, json: async () => hit[1] };
    };
}

test('readState on Windows: proxy/HTTP fields filled, Mac-only probes n/a', async () => {
    const cfg = loadConfig({ root: ROOT, env: {}, os: 'win', termux: false, exists: () => false, read: () => { throw new Error(); }, home: 'C:\\Users\\u' });
    cfg.stDir = 'D:\\SillyTavern';
    const s = await readState({
        cfg,
        fetch: jsonFetch({ '/status': { ok: true, version: '9.9.9', credential: { present: true, subscriptionType: 'pro' } }, '/v1/control/status': { busy: 1 } }),
        exists: () => false,
        nonEmpty: () => false,
        portOpen: async (p) => p === 8000,
        osStatus: () => ({}),
    });
    assert.equal(s.proxy, true);
    assert.equal(s.proxyVersion, '9.9.9');
    assert.equal(s.plan, 'Pro');
    assert.equal(s.busy, 1);
    assert.equal(s.stManaged, true);
    assert.equal(s.stRunning, true);
    assert.equal(s.phone, null);
    assert.equal(s.hasTT, false);
    assert.equal(s.lastSync, null);
    assert.equal(s.phoneMode, false);
});

test('readState on macOS: proxy down, phone and sync from the OS helper and files', async () => {
    const cfg = loadConfig({ root: ROOT, env: {}, os: 'mac', termux: false, exists: () => false, read: () => { throw new Error(); }, home: '/Users/u' });
    const when = new Date(2026, 8, 26, 7, 5);
    const s = await readState({
        cfg,
        fetch: jsonFetch({}),
        exists: (p) => p === '/Applications/TauriTavern.app',
        nonEmpty: (f) => f.endsWith('phone-sync-state-tt.local.json') || f === cfg.lanKeyFile,
        mtime: () => when,
        portOpen: async () => false,
        osStatus: () => ({ watchdog: '1', phone: 'wifi', ip: '10.0.0.2', lid_on: '0' }),
    });
    assert.equal(s.proxy, false);
    assert.equal(s.loggedIn, null);
    assert.equal(s.hubLabel, 'Mac TT'); // no SillyTavern: the hub is the Mac TT
    assert.equal(s.lastSync, '09-26 07:05');
    assert.equal(s.phoneMode, true);
    assert.equal(s.watchdog, true);
    assert.equal(s.phone, 'wifi');
    assert.equal(s.hasTT, true);
});

test('services: SillyTavern first when there is one; PID files shared with claude-max.ps1', () => {
    const cfg = { root: ROOT, stDir: '/st', stPort: 8000, proxyPort: 8901, logDir: '/logs' };
    assert.deepEqual(services(cfg).map((s) => [s.key, s.pidFile]), [['sillytavern', join('/logs', 'sillytavern.pid')], ['proxy', join('/logs', 'proxy.pid')]]);
    assert.deepEqual(services({ ...cfg, stDir: '' }).map((s) => s.key), ['proxy']);
});

test('action routing: check is Node everywhere; start/stop/restart Node except macOS and Termux', () => {
    for (const os of ['mac', 'win', 'linux']) assert.ok(nodeAction('check', os, false));
    assert.ok(nodeAction('check', 'linux', true));
    assert.equal(nodeAction('restart', 'mac', false), null);
    assert.ok(nodeAction('restart', 'win', false));
    assert.equal(nodeAction('start', 'linux', true), null);
    assert.equal(nodeAction('phone-sync', 'win', false), null);
});

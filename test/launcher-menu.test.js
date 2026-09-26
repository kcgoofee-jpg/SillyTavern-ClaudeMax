import { test } from 'node:test';
import assert from 'node:assert/strict';

import { width, pad, problems, renderHome, screens, statusLines } from '../launcher/menu.mjs';

const base = {
    proxy: true, proxyVersion: null, loggedIn: true, plan: 'Max', busy: 0, phoneMode: false, watchdog: false,
    lidInstalled: false, lidOn: false, ip: '', phone: 'none', lastSync: null, hubLabel: 'Mac TT', stManaged: false,
    stRunning: false, hasTT: true, macTTRunning: false, hasComfy: false, comfyRunning: false, hasModule: false,
    canTTImport: false, autostart: false, backend: { id: 'subscription', label: '订阅', missing: [] }, proxyVersion: null, phoneTT: null,
    lastSyncAt: null,
};
const mac = process.platform === 'darwin';

test('display width counts CJK as two columns and ignores colour codes', () => {
    assert.equal(width('abc'), 3);
    assert.equal(width('手机同步'), 8);
    assert.equal(width('\x1b[32m运行中\x1b[0m'), 6);
    assert.equal(width(pad('代理', 6)), 6);
});

test('problems: proxy down first, each with a fix', () => {
    assert.deepEqual(problems(base), []);
    const down = problems({ ...base, proxy: false });
    assert.equal(down.length, 1);
    assert.equal(down[0].fix, 'start');
    assert.equal(problems({ ...base, loggedIn: false })[0].fix, 'login');
    // not logged in is not reported while the proxy is down (can't tell yet)
    assert.equal(problems({ ...base, proxy: false, loggedIn: null }).length, 1);
});

test('problems: an outdated running proxy asks for a restart', () => {
    const p = problems({ ...base, proxyVersion: '0.0.1' });
    assert.equal(p.length, 1);
    assert.equal(p[0].fix, 'restart');
});

test('home: Enter starts when the proxy is down, opens when it runs', () => {
    assert.match(screens({ ...base, proxy: false }).home.primary.label, /启动/);
    assert.match(screens(base).home.primary.label, /打开/);
});

test('image-generation group only when ComfyUI is installed (macOS)', () => {
    const keys = (s) => screens(s).home.rows.flat().map((i) => i.sub).filter(Boolean);
    if (process.platform === 'darwin') {
        assert.ok(!keys(base).includes('comfy'));
        assert.ok(keys({ ...base, hasComfy: true }).includes('comfy'));
    } else {
        assert.ok(!keys({ ...base, hasComfy: true }).includes('comfy'));
    }
});

test('phone mode item flips its label with the mode', () => {
    const item = (s) => screens(s).phone.items.find((i) => i.id === 'phone-mode');
    assert.match(item(base).label, /切到手机模式/);
    assert.match(item({ ...base, phoneMode: true }).label, /切到电脑模式/);
});

test('problems: other backends need no login but need their settings', () => {
    const api = { ...base, loggedIn: false, backend: { id: 'apikey', label: 'API 密钥', missing: [] } };
    assert.deepEqual(problems(api), []);
    const p = problems({ ...api, backend: { ...api.backend, missing: ['apikey.apiKey'] } });
    assert.equal(p.length, 1);
    assert.equal(p[0].block, true);
});

test('problems: TT guard restoring / unfinished restore on the phone', () => {
    assert.match(problems({ ...base, phoneTT: { restoring: true } })[0].text, /正在恢复/);
    const p = problems({ ...base, phoneTT: { restorePending: true } })[0];
    assert.equal(p.sub, 'guard');
    assert.equal(p.block, undefined);   // 不影响玩
});

test('home: can I play / what is wrong / what next', () => {
    const s = { ...base, proxyVersion: '9.9.9', macTTRunning: true, phone: 'usb', lastSyncAt: new Date(Date.now() - 2 * 3600e3),
        phoneTT: { ttRunning: true, generating: true, root: true, guardVersion: '1.9', guardLastBackup: new Date(), restoring: false, restorePending: false } };
    const ok = statusLines({ ...s, proxyVersion: null });
    assert.match(ok[0], /● 可以玩 +代理 \? · 订阅 · 已登录（Max）/);
    if (mac) {
        assert.match(ok[1], /Mac TT 开着 · 手机 TT 在线（在生成回复）/);
        assert.match(ok[2], /上次同步 2 小时前 · TT 守护上次备份 \d\d:\d\d/);
    }
    const down = statusLines({ ...s, proxy: false });
    assert.match(down[0], /● 还不能玩 +代理没运行/);
    assert.match(down[1], /a  代理没在运行 +→ 启动代理/);
    const home = renderHome(s);
    assert.match(home.text, /CCST 酒馆工具 v\d+\.\d+/);
    assert.match(home.text, /回车  打开 TT/);
    assert.deepEqual(home.actions.map((a) => a.key ?? 'enter'), ['enter', '1', '2', '3', '4', '5', '6']);
    assert.equal(home.actions[1].id, 'phone-sync');
    assert.equal(home.actions[5].sub, 'guard');
    if (!mac) assert.ok(home.actions[1].why);
});

test('TT guard screen: version vs latest, auto pull, KernelSU hint', () => {
    const g = screens({ ...base, phone: 'usb', hasModule: true, guardLatest: '2.0', pullJob: { installed: true },
        phoneTT: { guardVersion: '1.9', guardLastBackup: null } }).guard;
    assert.deepEqual(g.items.map((i) => i.id), ['guard-status', 'guard-pull', 'guard-auto', 'guard-restore']);
    if (mac) {
        assert.match(g.note[0], /手机上 1\.9 · 有新版本 2\.0：在 KernelSU 里更新/);
        assert.match(g.note[1], /电脑自动拉备份 开着/);
        assert.match(g.note[2], /KernelSU → 模块 → TT 守护/);
        assert.equal(screens({ ...base, phone: 'none' }).guard.items[3].why, '手机没连');
    } else {
        assert.ok(g.items.every((i) => i.why));
    }
});

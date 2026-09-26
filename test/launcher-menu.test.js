import { test } from 'node:test';
import assert from 'node:assert/strict';

import { width, pad, problems, screens } from '../launcher/menu.mjs';

const base = {
    proxy: true, proxyVersion: null, loggedIn: true, plan: 'Max', busy: 0, phoneMode: false, watchdog: false,
    lidInstalled: false, lidOn: false, ip: '', phone: 'none', lastSync: null, hubLabel: 'Mac TT', stManaged: false,
    stRunning: false, hasTT: true, macTTRunning: false, hasComfy: false, comfyRunning: false, hasModule: false,
    canTTImport: false, autostart: false,
};

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

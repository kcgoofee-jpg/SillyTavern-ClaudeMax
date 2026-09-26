import { test } from 'node:test';
import assert from 'node:assert/strict';
import { springCurve, linearEasing } from '../src/shared/island.js';

test('springCurve starts at 0, ends at 1, overshoots only a little', () => {
    const c = springCurve({ stiffness: 420, damping: 32 });
    assert.equal(c.values[0], 0);
    assert.equal(c.values.at(-1), 1);
    assert.ok(c.overshoot >= 0 && c.overshoot < 0.05, `overshoot ${c.overshoot}`);
    assert.ok(c.duration > 150 && c.duration < 900, `duration ${c.duration}`);
});

test('critically damped spring never overshoots', () => {
    const c = springCurve({ stiffness: 400, damping: 40 });
    assert.ok(c.values.every((v) => v <= 1.0001));
});

test('linearEasing makes a CSS linear() string', () => {
    assert.equal(linearEasing([0, 0.5, 1]), 'linear(0, 0.5, 1)');
});

// Just enough DOM for createIsland (no layout, no Web Animations).
function fakeDoc() {
    const mk = (tag) => {
        const n = {
            tagName: tag, className: '', textContent: '', children: [], dataset: {}, parentElement: null, listeners: {},
            classList: { toggle() {}, add() {} },
            setAttribute() {},
            addEventListener(t, f) { n.listeners[t] = f; },
            append(...c) { for (const x of c) { x.parentElement = n; n.children.push(x); } },
            replaceChildren(...c) { n.children = []; n.append(...c); },
            get firstElementChild() { return n.children[0] ?? null; },
            getBoundingClientRect: () => ({ width: 0, height: 0 }),
            isConnected: true, offsetParent: {},
        };
        return n;
    };
    return { createElement: mk, hidden: false, defaultView: { matchMedia: () => ({ matches: true }), CSS: null, Element: { prototype: {} } } };
}
const shownTitle = (isl) => {
    const c = isl.root.children[0].children[0];
    return c.className.includes('cm-isl-notice') ? c.children[1].children[0].textContent : c.className;
};

test('a sticky notice steps aside when a reply starts generating', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
    const { createIsland } = await import('../src/shared/island.js');
    const isl = createIsland(fakeDoc());
    isl.notice({ tone: 'bad', title: '连不上代理', ms: 0, replace: 'proxy' });
    assert.equal(shownTitle(isl), '连不上代理');
    t.mock.timers.tick(60000);
    assert.equal(shownTitle(isl), '连不上代理', 'sticky while idle');
    isl.set({ kind: 'thinking', startedAt: Date.now() });
    assert.match(shownTitle(isl), /cm-isl-live/);
    // Raised during generation: shown only briefly.
    isl.notice({ tone: 'bad', title: '又断了', ms: 0 });
    assert.equal(shownTitle(isl), '又断了');
    t.mock.timers.tick(5001);
    assert.match(shownTitle(isl), /cm-isl-live/);
});

test('clear() needs a key; drain() hands back pending notices', async () => {
    const { createIsland } = await import('../src/shared/island.js');
    const isl = createIsland(fakeDoc());
    isl.notice({ tone: 'info', title: 'a', ms: 0 });
    isl.notice({ tone: 'info', title: 'b', ms: 0, replace: 'k' });
    isl.clear(undefined);
    assert.equal(shownTitle(isl), 'a');
    assert.equal(isl.pending, true);
    assert.deepEqual(isl.drain().map((n) => n.title), ['a', 'b']);
    assert.equal(isl.pending, false);
    assert.match(shownTitle(isl), /cm-isl-dot/);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { springCurve, linearEasing } from '../lib/island.js';

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

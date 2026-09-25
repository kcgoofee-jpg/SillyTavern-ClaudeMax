import test from 'node:test';
import assert from 'node:assert/strict';

import { planPresetReco } from '../lib/preset-reco.js';

const fields = { inlineSystem: { valid: (v) => typeof v === 'boolean' }, effort: { valid: (v) => typeof v === 'string' } };

test('a recommendation is undone when switching to a preset without one', () => {
    const s0 = { inlineSystem: true, effort: 'auto' };
    const a = planPresetReco(s0, { inlineSystem: false }, null, fields);           // → v1.4
    assert.equal(a.next.inlineSystem, false);
    assert.deepEqual(a.applied, ['inlineSystem']);
    const b = planPresetReco(a.next, undefined, a.record, fields);                  // → Ny (no reco)
    assert.equal(b.next.inlineSystem, true);
    assert.deepEqual(b.restored, ['inlineSystem']);
    assert.equal(b.record, null);
});

test('a manual change after the recommendation is kept', () => {
    const a = planPresetReco({ inlineSystem: true }, { inlineSystem: false }, null, fields);
    const manual = { ...a.next, inlineSystem: true };                               // user flipped it back by hand
    const b = planPresetReco({ ...manual, effort: 'high' }, undefined, a.record, fields);
    assert.deepEqual(b.restored, []);
    assert.equal(b.next.effort, 'high');
});

test('switching between two recommending presets restores then applies', () => {
    const a = planPresetReco({ inlineSystem: true, effort: 'auto' }, { inlineSystem: false }, null, fields);
    const b = planPresetReco(a.next, { effort: 'high' }, a.record, fields);
    assert.deepEqual([b.next.inlineSystem, b.next.effort], [true, 'high']);
    assert.deepEqual(b.record, { before: { effort: 'auto' }, applied: { effort: 'high' } });
});

// ──────────────────────────────────────────────
// Preset recommendations are scoped to the preset that ships them
// ──────────────────────────────────────────────
//
// A preset can carry `extensions.claude_max = { inlineSystem: false, … }`.
// Applying it used to be sticky: switching to a preset WITHOUT
// recommendations kept the previous preset's values (e.g. a cache-tuned
// preset's "hoist depth injections" silently reordered the next preset's
// post-history entries). Now each switch first undoes what the previous
// recommendation changed — unless the user has since changed that setting
// by hand — then applies the new preset's own recommendation.
// Pure function; shared by the panel (index.js) and the tests.

/**
 * @param {object} settings        current panel settings
 * @param {object|null} rec        new preset's extensions.claude_max (or null)
 * @param {object|null} record     what the last recommendation changed: { before: {k: v}, applied: {k: v} }
 * @param {Record<string, {valid: (v:any)=>boolean}>} fields  keys a preset may set
 * @returns {{ next: object, restored: string[], applied: string[], record: object|null }}
 */
export function planPresetReco(settings, rec, record, fields) {
    const next = { ...settings };
    const restored = [];
    for (const [key, value] of Object.entries(record?.before ?? {})) {
        // Only undo what is still the recommended value — a manual change wins.
        if (key in fields && next[key] === record.applied?.[key] && next[key] !== value) {
            next[key] = value;
            restored.push(key);
        }
    }
    const applied = [];
    const newRecord = { before: {}, applied: {} };
    if (rec && typeof rec === 'object') {
        for (const [key, field] of Object.entries(fields)) {
            if (rec[key] === undefined || !field.valid(rec[key]) || next[key] === rec[key]) continue;
            newRecord.before[key] = next[key];
            newRecord.applied[key] = rec[key];
            next[key] = rec[key];
            applied.push(key);
        }
    }
    return {
        next,
        restored: restored.filter((k) => !applied.includes(k)),
        applied,
        record: applied.length ? newRecord : null,
    };
}

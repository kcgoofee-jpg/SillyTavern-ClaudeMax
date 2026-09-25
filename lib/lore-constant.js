// ──────────────────────────────────────────────
// "Make this card's world info constant" (cache optimisation #1)
// ──────────────────────────────────────────────
//
// Keyword-triggered world-info entries change from turn to turn; they sit in
// front of the chat history, so every change makes the prompt cache re-write
// the whole conversation (measured: 27.6k → 2.8k tokens written per turn
// once a card's lore was all constant). This turns every enabled keyword
// entry into a constant one. Pure functions on SillyTavern's world-info
// object ({ entries: { uid: { constant, disable, content, … } } }); the panel
// does the loading, backup and saving.

/** Enabled, non-constant entries: what a conversion would change. */
export function keywordEntries(book) {
    return Object.values(book?.entries ?? {}).filter((e) => e && !e.disable && !e.constant);
}

export function summarizeLore(book) {
    const kw = keywordEntries(book);
    return { keyword: kw.length, keywordChars: kw.reduce((n, e) => n + String(e.content ?? '').length, 0) };
}

/** A deep copy with every enabled keyword entry made constant. */
export function makeAllConstant(book) {
    const next = JSON.parse(JSON.stringify(book ?? { entries: {} }));
    let changed = 0;
    for (const e of Object.values(next.entries ?? {})) {
        if (e && !e.disable && !e.constant) {
            e.constant = true;
            changed++;
        }
    }
    return { book: next, changed };
}

export const backupName = (name) => `${name}（常驻前备份）`;

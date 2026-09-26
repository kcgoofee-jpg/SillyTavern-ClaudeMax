// ──────────────────────────────────────────────
// Reply keeper: the last reply of each chat, in memory, for the panel to
// put back when the app lost it
// ──────────────────────────────────────────────
//
// A phone app in the background may receive a reply and never save it (the
// OS pauses its web view), or be closed mid-stream; the floor then shows
// "..." and the reply — already paid for — is gone. The UI extension tags
// each request with a slot: a short hash of the chat and the player's
// message (no text). The finished reply is kept here under that slot, IN
// MEMORY ONLY (never written to disk), for a few hours; when the chat is
// opened again and its last reply is empty, "..." or cut short, the panel
// fetches it by the same slot and puts it back.

const MAX_SLOTS = 40;
const TTL_MS = 6 * 3600 * 1000;
const SLOT_RE = /^[0-9a-f]{8,40}$/;

const kept = new Map(); // slot → { text, reasoning, finish, at }

export function isValidSlot(slot) {
    return typeof slot === 'string' && SLOT_RE.test(slot);
}

export function keepReply(slot, { text, reasoning = '', finish = 'stop' }) {
    if (!isValidSlot(slot) || !text) return;
    kept.delete(slot);
    kept.set(slot, { text, reasoning, finish, at: Date.now() });
    while (kept.size > MAX_SLOTS) kept.delete(kept.keys().next().value);
}

export function keptReply(slot, now = Date.now()) {
    const r = isValidSlot(slot) ? kept.get(slot) : null;
    if (!r) return null;
    if (now - r.at > TTL_MS) {
        kept.delete(slot);
        return null;
    }
    return r;
}

export function handleKeptReply(req, res) {
    const r = keptReply(String(req.params?.slot ?? ''));
    if (!r) return res.status(404).json({ ok: false });
    res.json({ ok: true, ...r });
}

/** Test seam. */
export function __resetKeptReplies() {
    kept.clear();
}

// ──────────────────────────────────────────────
// Phone → Mac remote control (standalone listener only)
// ──────────────────────────────────────────────
//
// The CCST panel on the phone can see how the Mac is doing and press a
// few fixed buttons. Everything goes through the launcher's own zsh
// functions (launcher/mac/lib.zsh), so the phone can do exactly what the
// menu can and nothing else: there is no way to pass a command, only an
// action name from ACTIONS. Remote callers need the LAN access key like any
// other request (guardRemote runs first). Every action is written to the
// launcher log and shown as a Mac notification.

import { execFile, spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, unlinkSync, statSync, openSync, readSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './paths.js';

const LAUNCHER_LIB = join(ROOT, 'launcher', 'mac', 'lib.zsh');
export const LID_PAUSE_FILE = join(ROOT, 'launcher', 'lid-pause.local');

let inFlight = 0;
// When a reply to another device (the phone) last finished. Kept in a file
// (a timestamp, nothing else) so a proxy restart doesn't forget it.
const LAST_REMOTE_FILE = process.env.NODE_TEST_CONTEXT ? null : join(ROOT, 'data', 'last-remote-done'); // unit tests never touch it
let lastRemoteDoneAt = (() => { try { return LAST_REMOTE_FILE ? Number(readFileSync(LAST_REMOTE_FILE, 'utf8')) || 0 : 0; } catch { return 0; } })();

/** Wrap the chat handler: count replies being generated until the handler
 *  itself is done — NOT until the response closes: a phone app that went to
 *  the background drops the connection while the reply keeps being written
 *  and kept (reply-keeper.js), and a restart then would lose it. Also
 *  remembers when a reply to another device last finished — the phone's app
 *  may still be holding it unsaved (Android pauses a background web view).
 *  A rejected handler goes to express's error handler instead of crashing. */
export function countInFlight(handler) {
    return async (req, res, next) => {
        inFlight++;
        const remote = !/^(127\.|::1$|::ffff:127\.)/.test(String(req?.socket?.remoteAddress ?? '127.0.0.1'));
        try {
            await handler(req, res, next);
        } catch (err) {
            next?.(err);
        } finally {
            inFlight--;
            if (remote && res.statusCode < 400) {
                lastRemoteDoneAt = Date.now();
                try { if (LAST_REMOTE_FILE) writeFileSync(LAST_REMOTE_FILE, String(lastRemoteDoneAt)); } catch { /* data/ missing: memory only */ }
            }
        }
    };
}

export function busyCount() {
    return inFlight;
}

// server.js (the launcher's standalone proxy) sets this. Inside SillyTavern
// (plugin mode) the process on the proxy port IS SillyTavern: stopping it
// from the phone would take the whole tavern down.
let standalone = false;
export function markStandalone(on = true) {
    standalone = !!on;
}

// name → { label, script (zsh, after sourcing lib.zsh) | run (in-process),
//          whenIdle: refused while replies are being written (idleNote says why),
//          standaloneOnly: refused when the proxy runs inside SillyTavern }
export const ACTIONS = {
    'restart-proxy': {
        label: '重启代理',
        // Detached: the old proxy is stopped from outside, then started again.
        script: 'sleep 1; stop_one $PROXY_PORT "Claude 代理" >/dev/null 2>&1; start_proxy >/dev/null 2>&1',
        whenIdle: true,
        idleNote: '写完再重启',
        standaloneOnly: true,
    },
    'lid-pause': {
        label: '合盖不睡：暂停',
        run: () => writeFileSync(LID_PAUSE_FILE, String(Date.now())),
    },
    'lid-resume': {
        label: '合盖不睡：恢复',
        run: () => { if (existsSync(LID_PAUSE_FILE)) unlinkSync(LID_PAUSE_FILE); },
    },
    'comfy-start': { label: '启动本地生图', script: 'start_comfy >/dev/null 2>&1' },
    'comfy-stop': { label: '关闭本地生图', script: 'stop_comfy >/dev/null 2>&1' },
    // The phone app is closed and reopened by the sync: answer first, and
    // never while a reply is still being written (it would be lost).
    'phone-sync': { label: '手机同步', script: 'sleep 3; phone_sync_auto >/dev/null 2>&1', whenIdle: true, idleNote: '写完再同步' },
};

function zsh(script, { detached = false } = {}) {
    const args = ['-c', `source ${JSON.stringify(LAUNCHER_LIB)}; ${script}`];
    if (detached) {
        const child = spawn('/bin/zsh', args, { detached: true, stdio: 'ignore' });
        child.unref();
        return Promise.resolve('');
    }
    return new Promise((resolve) => {
        execFile('/bin/zsh', args, { timeout: 15000 }, (err, stdout) => resolve(err ? '' : String(stdout)));
    });
}

function logEvent(text) {
    return zsh(`log_event ${JSON.stringify(`[遥控] ${text}`)}; osascript -e ${JSON.stringify(`display notification "${text.replace(/"/g, '')}" with title "CCST · 手机遥控"`)} >/dev/null 2>&1`);
}

function tail(file, lines) {
    try {
        const size = statSync(file).size;
        const len = Math.min(size, 64 * 1024);
        const buf = Buffer.alloc(len);
        const fd = openSync(file, 'r');
        readSync(fd, buf, 0, len, size - len);
        closeSync(fd);
        return buf.toString('utf8').split('\n').filter(Boolean).slice(-lines);
    } catch {
        return [];
    }
}

/** Mac-side state for the panel. Numbers and short lines only. */
export async function macStatus() {
    if (!existsSync(LAUNCHER_LIB) || process.platform !== 'darwin') {
        return { ok: false, supported: false };
    }
    const out = await zsh([
        'print -r -- "phone=$([[ -s $LAN_KEY_FILE ]] && print 1 || print 0)"',
        'print -r -- "watchdog=$(watchdog_running && print 1 || print 0)"',
        'print -r -- "lidInstalled=$(lid_supported && print 1 || print 0)"',
        'print -r -- "lidOn=$(lid_awake_on && print 1 || print 0)"',
        'print -r -- "lidClosed=$(lid_closed && print 1 || print 0)"',
        'print -r -- "battery=$(battery_pct)"',
        'print -r -- "onBattery=$(on_battery && print 1 || print 0)"',
        'print -r -- "ip=$(lan_ip)"',
        'print -r -- "comfy=$([[ -n "$(our_pids $COMFY_PORT)" ]] && print 1 || print 0)"',
        'print -r -- "logDir=$LOG_DIR"',
    ].join('; '));
    const kv = Object.fromEntries(out.split('\n').filter((l) => l.includes('=')).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
    const flag = (k) => kv[k] === '1';
    // Only what is still unresolved: errors since this launch and after the last good reply.
    const lines = kv.logDir ? tail(join(kv.logDir, 'proxy.log'), 400) : [];
    const since = Math.max(lines.findLastIndex((l) => l.includes('由酒馆工具箱启动')), lines.findLastIndex((l) => l.includes('] ✓ ')));
    const errors = lines.slice(since + 1).filter((l) => l.includes(' ✗ ')).slice(-3);
    return {
        ok: true, supported: true,
        phoneMode: flag('phone'), watchdog: flag('watchdog'),
        lid: { installed: flag('lidInstalled'), on: flag('lidOn'), closed: flag('lidClosed'), paused: existsSync(LID_PAUSE_FILE) },
        battery: kv.battery ? Number(kv.battery) : null, onBattery: flag('onBattery'),
        ip: kv.ip || null, comfy: flag('comfy'), busy: inFlight, lastRemoteDoneAt: lastRemoteDoneAt || null,
        recentErrors: errors.map((l) => l.replace(/^\[claude-subscription\]\s*/, '').slice(0, 200)),
    };
}

export async function handleControlStatus(_req, res) {
    res.json(await macStatus());
}

export async function handleControlAction(req, res) {
    const name = String(req.body?.action ?? '');
    // Own keys only: 'constructor' / '__proto__' must not resolve to Object.prototype members.
    const action = Object.hasOwn(ACTIONS, name) ? ACTIONS[name] : null;
    if (!action) return res.status(400).json({ ok: false, message: `没有这个操作：${name}` });
    if (!existsSync(LAUNCHER_LIB) || process.platform !== 'darwin') {
        return res.status(501).json({ ok: false, message: '只有 Mac 上用启动器运行的代理支持遥控' });
    }
    if (action.whenIdle && inFlight > 0) {
        return res.status(409).json({ ok: false, message: `代理正在写 ${inFlight} 条回复，${action.idleNote ?? '写完再试'}` });
    }
    if (action.standaloneOnly && !standalone) {
        return res.status(409).json({ ok: false, message: '代理现在运行在酒馆（SillyTavern）里面，从这里重启会把酒馆一起关掉。请在 Mac 上用启动器重启酒馆。' });
    }
    await logEvent(action.label);
    if (action.run) action.run();
    res.json({ ok: true, message: `${action.label}：已执行` });
    if (action.script) zsh(action.script, { detached: true });
}

export async function handleControlLog(_req, res) {
    const s = await macStatus();
    if (!s.supported) return res.status(501).json({ ok: false });
    const dir = (await zsh('print -r -- $LOG_DIR')).trim();
    res.json({ ok: true, proxy: tail(join(dir, 'proxy.log'), 30), launcher: tail(join(dir, 'launcher.log'), 15) });
}

// ── Performance diagnosis (the panel measures the page it runs in) ──
// The Mac asks (POST /v1/control/diag-request); the panel sees it on its next
// heartbeat (GET, which clears it), measures and posts the result; the Mac
// reads it back. Numbers, selectors and floor indexes only — no chat text.
let diagRequested = false;
let lastDiag = null;

export function handleDiagRequest(req, res) {
    if (req.method === 'POST') {
        diagRequested = true;
        return res.json({ ok: true });
    }
    const requested = diagRequested;
    diagRequested = false;
    res.json({ requested });
}

export function handleDiagResult(req, res) {
    if (req.method === 'POST') {
        const body = req.body;
        if (!body || typeof body !== 'object' || JSON.stringify(body).length > 200_000) return res.status(400).json({ ok: false });
        lastDiag = { at: Date.now(), ...body };
        return res.json({ ok: true });
    }
    res.json(lastDiag ?? { ok: false, message: '还没有诊断结果' });
}

/** Test seam. */
export function __setInFlight(n) {
    inFlight = n;
}

export function readLidPause() {
    try { return readFileSync(LID_PAUSE_FILE, 'utf8'); } catch { return null; }
}

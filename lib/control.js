// ──────────────────────────────────────────────
// Phone → Mac remote control (standalone listener only)
// ──────────────────────────────────────────────
//
// The Claude Max panel on the phone can see how the Mac is doing and press a
// few fixed buttons. Everything goes through the launcher's own zsh
// functions (launcher/mac/lib.zsh), so the phone can do exactly what the
// menu can and nothing else: there is no way to pass a command, only an
// action name from ACTIONS. Remote callers need the LAN access key like any
// other request (guardRemote runs first). Every action is written to the
// launcher log and shown as a Mac notification.

import { execFile, spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, unlinkSync, statSync, openSync, readSync, closeSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const LAUNCHER_LIB = join(ROOT, 'launcher', 'mac', 'lib.zsh');
export const LID_PAUSE_FILE = join(ROOT, 'launcher', 'lid-pause.local');

let inFlight = 0;
// When a reply to another device (the phone) last finished. Kept in a file
// (a timestamp, nothing else) so a proxy restart doesn't forget it.
const LAST_REMOTE_FILE = process.env.NODE_TEST_CONTEXT ? null : join(ROOT, 'data', 'last-remote-done'); // unit tests never touch it
let lastRemoteDoneAt = (() => { try { return LAST_REMOTE_FILE ? Number(readFileSync(LAST_REMOTE_FILE, 'utf8')) || 0 : 0; } catch { return 0; } })();

/** Middleware: count chat requests being answered, so a restart can wait;
 *  remember when a reply to another device last finished — the phone's app
 *  may still be holding it unsaved (Android pauses a background web view). */
export function countInFlight(req, res, next) {
    inFlight++;
    let done = false;
    const remote = !/^(127\.|::1$|::ffff:127\.)/.test(String(req?.socket?.remoteAddress ?? '127.0.0.1'));
    const end = () => {
        if (done) return;
        done = true;
        inFlight--;
        if (remote && res.statusCode < 400) {
            lastRemoteDoneAt = Date.now();
            try { if (LAST_REMOTE_FILE) writeFileSync(LAST_REMOTE_FILE, String(lastRemoteDoneAt)); } catch { /* data/ missing: memory only */ }
        }
    };
    res.on('finish', end);
    res.on('close', end);
    next();
}

export function busyCount() {
    return inFlight;
}

// name → { label, script (zsh, after sourcing lib.zsh) | run (in-process) }
export const ACTIONS = {
    'restart-proxy': {
        label: '重启代理',
        // Detached: the old proxy is stopped from outside, then started again.
        script: 'sleep 1; stop_one $PROXY_PORT "Claude 代理" >/dev/null 2>&1; start_proxy >/dev/null 2>&1',
        whenIdle: true,
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
    // The phone app is closed and reopened by the sync: answer first.
    'phone-sync': { label: '手机同步', script: 'sleep 3; phone_sync_auto >/dev/null 2>&1' },
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
    return zsh(`log_event ${JSON.stringify(`[遥控] ${text}`)}; osascript -e ${JSON.stringify(`display notification "${text.replace(/"/g, '')}" with title "Claude Max · 手机遥控"`)} >/dev/null 2>&1`);
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
    const action = ACTIONS[name];
    if (!action) return res.status(400).json({ ok: false, message: `没有这个操作：${name}` });
    if (!existsSync(LAUNCHER_LIB) || process.platform !== 'darwin') {
        return res.status(501).json({ ok: false, message: '只有 Mac 上用启动器运行的代理支持遥控' });
    }
    if (action.whenIdle && inFlight > 0) {
        return res.status(409).json({ ok: false, message: `代理正在写 ${inFlight} 条回复，写完再重启` });
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

/** Test seam. */
export function __setInFlight(n) {
    inFlight = n;
}

export function readLidPause() {
    try { return readFileSync(LID_PAUSE_FILE, 'utf8'); } catch { return null; }
}

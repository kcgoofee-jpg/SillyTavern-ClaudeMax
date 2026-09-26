#!/usr/bin/env node
// ──────────────────────────────────────────────
// CCST 酒馆工具：三个系统共用的状态和动作（菜单 menu.mjs 用；也能单独运行）
// ──────────────────────────────────────────────
//
// 这里放「不分系统」的部分：读配置、问代理、看装了什么、端口有没有人听、检查状态、
// 启动 / 关闭 / 重启代理和酒馆。真正分系统的（Mac 的手机 adb、合盖、守护、Mac App 在不在跑）
// 留在各系统的小脚本里：Mac 是 mac/menu-status.zsh，Windows / Termux 没有这些，显示「不适用」。
//
// 只按 PID 关程序，绝不按名字：PID 来自「在这个端口上监听」的进程，
// 再确认是我们的（工作目录在代理 / 酒馆目录里、或是我们记下的 PID、或代理自己报的 PID）。
// 不依赖任何 npm 包。
//
// 单独运行：node launcher/core.mjs <check|start|stop|restart|state> [--auto]
//   --auto：不问问题、不打开浏览器（Windows 开机自动启动用）

import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readlinkSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const HERE = dirname(fileURLToPath(import.meta.url));
export const ROOT = join(HERE, '..');
export const OS = process.platform === 'darwin' ? 'mac' : process.platform === 'win32' ? 'win' : 'linux';
export const IS_TERMUX = OS === 'linux' && /com\.termux/.test(process.env.PREFIX ?? '');
export const VERSION = (() => { try { return JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version; } catch { return '?'; } })();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── 配置 ──

/**
 * 读 config.local（sh：KEY=值、export KEY=值）或 config.local.ps1（$KEY = '值'，一行可以写几个用 ; 隔开）。
 * 只认大写键名；值里的 $HOME / ${HOME} / 开头的 ~ 展开成家目录。
 */
export function parseConfig(text, home = homedir()) {
    const out = {};
    const re = /(?:^|[;\s])(?:export\s+)?\$?([A-Z_][A-Z0-9_]*)\s*=\s*("([^"]*)"|'([^']*)'|[^\s;#]*)/g;
    for (const raw of String(text).split(/\r?\n/)) {
        const line = raw.trim();
        if (!line || line.startsWith('#')) continue;
        for (const m of line.matchAll(re)) {
            let v = m[3] ?? m[4] ?? m[2];
            if (m[4] === undefined) v = v.replace(/\$\{HOME\}|\$HOME/g, home);
            if (v.startsWith('~/') || v === '~') v = home + v.slice(1);
            out[m[1]] = v;
        }
    }
    return out;
}

/** 合成配置：默认值 ← config.local ← 环境变量 PROXY_PORT；酒馆目录的自动识别和 lib.zsh / claude-max.ps1 一样。 */
export function loadConfig({ root = ROOT, env = process.env, os = OS, termux = IS_TERMUX, exists = existsSync, read = (f) => readFileSync(f, 'utf8'), home = homedir() } = {}) {
    const files = os === 'win' ? ['config.local.ps1', 'config.local'] : ['config.local'];
    let local = {};
    for (const f of files) {
        try { local = parseConfig(read(join(root, 'launcher', f)), home); break; } catch { /* 没有这个文件 */ }
    }
    const num = (v, d) => (/^\d+$/.test(String(v ?? '')) ? Number(v) : d);
    const parent = dirname(root);
    let stDir = local.ST_DIR || '';
    if (!stDir && !termux) {
        if (basename(parent) === 'plugins' && exists(join(dirname(parent), 'server.js'))) stDir = dirname(parent);
        else if (exists(join(parent, 'SillyTavern', 'server.js'))) stDir = join(parent, 'SillyTavern');
    }
    return {
        root,
        os,
        termux,
        home,
        stDir,
        // Termux：代理装在 Debian 子系统里，日志在 ~/.claude-max（见 termux/claude-max.sh）
        logDir: local.LOG_DIR || (termux ? join(home, '.claude-max') : join(root, 'data', 'logs')),
        stPort: num(local.ST_PORT, 8000),
        proxyPort: num(env.PROXY_PORT, num(local.PROXY_PORT, 8901)),
        comfyDir: local.COMFY_DIR || join(parent, 'ComfyUI'),
        comfyPort: num(local.COMFY_PORT, 8188),
        stAutostart: local.ST_AUTOSTART !== '0',
        syncHub: local.SYNC_HUB === 'tt' || local.SYNC_HUB === 'st' ? local.SYNC_HUB : '',
        moduleDir: local.TT_MODULE_DIR || join(parent, 'tt-root-module'),
        macTTData: join(home, 'Library', 'Application Support', 'com.tauritavern.client', 'data'),
        lanKeyFile: join(root, 'launcher', 'lan-key.local'),
        restartMark: join(root, 'launcher', 'restarting.local'),
    };
}

// ── 探测 ──

export async function getJson(url, fetchImpl = globalThis.fetch) {
    try {
        const r = await fetchImpl(url, { signal: AbortSignal.timeout(1500) });
        return r.ok ? await r.json() : null;
    } catch {
        return null;
    }
}

/** 端口上有没有程序在听（连得上就算）。 */
export function portOpen(port, host = '127.0.0.1', ms = 400) {
    return new Promise((resolve) => {
        const s = connect({ port, host });
        const done = (v) => { s.destroy(); resolve(v); };
        s.setTimeout(ms, () => done(false));
        s.once('connect', () => done(true));
        s.once('error', () => done(false));
    });
}

const fileNonEmpty = (f) => { try { return statSync(f).size > 0; } catch { return false; } };
const mtimeOf = (f) => { try { return statSync(f).mtime; } catch { return null; } };
const two = (n) => String(n).padStart(2, '0');
export const fmtTime = (d) => `${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}`;

export const PLAN = { max: 'Max', pro: 'Pro', team: 'Team', enterprise: 'Enterprise' };
export const planName = (t) => PLAN[t] ?? t ?? null;

export function syncHub(cfg) { return cfg.syncHub || (cfg.stDir ? 'st' : 'tt'); }
export function hasComfy(cfg, exists = existsSync) {
    const py = cfg.os === 'win' ? join(cfg.comfyDir, '.venv', 'Scripts', 'python.exe') : join(cfg.comfyDir, '.venv', 'bin', 'python');
    return exists(py) && exists(join(cfg.comfyDir, 'main.py'));
}
export function autostartOn(cfg, exists = existsSync, env = process.env) {
    if (cfg.os === 'mac') return exists(join(cfg.home, 'Library', 'LaunchAgents', 'com.claudemax.autostart.plist'));
    if (cfg.os === 'win') {
        const dir = join(env.APPDATA ?? join(cfg.home, 'AppData', 'Roaming'), 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup');
        return exists(join(dir, 'CCST 启动器.lnk')) || exists(join(dir, 'Claude Max 启动器.lnk'));
    }
    return false;
}

/** Mac：mac/menu-status.zsh 的「键<TAB>值」（只剩手机、合盖、守护这些分系统的）；其他系统没有，返回 {}。 */
export function osStatus(os = OS) {
    if (os !== 'mac') return {};
    const r = spawnSync('/bin/zsh', [join(HERE, 'mac', 'menu-status.zsh')], { encoding: 'utf8', timeout: 15000 });
    return parseTsv(r.stdout);
}
export function parseTsv(text) {
    const out = {};
    for (const line of String(text ?? '').split('\n')) {
        const i = line.indexOf('\t');
        if (i > 0) out[line.slice(0, i)] = line.slice(i + 1);
    }
    return out;
}

// ── 手机（只 Mac 有 adb 这一套）──

export const TT_PKG = 'com.tauritavern.client';
export const GUARD_MOD = '/data/adb/modules/claudemax_tt_keepalive';
export const GUARD_DIR = '/data/adb/tt-guard';
// TT 2.3.0 起生成回复时才开的前台服务（和 tt-root-module 的 common.sh 同一个名字）
const GEN_SERVICE = 'AiGenerationForegroundService';

/** 一次 adb shell 看手机：TT 开没开、在不在生成回复、TT 守护的版本 / 上次备份 / 在不在恢复。root 部分整条交给 su -c。 */
export const PHONE_PROBE = [
    `p=$(pidof ${TT_PKG}); echo "tt_pid=$p"`,
    `[ -n "$p" ] && dumpsys activity services ${TT_PKG} 2>/dev/null | grep -q ${GEN_SERVICE} && echo gen=1`,
    `su -c 'sed -n "s/^version=/guard_version=/p" ${GUARD_MOD}/module.prop 2>/dev/null; grep "^last_backup=" ${GUARD_DIR}/state.txt 2>/dev/null; `
        + `[ -e ${GUARD_DIR}/.restore.lock ] && echo restore_lock=1; [ -e ${GUARD_DIR}/restore.pending ] && echo restore_pending=1; echo su_ok=1'`,
    'echo probe_end=1',
].join('; ');

/** PHONE_PROBE 的输出 → 状态；没读全返回 null。 */
export function parsePhoneProbe(text) {
    const kv = {};
    for (const line of String(text ?? '').split(/\r?\n/)) {
        const i = line.indexOf('=');
        if (i > 0) kv[line.slice(0, i).trim()] = line.slice(i + 1).trim();
    }
    if (kv.probe_end !== '1') return null;
    const last = Number(kv.last_backup);
    return {
        ttRunning: !!kv.tt_pid,
        generating: kv.gen === '1',
        root: kv.su_ok === '1',
        guardVersion: kv.guard_version || null,
        guardLastBackup: last > 0 ? new Date(last * 1000) : null,
        restoring: kv.restore_lock === '1',
        restorePending: kv.restore_pending === '1',
    };
}

export function adbRun(adb, serial, args, { timeout = 8000, input } = {}) {
    return spawnSync(adb, ['-s', serial, ...args], { encoding: 'utf8', timeout, input, windowsHide: true });
}

export function phoneProbe(adb, serial, run = adbRun) {
    if (!adb || !serial) return null;
    const r = run(adb, serial, ['shell', PHONE_PROBE], { timeout: 6000 });
    return parsePhoneProbe(r.stdout);
}

// 代理后端的短名字（首页一行放得下）
const BACKEND_SHORT = { subscription: '订阅', apikey: 'API 密钥', bedrock: 'Bedrock', vertex: 'Vertex', gateway: '网关', openrouter: 'OpenRouter' };
export function backendInfo(backend, status) {
    const id = backend?.backend ?? status?.backend?.id ?? null;
    if (!id) return null;
    return { id, label: BACKEND_SHORT[id] ?? backend?.label ?? status?.backend?.label ?? id, missing: backend?.missing ?? [] };
}

/** 「2 小时前」这种说法。 */
export function ago(d, now = new Date()) {
    if (!d) return null;
    const m = Math.max(0, Math.round((now - d) / 60000));
    if (m < 1) return '刚刚';
    if (m < 60) return `${m} 分钟前`;
    const h = Math.round(m / 60);
    if (h < 24) return `${h} 小时前`;
    return `${Math.round(h / 24)} 天前`;
}
/** 今天的只写时:分，别的天写月-日 时:分。 */
export function clock(d, now = new Date()) {
    if (!d) return null;
    const hm = `${two(d.getHours())}:${two(d.getMinutes())}`;
    return d.toDateString() === now.toDateString() ? hm : `${two(d.getMonth() + 1)}-${two(d.getDate())} ${hm}`;
}

/**
 * 菜单要的全部状态。deps 给测试换掉：fetch、exists、mtime、portOpen、osStatus、phoneProbe。
 * 分系统的字段在别的系统上是 null / false（菜单显示「只支持 Mac」）。
 */
export async function readState(deps = {}) {
    const cfg = deps.cfg ?? loadConfig();
    const exists = deps.exists ?? existsSync;
    const mtime = deps.mtime ?? mtimeOf;
    const nonEmpty = deps.nonEmpty ?? fileNonEmpty;
    const probe = deps.portOpen ?? portOpen;
    const base = `http://127.0.0.1:${cfg.proxyPort}`;
    const comfy = hasComfy(cfg, exists);
    const [status, control, backend, stUp, comfyUp] = await Promise.all([
        getJson(`${base}/status`, deps.fetch),
        getJson(`${base}/v1/control/status`, deps.fetch),
        getJson(`${base}/v1/backend`, deps.fetch),
        cfg.stDir ? probe(cfg.stPort) : false,
        comfy ? probe(cfg.comfyPort) : false,
    ]);
    const local = (deps.osStatus ?? osStatus)(cfg.os);
    const on = (k) => local[k] === '1';
    const mac = cfg.os === 'mac';
    const hub = syncHub(cfg);
    const syncFile = join(cfg.root, 'launcher', `phone-sync-state${hub === 'tt' ? '-tt' : ''}.local.json`);
    const synced = mac && nonEmpty(syncFile) ? mtime(syncFile) : null;
    const phone = local.phone ?? null;
    const onPhone = mac && (phone === 'usb' || phone === 'wifi') ? (deps.phoneProbe ?? phoneProbe)(local.adb, local.serial) : null;
    return {
        port: cfg.proxyPort,
        proxy: !!status?.ok,
        proxyVersion: status?.version ?? null,
        repoVersion: VERSION,
        loggedIn: status ? !!status.credential?.present : null,
        backend: backendInfo(backend, status),
        plan: planName(status?.credential?.subscriptionType),
        busy: control?.busy ?? 0,
        phoneMode: (mac && nonEmpty(cfg.lanKeyFile)) || !!control?.phoneMode,
        watchdog: on('watchdog'),
        lidInstalled: on('lid_installed'),
        lidOn: on('lid_on'),
        ip: local.ip || control?.ip || '',
        phone, // usb | wifi | unauthorized | none | noadb；不是 Mac 时 null
        adb: local.adb || null,
        serial: local.serial || null,
        phoneTT: onPhone, // 手机连着时：{ ttRunning, generating, root, guardVersion, guardLastBackup, restoring, restorePending }
        lastSync: synced ? fmtTime(synced) : null,
        lastSyncAt: synced ?? null,
        hubLabel: hub === 'tt' ? 'Mac TT' : '电脑酒馆',
        stManaged: !!cfg.stDir && cfg.stAutostart,
        stRunning: !!stUp,
        hasTT: mac && exists('/Applications/TauriTavern.app'),
        macTTRunning: on('mactt_running'),
        hasComfy: comfy,
        comfyRunning: !!comfyUp,
        hasModule: exists(join(cfg.moduleDir, 'pc', 'pull-backups.sh')),
        canTTImport: mac && !!cfg.stDir && exists(join(cfg.macTTData, 'default-user')),
        autostart: autostartOn(cfg, exists),
        modeMismatch: local.mode_mismatch || '',
        adbNoRoute: on('adb_noroute'),
    };
}

// ── 进程：按端口找 PID，确认是我们的再关 ──

/** Windows `netstat -ano -p TCP` 里在这个端口上 LISTENING 的 PID。 */
export function parseNetstat(text, port) {
    const out = new Set();
    for (const line of String(text).split(/\r?\n/)) {
        const f = line.trim().split(/\s+/);
        if (f.length >= 5 && /^TCP/i.test(f[0]) && /LISTEN/i.test(f[3]) && f[1].endsWith(`:${port}`)) out.add(Number(f[4]));
    }
    return [...out].filter((n) => n > 0);
}

/** `lsof -Fpn -d cwd` 的输出 → { pid: 工作目录 }。 */
export function parseLsofCwd(text) {
    const out = {};
    let pid = null;
    for (const line of String(text).split('\n')) {
        if (line[0] === 'p') pid = Number(line.slice(1));
        else if (line[0] === 'n' && pid) out[pid] = line.slice(1);
    }
    return out;
}

const within = (path, dir) => !!dir && !!path && (path === dir || path.startsWith(dir.endsWith(sep) ? dir : dir + sep));

/** 系统相关的最小一层：列监听 PID、读工作目录、读程序名、发信号。测试里整个换掉。 */
export function systemProc(os = OS) {
    const run = (cmd, args) => spawnSync(cmd, args, { encoding: 'utf8', timeout: 8000, windowsHide: true });
    return {
        /** 监听这个端口的 PID；列不出来（没有 lsof 等）返回 null。 */
        listeners(port) {
            if (os === 'win') {
                const r = run('netstat', ['-ano', '-p', 'TCP']);
                return r.error ? null : parseNetstat(r.stdout, port);
            }
            const r = run('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t']);
            if (r.error) return null;
            return [...new Set(r.stdout.split(/\s+/).filter(Boolean).map(Number))];
        },
        cwds(pids) {
            if (!pids.length || os === 'win') return {};
            if (os === 'linux') {
                const out = {};
                for (const p of pids) { try { out[p] = readlinkSync(`/proc/${p}/cwd`); } catch { /* 看不到 */ } }
                return out;
            }
            const r = run('lsof', ['-a', '-p', pids.join(','), '-d', 'cwd', '-Fpn']);
            return parseLsofCwd(r.stdout ?? '');
        },
        name(pid) {
            if (os === 'win') {
                const r = run('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH']);
                return (r.stdout ?? '').match(/^"([^"]+)"/m)?.[1] ?? '';
            }
            return basename((run('ps', ['-o', 'comm=', '-p', String(pid)]).stdout ?? '').trim());
        },
        alive(pid) { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } },
        kill(pid, sig) { try { process.kill(pid, sig); return true; } catch { return false; } },
    };
}

/** 要管的程序：代理、酒馆。pidFile 和 claude-max.ps1 用的是同一个（两边混用不会乱）。 */
export function services(cfg) {
    const list = [{ key: 'proxy', label: 'Claude 代理', dir: cfg.root, port: cfg.proxyPort, secs: 20, pidFile: join(cfg.logDir, 'proxy.pid'), log: join(cfg.logDir, 'proxy.log') }];
    if (cfg.stDir) list.unshift({ key: 'sillytavern', label: '酒馆', dir: cfg.stDir, port: cfg.stPort, secs: 120, pidFile: join(cfg.logDir, 'sillytavern.pid'), log: join(cfg.logDir, 'sillytavern.log') });
    return list;
}

const readPidFile = (f) => { try { const n = Number(readFileSync(f, 'utf8').trim()); return n > 0 ? n : null; } catch { return null; } };

/**
 * 端口上的进程分成「我们的」和「别人的」。
 * 我们的 = 工作目录在程序目录里（Mac / Linux），或是我们记下的 PID，或是代理 /status 自己报的 PID。
 * 列不出监听进程时（Termux 没 lsof）只信代理自己报的 PID。
 */
export function classify(svc, proc, { reportedPid = null, pidFile = readPidFile } = {}) {
    const pids = proc.listeners(svc.port);
    if (pids === null) return { ours: reportedPid ? [reportedPid] : [], foreign: [], known: false };
    const cwd = proc.cwds(pids);
    const recorded = pidFile(svc.pidFile);
    const ours = [];
    const foreign = [];
    for (const p of pids) (within(cwd[p], svc.dir) || p === recorded || p === reportedPid ? ours : foreign).push(p);
    return { ours, foreign, known: true };
}

// ── 输出（和 lib.zsh 一个样子）──

export function reporter(cfg, write = (s) => process.stdout.write(s + '\n')) {
    const tty = process.stdout.isTTY && !process.env.NO_COLOR;
    const col = (code) => (s) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s);
    const [dim, bold, green, yellow, red] = ['2', '1', '32', '33', '31'].map(col);
    const log = (t) => {
        try {
            mkdirSync(cfg.logDir, { recursive: true });
            const d = new Date();
            appendFileSync(join(cfg.logDir, 'launcher.log'), `${d.getFullYear()}-${fmtTime(d)}:${two(d.getSeconds())} ${t}\n`);
        } catch { /* 日志写不了不影响动作 */ }
    };
    const r = {
        warn: 0, fail: 0,
        banner(t) { write(''); write(bold(`══ ${t} ══`) + '  ' + dim(`CCST v${VERSION}`)); log(`===== ${t} =====`); },
        step(t) { write(''); write(bold(`▶ ${t}`)); log(`[步骤] ${t}`); },
        explain(t) { write(dim(`  ${t}`)); },
        head(t) { write(`  ${bold(t)}`); },
        line(t) { write(`  ${t}`); },
        ok(t) { write(`  ${green('✓')} ${t}`); log(`[正常] ${t}`); },
        warnLine(t) { write(`  ${yellow('!')} ${t}`); log(`[提醒] ${t}`); r.warn++; },
        failLine(t) { write(`  ${red('✗')} ${t}`); log(`[错误] ${t}`); r.fail++; },
        fix(t) { write(`    ${yellow('解决办法：')}${t}`); },
        summary() {
            write(''); write(bold('──────── 结果 ────────'));
            if (r.fail) write(`  ${red(`有 ${r.fail} 个问题需要处理`)}，见上面标 ✗ 的项目和「解决办法」。`);
            else if (r.warn) write(`  ${yellow(`可以使用，但有 ${r.warn} 条提醒`)}，见上面标 ! 的项目。`);
            else write(`  ${green('一切正常。')}`);
            write(`  日志文件夹：${cfg.logDir}`);
            log(`结果：错误 ${r.fail}，提醒 ${r.warn}`);
        },
    };
    return r;
}

// ── 日志诊断（和 lib.zsh 的 diagnose_log 同一套规则）──

const LOG_RULES = [
    [/EADDRINUSE|address already in use/i, '端口被占用，程序无法监听', '在酒馆工具里先选「关闭」，再选「启动」；如果还不行，重启电脑。'],
    [/ERR_MODULE_NOT_FOUND|Cannot find module|Cannot find package/i, '缺少依赖文件（node_modules 不完整）', '在酒馆工具里选「修复依赖」重新安装。'],
    [/Native CLI binary|claude-agent-sdk-(darwin|win32|linux)/i, '找不到 Claude 命令行程序（SDK 安装不完整）', '在酒馆工具里选「修复依赖」重新安装。'],
    [/Not logged in|Please run \/login|authentication_failed|invalid_token|token has expired/i, 'Claude 订阅未登录或登录已失效', '在酒馆工具里选「登录 Claude」重新登录。'],
    [/rate.limit|(^|[^0-9.,k])429([^0-9.,k]|$)|Too many requests/im, '触发了订阅额度限流（请求太频繁或额度用完）', '稍等几分钟再试；在酒馆的 CCST 面板里可以看到额度重置时间。'],
    [/Extra Usage|out of extra usage/i, '1M 上下文需要额外用量，当前套餐不可用', '改用不带「(1M context)」的模型。'],
    [/YAMLException|config\.yaml.*(error|invalid|fail)|(error|fail).*config\.yaml/i, '酒馆配置文件 config.yaml 格式有误', '检查酒馆目录里 config.yaml 最近的改动。'],
];

/** 只看这次启动以来、最后一次成功回复之后的日志（之前的错误已经过去了）；额度查询接口的 429 不算。 */
export function recentLog(text) {
    const lines = String(text).split('\n').slice(-2000);
    let buf = [];
    for (const l of lines) {
        if (l.includes('由酒馆工具箱启动') || l.includes('] ✓ ')) buf = [];
        else buf.push(l);
    }
    return buf.slice(-300).filter((l) => !l.includes('quota endpoint')).join('\n');
}
export function diagnoseText(text) {
    const recent = recentLog(text);
    return LOG_RULES.filter(([re]) => re.test(recent)).map(([, reason, remedy]) => ({ reason, remedy }));
}

function diagnoseLog(r, files, label) {
    const found = files.filter(existsSync);
    if (!found.length) { r.explain(`（还没有${label}日志）`); return; }
    const text = found.map((f) => readFileSync(f, 'utf8')).join('\n');
    const hits = diagnoseText(text);
    for (const h of hits) { r.failLine(`${label}：${h.reason}`); r.fix(h.remedy); }
    if (!hits.length) {
        r.explain(`${label}日志里没有发现已知错误。最后几行：`);
        for (const l of text.trimEnd().split("\n").slice(-8)) r.explain(`  │ ${l.replace(/\x1b(\[[0-9;?]*[A-Za-z]|\][^\x07\x1b]*(\x07|\x1b\\))/g, "")}`);
    }
}

// ── 检查状态 ──

function loginByCli(cfg) {
    const r = spawnSync(process.execPath, [join(cfg.root, 'bin', 'claude-cli.js'), 'auth', 'status'], { cwd: cfg.root, encoding: 'utf8', timeout: 20000, windowsHide: true });
    const s = r.stdout ?? '';
    const m = s.match(/"loggedIn"\s*:\s*(true|false)/);
    return { logged: m ? m[1] === 'true' : null, plan: s.match(/"subscriptionType"\s*:\s*"([^"]*)"/)?.[1] ?? '' };
}

function selfCheck(cfg, r, st, proc) {
    r.step('自检：确认运行环境是否完整');
    const major = Number(process.versions.node.split('.')[0]);
    if (major < 18) { r.failLine(`Node.js 版本太旧：${process.version}（需要 18 或更高）`); r.fix('到 https://nodejs.org 安装新版 LTS。'); }
    else r.ok(`Node.js ${process.version}`);
    if (cfg.termux) {
        r.explain('· Termux：代理装在 Debian 子系统里，下面只通过网络检查它');
        return;
    }
    const managed = cfg.stDir && cfg.stAutostart;
    if (managed) {
        if (existsSync(join(cfg.stDir, 'server.js'))) r.ok(`酒馆程序：${cfg.stDir}`);
        else { r.failLine(`找不到酒馆程序（${join(cfg.stDir, 'server.js')}）`); r.fix('检查 launcher 里 config.local 的 ST_DIR。'); }
    } else if (cfg.stDir) r.explain('· 酒馆不随启动器启动（config.local 里 ST_AUTOSTART=0），只管理 Claude 代理');
    else r.explain('· 没有找到酒馆目录，只管理 Claude 代理（TauriTavern 用户不需要酒馆）');
    r.ok(`Claude 代理程序：${cfg.root}`);
    for (const [dir, name] of [...(managed ? [[cfg.stDir, '酒馆']] : []), [cfg.root, 'Claude 代理']]) {
        if (existsSync(join(dir, 'node_modules'))) r.ok(`${name} 依赖已安装`);
        else { r.failLine(`${name} 缺少依赖（没有 node_modules 文件夹）`); r.fix('在酒馆工具「维护」里选「修复依赖」。'); }
    }
    if (existsSync(join(cfg.root, 'node_modules', '@anthropic-ai', `claude-agent-sdk-${process.platform}-${process.arch}`, 'package.json'))) r.ok('Claude 命令行程序（SDK 自带）');
    else { r.failLine('缺少 Claude 命令行程序（SDK 的平台包没装上）'); r.fix('在酒馆工具「维护」里选「修复依赖」。'); }
    // 代理在跑就问它（快）；没在跑才起一次命令行查
    const login = st.proxy ? { logged: st.loggedIn, plan: st.plan } : loginByCli(cfg);
    if (login.logged === true) r.ok(`Claude 订阅已登录（${planName(login.plan) || '未知'} 套餐）`);
    else if (login.logged === false) { r.warnLine('Claude 订阅还没有登录 —— 酒馆能打开，但发消息会失败'); r.fix('在酒馆工具「维护」里选「登录 Claude」。'); }
    else { r.warnLine('无法读取 Claude 登录状态'); r.explain('  可能是代理依赖不完整，先处理上面的错误。'); }
    if (managed) {
        let yaml = '';
        try { yaml = readFileSync(join(cfg.stDir, 'config.yaml'), 'utf8'); } catch { /* 没有 */ }
        if (/^enableServerPlugins:\s*true/m.test(yaml)) r.ok('酒馆已开启服务器插件（酒馆页面也能读取额度和状态）');
        else { r.warnLine('酒馆 config.yaml 里没有开启 enableServerPlugins'); r.explain('  不影响对话（代理是独立启动的），只是酒馆页面会直接连代理读取状态。'); }
    }
    for (const svc of services(cfg)) {
        if (svc.key === 'sillytavern' && !managed) continue;
        const c = classify(svc, proc, { reportedPid: svc.key === 'proxy' ? st.proxyPid : null });
        if (c.ours.length) r.ok(`${svc.label} 已经在运行（端口 ${svc.port}）`);
        else if (c.foreign.length) {
            const owner = proc.name(c.foreign[0]) || '未知程序';
            r.failLine(`端口 ${svc.port} 被其他程序占用：${owner}`);
            r.fix(`关闭「${owner}」后再试，或重启电脑。`);
        } else r.ok(`端口 ${svc.port} 空闲（留给${svc.label}）`);
    }
}

async function healthCheck(cfg, r, fetchImpl = globalThis.fetch) {
    r.step('服务检查：确认真的能用');
    const s = await getJson(`http://127.0.0.1:${cfg.proxyPort}/status`, fetchImpl);
    if (!s) { r.explain('· Claude 代理：没在运行（TauriTavern 需要它才能对话）'); }
    else if (!s.ok) { r.failLine('代理有响应，但报告异常（SDK 未加载）'); }
    else if (s.credential?.present) {
        r.ok(`代理正常：http://127.0.0.1:${cfg.proxyPort}/v1（v${s.version}，${planName(s.credential.subscriptionType) || '未知'} 订阅）`);
        if (s.version && VERSION !== '?' && s.version !== VERSION) {
            r.warnLine(`代理还在跑旧版本 v${s.version}，程序已经更新到 v${VERSION}`);
            r.fix('没在生成回复时在酒馆工具里选「重启代理」。');
        }
    } else { r.warnLine('代理正常，但没有找到 Claude 登录凭据'); r.fix('在酒馆工具「维护」里选「登录 Claude」。'); }
    if (!cfg.stDir) return;
    if (!(await portOpen(cfg.stPort))) { r.explain('· 酒馆没在运行，不检查网页（只用 TauriTavern 的话不需要它）'); return; }
    let code = 0;
    try { code = (await fetchImpl(`http://127.0.0.1:${cfg.stPort}/`, { redirect: 'manual', signal: AbortSignal.timeout(5000) })).status; } catch { /* 没响应 */ }
    if ([200, 302, 401].includes(code)) r.ok(`酒馆网页可以打开：http://127.0.0.1:${cfg.stPort}（HTTP ${code}）`);
    else if (!code) r.failLine('酒馆网页打不开（没有响应）');
    else r.warnLine(`酒馆网页返回 HTTP ${code}，可能还在加载中，稍后刷新试试`);
}

/** 检查状态：不启动也不关闭任何东西。 */
export async function actionCheck(io = {}) {
    const cfg = io.cfg ?? loadConfig();
    const r = io.reporter ?? reporter(cfg);
    const proc = io.proc ?? systemProc(cfg.os);
    r.banner('检查状态（体检）');
    r.explain('只做检查，不启动也不关闭任何程序：看环境是否完整、程序有没有在运行、日志里有没有报错。');
    const st = await readState({ cfg });
    st.proxyPid = (await getJson(`http://127.0.0.1:${cfg.proxyPort}/status`))?.pid ?? null;
    selfCheck(cfg, r, st, proc);
    await healthCheck(cfg, r);
    if (st.busy) r.explain(`· 代理正在写 ${st.busy} 条回复`);
    if (cfg.os === 'mac') {
        r.step('手机');
        if (st.modeMismatch) r.warnLine(st.modeMismatch);
        if (st.phoneMode) {
            if (st.watchdog) r.ok('手机模式守护：运行中'); else { r.warnLine('手机模式开着，但守护没在运行'); r.fix('在酒馆工具「手机」里选「手机模式」修复。'); }
            if (st.lidOn) r.ok('合盖不睡：开着');
            else r.explain(st.lidInstalled ? '· 合盖不睡：已安装，现在放开着' : '· 合盖不睡：未安装（合盖会睡，手机连不上）');
        } else {
            r.explain('· 电脑模式');
            if (st.lidOn) r.warnLine('合盖不睡开着，但手机模式是关的：合盖不会睡，注意发热耗电');
        }
        const g = st.phoneTT;
        if (g) {
            r.explain(`· 手机 TT ${g.ttRunning ? (g.generating ? '开着（在生成回复）' : '开着') : '没开'}；`
                + (g.guardVersion ? `TT 守护 ${g.guardVersion}，上次备份 ${g.guardLastBackup ? `${clock(g.guardLastBackup)}（${ago(g.guardLastBackup)}）` : '还没有'}` : 'TT 守护没装'));
            if (g.restoring) r.warnLine('手机上 TT 守护正在恢复备份：恢复完之前别同步');
            if (g.restorePending) { r.warnLine('手机上次从备份恢复没做完'); r.fix('在手机 KernelSU → 模块 → TT 守护 里重新恢复。'); }
        }
        if (st.adbNoRoute) {
            r.warnLine('后台连手机的无线调试时报「No route to host」：多半是 macOS 的「本地网络」权限挡住了后台启动的 adb');
            r.fix('插一次 USB 线，或在「系统设置 → 隐私与安全性 → 本地网络」里允许「终端」。');
        }
    }
    if (cfg.os === 'mac') await checkExtUpstream(cfg, r, io);
    r.step('日志诊断：在最近的日志里查找已知错误');
    diagnoseLog(r, [join(cfg.logDir, 'proxy.log'), join(cfg.logDir, 'proxy.err.log')], '代理');
    if (cfg.stDir) diagnoseLog(r, [join(cfg.logDir, 'sillytavern.log'), join(cfg.logDir, 'sillytavern.err.log')], '酒馆');
    r.summary();
    if (io.ask && await io.ask('要打开日志文件夹吗？')) openPath(cfg.logDir, cfg.os);
    return r.fail ? 1 : 0;
}

/** 本机的第三方扩展目录：电脑酒馆的、Mac TT 的（有才算）。 */
export function extDirs(cfg, exists = existsSync) {
    const out = [];
    if (cfg.stDir) out.push({ label: '电脑酒馆', dir: join(cfg.stDir, 'public', 'scripts', 'extensions', 'third-party') });
    out.push({ label: 'Mac TT', dir: join(cfg.macTTData, 'extensions', 'third-party') });
    return out.filter((d) => exists(d.dir));
}

/** 扩展的当前分支没设上游：TT 查扩展更新会报「Embedded Git branch has no fetch remote」。你同意才设（只改 .git/config）。 */
async function checkExtUpstream(cfg, r, io, run = (args) => spawnSync('python3', [join(HERE, 'phone_sync.py'), ...args], { encoding: 'utf8', timeout: 30000 })) {
    const dirs = extDirs(cfg);
    if (!dirs.length) return;
    r.step('扩展：能不能检查更新');
    const args = dirs.flatMap((d) => ['--upstream-check', d.dir]);
    let res = null;
    try { res = JSON.parse(run(args).stdout); } catch { r.explain('· 读不了扩展的 git 信息，跳过'); return; }
    const bad = dirs.flatMap((d) => (res[d.dir] ?? []).map((u) => ({ ...u, label: d.label })));
    if (!bad.length) { r.ok('扩展的分支都设了上游（TT 能检查更新）'); return; }
    for (const u of bad) {
        r.warnLine(`扩展 ${u.name}（${u.label}）：分支 ${u.branch} 没设上游，TT 查更新会报错`);
        if (!u.target) r.explain('  没有 origin，没法自动设');
    }
    const fixable = bad.filter((u) => u.target);
    if (!fixable.length || !io.ask) { if (fixable.length) r.fix('在酒馆工具里选「检查状态」，按提示设上游；手机上的在「同步手机」里设。'); return; }
    if (!(await io.ask(`把 ${fixable.length} 个扩展设成跟 origin 的默认分支吗？（只改 .git/config，不动提交）`))) return;
    let fixed = null;
    try { fixed = JSON.parse(run([...args, '--upstream-fix']).stdout); } catch { /* 下面报 */ }
    const names = fixed ? Object.values(fixed).flat().filter((u) => u.fixed).map((u) => u.name) : [];
    if (names.length) r.ok(`设好了：${names.join('、')}（手机上的在「同步手机」里设）`);
    else r.failLine('没设成');
}

export function openPath(target, os = OS) {
    if (os === 'mac') spawnSync('open', [target]);
    else if (os === 'win') spawnSync('cmd', ['/c', 'start', '', target], { windowsHide: true });
    else spawnSync('xdg-open', [target]);
}

// ── 启动 / 关闭 / 重启 ──

/** 重启前的把关：代理在写回复就不重启（会把回复掐断）。返回拒绝的原因，没问题返回 null。 */
export function restartRefusal(control) {
    const n = control?.busy ?? 0;
    return n > 0 ? `代理正在写 ${n} 条回复，现在重启会把它掐断。等写完再来。` : null;
}

/** 关一个程序：只关端口上确认是我们的 PID；先 TERM，最多等 10 秒，没退出再强制。 */
export async function stopService(svc, r, proc, { reportedPid = null, wait = sleep, mark = () => {} } = {}) {
    const c = classify(svc, proc, { reportedPid });
    if (!c.ours.length) {
        if (c.foreign.length) r.explain(`· 端口 ${svc.port} 上是别的程序（${proc.name(c.foreign[0]) || '未知'}），不是本工具启动的，不动它`);
        else r.ok(`${svc.label} 本来就没有运行`);
        return true;
    }
    mark();
    for (const p of c.ours) proc.kill(p, 'SIGTERM');
    for (let i = 0; i < 50 && c.ours.some((p) => proc.alive(p)); i++) await wait(200);
    const left = c.ours.filter((p) => proc.alive(p));
    if (!left.length) { r.ok(`已关闭${svc.label}`); cleanPid(svc); return true; }
    for (const p of left) proc.kill(p, 'SIGKILL');
    await wait(1000);
    const still = left.filter((p) => proc.alive(p));
    if (!still.length) { r.warnLine(`${svc.label} 没有正常退出，已强制关闭`); cleanPid(svc); return true; }
    r.failLine(`${svc.label} 无法关闭（进程 ${still.join(' ')}）`);
    r.fix('重启电脑即可。');
    return false;
}
function cleanPid(svc) { try { unlinkSync(svc.pidFile); } catch { /* 没有 */ } }

/** 在后台启动一个程序（自己一个进程组，关掉菜单窗口不影响），等端口出现。 */
export async function startService(svc, r, proc, cfg, { reportedPid = null } = {}) {
    const c = classify(svc, proc, { reportedPid });
    if (c.ours.length) { r.ok(`${svc.label} 已经在运行，跳过`); return true; }
    if (c.foreign.length) {
        const owner = proc.name(c.foreign[0]) || '未知程序';
        r.failLine(`端口 ${svc.port} 被其他程序占着：${owner}，${svc.label}启动不了`);
        r.fix(`关闭「${owner}」后再试，或重启电脑。`);
        return false;
    }
    mkdirSync(cfg.logDir, { recursive: true });
    // 超过 5MB 改名为 .old，只留一份旧日志
    try { if (statSync(svc.log).size > 5 * 1024 * 1024) renameSync(svc.log, svc.log + '.old'); } catch { /* 还没有日志 */ }
    appendFileSync(svc.log, `\n──────── ${new Date().toLocaleString('zh-CN', { hour12: false })} 由酒馆工具箱启动 ────────\n`);
    const env = { ...process.env };
    if (svc.key === 'proxy') {
        // 端口要告诉代理：config.local 里改了 PROXY_PORT 时，代理自己的默认值还是 8901
        env.CLAUDE_SUBSCRIPTION_PORT = String(svc.port);
        if (fileNonEmpty(cfg.lanKeyFile)) {
            r.explain('手机连接已开启：同一 Wi-Fi 下的设备带访问密码可以连这个代理。');
            env.CLAUDE_SUBSCRIPTION_HOST = '0.0.0.0';
            env.CLAUDE_SUBSCRIPTION_LAN_KEY = readFileSync(cfg.lanKeyFile, 'utf8').trim();
        }
    }
    const fd = openSync(svc.log, 'a');
    let exited = false;
    const child = spawn(process.execPath, ['server.js'], { cwd: svc.dir, env, detached: true, stdio: ['ignore', fd, fd], windowsHide: true });
    closeSync(fd);
    child.on('exit', () => { exited = true; });
    child.on('error', () => { exited = true; });
    child.unref();
    if (child.pid) writeFileSync(svc.pidFile, String(child.pid));
    const start = Date.now();
    let next = 10;
    while (Date.now() - start < svc.secs * 1000) {
        if (await portOpen(svc.port)) { r.ok(`${svc.label} 已启动：http://127.0.0.1:${svc.port}${svc.key === 'proxy' ? '/v1' : ''}`); return true; }
        if (exited) break;
        await sleep(300);
        if ((Date.now() - start) / 1000 >= next) { r.explain(`已等待 ${next} 秒…`); next += 10; }
    }
    r.failLine(exited ? `${svc.label}启动后马上退出了` : `${svc.label} ${svc.secs} 秒内没有启动成功`);
    diagnoseLog(r, [svc.log], svc.label);
    return false;
}

async function reportedProxyPid(cfg) {
    return (await getJson(`http://127.0.0.1:${cfg.proxyPort}/status`))?.pid ?? null;
}

async function stopAll(cfg, r, proc) {
    r.step(cfg.stDir ? '关闭酒馆和 Claude 代理' : '关闭 Claude 代理');
    const pid = await reportedProxyPid(cfg);
    let ok = true;
    for (const svc of services(cfg)) {
        const mark = svc.key === 'proxy' ? () => { try { writeFileSync(cfg.restartMark, ''); } catch { /* 标记写不了不要紧 */ } } : undefined;
        ok = (await stopService(svc, r, proc, { reportedPid: svc.key === 'proxy' ? pid : null, mark })) && ok;
    }
    return ok;
}

async function startAll(cfg, r, proc) {
    const managed = cfg.stDir && cfg.stAutostart;
    const list = services(cfg).filter((s) => s.key === 'proxy' || managed);
    r.step(managed ? `启动 Claude 代理（端口 ${cfg.proxyPort}）和酒馆（端口 ${cfg.stPort}）` : `启动 Claude 代理（端口 ${cfg.proxyPort}）`);
    if (managed) r.explain('酒馆首次启动或更新后需要编译前端，可能要 10–60 秒，请耐心等待。');
    const pid = await reportedProxyPid(cfg);
    // 酒馆编译前端最慢：两个同时启动
    const res = await Promise.all(list.map((svc) => startService(svc, r, proc, cfg, { reportedPid: svc.key === 'proxy' ? pid : null })));
    try { unlinkSync(cfg.restartMark); } catch { /* 没有 */ }
    return { proxyOk: res[list.findIndex((s) => s.key === 'proxy')], stOk: managed ? res[0] : false };
}

function preflight(cfg, r) {
    if (cfg.termux) return;
    if (!existsSync(join(cfg.root, 'node_modules'))) { r.failLine('Claude 代理缺少依赖（没有 node_modules 文件夹）'); r.fix('在酒馆工具「维护」里选「修复依赖」。'); }
    if (cfg.stDir && cfg.stAutostart && !existsSync(join(cfg.stDir, 'node_modules'))) { r.failLine('酒馆缺少依赖（没有 node_modules 文件夹）'); r.fix('在酒馆工具「维护」里选「修复依赖」。'); }
}

async function afterStart(cfg, r, { stOk }, io) {
    await healthCheck(cfg, r);
    r.summary();
    if (io.auto) return;
    if (stOk) { r.explain(`正在打开浏览器：http://127.0.0.1:${cfg.stPort}`); openPath(`http://127.0.0.1:${cfg.stPort}`, cfg.os); }
    else if (!(cfg.stDir && cfg.stAutostart)) r.explain('代理已就绪。打开 TauriTavern（或你的酒馆），在 CCST 面板里点「一键连接」。');
}

export async function actionStart(io = {}) {
    const cfg = io.cfg ?? loadConfig();
    const r = io.reporter ?? reporter(cfg);
    const proc = io.proc ?? systemProc(cfg.os);
    r.banner('启动');
    preflight(cfg, r);
    if (r.fail && !io.auto && io.ask && !(await io.ask('发现问题，仍然尝试启动吗？'))) { r.summary(); return 1; }
    const res = await startAll(cfg, r, proc);
    await afterStart(cfg, r, res, io);
    return res.proxyOk ? 0 : 1;
}

export async function actionStop(io = {}) {
    const cfg = io.cfg ?? loadConfig();
    const r = io.reporter ?? reporter(cfg);
    const proc = io.proc ?? systemProc(cfg.os);
    r.banner('关闭');
    r.explain('只会关闭本工具启动的程序（按端口上的进程号），不影响电脑上的其他程序。聊天记录都已保存。');
    const busy = (await getJson(`http://127.0.0.1:${cfg.proxyPort}/v1/control/status`))?.busy ?? 0;
    if (busy > 0) {
        r.warnLine(`代理正在写 ${busy} 条回复，现在关闭会把它掐断（那条回复要重新生成）`);
        if (!io.ask || !(await io.ask('仍然现在关闭吗？（选 N 就等写完再来）'))) { r.warnLine('没有关闭。等这条回复写完再来。'); r.summary(); return 0; }
    }
    const ok = await stopAll(cfg, r, proc);
    r.summary();
    return ok ? 0 : 1;
}

export async function actionRestart(io = {}) {
    const cfg = io.cfg ?? loadConfig();
    const r = io.reporter ?? reporter(cfg);
    const proc = io.proc ?? systemProc(cfg.os);
    r.banner('重启');
    const why = restartRefusal(await getJson(`http://127.0.0.1:${cfg.proxyPort}/v1/control/status`));
    if (why) { r.warnLine(`没有重启：${why}`); r.summary(); return 0; }
    preflight(cfg, r);
    if (r.fail && io.ask && !(await io.ask('发现问题，仍然要重启吗？（现在运行着的会先关掉）'))) { r.summary(); return 1; }
    if (!(await stopAll(cfg, r, proc))) { r.summary(); return 1; }
    const res = await startAll(cfg, r, proc);
    await afterStart(cfg, r, res, io);
    return res.proxyOk ? 0 : 1;
}

export const ACTIONS = { check: actionCheck, start: actionStart, stop: actionStop, restart: actionRestart };

// ── 单独运行 ──

async function cliAsk(q) {
    if (!process.stdin.isTTY) return false;
    const { createInterface } = await import('node:readline/promises');
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const a = await rl.question(`  ${q} (y/N) `);
    rl.close();
    return /^y/i.test(a.trim());
}

const self = (p) => (OS === 'win' ? p.toLowerCase() : p);
if (process.argv[1] && self(fileURLToPath(import.meta.url)) === self(resolve(process.argv[1]))) {
    const [cmd = 'check', ...flags] = process.argv.slice(2);
    const auto = flags.includes('--auto');
    if (cmd === 'state') {
        readState().then((s) => { process.stdout.write(JSON.stringify(s, null, 2) + '\n'); });
    } else if (!ACTIONS[cmd]) {
        process.stderr.write(`用法：node launcher/core.mjs <${Object.keys(ACTIONS).join('|')}|state> [--auto]\n`);
        process.exit(2);
    } else {
        ACTIONS[cmd]({ auto, ask: auto ? null : cliAsk }).then((code) => process.exit(code));
    }
}

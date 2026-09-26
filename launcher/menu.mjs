#!/usr/bin/env node
// ──────────────────────────────────────────────
// CCST 酒馆工具：菜单（Mac / Windows / Termux 共用一份）
// ──────────────────────────────────────────────
//
// 各系统只留一个启动壳（mac/酒馆工具.command、windows/酒馆工具.bat、termux/claude-max.sh menu），
// 菜单的分组、说明、问题判断都在这里。动作仍由各系统自己的脚本做：
//   Mac      mac/actions/<id>.zsh（+ mac/menu-status.zsh 给手机、同步等本机状态）
//   Windows  windows/claude-max.ps1 <动作>
//   Termux   termux/claude-max.sh <动作>
// 不依赖任何 npm 包：依赖坏了的时候（菜单里正好有「修复依赖」）也要能打开。
//
// 按键：数字 / 字母直接执行；↑↓ 选、回车执行；0、Esc 返回；h 说明；q 退出。
// 不是终端（管道、测试）时退回「输入编号回车」。CCST_MENU_PLAIN=1 也强制用这种方式。

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { emitKeypressEvents } from 'node:readline';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const OS = process.platform === 'darwin' ? 'mac' : process.platform === 'win32' ? 'win' : 'linux';
const VERSION = (() => { try { return JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version; } catch { return '?'; } })();

// ── 显示宽度（中文两格）和颜色 ──

export function width(s) {
    let w = 0;
    for (const ch of String(s).replace(/\x1b\[[0-9;]*m/g, '')) {
        const c = ch.codePointAt(0);
        w += (c >= 0x1100 && c <= 0x115f) || (c >= 0x2e80 && c <= 0xa4cf) || (c >= 0xac00 && c <= 0xd7a3)
            || (c >= 0xf900 && c <= 0xfaff) || (c >= 0xfe30 && c <= 0xfe4f) || (c >= 0xff00 && c <= 0xff60)
            || (c >= 0xffe0 && c <= 0xffe6) || c >= 0x20000 ? 2 : 1;
    }
    return w;
}
export const pad = (s, n) => s + ' '.repeat(Math.max(0, n - width(s)));
const COLOR = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code) => (s) => (COLOR ? `\x1b[${code}m${s}\x1b[0m` : s);
const c = { dim: paint('2'), bold: paint('1'), ok: paint('32'), warn: paint('33'), bad: paint('31'), key: paint('36'), inv: paint('7') };
const RULE = ' ' + '-'.repeat(58);

// ── 配置和状态 ──

function proxyPort() {
    if (/^\d+$/.test(process.env.PROXY_PORT ?? '')) return Number(process.env.PROXY_PORT);
    for (const f of ['config.local', 'config.local.ps1']) {
        try {
            const m = readFileSync(join(HERE, f), 'utf8').match(/^\s*\$?(?:export\s+)?PROXY_PORT\s*=\s*["']?(\d+)/m);
            if (m) return Number(m[1]);
        } catch { /* 没有这个文件 */ }
    }
    return 8901;
}

async function getJson(url) {
    try {
        const r = await fetch(url, { signal: AbortSignal.timeout(1500) });
        return r.ok ? await r.json() : null;
    } catch {
        return null;
    }
}

/** Mac：menu-status.zsh 的「键<TAB>值」；其他系统没有这些。 */
function localStatus() {
    if (OS !== 'mac') return {};
    const r = spawnSync('/bin/zsh', [join(HERE, 'mac', 'menu-status.zsh')], { encoding: 'utf8', timeout: 15000 });
    const out = {};
    for (const line of (r.stdout ?? '').split('\n')) {
        const i = line.indexOf('\t');
        if (i > 0) out[line.slice(0, i)] = line.slice(i + 1);
    }
    return out;
}

export async function readState() {
    const port = proxyPort();
    const [status, control] = await Promise.all([
        getJson(`http://127.0.0.1:${port}/status`),
        getJson(`http://127.0.0.1:${port}/v1/control/status`),
    ]);
    const local = localStatus();
    const on = (k) => local[k] === '1';
    return {
        port,
        proxy: !!status?.ok,
        proxyVersion: status?.version ?? null,
        loggedIn: status ? !!status.credential?.present : null,
        plan: { max: 'Max', pro: 'Pro', team: 'Team', enterprise: 'Enterprise' }[status?.credential?.subscriptionType] ?? status?.credential?.subscriptionType ?? null,
        busy: control?.busy ?? 0,
        phoneMode: on('phone_mode') || !!control?.phoneMode,
        watchdog: on('watchdog'),
        lidInstalled: on('lid_installed'),
        lidOn: on('lid_on'),
        ip: local.ip || control?.ip || '',
        phone: local.phone ?? null, // usb | wifi | unauthorized | none | noadb
        lastSync: local.last_sync ?? null,
        hubLabel: local.hub_label ?? '',
        stManaged: on('st_managed'),
        stRunning: on('st_running'),
        hasTT: on('has_tt'),
        macTTRunning: on('mactt_running'),
        hasComfy: on('has_comfy'),
        comfyRunning: on('comfy_running'),
        hasModule: on('has_module'),
        canTTImport: on('can_tt_import'),
        autostart: on('autostart'),
    };
}

// ── 菜单内容：只描述「有什么、叫什么、什么时候能用」，怎么做交给 run() ──

/** 要处理的问题，每条带一个修复动作（没有就只提示）。 */
export function problems(s) {
    const out = [];
    if (!s.proxy) out.push({ text: '代理没在运行', fix: 'start', fixLabel: '启动代理' });
    else if (s.loggedIn === false) out.push({ text: 'Claude 还没登录', fix: 'login', fixLabel: '登录' });
    if (s.proxy && s.proxyVersion && s.proxyVersion !== VERSION) {
        out.push({ text: `代理还在跑 v${s.proxyVersion}（本地代码 v${VERSION}）`, fix: 'restart', fixLabel: '重启代理' });
    }
    if (s.phoneMode && !s.watchdog && OS === 'mac') out.push({ text: '手机模式的守护没在运行', fix: 'phone-mode', fixLabel: '修复' });
    if (s.phone === 'unauthorized') out.push({ text: '手机上还没允许这台电脑调试', fixLabel: '在手机上点「允许」' });
    return out;
}

const MAC_ONLY = '目前只支持 Mac';

/** 一个菜单项：key 按键、id 动作、label 名字、note 说明；why 有值时灰着显示原因。 */
export function screens(s) {
    const mac = OS === 'mac';
    const openLabel = s.stManaged ? '打开酒馆' : s.hasTT || !mac ? '打开 TauriTavern' : '打开酒馆';
    const home = {
        title: '首页',
        primary: { id: 'start', label: s.proxy ? openLabel : `启动代理${s.stManaged ? '和酒馆' : ''}` },
        rows: [[
            { key: '1', id: 'restart', label: s.stManaged ? '重启代理和酒馆' : '重启代理' },
            { key: '2', id: 'stop', label: s.stManaged ? '关闭代理和酒馆' : '关闭代理' },
            { key: '3', id: 'phone-sync', label: '手机同步', why: mac ? null : MAC_ONLY },
            { key: '4', id: 'check', label: '检查状态' },
        ], [
            { key: '5', sub: 'phone', label: '手机 >' },
            ...(mac && s.hasComfy ? [{ key: '6', sub: 'comfy', label: '生图 >' }] : []),
            { key: '7', sub: 'maint', label: '维护 >' },
        ]],
    };
    const phone = {
        title: '手机',
        note: mac
            ? `${s.phoneMode ? '手机模式 开' + (s.watchdog ? '（守护中）' : '（守护没在运行）') : '电脑模式'}  ·  ${phoneText(s.phone)}${s.lastSync ? `  ·  上次同步 ${s.lastSync}` : ''}`
            : '手机相关功能目前只支持 Mac。',
        items: [
            { key: '1', id: 'phone-sync', label: '手机同步', note: `${s.hubLabel || '电脑'} <-> 手机：聊天、角色、世界书、预设`, why: mac ? null : MAC_ONLY },
            { key: '2', id: 'phone-mode', label: s.phoneMode ? '切到电脑模式' : '切到手机模式', note: s.phoneMode ? '关掉防睡眠和掉线重启' : '同一 Wi-Fi 的手机用这台 Mac 的代理', why: mac ? null : MAC_ONLY },
            { group: '一次性设置' },
            { key: '3', id: 'lid', label: '合盖不睡', note: s.lidInstalled ? '已安装 · 装 / 卸' : '没安装 · 装 / 卸（输一次密码）', why: mac ? null : MAC_ONLY },
            { key: '4', id: 'keepalive-module', label: '安卓保活模块', note: '看状态 / 更新（KernelSU）', why: !mac ? MAC_ONLY : s.hasModule ? null : '需要 tt-root-module（clone 到本仓库同级目录）' },
        ],
    };
    const comfy = {
        title: '生图',
        note: `本地 ComfyUI ${s.comfyRunning ? '运行中' : '没运行'}（用 NovelAI 出图不需要它）`,
        items: [
            s.comfyRunning
                ? { key: '1', id: 'comfy-stop', label: '关闭生图', note: '很占内存，不用时关掉' }
                : { key: '1', id: 'comfy-start', label: '启动生图', note: '本地 ComfyUI，端口 8188' },
        ],
    };
    const maint = {
        title: '维护',
        items: [
            { key: '1', id: 'login', label: '登录 Claude', note: s.loggedIn ? `已登录${s.plan ? `（${s.plan}）` : ''}` : '浏览器登录订阅，一般只要一次' },
            { key: '2', id: 'repair', label: '修复依赖', note: '报「缺少依赖 / Cannot find module」时' },
            { key: '3', id: 'logs', label: '打开日志', note: '出错时附上最后几十行求助' },
            { key: '4', id: 'autostart-toggle', label: '开机自动启动', note: s.autostart ? '已开 · 开 / 关' : '没开 · 开 / 关' },
            ...(mac ? [{ group: '工具' },
                { key: '5', id: 'baibai-import', label: '导入柏宝绘配方', note: '把「提示词拆分」导出的配方写进酒馆和手机' },
                { key: '6', id: 'prompt-split', label: '提示词拆分', note: '打开本机网页工具' },
                ...(s.canTTImport ? [{ key: '7', id: 'tt-import', label: '本机TT导入', note: '测试用：电脑酒馆 -> 这台 Mac 的 TauriTavern' }] : []),
            ] : []),
        ],
    };
    return { home, phone, comfy, maint };
}

function phoneText(p) {
    return { usb: '手机 USB 已连', wifi: '手机 无线已连', unauthorized: '手机 待授权', noadb: '没找到 adb' }[p] ?? '手机 没连';
}

// ── 执行动作 ──

const WIN_ACTIONS = { start: 'start', stop: 'stop', restart: 'restart', check: 'status', login: 'login', repair: 'repair', logs: 'logs', 'autostart-toggle': 'autostart' };
const LINUX_ACTIONS = { start: 'start', stop: 'stop', restart: 'restart', check: 'status', login: 'login', logs: 'logs' };

function run(id) {
    const env = { ...process.env, CM_MENU: '1' };
    let r;
    if (OS === 'mac') {
        const f = join(HERE, 'mac', 'actions', `${id}.zsh`);
        if (!existsSync(f)) return `找不到动作脚本 ${id}`;
        r = spawnSync('/bin/zsh', [f], { stdio: 'inherit', env });
    } else if (OS === 'win') {
        if (!WIN_ACTIONS[id]) return `「${id}」目前只支持 Mac`;
        r = spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(HERE, 'windows', 'claude-max.ps1'), WIN_ACTIONS[id]], { stdio: 'inherit', env });
    } else {
        if (!LINUX_ACTIONS[id]) return `「${id}」目前只支持 Mac`;
        r = spawnSync('bash', [join(HERE, 'termux', 'claude-max.sh'), LINUX_ACTIONS[id]], { stdio: 'inherit', env });
    }
    return r.status === 0 ? null : `结束（退出码 ${r.status ?? r.signal}）`;
}

function openHelp() {
    const f = join(HERE, '使用说明.txt');
    if (OS === 'mac') spawnSync('open', [f]);
    else if (OS === 'win') spawnSync('cmd', ['/c', 'start', '', f]);
    else console.log(readFileSync(f, 'utf8'));
}

// ── 画面 ──

function header(s, title) {
    const now = new Date();
    const t = `${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
    const left = ` ${c.bold('酒馆工具')}${title === '首页' ? '' : ` > ${title}`}  ${c.dim('CCST v' + VERSION)}`;
    return [pad(left, 50) + c.dim(t), RULE];
}

function statusBlock(s, probs) {
    const lines = [];
    if (!probs.length) lines.push(`  ${c.ok('[OK] 一切正常')}`);
    else {
        lines.push(`  ${c.bad(`[!!] ${probs.length} 个问题要处理`)}`);
        const w = Math.max(...probs.map((p) => width(p.text))) + 2;
        probs.forEach((p, i) => lines.push(`   ${c.key(String.fromCharCode(97 + i))}  ${pad(p.text, w)}${p.fix ? `-> ${p.fixLabel}` : c.dim(p.fixLabel)}`));
    }
    const facts = [`代理 ${s.proxy ? c.ok('运行中') : c.dim('没运行')}`];
    if (s.proxy && s.loggedIn) facts.push(`Claude 已登录${s.plan ? `（${s.plan}）` : ''}`);
    if (s.busy) facts.push(c.warn(`正在写 ${s.busy} 条回复`));
    lines.push('  ' + facts.join('  ·  '));
    if (OS === 'mac') {
        const m = [s.phoneMode ? `手机模式${s.watchdog ? ' 守护中' : ''}${s.lidOn ? ' 合盖不睡' : ''}` : '电脑模式'];
        if (s.phoneMode && s.ip) m.push(`Mac ${s.ip}`);
        m.push(phoneText(s.phone));
        if (s.lastSync) m.push(`上次同步 ${s.lastSync}`);
        lines.push('  ' + m.join('  ·  '));
    }
    return lines;
}

function renderHome(s, sel, msg) {
    const { home } = screens(s);
    const probs = problems(s);
    const L = [...header(s, '首页'), ...statusBlock(s, probs), RULE];
    const mark = (i, text) => (sel === i ? c.inv(text) : text);
    L.push(`  ${mark(0, `${c.key('回车')}  ${home.primary.label}`)}`, '');
    let i = 1;
    for (const row of home.rows) {
        L.push('   ' + row.map((it) => mark(i++, it.why ? c.dim(`${it.key} ${it.label}`) : `${c.key(it.key)} ${it.label}`)).join('    '), '');
    }
    L.push(RULE, `  ${c.dim('按键直接执行 · ↑↓ 选、回车执行 · h 说明 · q 退出')}`);
    if (msg) L.push('', `  ${c.warn(msg)}`);
    return { text: L.join('\n'), actions: [home.primary, ...home.rows.flat()], probs };
}

function renderSub(s, name, sel, msg) {
    const scr = screens(s)[name];
    const L = [...header(s, scr.title)];
    if (scr.note) L.push(`  ${scr.note}`, RULE);
    const actions = [];
    for (const it of scr.items) {
        if (it.group) { L.push('', `  ${c.dim(it.group)}`); continue; }
        const idx = actions.push(it) - 1;
        const line = `   ${it.why ? c.dim(it.key) : c.key(it.key)}  ${pad(it.label, 14)}${c.dim(it.why ?? it.note ?? '')}`;
        L.push(sel === idx ? c.inv(line) : line);
    }
    L.push('', RULE, `  ${c.dim('按键直接执行 · ↑↓ 选、回车执行 · 0 / Esc 返回 · q 退出')}`);
    if (msg) L.push('', `  ${c.warn(msg)}`);
    return { text: L.join('\n'), actions };
}

// ── 主循环 ──

function readKey() {
    return new Promise((resolve) => {
        const onKey = (str, key) => { process.stdin.off('keypress', onKey); resolve({ str, key: key ?? {} }); };
        process.stdin.on('keypress', onKey);
    });
}

// 不是终端时一行一个按键；管道里一次给多行也要一行一行用，不能丢
let lineBuf = '';
let stdinEnded = false;
async function readLine(prompt) {
    process.stdout.write(prompt);
    const take = () => {
        const i = lineBuf.indexOf('\n');
        if (i < 0) return undefined;
        const line = lineBuf.slice(0, i).trim();
        lineBuf = lineBuf.slice(i + 1);
        return line;
    };
    const ready = take();
    if (ready !== undefined) return ready;
    if (stdinEnded) return lineBuf ? (() => { const l = lineBuf.trim(); lineBuf = ''; return l; })() : null;
    return new Promise((resolve) => {
        const onData = (d) => {
            lineBuf += d;
            const line = take();
            if (line !== undefined) { cleanup(); resolve(line); }
        };
        const onEnd = () => { stdinEnded = true; cleanup(); const l = lineBuf.trim(); lineBuf = ''; resolve(l || null); };
        const cleanup = () => { process.stdin.off('data', onData); process.stdin.off('end', onEnd); process.stdin.pause(); };
        process.stdin.setEncoding('utf8');
        process.stdin.on('data', onData);
        process.stdin.on('end', onEnd);
        process.stdin.resume();
    });
}

async function main() {
    const plain = !process.stdin.isTTY || process.env.CCST_MENU_PLAIN === '1';
    if (!plain) emitKeypressEvents(process.stdin);
    let screen = 'home';
    let sel = 0;
    let msg = '';
    for (;;) {
        const s = await readState();
        const view = screen === 'home' ? renderHome(s, sel, msg) : renderSub(s, screen, sel, msg);
        msg = '';
        if (!plain) process.stdout.write('\x1b[2J\x1b[H');
        process.stdout.write(view.text + '\n');

        let pressed;
        if (plain) {
            const line = await readLine('\n输入按键回车：');
            if (line === null) return 0;
            pressed = { str: line === '' ? '\r' : line, key: line === '' ? { name: 'return' } : {} };
        } else {
            process.stdin.setRawMode(true);
            process.stdin.resume();
            pressed = await readKey();
            process.stdin.setRawMode(false);
            process.stdin.pause();
        }
        const { str, key } = pressed;
        const k = String(str ?? '').toLowerCase();
        if (key.ctrl && key.name === 'c') return 0;
        if (k === 'q') return 0;
        if (k === 'h') { openHelp(); continue; }
        if (key.name === 'up') { sel = Math.max(0, sel - 1); continue; }
        if (key.name === 'down') { sel = Math.min(view.actions.length - 1, sel + 1); continue; }
        if (screen !== 'home' && (k === '0' || key.name === 'escape' || key.name === 'backspace' || key.name === 'left')) { screen = 'home'; sel = 0; continue; }

        let item = null;
        if (key.name === 'return' || k === '\r') item = view.actions[sel] ?? null;
        else if (screen === 'home' && /^[a-z]$/.test(k) && view.probs?.[k.charCodeAt(0) - 97]) {
            const p = view.probs[k.charCodeAt(0) - 97];
            if (!p.fix) { msg = p.fixLabel; continue; }
            item = { id: p.fix, label: p.fixLabel };
        } else item = view.actions.find((a) => a.key === k) ?? null;

        if (!item) { if (k.trim()) msg = `没有「${k}」这一项`; continue; }
        if (item.why) { msg = `${item.label.replace(/ >$/, '')}：${item.why}`; continue; }
        if (item.sub) { screen = item.sub; sel = 0; continue; }
        if (!plain) process.stdout.write('\x1b[2J\x1b[H');
        const err = run(item.id);
        msg = err ? `${item.label}：${err}` : '';
        sel = screen === 'home' ? 0 : sel;
    }
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('menu.mjs')) {
    main().then((code) => { process.stdout.write('\n'); process.exit(code ?? 0); });
}

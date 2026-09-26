#!/usr/bin/env node
// ──────────────────────────────────────────────
// CCST 酒馆工具：手机同步、TT 守护（只 Mac 有：要 adb 和 mac/*.zsh）
// ──────────────────────────────────────────────
//
// 同步 = 看两边 → 预览 → 你选拿不准的 → 快照 → 执行 → 核对。
//   · 预览分三组：自动（只有一边改过，不用问）、要你选、跳过（判断不了）。计划由 phone_sync.py --plan-json 算，
//     这里只负责问和显示；你选的交给 phone_sync.py --choices 执行（快照、备份、从不删文件都在它那里）。
//   · 不问问题（--auto，或不是终端）：「要你选」的按安全默认——冲突用较新的并留冲突副本，API 设置和密钥不动。
//   · 手机上的 TT 守护正在恢复备份：不同步；上次恢复没做完：问你。
// TT 守护（tt-root-module）：看版本 / 更新（只提示去 KernelSU 里更新，从不 adb 安装）、立即拉一次备份、
//   电脑自动拉备份开关（pc/install-mac.sh）、从备份恢复（ui.sh restore，TT 要先在手机上关掉，这里不替你关）。
// 从不运行 adb kill-server（TT 守护的定时任务每分钟都在用 adb）。不依赖任何 npm 包。
//
// 单独运行：node launcher/phone.mjs <sync|guard-status|guard-pull|guard-auto|guard-restore> [--auto]

import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { GUARD_MOD, HERE, OS, TT_PKG, adbRun, ago, clock, getJson, loadConfig, osStatus, phoneProbe, portOpen, reporter, syncHub } from './core.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const UPDATE_JSON = 'https://raw.githubusercontent.com/kcgoofee-jpg/tt-root-module/main/update.json';
export const PULL_JOB = 'com.ttguard.pull-backups';

// ── 同步中心（和 lib.zsh 的 hub_sync_args 一样）──

export function hubLabel(cfg) { return syncHub(cfg) === 'tt' ? 'Mac TT' : '电脑酒馆'; }

export function hubSyncArgs(cfg, exists = existsSync) {
    const stExt = cfg.stDir ? join(cfg.stDir, 'public', 'scripts', 'extensions', 'third-party') : '';
    const extDir = stExt && exists(stExt) ? stExt : join(cfg.macTTData, 'extensions', 'third-party');
    const a = syncHub(cfg) === 'tt'
        ? ['--st', join(cfg.macTTData, 'default-user'), '--local-name', 'Mac TT', '--state', join(cfg.root, 'launcher', 'phone-sync-state-tt.local.json')]
        : ['--st', join(cfg.stDir, 'data', 'default-user'), '--state', join(cfg.root, 'launcher', 'phone-sync-state.local.json')];
    return [...a, '--backups', join(dirname(cfg.root), 'backups'), '--port', String(cfg.proxyPort), '--ext-dir', extDir];
}

export function hubProblem(cfg, exists = existsSync) {
    if (syncHub(cfg) === 'tt') return exists(join(cfg.macTTData, 'default-user')) ? null : '这台 Mac 上没找到 TauriTavern 的数据（装好并打开过一次才有）';
    return cfg.stDir ? null : 'Mac 上没有酒馆数据';
}

// ── 预览：把 phone_sync.py 的计划排成三组 ──

const short = (rel) => basename(rel).replace(/\.jsonl$/, '');
const list = (xs, n = 3) => xs.slice(0, n).map(short).join('、') + (xs.length > n ? ` 等 ${xs.length} 个` : '');
const whose = (plan, side) => (side === 'local' ? plan.local : plan.remote);
// 中文紧跟英文 / 数字时空一格（「Mac TT 的」「手机的」）
const sp = (x) => (/[A-Za-z0-9]$/.test(x) ? `${x} ` : x);

/**
 * 要你选的事，一条一个问题：{ key, text, question, options, def, apply(choices, i) }。
 * ctx：{ phone: { running, generating }, macRunning, busy }（要不要关 TT、默认等不等）。
 */
export function questions(plan, ctx = {}) {
    const L = plan.local, R = plan.remote;
    const qs = [];
    const chats = plan.ask.chats;
    const setFile = (rel, v) => (c) => { c.files[rel] = v; };
    if (chats.length > 5) {
        qs.push({
            text: `${chats.length} 个聊天两边都改过（${list(chats.map((c) => c.rel))}）`,
            question: `${chats.length} 个两边都改过的聊天怎么办？`,
            options: ['每个都两份都留（较新的当正本）', `全部用 ${sp(L)}的`, `全部用${sp(R)}的`.replace(/^全部用(?=[A-Za-z])/, '全部用 ')],
            def: 0,
            apply: (c, i) => { for (const x of chats) c.files[x.rel] = ['both', 'local', 'remote'][i]; },
        });
    } else {
        for (const x of chats) {
            const more = [x.extra.local && `${sp(L)}多 ${x.extra.local} 楼`, x.extra.remote && `${sp(R)}多 ${x.extra.remote} 楼`].filter(Boolean).join('，') || '楼层一样、内容不同';
            qs.push({
                text: `聊天「${short(x.rel)}」两边都改过（${more}；${sp(whose(plan, x.newer))}的较新）`,
                question: `聊天「${short(x.rel)}」用哪份？`,
                options: [`${sp(L)}的`, `${sp(R)}的`, '两份都留'],
                def: 2,
                apply: (c, i) => setFile(x.rel, ['local', 'remote', 'both'][i])(c),
            });
        }
    }
    const files = plan.ask.files;
    if (files.length) {
        qs.push({
            text: `${files.length} 个别的文件两边都改过（${list(files.map((f) => f.rel))}）`,
            question: `这 ${files.length} 个文件用哪边的？（另一份都进备份）`,
            options: ['各自用较新的', `全部用 ${sp(L)}的`, `全部用${sp(R)}的`.replace(/^全部用(?=[A-Za-z])/, '全部用 ')],
            def: 0,
            apply: (c, i) => { for (const f of files) c.files[f.rel] = ['newer', 'local', 'remote'][i]; },
        });
    }
    const api = plan.ask.api;
    if (api) {
        const p = (s) => (api.preset?.[s] ? `「${api.preset[s]}」` : '');
        qs.push({
            text: `API 和预设设置两边不一样（${L}${p('local')}，${R}${p('remote')}；${sp(whose(plan, api.newer))}的较新）`,
            question: 'API 和预设设置用哪边的？（连哪个地址各自保留）',
            options: [`${sp(L)}的`, `${sp(R)}的`, '跳过'],
            def: 2,
            apply: (c, i) => { c.api = ['local', 'remote', 'skip'][i]; },
        });
    }
    const sec = plan.ask.secrets;
    if (sec) {
        qs.push({
            text: `API 密钥两边不一样（${sp(L)}缺 ${sec.local} 条，${sp(R)}缺 ${sec.remote} 条）`,
            question: 'API 密钥：',
            options: ['两边互补（只加缺的，不改各自正在用的）', '跳过'],
            def: 0,
            apply: (c, i) => { c.secrets = ['merge', 'skip'][i]; },
        });
    }
    const up = plan.ask.upstream ?? [];
    if (up.length) {
        qs.push({
            text: `${up.length} 个扩展的分支没设上游，TT 查更新会报错（${up.map((u) => `${u.name}（${whose(plan, u.side)}）`).join('、')}）`,
            question: '把它们设成跟 origin 的默认分支吗？（只改 .git/config，不动提交）',
            options: ['设', '不设'],
            def: 0,
            apply: (c, i) => { c.extUpstream = i === 0; },
        });
    }
    if (plan.guard?.pending) {
        qs.push({
            text: `${R}上次从备份恢复没做完（TT 守护留了记号），数据可能不完整`,
            question: '仍然同步吗？（建议先在手机 KernelSU → 模块 → TT 守护 里重新恢复）',
            options: ['取消', '仍然同步'],
            def: 0,
            cancel: 0,
            apply: (c, i) => { c.pendingOk = i === 1; },
        });
    }
    if (!plan.nothing) {
        const using = [ctx.phone?.running && `${R}上的 TT${ctx.phone.generating ? '（在生成回复）' : ''}`, ctx.macRunning && '这台 Mac 上的 TT'].filter(Boolean);
        if (using.length) {
            const gen = !!ctx.phone?.generating || !!ctx.busy;
            qs.push({
                text: `要关掉${using.join('和')}（开着会把旧内容存回去；同步完再打开）`,
                question: `现在关掉${using.join('和')}吗？`,
                options: ['现在关', '等生成完再关', '取消'],
                def: gen ? 1 : 0,
                cancel: 2,
                apply: (c, i) => { c.close = ['now', 'wait'][i]; },
            });
        }
    }
    return qs;
}

/** 三组预览的文字（不带颜色）。 */
export function previewLines(plan, qs, extras = []) {
    const L = plan.local, R = plan.remote;
    const out = [];
    const auto = [];
    if (plan.auto.push.length) auto.push(`→ ${R} ${plan.auto.push.length} 个：${list(plan.auto.push)}`);
    if (plan.auto.pull.length) auto.push(`← ${L} ${plan.auto.pull.length} 个：${list(plan.auto.pull)}`);
    if (plan.auto.ext.length) auto.push(`扩展 → ${R}：${plan.auto.ext.join('、')}`);
    auto.push(...extras);
    if (plan.auto.tags) auto.push(plan.auto.tags);
    out.push('自动（只有一边改过，不用问）');
    out.push(...(auto.length ? auto.map((t) => `  ${t}`) : ['  （没有）']));
    out.push('要你选');
    out.push(...(qs.length ? qs.map((q, i) => `  ${String.fromCharCode(97 + i)} ${q.text}`) : ['  （没有）']));
    if (plan.skip.length) {
        out.push('跳过（判断不了，没动）');
        out.push(...plan.skip.slice(0, 10).map((s) => `  · ${s.what}：${s.why}`));
        if (plan.skip.length > 10) out.push(`  · … 另 ${plan.skip.length - 10} 条`);
    }
    return out;
}

/** 没人回答时（--auto）：不传 --choices，phone_sync.py 用安全默认。有人回答：逐个问，返回 choices；取消返回 null。 */
export async function askChoices(qs, choose) {
    const c = { files: {} };
    for (const [i, q] of qs.entries()) {
        const pick = await choose(`${String.fromCharCode(97 + i)} ${q.question}`, q.options, q.def);
        if (pick === null || pick === undefined || (q.cancel !== undefined && pick === q.cancel)) return null;
        q.apply(c, pick);
    }
    return c;
}

/** 同步结果 → 一行一条。 */
export function resultLines(plan, res, after) {
    const L = plan.local, R = plan.remote;
    const out = [];
    const ok = (t) => out.push(['ok', t]);
    const bad = (t) => out.push(['bad', t]);
    const note = (t) => out.push(['note', t]);
    if (!res) { bad('同步程序没给出结果（看上面的输出）'); return out; }
    if (res.snapshot?.startsWith('ok ')) ok(`TT 守护快照：${res.snapshot.slice(3)}`);
    else if (res.snapshot?.startsWith('failed ')) note(`TT 守护快照没做成（${res.snapshot.slice(7)}），被覆盖的文件照样备份到了电脑`);
    const fline = (d, t, dir) => (d === t ? ok : bad)(`${dir} ${d}/${t} 个文件`);
    if (res.push.total) fline(res.push.done, res.push.total, `→ ${R}`);
    if (res.pull.total) fline(res.pull.done, res.pull.total, `← ${L}`);
    if (res.copies.length) ok(`冲突副本 ${res.copies.length} 个（两边都有）：${list(res.copies)}`);
    if (res.ext.total) (res.ext.failed.length ? bad : ok)(`扩展 ${res.ext.total - res.ext.failed.length}/${res.ext.total} 个`);
    if (res.upstreamFixed?.length) ok(`扩展上游设好了：${res.upstreamFixed.join('、')}`);
    if (res.tags) ok(res.tags);
    if (res.api) ok(`API 和预设 ${res.api}`);
    if (res.secrets) ok(`API 密钥：${res.secrets}`);
    if (res.endpoint) ok(`${R}的代理地址：${res.endpoint}`);
    for (const d of res.deferred ?? []) note(`没动：${d}`);
    for (const n of res.notes ?? []) bad(n);
    if (res.missing?.length) bad(`没同步成功：${list(res.missing, 5)}（下次自动重试）`);
    if (after) {
        const left = after.auto.push.length + after.auto.pull.length + after.ask.chats.length + after.ask.files.length;
        if (!after.ok) bad(`核对没做成：${after.error ?? '读不了'}`);
        else if (!left) ok('核对：两边的文件一致');
        else bad(`核对：还有 ${left} 个文件两边不一样（下次同步再处理）`);
    }
    if (res.backups) note(`被覆盖的旧文件在 ${res.backups}`);
    return out;
}

// ── 真正做事的（测试里整个换掉）──

function macShell(fn, args = [], { capture = false } = {}) {
    const lib = join(HERE, 'mac', 'lib.zsh');
    return spawnSync('/bin/zsh', ['-c', `source ${JSON.stringify(lib)} >/dev/null 2>&1; ${fn} "$@"`, 'ccst', ...args],
        { encoding: 'utf8', stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit', env: { ...process.env, CM_MENU: '1' } });
}

export function realDeps(cfg) {
    const py = (args, capture) => macShell('python3', [join(HERE, 'phone_sync.py'), ...args], { capture });
    const tmp = mkdtempSync(join(tmpdir(), 'ccst-sync-'));
    const readJson = (f) => { try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return null; } };
    return {
        cleanup: () => rmSync(tmp, { recursive: true, force: true }),
        hubProblem: () => hubProblem(cfg),
        connect() {
            const r = spawnSync('/bin/zsh', [join(HERE, 'mac', 'phone-connect.zsh')], { encoding: 'utf8', stdio: ['inherit', 'pipe', 'inherit'] });
            const kv = Object.fromEntries(String(r.stdout ?? '').split('\n').filter((l) => l.includes('\t')).map((l) => l.split('\t')));
            return r.status === 0 && kv.SERIAL ? { adb: kv.ADB, serial: kv.SERIAL, macIp: kv.MAC_IP || '' } : null;
        },
        probe: (adb, serial) => phoneProbe(adb, serial),
        macRunning: () => syncHub(cfg) === 'tt' && osStatus('mac').mactt_running === '1',
        busy: async () => (await getJson(`http://127.0.0.1:${cfg.proxyPort}/v1/control/status`))?.busy ?? 0,
        stRunning: () => (cfg.stDir ? portOpen(cfg.stPort) : false),
        plan(args) {
            const f = join(tmp, `plan-${Date.now()}.json`);
            const r = py([...args, '--plan-json', f], true);
            return readJson(f) ?? { ok: false, error: (r.stdout || r.stderr || '').trim().split('\n').pop() || `退出码 ${r.status}` };
        },
        sync(args, choices) {
            const r = join(tmp, 'result.json');
            const extra = ['--result-json', r];
            if (choices) { writeFileSync(join(tmp, 'choices.json'), JSON.stringify(choices)); extra.push('--choices', join(tmp, 'choices.json')); }
            const p = py([...args, ...extra], true);
            return { rc: p.status, result: readJson(r), output: `${p.stdout ?? ''}${p.stderr ?? ''}` };
        },
        macExtPreview() {
            const r = macShell('hub_update_mac_tt_ext', ['--dry-run'], { capture: true });
            return [...String(r.stdout ?? '').matchAll(/扩展 → Mac TT：(\S+?)（/g)].map((m) => m[1]);
        },
        macExtUpdate: () => macShell('hub_update_mac_tt_ext').status === 0,
        quitMac: () => macShell('mac_tt_quit').status === 0,
        openMac: () => macShell('mac_tt_open').status === 0,
        notifyPhone: (adb, serial, title, msg) => adbRun(adb, serial, ['shell', `cmd notification post -S bigtext -t '${title.replace(/'/g, '')}' claudemax '${msg.replace(/'/g, '')}'`]),
        stopPhone: (adb, serial) => adbRun(adb, serial, ['shell', `am force-stop ${TT_PKG}`]).status === 0,
        openPhone: (adb, serial) => adbRun(adb, serial, ['shell', `monkey -p ${TT_PKG} -c android.intent.category.LAUNCHER 1`]).status === 0,
        sleep,
    };
}

// ── 同步 ──

/**
 * io：{ choose(问题, 选项, 默认) → 序号 / null（取消）, ask, auto }；没有 choose 或 auto 时不问问题。
 * 返回退出码：0 做完了（或两边一样），1 有没做成的，2 没做（找不到手机、在恢复、取消）。
 */
export async function actionPhoneSync(io = {}, deps = null) {
    const cfg = io.cfg ?? loadConfig();
    const r = io.reporter ?? reporter(cfg);
    const d = deps ?? realDeps(cfg);
    try {
        return await syncFlow(cfg, r, d, io);
    } finally {
        d.cleanup?.();
    }
}

async function syncFlow(cfg, r, d, io) {
    const interactive = !!io.choose && !io.auto;
    const L = hubLabel(cfg);
    r.banner(`同步手机（${L} ↔ 手机）`);
    const hp = d.hubProblem();
    if (hp) { r.failLine(hp); r.summary(); return 2; }

    r.step('找手机');
    const conn = d.connect();
    if (!conn) { r.summary(); return 2; }   // phone-connect.zsh 已经说了原因

    r.step('看看两边');
    const probe = d.probe(conn.adb, conn.serial);
    if (!probe) { r.failLine('读不了手机的状态（连接断了？）'); r.summary(); return 2; }
    const macRunning = d.macRunning();
    const busy = await d.busy();
    const facts = [
        syncHub(cfg) === 'tt' ? `Mac TT ${macRunning ? '开着' : '没开'}` : null,
        `手机 TT ${probe.ttRunning ? (probe.generating ? '开着（在生成回复）' : '开着') : '没开'}`,
        busy ? `代理在写 ${busy} 条回复` : '代理空闲',
        probe.guardVersion ? `TT 守护 ${probe.guardVersion}` : '没装 TT 守护',
    ].filter(Boolean);
    r.explain(facts.join(' · '));
    if (probe.restoring) {
        r.failLine('手机上的 TT 守护正在恢复备份，这次不同步');
        r.fix('等它恢复完（KernelSU → 模块 → TT 守护 里能看到）再来。');
        r.summary();
        return 2;
    }
    if (probe.restorePending) r.warnLine('手机上次从备份恢复没做完（TT 守护留了记号）');
    if (syncHub(cfg) === 'st' && await d.stRunning()) {
        r.warnLine('电脑上的酒馆在运行：浏览器里开着的酒馆页面可能把旧内容存回去，同步完刷新一下页面。');
    }

    r.step('预览');
    const args = [...hubSyncArgs(cfg), '--adb', conn.adb, '--serial', conn.serial];
    if (conn.macIp) args.push('--mac-ip', conn.macIp, '--lan-key-file', cfg.lanKeyFile);
    const plan = d.plan(args);
    if (!plan.ok) { r.failLine(`读不了两边的数据：${plan.error}`); r.summary(); return 2; }
    const macExt = syncHub(cfg) === 'tt' ? d.macExtPreview() : [];
    const extras = macExt.length ? [`扩展 → Mac TT：${macExt.join('、')}`] : [];
    if (plan.firstSync) r.explain(`第一次按「${L} ↔ 手机」同步：两边不一样的文件都算「两边都改过」，要你选；以后只列真的两边都改过的。`);
    const ctx = { phone: { running: probe.ttRunning, generating: probe.generating }, macRunning, busy };
    if (plan.nothing) {
        r.ok('两边已经一样，什么都没关');
        if (macExt.length && !macRunning) { if (d.macExtUpdate()) r.ok(`Mac TT 的扩展更新了：${macExt.join('、')}`); }
        else if (macExt.length) r.explain(`Mac TT 的扩展有新版本（${macExt.join('、')}），Mac TT 开着没更新：下次它没开时同步会更新。`);
        r.summary();
        return 0;
    }
    const qs = questions(plan, ctx);
    for (const line of previewLines(plan, qs, extras)) (/^\S/.test(line) ? r.head : r.line)(line);

    let choices = null;
    if (interactive) {
        if (qs.length) r.step('你来选（直接回车 = 括号里的默认）');
        choices = await askChoices(qs, io.choose);
        if (!choices) { r.warnLine('取消了，什么都没改。'); r.summary(); return 2; }
    } else if (plan.guard?.pending) {
        r.warnLine('不问问题的同步不处理没做完的恢复：这次不同步。'); r.summary(); return 2;
    }

    // 关 TT：等生成完（选了等，或不问问题时代理在写回复）
    const phoneWas = probe.ttRunning;
    if (phoneWas || macRunning) {
        const wait = interactive ? choices.close === 'wait' : true;
        if (wait && !(await waitIdle(d, conn, r))) { r.warnLine('等了 10 分钟还在生成回复，没有同步，TT 没动。'); r.summary(); return 2; }
        if (macRunning) {
            if (!d.quitMac()) { r.failLine('Mac 上的 TauriTavern 没能退出，先手动退出再同步'); r.summary(); return 2; }
            r.explain('已退出 Mac 上的 TauriTavern。');
        }
        if (phoneWas) {
            d.notifyPhone(conn.adb, conn.serial, 'Mac 在同步', 'TauriTavern 马上关闭，同步完会重新打开。');
            d.stopPhone(conn.adb, conn.serial);
            r.explain('已关掉手机上的 TauriTavern（它开着时会把旧内容存回去）。');
        }
    }
    if (macExt.length) { r.step('更新 Mac TT 上的扩展'); if (!d.macExtUpdate()) r.warnLine('有扩展没更新成，看上面的说明'); }

    r.step('同步');
    const { rc, result, output } = d.sync(args, choices);
    // 同步程序的逐条输出只留出错和提醒；成了什么在下面的结果里
    const noisy = String(output ?? '').split('\n').filter((l) => (result ? /^\s*(✗|!)/.test(l) : l.trim()));
    for (const l of noisy) r.line(l.trim());
    r.step('核对');
    const after = d.plan(args);
    for (const [kind, t] of resultLines(plan, result, after)) (kind === 'ok' ? r.ok : kind === 'bad' ? r.failLine : r.explain)(t);

    if (phoneWas && d.openPhone(conn.adb, conn.serial)) r.ok('已重新打开手机上的 TauriTavern');
    if (macRunning && d.openMac()) r.ok('已重新打开 Mac 上的 TauriTavern');
    if (!existsSync(cfg.lanKeyFile)) r.explain('现在是电脑模式：手机要连这台 Mac 的代理，先在「手机」里打开手机模式。');
    r.summary();
    return rc === 0 ? 0 : 1;
}

/** 等代理写完、手机上不在生成回复（最多 10 分钟）。 */
async function waitIdle(d, conn, r) {
    for (let i = 0; i < 300; i++) {
        const busy = await d.busy();
        const gen = d.probe(conn.adb, conn.serial)?.generating;
        if (!busy && !gen) return true;
        if (i === 0) {
            r.explain('在生成回复，等它写完…（Ctrl-C 取消）');
            d.notifyPhone(conn.adb, conn.serial, '稍等', '回复写完后 Mac 要关闭 TauriTavern 同步一下。');
        }
        await d.sleep(2000);
    }
    return false;
}

// ── TT 守护 ──

export function compareVersions(a, b) {
    const pa = String(a ?? '').split('.').map(Number), pb = String(b ?? '').split('.').map(Number);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
        const x = pa[i] || 0, y = pb[i] || 0;
        if (x !== y) return x < y ? -1 : 1;
    }
    return 0;
}

/** launchctl print 的输出 → { installed, running, lastExit }。 */
export function parseLaunchctl(text, ok = true) {
    if (!ok) return { installed: false };
    const t = String(text ?? '');
    const code = t.match(/last exit code = (-?\d+)/)?.[1];
    return { installed: true, running: /\bstate = running/.test(t), lastExit: code === undefined ? null : Number(code) };
}

export function pullJob() {
    if (OS !== 'mac') return { installed: false };
    const uid = process.getuid?.() ?? '';
    const r = spawnSync('launchctl', ['print', `gui/${uid}/${PULL_JOB}`], { encoding: 'utf8', timeout: 4000 });
    return parseLaunchctl(r.stdout, r.status === 0);
}

let latestCache = null;
/** update.json 里的最新版本（10 分钟缓存；连不上返回 null）。 */
export async function latestGuard(fetchImpl = globalThis.fetch) {
    if (latestCache && Date.now() - latestCache.at < 600000) return latestCache.v;
    let v = null;
    try {
        const res = await fetchImpl(UPDATE_JSON, { signal: AbortSignal.timeout(4000) });
        if (res.ok) v = (await res.json()).version ?? null;
    } catch { /* 没网 */ }
    latestCache = { at: Date.now(), v };
    return v;
}

export function versionNote(installed, latest) {
    if (!installed) return '手机上没装（或没 root）';
    if (!latest) return `手机上 ${installed}（查不到最新版本）`;
    return compareVersions(installed, latest) < 0 ? `手机上 ${installed} · 有新版本 ${latest}：在 KernelSU 里更新` : `手机上 ${installed}（已是最新）`;
}

/** list-backups 的输出（每行「文件名 KB sha256」）→ [{ name, kb }]，只认 TT 的备份，新的在前。 */
export function parseBackups(text) {
    return String(text ?? '').split(/\r?\n/).map((l) => l.trim().split(/\s+/))
        .filter(([n]) => /^tt-[A-Za-z0-9._-]+\.tar\.gz$/.test(n ?? ''))
        .map(([name, kb]) => ({ name, kb: Number(kb) || 0 }));
}

export const RESTORE_RC = {
    0: '恢复好了。打开手机上的 TT 看看。',
    3: 'TT 还开着：先在手机的最近任务里把 TauriTavern 划掉，再来恢复。',
    4: '手机开机后还没解锁过：先解锁再恢复。',
    7: '另一个恢复正在进行。',
    9: '这份备份校验不对，可能坏了，没恢复。换一份试试。',
    10: '手机电量低于 15%：先充电再恢复（恢复途中关机会让数据不完整）。',
};

function whenFromName(n) {
    const m = n.match(/(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})/);
    return m ? `${m[2]}-${m[3]} ${m[4]}:${m[5]}` : '';
}

function findPhone() {
    const s = osStatus('mac');
    return s.adb && s.serial ? { adb: s.adb, serial: s.serial } : null;
}

const su = (adb, serial, cmd, timeout = 20000) => adbRun(adb, serial, ['shell', `su -c '${cmd}'`], { timeout });

export async function actionGuardStatus(io = {}) {
    const cfg = io.cfg ?? loadConfig();
    const r = io.reporter ?? reporter(cfg);
    r.banner('TT 守护：状态');
    r.explain('手机上的界面：KernelSU → 模块 → TT 守护。');
    const ph = findPhone();
    const latest = await latestGuard();
    if (!ph) { r.warnLine('手机没连（插线或开无线调试）'); r.explain(`最新版本：${latest ?? '查不到'}`); r.summary(); return 0; }
    const probe = phoneProbe(ph.adb, ph.serial);
    r.step('版本');
    if (!probe?.guardVersion) r.warnLine('手机上没装 TT 守护（或没 root）');
    else if (latest && compareVersions(probe.guardVersion, latest) < 0) {
        r.warnLine(`手机上是 ${probe.guardVersion}，有新版本 ${latest}`);
        r.fix('在手机 KernelSU → 模块 → TT 守护 点「更新」（这里不替你装）。');
    } else r.ok(versionNote(probe.guardVersion, latest));
    if (!probe?.guardVersion) { r.summary(); return 0; }
    r.step('手机上');
    const st = su(ph.adb, ph.serial, `sh ${GUARD_MOD}/ui.sh status`);
    let j = null;
    try { j = JSON.parse(String(st.stdout).trim().split('\n').pop()); } catch { /* 读不了 */ }
    if (!j) r.warnLine('读不了 TT 守护的状态');
    else {
        r.ok(`TT ${j.tt?.running ? (j.tt.generating ? '开着（在生成回复）' : '开着') : '没开'}${j.tt?.version ? ` · TT ${j.tt.version}` : ''}`);
        const tt = (j.targets ?? []).find((t) => t.id === 'tt');
        const last = j.backup?.last ? new Date(j.backup.last * 1000) : null;
        r.ok(`上次备份 ${last ? `${clock(last)}（${ago(last)}）` : '还没有'} · 手机上 ${tt?.count ?? '?'} 份${tt?.live ? ` · 实时副本 ${clock(new Date(tt.live * 1000))}` : ''}`);
        const pulled = j.backup?.mac_pulled ? new Date(j.backup.mac_pulled * 1000) : null;
        r.explain(`电脑上次拷走备份：${pulled ? ago(pulled) : '还没有'}`);
        if (j.restoring) r.warnLine('正在恢复备份');
        if (j.restore_interrupted) r.warnLine(`上次恢复没做完：${j.restore_interrupted}`);
        if (j.power?.level !== undefined) r.explain(`电量 ${j.power.level}%${j.power.charging ? '（充电中）' : ''}`);
    }
    const job = pullJob();
    r.step('电脑');
    r.explain(job.installed ? `自动拉备份：开着（每分钟看一次）${job.lastExit ? ` · 上次退出码 ${job.lastExit}` : ''}` : '自动拉备份：没开');
    r.summary();
    return 0;
}

function moduleScript(cfg, rel) {
    const f = join(cfg.moduleDir, 'pc', rel);
    return existsSync(f) ? f : null;
}

export async function actionGuardPull(io = {}) {
    const cfg = io.cfg ?? loadConfig();
    const r = io.reporter ?? reporter(cfg);
    r.banner('TT 守护：立即拉一次备份');
    const f = moduleScript(cfg, 'pull-backups.sh');
    if (!f) { r.failLine(`找不到 ${join(cfg.moduleDir, 'pc', 'pull-backups.sh')}`); r.fix('把 tt-root-module clone 到本仓库同级目录。'); r.summary(); return 1; }
    const ph = findPhone();
    const env = { ...process.env, ...(ph?.adb ? { ADB: ph.adb } : {}) };
    r.explain('和电脑的自动拉备份是同一个脚本（同时只跑一个）。');
    const p = spawnSync('/bin/zsh', [f], { stdio: 'inherit', env });
    if (p.status === 0) r.ok('拉好了（或者没有新备份）');
    else if (p.status === 2) r.warnLine('没连上手机，或者手机上没装 TT 守护');
    else r.failLine('没拉完，看备份文件夹里的 pull.log');
    r.summary();
    return p.status === 1 ? 1 : 0;
}

export async function actionGuardAuto(io = {}) {
    const cfg = io.cfg ?? loadConfig();
    const r = io.reporter ?? reporter(cfg);
    r.banner('TT 守护：电脑自动拉备份');
    const f = moduleScript(cfg, 'install-mac.sh');
    if (!f) { r.failLine(`找不到 ${join(cfg.moduleDir, 'pc', 'install-mac.sh')}`); r.summary(); return 1; }
    const job = pullJob();
    r.explain('开着时每分钟看一次：手机连着（数据线或无线调试）且有新备份就拷到电脑。');
    if (job.installed) {
        r.ok(`现在开着${job.lastExit ? `（上次退出码 ${job.lastExit}）` : ''}`);
        if (!io.ask || !(await io.ask('要关掉吗？（电脑上已拷的备份不删）'))) { r.explain('没改。'); r.summary(); return 0; }
        const p = spawnSync('/bin/zsh', [f, '--uninstall'], { stdio: 'inherit' });
        (p.status === 0 ? r.ok : r.failLine)(p.status === 0 ? '已关掉' : '没关成');
    } else {
        r.explain('现在没开。');
        if (!io.ask || !(await io.ask('要打开吗？'))) { r.explain('没改。'); r.summary(); return 0; }
        const p = spawnSync('/bin/zsh', [f], { stdio: 'inherit' });
        (p.status === 0 ? r.ok : r.failLine)(p.status === 0 ? '已打开' : '没打开成');
    }
    r.summary();
    return 0;
}

export async function actionGuardRestore(io = {}) {
    const cfg = io.cfg ?? loadConfig();
    const r = io.reporter ?? reporter(cfg);
    r.banner('TT 守护：从备份恢复');
    r.explain('用选的备份覆盖手机上 TT 同名的聊天、角色卡、世界书、设置和扩展；之后新建的不删；不动 API 密钥。');
    r.explain('恢复前 TT 守护会先把现在的数据另存一份。TT 要先在手机上关掉（这里不替你关）。');
    const ph = findPhone();
    if (!ph) { r.failLine('手机没连'); r.summary(); return 1; }
    const list = parseBackups(su(ph.adb, ph.serial, `sh ${GUARD_MOD}/ui.sh list-backups`).stdout);
    if (!list.length) { r.warnLine('手机上没有 TT 的备份（或没装 TT 守护）'); r.summary(); return 0; }
    if (!io.choose) { r.warnLine('要在菜单里选备份'); r.summary(); return 0; }
    const shown = list.slice(0, 9);
    const pick = await io.choose('恢复哪一份？（新的在前；直接回车 = 不恢复）',
        [...shown.map((b) => `${whenFromName(b.name) || b.name}  ${(b.kb / 1024).toFixed(1)} MB  ${b.name}`), '不恢复'], shown.length);
    if (pick === null || pick === undefined || pick >= shown.length) { r.explain('没恢复。'); r.summary(); return 0; }
    const b = shown[pick];
    if (!io.ask || !(await io.ask(`确定用 ${b.name} 恢复吗？`))) { r.explain('没恢复。'); r.summary(); return 0; }
    const out = su(ph.adb, ph.serial, `sh ${GUARD_MOD}/ui.sh restore ${b.name}`, 600000);
    let j = null;
    try { j = JSON.parse(String(out.stdout).trim().split('\n').pop()); } catch { /* 读不了 */ }
    if (!j) { r.failLine('没有回应（连接断了？）'); r.summary(); return 1; }
    const why = RESTORE_RC[j.rc] ?? `没恢复（${(j.out ?? []).join(' ') || `代码 ${j.rc}`}）`;
    (j.rc === 0 ? r.ok : r.failLine)(why);
    r.summary();
    return j.rc === 0 ? 0 : 1;
}

export const PHONE_ACTIONS = {
    'phone-sync': actionPhoneSync,
    'guard-status': actionGuardStatus,
    'guard-pull': actionGuardPull,
    'guard-auto': actionGuardAuto,
    'guard-restore': actionGuardRestore,
};

// ── 单独运行 ──

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
    const [cmd = 'sync', ...flags] = process.argv.slice(2);
    const id = cmd === 'sync' ? 'phone-sync' : cmd;
    if (!PHONE_ACTIONS[id]) {
        process.stderr.write(`用法：node launcher/phone.mjs <sync|${Object.keys(PHONE_ACTIONS).filter((k) => k !== 'phone-sync').join('|')}> [--auto]\n`);
        process.exit(2);
    }
    PHONE_ACTIONS[id]({ auto: flags.includes('--auto') }).then((code) => process.exit(code));
}

// ──────────────────────────────────────────────
// Claude Max — UI extension for the claude-subscription server plugin
// ──────────────────────────────────────────────
//
// This file is the UI EXTENSION (loaded in the browser). The SERVER plugin
// entry is plugin.js (wired via package.json "main"). Keeping the extension
// at the repo root with manifest.json makes the repo installable straight
// from SillyTavern's "Install extension" dialog, AND the server plugin
// auto-installs these same files — a window guard below makes whichever
// copy loads second a no-op.
//
// Built exclusively on SillyTavern.getContext() — no relative imports — so
// the file works unchanged from ANY install location (global third-party,
// per-user data extensions, or the plugin's auto-installed copy).
//
// What it does:
//   • One-click Connect: pilots SillyTavern's Custom (OpenAI-compatible)
//     source at the plugin's local endpoint — no URL typing. The endpoint
//     and key are set BEFORE the source switch because ST's change handler
//     auto-reconnects immediately with whatever URL is current.
//   • Claude-native settings (effort low..max, thinking mode, reasoning
//     display, identity mode, session resume) injected per-request through
//     `custom_include_body` — the only channel ST's backend forwards
//     unconditionally for Custom sources. ST's own Reasoning Effort dropdown
//     is bypassed entirely (it downgrades max→high client-side and drops the
//     field for Claude model IDs server-side); leave it on "Auto".
//   • Quota meter: same-origin plugin route first (works from remote
//     browsers), direct listener fallback.
//
// Injection is scoped: it only fires when the active connection actually
// points at this plugin's endpoint, so other Custom endpoints (Meridian,
// llama.cpp, etc.) are untouched.

(function () {
    if (window.__claudeMaxUiLoaded) {
        console.log('[claude-max] another copy of the Claude Max extension is already active — this one will stay dormant');
        return;
    }
    window.__claudeMaxUiLoaded = true;

    const ctx = SillyTavern.getContext();
    const { eventSource, eventTypes, extensionSettings, saveSettingsDebounced } = ctx;

    // TauriTavern has a Rust backend: no server plugins, so the ST-origin
    // /api/plugins routes don't exist — talk to the standalone proxy directly.
    const IS_TAURI = !!window.__TAURITAVERN__;

    const MODULE = 'claude_max';
    const DEFAULT_ENDPOINT = 'http://127.0.0.1:8901/v1';

    const VALID_EFFORTS = ['auto', 'low', 'medium', 'high', 'xhigh', 'max'];
    const VALID_THINKING = ['adaptive', 'on', 'off'];

    const defaultSettings = {
        enabled: true,
        endpoint: DEFAULT_ENDPOINT,
        effort: 'auto',          // 'auto' = don't send → model default
        thinking: 'adaptive',
        showReasoning: true,
        identityMode: false,
        useResume: true,
        inlineSystem: true,
        debugDump: false,
    };

    function getSettings() {
        if (extensionSettings[MODULE] === undefined) {
            extensionSettings[MODULE] = structuredClone(defaultSettings);
        }
        for (const key in defaultSettings) {
            if (extensionSettings[MODULE][key] === undefined) {
                extensionSettings[MODULE][key] = defaultSettings[key];
            }
        }
        return extensionSettings[MODULE];
    }

    function normalizeEndpoint(url) {
        return String(url ?? '').trim().replace(/\/+$/, '');
    }

    function isOurEndpoint(customUrl, settings) {
        const a = normalizeEndpoint(customUrl);
        const b = normalizeEndpoint(settings.endpoint);
        return a !== '' && a === b;
    }

    // ── One-click connect (same selector path as ST's /api-url command) ──

    function connect(settings) {
        try {
            $('#main_api').val('openai').trigger('change');
            // Endpoint + key MUST be set before the source change: ST's
            // change handler auto-reconnects immediately, and firing it with
            // the stale custom_url would race a status check against the
            // wrong endpoint.
            $('#custom_api_url_text').val(settings.endpoint).trigger('input');
            const keyField = $('#api_key_custom');
            if (keyField.length && !String(keyField.val() ?? '').trim()) {
                keyField.val('sk-no-key-needed');
            }
            $('#chat_completion_source').val('custom').trigger('change');
            // The proxy sorts out roles itself. ST's merge/strict post-processing
            // turns the whole preset into a user message (after the first
            // assistant-role preset entry), which kills prompt caching.
            $('#custom_prompt_post_processing').val('').trigger('change');
            $('#api_button_openai').trigger('click');
            toastr?.success?.('正在连接，模型列表稍后出现在「API 连接」的模型下拉框中。', 'Claude Max');
            if (IS_TAURI) {
                toastr?.info?.(`首次连接时 TauriTavern 会弹出授权框，请允许访问 ${settings.endpoint}。`, 'Claude Max', { timeOut: 10000 });
            }
            setTimeout(refreshAll, 800);
        } catch (err) {
            console.error('[claude-max] connect failed', err);
            toastr?.error?.(`连接失败：${err}`, 'Claude Max');
        }
    }

    // ── Preflight: warn before a request that Opus 5.5 is likely to refuse ──

    // Opus 5.5's safeguards refuse prompts that make the model write its
    // reasoning into the reply (category reasoning_extraction). Presets that
    // prescribe a <thinking>/<cot> block in the output trip it every time.
    const warnedPresets = new Set();
    function preflightCheck(data) {
        // Verified live: Opus 5 refuses these too, not only Opus 5.5 (the docs say 5.5 only).
        if (!/opus-5/i.test(String(data.model ?? ''))) return;
        const preset = SillyTavern.getContext().chatCompletionSettings?.preset_settings_openai ?? '';
        if (warnedPresets.has(preset)) return;
        const text = (data.messages ?? [])
            .filter((m) => m?.role === 'system')
            .map((m) => (typeof m.content === 'string' ? m.content : ''))
            .join('\n');
        if (!/<\/?(thinking|cot)>/i.test(text)) return;
        warnedPresets.add(preset);
        toastr?.warning?.(
            `当前预设「${preset}」要求模型把思考过程（<thinking>/<cot>）写进回复，Opus 5 / Opus 5.5 的安全分类器会拦截这类请求（reasoning_extraction），而且被拦也照样计费。` +
            '建议换用改成原生思考的预设（十四行诗3.0-Claude），想看写在正文里的思维链就改用 Opus 4.6 并把思考模式设为关闭。',
            'Claude Max',
            { timeOut: 15000 },
        );
    }

    // ST's Custom-endpoint "prompt post-processing" (merge / semi / strict)
    // merges the preset into user messages before the proxy sees it: the
    // system prompt shrinks to the first entry, the preset loses system
    // authority, and world info changing every turn breaks the cache for
    // the whole conversation.
    const POST_PROCESSING_LABELS = {
        merge: '合并连续角色', semi: '半严格', strict: '严格', single: '单条用户消息',
        merge_tools: '合并连续角色（工具）', semi_tools: '半严格（工具）', strict_tools: '严格（工具）',
    };
    let warnedPostProcessing = false;
    function postProcessingCheck(data) {
        const mode = String(data.custom_prompt_post_processing ?? '');
        if (!mode || warnedPostProcessing) return;
        warnedPostProcessing = true;
        toastr?.warning?.(
            `酒馆的「提示词后处理」现在是「${POST_PROCESSING_LABELS[mode] ?? mode}」：它会把预设合并成用户消息，预设失去系统权重，而且世界书一变整段缓存就失效。` +
            '建议改成「无」（API 连接 → 提示词后处理），或重新点一次 Claude Max 面板的「一键连接」自动改好。',
            'Claude Max',
            { timeOut: 20000 },
        );
    }

    // ── Preset-recommended settings ──

    // A preset can ship `extensions.claude_max = { effort, thinking, ... }`;
    // switching to it applies those values so preset and panel stay in sync.
    const PRESET_FIELDS = {
        effort: { label: '思考深度', valid: (v) => VALID_EFFORTS.includes(v) },
        thinking: { label: '思考模式', valid: (v) => VALID_THINKING.includes(v) },
        showReasoning: { label: '显示思考过程', valid: (v) => typeof v === 'boolean' },
        useResume: { label: '会话续接', valid: (v) => typeof v === 'boolean' },
        inlineSystem: { label: '深度注入保持原位', valid: (v) => typeof v === 'boolean' },
        identityMode: { label: '身份模式', valid: (v) => typeof v === 'boolean' },
    };

    function applyPresetRecommendation() {
        const ctx = SillyTavern.getContext();
        const rec = ctx.chatCompletionSettings?.extensions?.claude_max;
        if (!rec || typeof rec !== 'object') return;
        const settings = getSettings();
        const changed = [];
        for (const [key, field] of Object.entries(PRESET_FIELDS)) {
            if (rec[key] === undefined || !field.valid(rec[key]) || settings[key] === rec[key]) continue;
            settings[key] = rec[key];
            changed.push(field.label);
        }
        if (!changed.length) return;
        saveSettingsDebounced();
        rebuildPanel();
        const preset = ctx.chatCompletionSettings?.preset_settings_openai ?? '当前预设';
        toastr?.info?.(`已按预设「${preset}」的推荐调整：${changed.join('、')}。`, 'Claude Max', { timeOut: 8000 });
    }

    // ── Per-request injection (CHAT_COMPLETION_SETTINGS_READY) ──

    // One-shot effort for the next reply (M2): kept in memory only, used by
    // every request until a chat message arrives, then cleared.
    let nextEffort = null;

    function effectiveEffort(settings) {
        return nextEffort ?? settings.effort;
    }

    function buildIncludeBodyYaml(settings) {
        const lines = ['claude_subscription:'];
        const effort = effectiveEffort(settings);
        if (effort !== 'auto') lines.push(`  effort: ${effort}`);
        lines.push(`  thinking: ${settings.thinking}`);
        lines.push(`  show_reasoning: ${settings.showReasoning}`);
        lines.push(`  identity_mode: ${settings.identityMode}`);
        lines.push(`  use_resume: ${settings.useResume}`);
        lines.push(`  system_placement: ${settings.inlineSystem ? 'inline' : 'hoist'}`);
        if (settings.debugDump) lines.push('  debug_dump: true');
        return lines.join('\n');
    }

    function onSettingsReady(data) {
        try {
            const settings = getSettings();
            if (!settings.enabled) return;
            if (!data || data.chat_completion_source !== 'custom') return;
            if (!isOurEndpoint(data.custom_url, settings)) return;

            const existing = typeof data.custom_include_body === 'string' ? data.custom_include_body : '';
            const cleaned = existing
                .replace(/^claude_subscription:[\s\S]*?(?=^\S|\s*$(?![\s\S]))/m, '')
                .replace(/\n{3,}/g, '\n\n')
                .trim();
            data.custom_include_body = (cleaned ? cleaned + '\n' : '') + buildIncludeBodyYaml(settings);
            preflightCheck(data);
            postProcessingCheck(data);
        } catch (err) {
            console.error('[claude-max] failed to inject settings', err);
        }
    }

    // ── Proxy access ──

    function proxyBase(settings) {
        return normalizeEndpoint(settings.endpoint).replace(/\/v1$/, '');
    }

    /** GET a proxy route: ST's same-origin plugin route first (works when
     *  the ST UI is opened from another device), then the proxy directly
     *  (standalone mode / TauriTavern). */
    async function fetchProxy(pluginPath, directPath) {
        let res = null;
        if (!IS_TAURI) {
            try {
                res = await fetch(`/api/plugins/claude-subscription${pluginPath}`, { signal: AbortSignal.timeout(12000) });
            } catch { /* ST route unavailable — fall back below */ }
        }
        if (!res || !res.ok) {
            res = await fetch(`${proxyBase(getSettings())}${directPath}`, { signal: AbortSignal.timeout(12000) });
        }
        return res;
    }

    // ── Small DOM helpers ──

    function el(tag, className, text) {
        const node = document.createElement(tag);
        if (className) node.className = className;
        if (text !== undefined) node.textContent = text;
        return node;
    }

    function iconButton(iconClass, title, onClick) {
        const btn = el('div', `menu_button cm-icon-btn fa-solid ${iconClass}`);
        btn.title = title;
        btn.setAttribute('role', 'button');
        btn.tabIndex = 0;
        btn.addEventListener('click', onClick);
        return btn;
    }

    const EFFORT_LABEL = { auto: '自动', low: '低', medium: '中', high: '高', xhigh: '超高', max: '最大' };

    /** 「下一轮临时加深」：只作用于下一条回复，收到回复后自动恢复。 */
    function oneShotEffortRow(settings) {
        const wrap = el('div', 'cm-field cm-oneshot');
        wrap.id = 'claude_max_oneshot';
        const row = el('div', 'cm-oneshot-row');
        row.append(el('span', 'cm-field-label', '下一轮临时'));
        const status = el('small', 'cm-hint');
        const group = el('div', 'cm-seg');
        row.append(group);
        const render = () => {
            group.querySelectorAll('button').forEach((b) => b.classList.toggle('active', b.dataset.effort === (nextEffort ?? '')));
            status.textContent = nextEffort
                ? `下一条回复用「${EFFORT_LABEL[nextEffort]}」，收到后自动恢复为「${EFFORT_LABEL[settings.effort]}」。换思考深度会让这一轮和恢复后的一轮各重写一次缓存。`
                : '关键剧情想让模型多想一会儿时点一下，只影响下一条回复。';
        };
        for (const [value, label] of [['high', '高'], ['xhigh', '超高'], ['', '取消']]) {
            const b = el('button', 'cm-seg-btn', label);
            b.type = 'button';
            b.dataset.effort = value;
            b.addEventListener('click', () => { nextEffort = value || null; render(); });
            group.append(b);
        }
        wrap.append(row, status);
        wrap.refresh = render;
        render();
        return wrap;
    }

    function clearOneShotEffort() {
        if (!nextEffort) return;
        nextEffort = null;
        document.getElementById('claude_max_oneshot')?.refresh?.();
    }

    /** Segmented control: one choice out of a few, hint text follows it. */
    function segmented({ label, options, current, onChange }) {
        const wrap = el('div', 'cm-field');
        wrap.append(el('div', 'cm-field-label', label));
        const group = el('div', 'cm-seg');
        group.setAttribute('role', 'radiogroup');
        group.setAttribute('aria-label', label);
        const hint = el('small', 'cm-hint');
        const buttons = options.map((opt) => {
            const b = el('button', 'cm-seg-btn', opt.label);
            b.type = 'button';
            b.setAttribute('role', 'radio');
            b.addEventListener('click', () => select(opt.value, true));
            group.append(b);
            return b;
        });
        function select(value, fire) {
            options.forEach((opt, i) => {
                const on = opt.value === value;
                buttons[i].classList.toggle('active', on);
                buttons[i].setAttribute('aria-checked', String(on));
                if (on) hint.textContent = opt.hint;
            });
            if (fire) onChange(value);
        }
        select(current, false);
        wrap.append(group, hint);
        return wrap;
    }

    /** Toggle row: title + one-line description, switch on the right. */
    function toggleRow({ id, title, desc, checked, onChange }) {
        const row = el('label', 'cm-toggle');
        row.htmlFor = id;
        const text = el('div', 'cm-toggle-text');
        text.append(el('div', 'cm-toggle-title', title), el('small', 'cm-hint', desc));
        const input = el('input');
        input.type = 'checkbox';
        input.id = id;
        input.checked = checked;
        input.addEventListener('change', () => onChange(input.checked));
        const sw = el('span', 'cm-switch');
        row.append(text, input, sw);
        return row;
    }

    function section(title, extra) {
        const head = el('div', 'cm-section-head');
        head.append(el('div', 'cm-section-title', title));
        if (extra) head.append(extra);
        return head;
    }

    // ── Proxy status ──

    function setDot(state) {
        for (const dot of document.querySelectorAll('.cm-dot')) {
            dot.dataset.state = state;
        }
    }

    const SUBSCRIPTION_LABELS = { max: 'Max', pro: 'Pro', team: 'Team', enterprise: 'Enterprise' };
    const SOURCE_LABELS = { keychain: '钥匙串', file: '凭据文件', env: '环境变量' };

    async function refreshProxyStatus() {
        const title = document.getElementById('claude_max_status_title');
        const sub = document.getElementById('claude_max_status_sub');
        if (!title || !sub) return;
        setDot('pending');
        title.textContent = '正在检测代理…';
        sub.textContent = '';
        try {
            const res = await fetchProxy('/status', '/status');
            const data = await res.json();
            if (!res.ok || !data.ok) throw new Error(data.message || `HTTP ${res.status}`);
            const cred = data.credential ?? {};
            if (cred.present) {
                setDot('online');
                title.textContent = '代理在线，已登录';
                const plan = SUBSCRIPTION_LABELS[cred.subscriptionType] ?? cred.subscriptionType ?? '订阅';
                sub.textContent = `${plan} 订阅 · 凭据来自${SOURCE_LABELS[cred.source] ?? cred.source} · 代理 v${data.version}`;
            } else {
                setDot('warning');
                title.textContent = '代理在线，但未登录';
                sub.textContent = '在代理目录运行 npm run login 登录 Claude 订阅账号';
            }
        } catch {
            setDot('offline');
            title.textContent = '连接不到代理';
            sub.textContent = IS_TAURI
                ? '请先在代理目录运行 npm start 启动本地代理'
                : '请确认服务器插件已加载，或在代理目录运行 npm start';
        }
    }

    // ── Quota meter ──

    const WINDOW_LABELS = {
        five_hour: '5 小时窗口',
        seven_day: '7 天 · 全部模型',
        seven_day_opus: '7 天 · Opus',
        seven_day_sonnet: '7 天 · Sonnet',
        seven_day_fable: '7 天 · Fable',
        seven_day_oauth_apps: '7 天 · 第三方应用',
    };

    function formatReset(ts) {
        if (!ts) return '';
        const d = new Date(ts);
        const time = d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
        const sameDay = d.toDateString() === new Date().toDateString();
        return sameDay ? `${time} 重置` : `${d.getMonth() + 1}/${d.getDate()} ${time} 重置`;
    }

    async function refreshQuota() {
        const box = document.getElementById('claude_max_quota');
        const stamp = document.getElementById('claude_max_quota_time');
        if (!box) return;
        box.classList.add('cm-loading');
        try {
            const res = await fetchProxy('/quota', '/v1/usage/quota');
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const data = await res.json();
            box.replaceChildren();
            if (!data.windows?.length) {
                box.append(el('small', 'cm-hint', '暂无额度数据'));
                return;
            }
            for (const w of data.windows) {
                const pct = w.utilization !== null ? Math.round(w.utilization * 100) : null;
                const row = el('div', 'cm-quota-row');
                const top = el('div', 'cm-quota-top');
                top.append(
                    el('span', 'cm-quota-label', WINDOW_LABELS[w.type] ?? w.type),
                    el('span', 'cm-quota-value', pct !== null ? `${pct}%` : '–'),
                );
                const bar = el('div', 'cm-quota-bar');
                const fill = el('div', 'cm-quota-fill');
                fill.style.width = `${Math.min(100, pct ?? 0)}%`;
                if ((pct ?? 0) >= 90) fill.classList.add('critical');
                else if ((pct ?? 0) >= 70) fill.classList.add('warning');
                bar.append(fill);
                row.append(top, bar);
                const reset = formatReset(w.resetsAt);
                if (reset) row.append(el('small', 'cm-hint cm-quota-reset', reset));
                box.append(row);
            }
            if (data.extraUsage?.isEnabled) {
                box.append(el('small', 'cm-hint',
                    `额外用量：${data.extraUsage.usedCredits} / ${data.extraUsage.monthlyLimit} ${data.extraUsage.currency}`));
            }
            if (stamp) {
                stamp.textContent = `更新于 ${new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })}`;
            }
        } catch (err) {
            box.replaceChildren(el('small', 'cm-hint', `额度暂不可用（${err instanceof Error ? err.message : err}）`));
        } finally {
            box.classList.remove('cm-loading');
        }
    }

    // ── Usage stats ──

    const fmtK = (n) => (n >= 10000 ? `${Math.round(n / 1000)}k` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n ?? 0));
    const fmtSec = (ms) => (ms == null ? '–' : ms >= 60000 ? `${Math.floor(ms / 60000)}分${Math.round((ms % 60000) / 1000)}秒` : `${(ms / 1000).toFixed(1)}秒`);
    const fmtPct = (x) => (x == null ? '–' : `${Math.round(x * 100)}%`);
    const fmtWhen = (ts) => {
        const d = new Date(ts);
        const time = d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
        return d.toDateString() === new Date().toDateString() ? `今天 ${time}` : `${d.getMonth() + 1}/${d.getDate()} ${time}`;
    };

    function statsRow(title, a) {
        const row = el('div', 'cm-stat-row');
        row.append(el('div', 'cm-stat-title', title));
        const grid = el('div', 'cm-stat-grid');
        const cells = [
            ['请求', a.failed ? `${a.requests}（失败 ${a.failed}）` : String(a.requests)],
            ['输出', `${fmtK(a.outputTokens)} token`],
            ['平均耗时', fmtSec(a.avgDurationMs)],
            ['首字等待', fmtSec(a.avgTtftMs)],
            ['缓存命中', fmtPct(a.cacheHitRate)],
            ['带原生思考', `${a.withReasoning} 次`],
        ];
        for (const [k, v] of cells) {
            const cell = el('div', 'cm-stat');
            cell.append(el('small', 'cm-hint', k), el('div', 'cm-stat-value', v));
            grid.append(cell);
        }
        row.append(grid);
        return row;
    }

    async function refreshStats() {
        const box = document.getElementById('claude_max_stats');
        if (!box) return;
        box.classList.add('cm-loading');
        try {
            const res = await fetchProxy('/stats', '/v1/usage/stats');
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const data = await res.json();
            box.replaceChildren();
            if (!data.week?.requests) {
                box.append(el('small', 'cm-hint', '还没有记录。从 v2.4 起每次对话都会记在这里（只记录耗时和 token 数，不记录聊天内容）。'));
            } else {
                box.append(statsRow('今天', data.today), statsRow('近 7 天', data.week));
            }
            if (data.lastCache) {
                const c = data.lastCache;
                const card = el('div', c.hitPct >= 50 ? 'cm-cache' : 'cm-cache cm-last-error cm-tip');
                card.append(el('div', 'cm-last-error-title', `最近一轮缓存 · ${c.headline}`));
                for (const r of c.reasons) card.append(el('small', 'cm-hint cm-cache-reason', r));
                box.append(card);
            }
            if (data.lastError) {
                const err = el('div', 'cm-last-error');
                err.append(
                    el('div', 'cm-last-error-title', `最近一次失败 · ${fmtWhen(data.lastError.at)} · ${data.lastError.model}`),
                    el('div', null, data.lastError.message),
                    el('small', 'cm-hint', `办法：${data.lastError.hint}`),
                );
                const raw = el('small', 'cm-hint cm-raw', `原始错误：${data.lastError.raw}`);
                err.append(raw);
                box.append(err);
            }
        } catch (err) {
            box.replaceChildren(el('small', 'cm-hint', `统计暂不可用（${err instanceof Error ? err.message : err}）`));
        } finally {
            box.classList.remove('cm-loading');
        }
        checkInlineCot();
    }

    // Presets that make the model write its chain of thought INTO the reply
    // (<thinking>…</thinking>) leave the native reasoning box empty, and ST's
    // auto-parse only catches it when its prefix/suffix match those tags.
    function checkInlineCot() {
        const tip = document.getElementById('claude_max_cot_tip');
        if (!tip) return;
        const chat = SillyTavern.getContext().chat ?? [];
        const last = [...chat].reverse().find((m) => !m.is_user && !m.is_system);
        const match = last?.mes?.match(/<(thinking|think|cot|analysis)\b[^>]*>/i);
        if (!match || last.extra?.reasoning) {
            tip.hidden = true;
            return;
        }
        const tag = match[1];
        tip.hidden = false;
        tip.replaceChildren(
            el('div', 'cm-last-error-title', '当前预设把思维链写在了正文里'),
            el('small', 'cm-hint',
                `最近的回复里有 <${tag}> 块，所以原生思考框是空的：模型已经在正文里思考，就不会再启用原生思考，而且这部分也会占用输出长度和生成时间。` +
                `想把它收进折叠框：酒馆「用户设置 → 推理 → 自动解析」，前缀填 <${tag}>、后缀填 </${tag}>。` +
                '想改用原生思考：关掉预设里的思维链条目，并在上面把「思考模式」设为「始终思考」。'),
        );
    }

    function refreshAll() {
        refreshProxyStatus();
        refreshQuota();
        refreshStats();
    }

    // ── Settings UI ──

    const EFFORT_OPTIONS = [
        { value: 'auto', label: '自动', hint: '不指定，使用模型默认值（多数模型为「高」，Opus 5.5 为「中」）。' },
        { value: 'low', label: '低', hint: '最快、最省额度，但长篇角色扮演容易漏规则、人设变浅，一般不推荐。' },
        { value: 'medium', label: '中', hint: '速度与质量的平衡点。' },
        { value: 'high', label: '高', hint: '复杂剧情更连贯、规则执行更完整，回复稍慢。长篇角色扮演推荐。' },
        { value: 'xhigh', label: '超高', hint: '更深入的推理，回复更慢、更耗额度。' },
        { value: 'max', label: '最大', hint: '最深度的思考，最慢、最耗额度。' },
    ];

    const THINKING_OPTIONS = [
        { value: 'adaptive', label: '自适应', hint: '由模型判断是否需要思考，简单对话不额外等待（推荐）。' },
        { value: 'on', label: '始终思考', hint: '每次回复前都先思考。Sonnet 5 会按自适应处理。' },
        { value: 'off', label: '关闭', hint: '不思考。Fable、Opus 4.7 及以上（含 Opus 5 / 5.5）总会思考，此项对它们无效。' },
    ];

    function addExtensionSettings(settings) {
        const container = document.getElementById('extensions_settings') ?? document.body;
        const save = () => saveSettingsDebounced();

        const drawer = el('div', 'inline-drawer claude-max');
        const toggle = el('div', 'inline-drawer-toggle inline-drawer-header');
        const heading = el('b', 'cm-heading');
        heading.append(el('span', 'cm-dot'), document.createTextNode('Claude Max 订阅'));
        toggle.append(heading, el('div', 'inline-drawer-icon fa-solid fa-circle-chevron-down down'));
        const drawerContent = el('div', 'inline-drawer-content');
        // ST slide-toggles the drawer content's display — keep our flex
        // layout on an inner wrapper so it never fights that.
        const content = el('div', 'cm-body');
        drawerContent.append(content);
        drawer.append(toggle, drawerContent);
        container.append(drawer);

        // Refresh live data whenever the drawer is opened.
        toggle.addEventListener('click', () => setTimeout(() => {
            if (drawerContent.offsetParent !== null) refreshAll();
        }, 50));

        // Status card + connect
        const card = el('div', 'cm-card cm-status');
        const statusText = el('div', 'cm-status-text');
        const statusTitle = el('div', 'cm-status-title');
        statusTitle.id = 'claude_max_status_title';
        const statusSub = el('small', 'cm-hint');
        statusSub.id = 'claude_max_status_sub';
        statusText.append(statusTitle, statusSub);
        card.append(el('span', 'cm-dot cm-dot-lg'), statusText, iconButton('fa-rotate', '重新检测', refreshProxyStatus));
        content.append(card);

        const connectBtn = el('div', 'menu_button cm-connect');
        connectBtn.append(el('i', 'fa-solid fa-plug'), document.createTextNode(' 一键连接'));
        connectBtn.addEventListener('click', () => connect(getSettings()));
        content.append(connectBtn);
        content.append(el('small', 'cm-hint cm-center',
            '自动切到 Chat Completion → Custom 并填好地址，连接后在模型下拉框里选择 Claude 模型。'));

        // Reasoning
        content.append(section('推理'));
        content.append(segmented({
            label: '思考深度',
            options: EFFORT_OPTIONS,
            current: settings.effort,
            onChange: (v) => { settings.effort = VALID_EFFORTS.includes(v) ? v : 'auto'; save(); },
        }));
        content.append(oneShotEffortRow(settings));
        content.append(segmented({
            label: '思考模式',
            options: THINKING_OPTIONS,
            current: settings.thinking,
            onChange: (v) => { settings.thinking = VALID_THINKING.includes(v) ? v : 'adaptive'; save(); },
        }));
        content.append(toggleRow({
            id: 'claudeMaxShowReasoning',
            title: '显示思考过程',
            desc: '在回复上方的折叠框里显示思考摘要（需同时开启酒馆的「显示模型思维」）。只影响显示，不会进入聊天记录。',
            checked: settings.showReasoning,
            onChange: (v) => { settings.showReasoning = v; save(); },
        }));

        // Quota
        const quotaStamp = el('small', 'cm-hint');
        quotaStamp.id = 'claude_max_quota_time';
        const quotaTools = el('div', 'cm-section-tools');
        quotaTools.append(quotaStamp, iconButton('fa-rotate', '刷新额度', refreshQuota));
        content.append(section('订阅额度', quotaTools));
        const quotaBox = el('div', 'cm-quota');
        quotaBox.id = 'claude_max_quota';
        quotaBox.append(el('small', 'cm-hint', '展开面板时自动加载。'));
        content.append(quotaBox);

        // Usage stats
        const statsTools = el('div', 'cm-section-tools');
        statsTools.append(iconButton('fa-rotate', '刷新统计', refreshStats));
        content.append(section('使用统计', statsTools));
        const statsBox = el('div', 'cm-stats');
        statsBox.id = 'claude_max_stats';
        statsBox.append(el('small', 'cm-hint', '展开面板时自动加载。'));
        content.append(statsBox);
        const cotTip = el('div', 'cm-last-error cm-tip');
        cotTip.id = 'claude_max_cot_tip';
        cotTip.hidden = true;
        content.append(cotTip);

        // Advanced
        const adv = el('details', 'cm-details');
        adv.append(el('summary', null, '高级设置'));
        const endpointField = el('div', 'cm-field');
        endpointField.append(el('div', 'cm-field-label', '代理地址'));
        const endpointInput = el('input', 'text_pole');
        endpointInput.type = 'text';
        endpointInput.value = settings.endpoint;
        endpointInput.placeholder = DEFAULT_ENDPOINT;
        endpointInput.addEventListener('input', () => {
            settings.endpoint = endpointInput.value || DEFAULT_ENDPOINT;
            save();
        });
        endpointField.append(endpointInput, el('small', 'cm-hint', `默认 ${DEFAULT_ENDPOINT}。修改了代理端口时同步改这里，再点一键连接。`));
        adv.append(endpointField);
        adv.append(toggleRow({
            id: 'claudeMaxEnabled',
            title: '把以上设置附加到请求',
            desc: '只对指向本代理的连接生效，其他 Custom 端点不受影响。',
            checked: settings.enabled,
            onChange: (v) => { settings.enabled = v; save(); },
        }));
        adv.append(toggleRow({
            id: 'claudeMaxResume',
            title: '会话续接',
            desc: '把聊天记录还原成真实多轮对话，角色区分更准，能用上提示缓存（更快、更省额度）。仅排查问题时关闭。',
            checked: settings.useResume,
            onChange: (v) => { settings.useResume = v; save(); },
        }));
        adv.append(toggleRow({
            id: 'claudeMaxInlineSystem',
            title: '深度注入保持原位',
            desc: '预设里「深度 N」的条目、世界书深度条目、作者注释留在聊天记录里原来的位置，和酒馆直连 Claude 的做法一致，靠近结尾的提醒才有效。关闭则全部提到开头；那样的话只要其中有一条变化（比如世界书被触发），整个系统提示词的缓存都会失效。',
            checked: settings.inlineSystem,
            onChange: (v) => { settings.inlineSystem = v; save(); },
        }));
        adv.append(toggleRow({
            id: 'claudeMaxIdentity',
            title: '身份模式',
            desc: '在角色卡前加上 Claude Code 官方前言，模型能正确说出自己是哪个型号，但会多耗 token 并带点编程助手味。角色扮演建议关闭。',
            checked: settings.identityMode,
            onChange: (v) => { settings.identityMode = v; save(); },
        }));
        adv.append(toggleRow({
            id: 'claudeMaxDebugDump',
            title: '调试：保存最近一次完整请求',
            desc: '把最近一次发给 Claude 的系统提示词和聊天记录存到代理目录 data/debug/（只存本机，每次覆盖，上一份另存为 previous）。排查预设、世界书、缓存问题时打开，平时关闭。',
            checked: settings.debugDump,
            onChange: (v) => { settings.debugDump = v; save(); },
        }));
        content.append(adv);

        // Notes
        const notes = el('details', 'cm-details');
        notes.append(el('summary', null, '使用说明'));
        const list = el('ul', 'cm-notes');
        for (const line of [
            '代理需要一直运行：在代理目录执行 npm start（原版酒馆装了服务器插件时会自动启动）。',
            IS_TAURI
                ? '首次连接时 TauriTavern 会弹出授权框，允许访问代理地址即可。'
                : '从手机或其他设备打开酒馆时，额度和状态会经由酒馆服务器转发读取。',
            '请把酒馆自带的「推理强度」保持为自动，由本面板的「思考深度」代替。',
            '修改「思考深度」后的下一轮，提示词缓存会失效一次（官方说明），不要频繁来回切换。',
            '订阅通道不支持温度、Top-P 等采样参数（Agent SDK 限制）。',
            '「(1M context)」模型提供 100 万上下文；部分套餐需要开通额外用量，失败时会自动退回普通版本一小时。',
        ]) {
            list.append(el('li', null, line));
        }
        notes.append(list);
        content.append(notes);
    }

    function rebuildPanel() {
        const old = document.querySelector('.inline-drawer.claude-max');
        const wasOpen = old?.querySelector('.inline-drawer-content')?.offsetParent != null;
        const anchor = old?.nextSibling ?? null;
        const parent = old?.parentElement;
        old?.remove();
        addExtensionSettings(getSettings());
        const fresh = document.querySelector('.inline-drawer.claude-max');
        if (parent && fresh && anchor) parent.insertBefore(fresh, anchor);
        if (wasOpen) {
            fresh?.querySelector('.inline-drawer-toggle')?.click();
        }
        refreshProxyStatus();
    }

    // ── Boot ──

    const settings = getSettings();
    addExtensionSettings(settings);
    refreshProxyStatus();
    eventSource.on(eventTypes.CHAT_COMPLETION_SETTINGS_READY, onSettingsReady);
    // Keep stats fresh while the panel is open.
    const refreshIfOpen = () => {
        const box = document.getElementById('claude_max_stats');
        if (box && box.offsetParent !== null) setTimeout(refreshStats, 500);
    };
    eventSource.on(eventTypes.MESSAGE_RECEIVED, clearOneShotEffort);
    eventSource.on(eventTypes.MESSAGE_RECEIVED, refreshIfOpen);
    eventSource.on(eventTypes.CHAT_CHANGED, refreshIfOpen);
    eventSource.on(eventTypes.OAI_PRESET_CHANGED_AFTER, applyPresetRecommendation);
    console.log(`[claude-max] UI extension loaded${IS_TAURI ? ' (TauriTavern mode)' : ''}`);
})();

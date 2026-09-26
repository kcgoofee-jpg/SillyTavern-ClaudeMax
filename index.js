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

    // Shared reply checks (lib/chat-check.js, also used by the tests). Loaded
    // lazily so a copy of this file without lib/ still works — the check-up
    // section then just says it is unavailable.
    let chatCheck = null;
    import(new URL('./lib/chat-check.js', import.meta.url).href)
        .then((m) => { chatCheck = m; runCheckup(); })
        .catch(() => { /* check-up unavailable */ });
    let loreConst = null;
    import(new URL('./lib/lore-constant.js', import.meta.url).href)
        .then((m) => { loreConst = m; refreshLoreBox(); })
        .catch(() => { /* lore tool unavailable */ });
    let cardAudit = null;
    import(new URL('./lib/card-audit.js', import.meta.url).href)
        .then((m) => { cardAudit = m; runCardAudit({ toast: true }); })
        .catch(() => { /* card audit unavailable */ });
    let presetReco = null;
    import(new URL('./lib/preset-reco.js', import.meta.url).href)
        .then((m) => { presetReco = m; adoptUnrecordedReco(); })
        .catch(() => { /* preset recommendations unavailable */ });
    // 灵动岛 (lib/island.js): one morphing pill at the top of the Claude Max
    // panel (never over the chat). It shows the reply being generated and,
    // while the panel is open, the notices; with the panel closed notices are
    // ordinary toasts.
    let island = null;
    import(new URL('./lib/island.js', import.meta.url).href)
        .then((m) => {
            island = m.createIsland(document);
            island.set({ online: proxyOnline });
            island.mount(document.getElementById('claude_max_island_slot'));
        })
        .catch(() => { /* toasts only */ });

    const TOAST_KIND = { ok: 'success', info: 'info', warn: 'warning', bad: 'error' };
    const toastByKey = {};
    /** One notice: the island when the panel is open, a toast otherwise. */
    function notify(tone, title, text = '', opts = {}) {
        const ms = opts.ms ?? 6000;
        if (opts.replace && toastByKey[opts.replace]) {
            toastr?.clear?.(toastByKey[opts.replace]);
            delete toastByKey[opts.replace];
        }
        if (island?.visible) return island.notice({ tone, title, text, ms, replace: opts.replace, onDismiss: opts.onDismiss });
        island?.clear(opts.replace);
        const esc = (v) => String(v).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
        const t = toastr?.[TOAST_KIND[tone]]?.(esc(text).replace(/\n/g, '<br>'), `Claude Max · ${esc(title)}`, {
            timeOut: ms, extendedTimeOut: ms === 0 ? 0 : 1000, escapeHtml: false, preventDuplicates: true,
            onCloseClick: opts.onDismiss,
        });
        if (opts.replace && t) toastByKey[opts.replace] = t;
        return t;
    }

    // Recommendations applied by v2.5.0 left no record, so switching away
    // couldn't undo them. If the active preset's recommendation is in effect
    // and differs from the defaults, record it once (restore target: default).
    function adoptUnrecordedReco() {
        try {
            const settings = getSettings();
            if (settings.presetRecoRecord) return;
            const rec = SillyTavern.getContext().chatCompletionSettings?.extensions?.claude_max;
            if (!rec || typeof rec !== 'object') return;
            const record = { before: {}, applied: {} };
            for (const key of Object.keys(PRESET_FIELDS)) {
                if (rec[key] !== undefined && settings[key] === rec[key] && rec[key] !== defaultSettings[key]) {
                    record.before[key] = defaultSettings[key];
                    record.applied[key] = rec[key];
                }
            }
            if (Object.keys(record.applied).length) {
                settings.presetRecoRecord = record;
                saveSettingsDebounced();
            }
        } catch { /* best-effort */ }
    }

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
        checkupToast: true,      // 本轮体检发现问题时弹提示
        leakWords: {},           // 角色卡 → 隐藏设定关键词（逗号分隔）
        presetRecoRecord: null,  // 上一个预设的推荐改了什么（切走时恢复）
        tailBlockFront: false,   // 实验：预设后置条目提前（省缓存）
        loreTail: true,          // 每轮变化的世界书移到本轮消息开头（省缓存）
        foldTail: true,          // 发言后面的深度 0 注入并进发言（省缓存）
        accessKey: '',           // 局域网访问密码（手机连 Mac 上的代理时用）
        quietEffort: 'low',      // 后台请求（其他插件的生图 tag、总结等）的思考深度；'follow' = 跟随面板
        panelTab: 'reason',      // 面板上次打开的分页
        compactScriptButtons: true, // 输入栏上方的脚本按钮并排显示
        quietRender: 'auto',     // 省电显示：'auto'（手机 / TauriTavern 上开）| 'on' | 'off'
        checkupMuted: {},        // 体检提示被点掉的次数（按问题类型）；两次后不再弹
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
            if (keyField.length && settings.accessKey) {
                // LAN: the proxy checks this as the access key
                keyField.val(settings.accessKey).trigger('input');
            } else if (keyField.length && !String(keyField.val() ?? '').trim()) {
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
        tailBlockFront: { label: '预设后置条目提前', valid: (v) => typeof v === 'boolean' },
        loreTail: { label: '世界书变化部分移到末尾', valid: (v) => typeof v === 'boolean' },
        foldTail: { label: '发言后的注入并进发言', valid: (v) => typeof v === 'boolean' },
        identityMode: { label: '身份模式', valid: (v) => typeof v === 'boolean' },
    };

    function applyPresetRecommendation() {
        if (!presetReco) return;
        const ctx = SillyTavern.getContext();
        const rec = ctx.chatCompletionSettings?.extensions?.claude_max;
        const settings = getSettings();
        const { next, restored, applied, record } = presetReco.planPresetReco(settings, rec, settings.presetRecoRecord ?? null, PRESET_FIELDS);
        settings.presetRecoRecord = record;
        if (!restored.length && !applied.length) return;
        Object.assign(settings, next, { presetRecoRecord: record });
        saveSettingsDebounced();
        rebuildPanel();
        const preset = ctx.chatCompletionSettings?.preset_settings_openai ?? '当前预设';
        const parts = [];
        if (applied.length) parts.push(`按预设「${preset}」的推荐调整：${applied.map((k) => PRESET_FIELDS[k].label).join('、')}`);
        if (restored.length) parts.push(`恢复上一个预设改动过的：${restored.map((k) => PRESET_FIELDS[k].label).join('、')}`);
        notify('info', `预设「${preset}」`, `${parts.join('；')}。`, { ms: 8000 });
    }


    // ── Per-request injection (CHAT_COMPLETION_SETTINGS_READY) ──

    // One-shot effort for the next reply (M2): kept in memory only, used by
    // every request until a chat message arrives, then cleared.
    let nextEffort = null;

    function effectiveEffort(settings) {
        return nextEffort ?? settings.effort;
    }

    // ── Reply keeper (lib/reply-keeper.js) ──
    // Each request carries a slot: a hash of the chat and the player's message
    // (no text). The proxy keeps the finished reply under it, in memory; if the
    // app lost it (background, closed mid-stream) the floor is filled back in.

    function fnv64(str) {
        let h1 = 0x811c9dc5, h2 = 0x01000193;
        for (let i = 0; i < str.length; i++) {
            const c = str.charCodeAt(i);
            h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
            h2 = Math.imul(h2 ^ c, 0x5bd1e995) >>> 0;
        }
        return h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0');
    }

    function replySlotFor(ctx, beforeIndex = ctx.chat?.length ?? 0) {
        const chat = ctx.chat ?? [];
        for (let i = Math.min(beforeIndex, chat.length) - 1; i >= 0; i--) {
            const m = chat[i];
            if (m?.is_user) return fnv64(`${ctx.chatId ?? ''}\u0000${m.mes ?? ''}`);
        }
        return null;
    }

    let recovering = false;
    async function recoverKeptReply() {
        if (recovering) return;
        const ctx = SillyTavern.getContext();
        const chat = ctx.chat ?? [];
        const i = chat.length - 1;
        const last = chat[i];
        if (!last || last.is_user || last.is_system || i < 1) return;
        if (ctx.streamingProcessor && !ctx.streamingProcessor.isFinished) return; // still being written
        const now = String(last.mes ?? '').trim();
        const slot = replySlotFor(ctx, i);
        if (!slot) return;
        recovering = true;
        try {
            const res = await fetchProxy(`/reply/${slot}`, `/v1/replies/${slot}`);
            if (!res.ok) return;
            const kept = await res.json();
            const text = String(kept?.text ?? '');
            if (!text || text.length <= now.length) return;
            const partial = now && now !== '...';
            if (partial && !text.startsWith(now.slice(0, Math.min(40, now.length)))) return; // a different reply: leave it
            const cur = SillyTavern.getContext().chat?.[i];
            if (cur !== last) return; // chat changed meanwhile
            last.mes = text;
            if (Array.isArray(last.swipes) && Number.isInteger(last.swipe_id)) last.swipes[last.swipe_id] = text;
            last.extra = { ...(last.extra ?? {}), ...(kept.reasoning ? { reasoning: kept.reasoning } : {}) };
            last.gen_finished = new Date(kept.at).toISOString();
            ctx.updateMessageBlock?.(i, last);
            await ctx.saveChat?.();
            notify('ok', `第 ${i} 楼已补回`, `刚才没存上，从代理取回 ${text.length} 字`, { ms: 8000 });
        } catch { /* proxy unreachable: try again next time */ } finally {
            recovering = false;
        }
    }

    function buildIncludeBodyYaml(settings, quiet = false, slot = null) {
        const lines = ['claude_subscription:'];
        // Background calls never take the one-shot effort meant for the next reply.
        const effort = quiet ? (settings.quietEffort === 'follow' ? settings.effort : settings.quietEffort) : effectiveEffort(settings);
        if (quiet) lines.push('  purpose: quiet');
        if (effort !== 'auto') lines.push(`  effort: ${effort}`);
        lines.push(`  thinking: ${settings.thinking}`);
        // Follows ST's「显示模型思维」; a preset can still turn it off.
        const stShows = SillyTavern.getContext().chatCompletionSettings?.show_thoughts !== false;
        lines.push(`  show_reasoning: ${settings.showReasoning && stShows}`);
        lines.push(`  identity_mode: ${settings.identityMode}`);
        lines.push(`  use_resume: ${settings.useResume}`);
        lines.push(`  system_placement: ${settings.inlineSystem ? 'inline' : 'hoist'}`);
        if (settings.tailBlockFront) lines.push('  tail_block: front');
        lines.push(`  lore_tail: ${settings.loreTail}`);
        lines.push(`  fold_tail: ${settings.foldTail}`);
        if (settings.debugDump) lines.push('  debug_dump: true');
        if (slot && !quiet) lines.push(`  reply_slot: ${slot}`);
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
            const slot = ['quiet', 'impersonate', 'continue'].includes(data.type) ? null : replySlotFor(SillyTavern.getContext());
            data.custom_include_body = (cleaned ? cleaned + '\n' : '') + buildIncludeBodyYaml(settings, data.type === 'quiet', slot);
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
        // The proxy itself first: it is the source of truth (the ST plugin
        // route can be an older copy until SillyTavern restarts). On another
        // device 127.0.0.1 is unreachable, so that fails fast and the
        // same-origin plugin route takes over.
        // The plugin route speaks for the proxy on the default port only: with
        // another endpoint (phone → Mac, another port) falling back to it
        // would report a different proxy as healthy while this one is down.
        const settings = getSettings();
        const directOnly = IS_TAURI || normalizeEndpoint(settings.endpoint) !== normalizeEndpoint(DEFAULT_ENDPOINT);
        try {
            const key = settings.accessKey;
            const direct = await fetch(`${proxyBase(settings)}${directPath}`, { signal: AbortSignal.timeout(directOnly ? 12000 : 1500), headers: key ? { 'X-Claude-Max-Key': key } : {} });
            if (direct.ok || directOnly) return direct;
        } catch (err) {
            if (directOnly) throw err;
        }
        return fetch(`/api/plugins/claude-subscription${pluginPath}`, { signal: AbortSignal.timeout(12000) });
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
        row.append(el('span', 'cm-field-label', '仅下一轮'));
        const status = el('small', 'cm-hint');
        const group = el('div', 'cm-seg');
        row.append(group);
        const render = () => {
            group.querySelectorAll('button').forEach((b) => b.classList.toggle('active', b.dataset.effort === (nextEffort ?? '')));
            status.textContent = nextEffort
                ? `下一条回复用「${EFFORT_LABEL[nextEffort]}」，收到后恢复「${EFFORT_LABEL[settings.effort]}」。再点一次取消。`
                : '关键剧情点一下，只影响下一条回复。实测高约慢 1/3，超高约慢 3 倍；这一轮聊天记录的缓存要重写一次，下一轮切回后原来的缓存照样能用。';
        };
        for (const [value, label] of [['high', '高'], ['xhigh', '超高']]) {
            const b = el('button', 'cm-seg-btn', label);
            b.type = 'button';
            b.dataset.effort = value;
            b.addEventListener('click', () => { nextEffort = nextEffort === value ? null : value; render(); renderGlance(); });
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
        renderGlance();
    }

    // ── 缓存优化：当前角色卡的世界书设为常驻 ──

    async function refreshLoreBox() {
        const box = document.getElementById('claude_max_lore');
        if (!box) return;
        if (!loreConst) {
            box.replaceChildren(el('small', 'cm-hint', '这个功能没有加载（扩展文件不完整），重新安装扩展即可。'));
            return;
        }
        const ctx = SillyTavern.getContext();
        const ch = ctx.groupId ? null : ctx.characters?.[ctx.characterId];
        const name = ch?.data?.extensions?.world;
        if (!ch) { box.replaceChildren(el('small', 'cm-hint', '打开一张角色卡的聊天后可用。')); return; }
        if (!name) { box.replaceChildren(el('small', 'cm-hint', `「${ch.name}」没有绑定世界书，不需要处理。`)); return; }
        let book;
        try { book = await ctx.loadWorldInfo(name); } catch { book = null; }
        if (!book) { box.replaceChildren(el('small', 'cm-hint', `读不到世界书「${name}」。`)); return; }
        const sum = loreConst.summarizeLore(book);
        const backup = loreConst.backupName(name);
        const hasBackup = (ctx.getWorldInfoNames?.() ?? []).includes(backup);
        box.replaceChildren(el('small', 'cm-hint', sum.keyword
            ? `「${name}」有 ${sum.keyword} 条按关键词触发的条目（约 ${sum.keywordChars.toLocaleString()} 字），会让聊天记录每轮重写缓存。`
            : `「${name}」的条目已全部常驻，不影响缓存。`));
        if (sum.keyword) {
            const why = el('details', 'cm-mini');
            why.append(el('summary', null, '设为常驻有什么影响'), el('small', 'cm-hint',
                '每轮触发的条目不同，整段聊天记录的缓存就对不上。设为常驻后每轮都发送这些条目（多占上下文），但聊天记录能命中缓存；实测每轮缓存写入约从 2.8 万降到 3 千 token。'));
            box.append(why);
        }
        const row = el('div', 'cm-oneshot-row');
        if (sum.keyword) {
            const b = el('div', 'menu_button', '设为常驻（先自动备份）');
            b.addEventListener('click', () => convertLore(name, book, backup));
            row.append(b);
        }
        if (hasBackup) {
            const r = el('div', 'menu_button', '恢复为设为常驻之前');
            r.addEventListener('click', () => restoreLore(name, backup));
            row.append(r);
        }
        if (row.childElementCount) box.append(row);
    }

    async function convertLore(name, book, backup) {
        const ctx = SillyTavern.getContext();
        const ok = await ctx.callGenericPopup(`把世界书「${name}」里按关键词触发的条目全部改为常驻？\n原世界书会先备份为「${backup}」，之后可以一键恢复。`, ctx.POPUP_TYPE.CONFIRM);
        if (!ok) return;
        try {
            if (!(ctx.getWorldInfoNames?.() ?? []).includes(backup)) {
                await ctx.saveWorldInfo(backup, book, true);
                await ctx.updateWorldInfoList?.();
            }
            const { book: next, changed } = loreConst.makeAllConstant(book);
            await ctx.saveWorldInfo(name, next, true);
            ctx.reloadWorldInfoEditor?.(name);
            toastr?.success?.(`「${name}」：${changed} 条改为常驻，备份在「${backup}」。`, 'Claude Max');
        } catch (err) {
            toastr?.error?.(`没改成：${err instanceof Error ? err.message : err}`, 'Claude Max');
        }
        refreshLoreBox();
    }

    async function restoreLore(name, backup) {
        const ctx = SillyTavern.getContext();
        const ok = await ctx.callGenericPopup(`用备份「${backup}」覆盖世界书「${name}」，恢复成设为常驻之前的样子？`, ctx.POPUP_TYPE.CONFIRM);
        if (!ok) return;
        try {
            const saved = await ctx.loadWorldInfo(backup);
            await ctx.saveWorldInfo(name, saved, true);
            ctx.reloadWorldInfoEditor?.(name);
            toastr?.success?.(`「${name}」已恢复。备份仍保留，不需要时可在世界书列表里删除。`, 'Claude Max');
        } catch (err) {
            toastr?.error?.(`没恢复成：${err instanceof Error ? err.message : err}`, 'Claude Max');
        }
        refreshLoreBox();
    }

    // ── 本轮体检（M4）──

    function currentCharKey() {
        const ctx = SillyTavern.getContext();
        return ctx.groupId ? `group:${ctx.groupId}` : (ctx.characters?.[ctx.characterId]?.avatar ?? 'default');
    }

    let lastToastKey = '';

    function runCheckup({ toast = false } = {}) {
        const box = document.getElementById('claude_max_checkup');
        if (!chatCheck) {
            box?.replaceChildren(el('small', 'cm-hint', '体检模块没有加载（扩展文件不完整），重新安装扩展即可。'));
            return;
        }
        const settings = getSettings();
        const ctx = SillyTavern.getContext();
        const chat = ctx.chat ?? [];
        const ai = chat.filter((m) => !m.is_user && !m.is_system);
        if (chat.length < 2 || !ai.length) {
            box?.replaceChildren(el('small', 'cm-hint', '还没有 AI 回复。每条回复生成完会自动体检。'));
            return;
        }
        const prompts = ctx.chatCompletionSettings?.prompts ?? [];
        const leaks = String(settings.leakWords?.[currentCharKey()] ?? '').split(/[,，、\s]+/).filter(Boolean);
        const last = ai[ai.length - 1];
        const prev = ai.length > 1 ? ai[ai.length - 2] : null;
        const r = chatCheck.checkReply({
            mes: last.mes ?? '', prevMes: prev?.mes ?? null,
            words: chatCheck.wordRangeFromPreset(ctx.chatCompletionSettings), banned: chatCheck.bannedFromPrompts(prompts), leaks,
            secondPerson: chatCheck.secondPersonFromPreset(ctx.chatCompletionSettings),
            paragraphs: chatCheck.paragraphRangeFromPreset?.(ctx.chatCompletionSettings) ?? null,
            sceneCard: chatCheck.sceneCardFromPreset?.(ctx.chatCompletionSettings) ?? false,
        });
        glance.issues = r.issues.length;
        renderGlance();
        if (box) {
            const card = el('div', r.issues.length ? 'cm-last-error cm-tip' : 'cm-cache');
            card.append(el('div', 'cm-last-error-title', r.issues.length
                ? `最新回复 · 正文 ${r.chars} 字 / ${r.paragraphs ?? '?'} 段 · ${r.issues.length} 个问题`
                : `最新回复 · 正文 ${r.chars} 字 / ${r.paragraphs ?? '?'} 段 · 没发现问题`));
            for (const i of r.issues) card.append(el('small', 'cm-hint', `· ${i.text}`));
            box.replaceChildren(card);
        }
        // Toast only when the problems change: the same issue every reply is noise.
        const toastKey = `${currentCharKey()}|${r.issues.map((i) => i.code).sort().join(',')}`;
        if (!r.issues.length) lastToastKey = '';
        const always = r.issues.some((i) => i.code === 'flashback');
        // Tapping a check-up notice away twice mutes that kind of issue (the
        // 体检 tab still lists it).
        const muted = settings.checkupMuted ?? {};
        const loud = r.issues.filter((i) => (muted[i.code] ?? 0) < 2);
        if (toast && loud.length && settings.checkupToast && (always || toastKey !== lastToastKey)) {
            lastToastKey = toastKey;
            notify('warn', `本轮体检 · ${loud.length} 个问题`, loud.map((i) => i.text).join('\n'), {
                ms: 9000,
                replace: 'checkup',
                onDismiss: () => {
                    const m = { ...(getSettings().checkupMuted ?? {}) };
                    for (const i of loud) m[i.code] = (m[i.code] ?? 0) + 1;
                    getSettings().checkupMuted = m;
                    saveSettingsDebounced();
                    const now = loud.filter((i) => m[i.code] === 2);
                    if (now.length) notify('info', '这类问题以后不再弹出', '体检页里照样能看到', { ms: 4000 });
                },
            });
        }
    }

    // ── 角色卡检查：未成年人物与幼态化描写（lib/card-audit.js）──

    const auditedCards = new Set(); // warned once per card per page load

    async function runCardAudit({ toast = false } = {}) {
        const box = document.getElementById('claude_max_card_audit');
        if (!cardAudit) {
            box?.replaceChildren(el('small', 'cm-hint', '这个功能没有加载（扩展文件不完整），重新安装扩展即可。'));
            return;
        }
        const ctx = SillyTavern.getContext();
        const ch = ctx.groupId ? null : ctx.characters?.[ctx.characterId];
        if (!ch) { box?.replaceChildren(el('small', 'cm-hint', '打开一张角色卡的聊天后可用。')); return; }
        const items = cardAudit.cardItems(ch.data ?? ch);
        const books = new Set([ch.data?.extensions?.world].filter(Boolean));
        try {
            const wi = await import('/scripts/world-info.js');
            for (const n of wi.selected_world_info ?? []) books.add(n);
        } catch { /* global lorebooks unknown in this frontend */ }
        for (const name of books) {
            try { items.push(...cardAudit.worldItems(await ctx.loadWorldInfo(name), name)); } catch { /* unreadable book */ }
        }
        const persona = ctx.powerUserSettings?.persona_description;
        if (persona) items.push({ where: '你的人设', text: persona });
        const found = cardAudit.auditTexts(items);
        const high = found.filter((f) => f.level === 'high');
        if (box) {
            const card = el('div', high.length ? 'cm-last-error' : found.length ? 'cm-last-error cm-tip' : 'cm-cache');
            card.append(el('div', 'cm-last-error-title', found.length
                ? `「${ch.name}」：高风险 ${high.length} 处，提醒 ${found.length - high.length} 处`
                : `「${ch.name}」：没有发现未成年人物或幼态化描写`));
            for (const f of found.slice(0, 12)) {
                card.append(el('small', 'cm-hint', `${f.level === 'high' ? '✗' : '!'} ${f.text} · ${f.where}${f.disabled ? '（已关闭）' : ''}：${f.snippet}`));
            }
            if (found.length > 12) card.append(el('small', 'cm-hint', `……另有 ${found.length - 12} 处。`));
            if (found.length) {
                card.append(el('small', 'cm-hint', '这类内容会让 Claude 每轮先在思考里核查年龄、主动收敛剧情，也违反 Anthropic 的使用政策。已关闭的条目也列出来了：换个开关组合就可能被发出去。'));
            }
            box.replaceChildren(card);
        }
        const key = ch.avatar ?? ch.name;
        if (toast && high.length && !auditedCards.has(key)) {
            auditedCards.add(key);
            toastr?.error?.(`「${ch.name}」里有 ${high.length} 处未成年人物相关内容（${[...new Set(high.map((f) => f.where))].slice(0, 3).join('、')}）。详情见 Claude Max 面板「体检 → 角色卡检查」。`, 'Claude Max · 角色卡检查', { timeOut: 15000 });
        }
    }

    async function showDebugRequest() {
        let data;
        try {
            const res = await fetchProxy('/debug', '/v1/debug/last');
            data = await res.json();
        } catch (err) {
            toastr?.error?.(`读取失败：${err instanceof Error ? err.message : err}`, 'Claude Max');
            return;
        }
        if (!data?.ok) {
            toastr?.info?.(data?.error ?? '还没有保存的请求。', 'Claude Max', { timeOut: 8000 });
            return;
        }
        const wrap = el('div', 'cm-debug-view');
        const s = data.settings ?? {};
        wrap.append(el('div', 'cm-last-error-title',
            `${new Date(data.at).toLocaleString('zh-CN')} · ${data.model} · 思考深度 ${s.effort ?? '默认'} · 深度注入${s.systemPlacement === 'hoist' ? '提到系统提示词' : '保持原位'}`));
        wrap.append(el('small', 'cm-hint', `系统提示词 ${data.systemMarked.length.toLocaleString()} 字${s.systemSplitAt ? `，缓存分界在第 ${s.systemSplitAt.toLocaleString()} 字（文中有标记）` : ''}；聊天记录 ${data.messages.length} 条。`));
        const sys = el('details', 'cm-details');
        sys.append(el('summary', null, '系统提示词'), el('pre', 'cm-debug-pre', data.systemMarked));
        wrap.append(sys);
        const hist = el('details', 'cm-details');
        hist.append(el('summary', null, '聊天记录（代理整理后的顺序）'));
        data.messages.forEach((m, i) => {
            const text = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
            const item = el('details', 'cm-details');
            item.append(el('summary', null, `${i + 1}. ${m.role === 'user' ? '用户' : 'AI'} · ${text.length} 字`), el('pre', 'cm-debug-pre', text));
            hist.append(item);
        });
        wrap.append(hist);
        const ctx = SillyTavern.getContext();
        await ctx.callGenericPopup(wrap, ctx.POPUP_TYPE.TEXT, '', { wide: true, large: true, allowVerticalScrolling: true });
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

    /** Toggle row: title + one-line description, switch on the right.
     *  `more` (optional) is the long explanation, behind a「说明」link. */
    function toggleRow({ id, title, desc, more, checked, onChange }) {
        const row = el('label', 'cm-toggle');
        row.htmlFor = id;
        const text = el('div', 'cm-toggle-text');
        const hint = el('small', 'cm-hint', desc);
        text.append(el('div', 'cm-toggle-title', title), hint);
        const input = el('input');
        input.type = 'checkbox';
        input.id = id;
        input.checked = checked;
        input.addEventListener('change', () => onChange(input.checked));
        const sw = el('span', 'cm-switch');
        row.append(text, input, sw);
        if (!more) return row;
        const moreText = el('small', 'cm-hint cm-more-text', more);
        moreText.hidden = true;
        const link = el('a', 'cm-more', '说明');
        link.href = '#';
        link.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            moreText.hidden = !moreText.hidden;
            link.textContent = moreText.hidden ? '说明' : '收起';
        });
        hint.append(' ', link);
        const wrap = el('div', 'cm-toggle-wrap');
        wrap.append(row, moreText);
        return wrap;
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

    let proxyState = null;

    /** Card title once the proxy is up: whether SillyTavern is pointed at it, and with which model. */
    function statusTitleOnline() {
        const { connected, model } = connectionInfo();
        if (!connected) return '代理在线，酒馆还没连上';
        return model ? `已连接 · ${shortModel(model)}` : '已连接 · 请在模型下拉框里选 Claude 模型';
    }

    async function refreshProxyStatus() {
        const title = document.getElementById('claude_max_status_title');
        const sub = document.getElementById('claude_max_status_sub');
        if (!title || !sub) return;
        setDot('pending');
        title.textContent = '正在检测代理…';
        sub.textContent = '';
        try {
            const res = await fetchProxy('/status', '/status');
            const data = await res.json().catch(() => ({}));
            if (res.status === 401 || res.status === 403) {
                // Reached the proxy, which turned us away (access key / LAN not on)
                proxyState = 'offline';
                setDot('offline');
                title.textContent = res.status === 401 ? '代理拒绝了连接：访问密码不对' : '代理拒绝了连接';
                sub.textContent = data.error?.message ?? `HTTP ${res.status}`;
                renderConnect();
                return;
            }
            if (!res.ok || !data.ok) throw new Error(data.message || `HTTP ${res.status}`);
            const cred = data.credential ?? {};
            proxyState = cred.present ? 'online' : 'warning';
            proxyOnline = true;
            island?.set({ online: true });
            if (cred.present) {
                setDot('online');
                title.textContent = statusTitleOnline();
                const plan = SUBSCRIPTION_LABELS[cred.subscriptionType] ?? cred.subscriptionType ?? '订阅';
                sub.textContent = `${plan} 订阅 · 凭据来自${SOURCE_LABELS[cred.source] ?? cred.source} · 代理 v${data.version}`;
                const info = document.getElementById('claude_max_proxy_info');
                if (info) info.textContent = `代理 v${data.version} 在线 · ${plan} 订阅 · 凭据来自${SOURCE_LABELS[cred.source] ?? cred.source}`;
            } else {
                setDot('warning');
                title.textContent = '代理在线，但未登录';
                sub.textContent = 'Mac：双击「酒馆工具」选「登录 Claude」。其他系统：在代理目录运行 npm run login。';
            }
        } catch {
            proxyState = 'offline';
            proxyOnline = false;
            island?.set({ online: false });
            setDot('offline');
            title.textContent = '连接不到代理';
            const where = normalizeEndpoint(getSettings().endpoint);
            const remote = !/\/\/(127\.0\.0\.1|localhost)[:/]/.test(where);
            sub.textContent = remote
                ? `连不上 ${where}。确认那台电脑开着、代理在运行、「手机连接」已开启，并且两台设备连着同一个 Wi-Fi；换过 Wi-Fi 的话，那台电脑的地址可能变了。`
                : `连不上 ${where}。Mac：双击「酒馆工具」选「启动酒馆」；其他系统在代理目录运行 npm start。改过代理端口的话，在下面改代理地址。`;
        }
        renderConnect();
    }

    // ── Heartbeat: notice a dropped proxy (Mac asleep, Wi-Fi switched) and its return ──

    const HEARTBEAT_MS = 20000;
    let heartbeatDown = false;
    let proxyOnline = null;
    async function heartbeat() {
        if (!getSettings().enabled || document.hidden) return;
        let up = false;
        try {
            const res = await fetchProxy('/status', '/status');
            up = res.ok;
        } catch { /* down */ }
        if (up) diagIfAsked();
        quietSweep();
        if (up !== proxyOnline) { proxyOnline = up; island?.set({ online: up }); }
        if (!up && !heartbeatDown) {
            heartbeatDown = true;
            notify('bad', '连不上代理，自动重试中', '手机连 Mac 时：确认 Mac 没睡眠、两边在同一个 Wi-Fi。', { ms: 0, replace: 'proxy' });
            refreshProxyStatus();
        } else if (up && heartbeatDown) {
            heartbeatDown = false;
            notify('ok', '代理已恢复', '可以继续发消息了', { ms: 3000, replace: 'proxy' });
            setTimeout(recoverKeptReply, 500);
            refreshProxyStatus();
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
        if (!box) return;
        box.classList.add('cm-loading');
        try {
            const res = await fetchProxy('/quota', '/v1/usage/quota');
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const data = await res.json();
            box.replaceChildren();
            const five = data.windows?.find((w) => w.type === 'five_hour');
            glance.quota = five?.utilization != null ? Math.round(five.utilization * 100) : null;
            renderGlance();
            if (!data.windows?.length) {
                box.append(el('small', 'cm-hint', '暂无额度数据'));
                return;
            }
            // One line per window: label · bar · percent · reset time.
            for (const w of data.windows) {
                const pct = w.utilization !== null ? Math.round(w.utilization * 100) : null;
                const row = el('div', 'cm-qline');
                const bar = el('div', 'cm-quota-bar');
                const fill = el('div', 'cm-quota-fill');
                fill.style.width = `${Math.min(100, pct ?? 0)}%`;
                if ((pct ?? 0) >= 90) fill.classList.add('critical');
                else if ((pct ?? 0) >= 70) fill.classList.add('warning');
                bar.append(fill);
                const reset = formatReset(w.resetsAt);
                row.title = reset;
                row.append(
                    el('span', 'cm-qline-label', WINDOW_LABELS[w.type] ?? w.type),
                    bar,
                    el('b', 'cm-qline-pct', pct !== null ? `${pct}%` : '–'),
                    el('small', 'cm-hint cm-qline-reset', reset.replace(' 重置', '')),
                );
                box.append(row);
            }
            if (data.extraUsage?.isEnabled) {
                box.append(el('small', 'cm-hint',
                    `额外用量：${data.extraUsage.usedCredits} / ${data.extraUsage.monthlyLimit} ${data.extraUsage.currency}`));
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

    /** Today and the last 7 days side by side (one column when they are the same). */
    function usageTable(today, week) {
        const cols = today.requests === week.requests ? [['今天 · 近 7 天', today]] : [['今天', today], ['近 7 天', week]];
        const table = el('table', 'cm-usage');
        const head = el('tr');
        head.append(el('th'), ...cols.map(([t]) => el('th', null, t)));
        table.append(head);
        const rows = [
            ['请求', (a) => (a.failed ? `${a.requests}（失败 ${a.failed}）` : String(a.requests))],
            ['输出', (a) => `${fmtK(a.outputTokens)} token`],
            ['平均耗时', (a) => fmtSec(a.avgDurationMs)],
            ['首字等待', (a) => fmtSec(a.avgTtftMs)],
            ['缓存命中', (a) => fmtPct(a.cacheHitRate) + (a.rerolls ? `（不含重roll ${a.rerolls} 次）` : '')],
        ];
        for (const [label, fn] of rows) {
            const tr = el('tr');
            tr.append(el('td', 'cm-hint', label), ...cols.map(([, a]) => el('td', null, a.requests ? fn(a) : '–')));
            table.append(tr);
        }
        return table;
    }

    /** The last turn: cache headline, why, where the first-token wait went. */
    function lastTurnCard(data) {
        const c = data.lastCache;
        const last = data.lastRequest;
        const card = el('div', c.hitPct >= 50 ? 'cm-cache' : 'cm-last-error cm-tip');
        card.append(el('div', 'cm-last-error-title', `缓存 · ${c.headline}`));
        if (last) {
            card.append(el('small', 'cm-hint',
                `${shortModel(last.model)} · 用时 ${fmtSec(last.durationMs)} · 输出 ${fmtK(last.outputTokens)} token${last.reasoningChars ? ` · 思考 ${last.reasoningChars} 字` : ''}`));
        }
        if (last?.finish === 'content_filter') {
            card.append(el('small', 'cm-hint cm-warn', '这条回复被 Claude 的安全机制中途截断，结尾缺了内容（例如变量更新的 JSON 不完整、状态栏报错）。可以重新生成，或回退一楼换个说法。'));
        } else if (last?.finish === 'length') {
            card.append(el('small', 'cm-hint cm-warn', '这条回复写到了最大长度被截断。调高酒馆的「最大回复长度」。'));
        }
        // The first reason is the conclusion; everything else is detail.
        const [first, ...rest] = c.reasons;
        if (first) card.append(el('small', 'cm-hint cm-cache-reason', first));
        const ph = last?.phases;
        const sec = (v) => (v / 1000).toFixed(1);
        if (rest.length || (ph?.init && ph.firstDelta)) {
            const more = el('details', 'cm-mini');
            more.append(el('summary', null, '详情'));
            for (const r of rest) more.append(el('small', 'cm-hint cm-cache-reason', r));
            if (ph?.init && ph.firstDelta) {
                more.append(el('small', 'cm-hint', `首字 ${sec(ph.firstDelta)} 秒：代理和 CLI 启动 ${sec(ph.init)} 秒（本机）；模型读完提示词开始回复 ${sec((ph.apiStart ?? ph.firstDelta) - ph.init)} 秒，开始写 ${sec(ph.firstDelta - (ph.apiStart ?? ph.firstDelta))} 秒（Anthropic 那边）。`));
            }
            card.append(more);
        }
        return card;
    }

    // After a reply: tell the user when the proxy served something other
    // than what was asked for (base model instead of 1M, a reply cut off by a
    // safety stop, or redone by another model). Once per request.
    let lastNoticeAt = 0;
    async function noticeLastTurn() {
        try {
            const res = await fetchProxy('/stats', '/v1/usage/stats');
            if (!res.ok) return;
            const data = await res.json();
            const last = data.lastRequest;
            if (!last || last.auxiliary || last.at <= lastNoticeAt || Date.now() - last.at > 5 * 60 * 1000) return;
            lastNoticeAt = last.at;
            islandDone({ cache: data.lastCache?.hitPct ?? null, seconds: last.durationMs != null ? Math.round(last.durationMs / 1000) : null });
            const notices = last.notices ?? [];
            const fallback = notices.find((n) => n.startsWith('fallback:'))?.slice(9);
            if (fallback) {
                notify('warn', `换了模型：${shortModel(fallback)} 重写`, `${shortModel(last.model)} 被安全机制中途截断。文风可能不同，格式可能错乱。`, { ms: 15000 });
            } else if (notices.includes('refusal') || last.finish === 'content_filter') {
                notify('warn', '回复被安全机制截断', '结尾缺了内容（变量、状态栏可能报错）。重新生成，或回退一楼换个说法。', { ms: 15000 });
            } else if (last.finish === 'length') {
                notify('warn', '回复写到最大长度被截断', '调高酒馆的「最大回复长度」。', { ms: 12000 });
            }
            if (notices.includes('no-1m')) {
                notify('info', '这一轮用的是普通上下文', `1M 额度不可用，用了 ${shortModel(last.model).replace(/\s*1M$/, '')}，一小时后再试 1M。`, { ms: 12000 });
            }
        } catch { /* proxy unreachable: the status block already says so */ }
    }

    // ── 灵动岛: follow the reply being generated ──
    // Only for chat replies going to this proxy (not background requests or
    // other connections). done → shows length, time and cache, then shrinks
    // back to the dot.
    let genActive = false;
    let doneTimer = null;
    function islandGenStart(type, _opts, dryRun) {
        if (!island || dryRun || type === 'quiet' || type === 'impersonate' || !connectionInfo().connected) return;
        genActive = true;
        clearTimeout(doneTimer);
        island.set({ kind: 'thinking', startedAt: Date.now(), chars: 0, cache: null, seconds: null });
    }
    let tokenAt = 0;
    function islandToken(text) {
        // Fires per token with the whole text so far (empty while the model is still thinking).
        if (!genActive || Date.now() - tokenAt < 200) return;
        tokenAt = Date.now();
        const chars = String(text ?? '').replace(/<[^>]*>/g, '').replace(/\s+/g, '').length;
        if (chars) island.set({ kind: 'writing', chars });
    }
    function islandGenEnd() {
        if (!genActive) return;
        genActive = false;
        const chat = SillyTavern.getContext().chat ?? [];
        const last = chat[chat.length - 1];
        if (!last || last.is_user || last.is_system) { island.set({ kind: 'idle' }); return; }
        const chars = last && !last.is_user ? String(last.mes ?? '').replace(/<[^>]*>/g, '').replace(/\s+/g, '').length : 0;
        const startedAt = island.state.startedAt;
        islandDone({ chars, seconds: startedAt ? Math.round((Date.now() - startedAt) / 1000) : null });
    }
    function islandStopped() {
        if (!genActive) return;
        genActive = false;
        island.set({ kind: 'idle' });
    }
    function islandDone(patch) {
        if (!island || genActive) return;
        const wasDone = island.state.kind === 'done';
        if (!wasDone && patch.chars == null) return; // stats for a turn we didn't watch
        island.set({ ...patch, kind: 'done' });
        clearTimeout(doneTimer);
        doneTimer = setTimeout(() => island.set({ kind: 'idle' }), wasDone ? 2500 : 4000);
    }

    async function refreshStats() {
        const box = document.getElementById('claude_max_stats');
        const lastBox = document.getElementById('claude_max_lastturn');
        if (!box) return;
        box.classList.add('cm-loading');
        try {
            const res = await fetchProxy('/stats', '/v1/usage/stats');
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const data = await res.json();
            glance.cache = data.lastCache?.hitPct ?? null;
            renderGlance();
            lastBox?.replaceChildren(data.lastCache ? lastTurnCard(data) : el('small', 'cm-hint', '还没有对话。'));
            box.replaceChildren();
            if (!data.week?.requests) {
                box.append(el('small', 'cm-hint', '还没有记录。每次对话会在这里记一行（只记耗时和 token 数，不记聊天内容）。'));
            } else {
                box.append(usageTable(data.today, data.week));
            }
            const bg = data.background;
            if (bg?.week?.requests) {
                box.append(el('small', 'cm-hint', `后台请求（其他插件的生图 tag、总结等，不计入上表）：今天 ${bg.today.requests} 次、近 7 天 ${bg.week.requests} 次，输出 ${fmtK(bg.week.outputTokens)} token${bg.week.failed ? `，失败 ${bg.week.failed} 次` : ''}。`));
            }
            // Only surface a failure from the last day; older ones are noise.
            if (data.lastError && Date.now() - data.lastError.at < 24 * 3600 * 1000) {
                const err = el('div', 'cm-last-error');
                err.append(
                    el('div', 'cm-last-error-title', `最近一次失败 · ${fmtWhen(data.lastError.at)} · ${shortModel(data.lastError.model)}${data.lastError.background ? ' · 后台请求' : ''}`),
                    el('small', null, data.lastError.message),
                );
                const more = el('details', 'cm-mini');
                more.append(el('summary', null, '怎么办 · 原始错误'),
                    el('small', 'cm-hint', data.lastError.hint),
                    el('small', 'cm-hint cm-raw', data.lastError.raw));
                err.append(more);
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
                '想改用原生思考：关掉预设里的思维链条目即可（需要时在「更多 → 调试选项」把思考模式设为「始终思考」）。'),
        );
    }

    function refreshAll() {
        renderConnect();
        renderGlance();
        refreshProxyStatus();
        refreshStatsPage();
        refreshLoreBox();
        runCheckup();
        runCardAudit();
    }

    // ── Settings UI ──

    const EFFORT_OPTIONS = [
        { value: 'auto', label: '自动', hint: '不指定，使用模型默认值（多数模型为「高」，Opus 5.5 为「中」）。' },
        { value: 'low', label: '低', hint: '最快、最省额度，但长篇角色扮演容易漏规则、人设变浅，一般不推荐。' },
        { value: 'medium', label: '中', hint: '速度与质量的平衡点。' },
        { value: 'high', label: '高', hint: '复杂剧情更连贯、规则执行更完整，回复稍慢。长篇角色扮演推荐。' },
        { value: 'xhigh', label: '超高', hint: '更深入的推理，回复更慢、更耗额度。Opus 4.6 没有这一档，按「高」处理。' },
        { value: 'max', label: '最大', hint: '最深度的思考，最慢、最耗额度。' },
    ];

    const THINKING_OPTIONS = [
        { value: 'adaptive', label: '自适应', hint: '由模型判断是否需要思考，简单对话不额外等待（推荐）。' },
        { value: 'on', label: '始终思考', hint: '每次回复前都先思考。Sonnet 5 会按自适应处理。' },
        { value: 'off', label: '关闭', hint: '不思考。Fable、Opus 4.7 及以上（含 Opus 5 / 5.5）总会思考，此项对它们无效。' },
    ];

    // ── At-a-glance summary (drawer header + chips above the tabs) ──

    // Filled in by refreshQuota / refreshStats / runCheckup; rendered by
    // renderGlance so the header shows the essentials even when collapsed.
    const glance = { quota: null, cache: null, issues: null };

    const MODEL_SHORT = [
        [/fable-5-1/, 'Fable 5.1'], [/fable-5/, 'Fable 5'], [/opus-5-5/, 'Opus 5.5'], [/opus-5/, 'Opus 5'],
        [/sonnet-5/, 'Sonnet 5'], [/opus-4-(\d)/, 'Opus 4.$1'], [/sonnet-4-(\d)/, 'Sonnet 4.$1'], [/haiku-4-5/, 'Haiku 4.5'],
    ];

    function shortModel(id) {
        const s = String(id ?? '');
        for (const [re, label] of MODEL_SHORT) {
            const m = s.match(re);
            if (m) return label.replace('$1', m[1] ?? '') + (/\[1m\]|-1m/i.test(s) ? ' 1M' : '');
        }
        return s;
    }

    /** Is SillyTavern currently pointed at this proxy? */
    function connectionInfo() {
        const ctx = SillyTavern.getContext();
        const oai = ctx.chatCompletionSettings ?? {};
        const connected = ctx.mainApi === 'openai' && oai.chat_completion_source === 'custom' && isOurEndpoint(oai.custom_url, getSettings());
        return { connected, model: connected ? oai.custom_model : null };
    }

    function renderGlance() {
        const settings = getSettings();
        const { connected, model } = connectionInfo();
        const effort = effectiveEffort(settings);
        const parts = [];
        if (connected && model) parts.push(shortModel(model));
        if (effort !== 'auto') parts.push(nextEffort ? `下一轮${EFFORT_LABEL[effort]}` : EFFORT_LABEL[effort]);
        if (glance.quota != null) parts.push(`5h ${glance.quota}%`);
        const head = document.getElementById('claude_max_head_sum');
        if (head) head.textContent = parts.join(' · ');

        const chips = document.getElementById('claude_max_glance');
        if (!chips) return;
        const chip = (label, value, tab, tone) => {
            const b = el('button', `cm-chip${tone ? ` ${tone}` : ''}`);
            b.type = 'button';
            b.append(el('small', null, label), el('b', null, value));
            b.addEventListener('click', () => chips.showTab?.(tab));
            return b;
        };
        const q = glance.quota;
        const c = glance.cache;
        const n = glance.issues;
        chips.replaceChildren(
            // 「1M」goes into the label so the model name fits the narrow chip.
            chip(connected && / 1M$/.test(shortModel(model)) ? '模型 · 1M' : '模型',
                connected ? (model ? shortModel(model).replace(/ 1M$/, '') : '未选') : '未连接', 'reason', connected ? '' : 'bad'),
            chip('5 小时额度', q == null ? '–' : `${q}%`, 'stats', q >= 90 ? 'bad' : q >= 70 ? 'warn' : ''),
            chip('上轮缓存', c == null ? '–' : `${c}%`, 'stats', c != null && c < 50 ? 'warn' : ''),
            chip('体检', n == null ? '–' : n ? `${n} 项` : '正常', 'check', n ? 'warn' : ''),
        );
    }

    /** Status card + one-click connect, above the tabs. Shown only while
     *  something needs doing (proxy down, not logged in, ST not connected). */
    function buildStatusBlock() {
        const block = el('div', 'cm-status-block');
        block.id = 'claude_max_status_block';
        const card = el('div', 'cm-card cm-status');
        const statusText = el('div', 'cm-status-text');
        const statusTitle = el('div', 'cm-status-title');
        statusTitle.id = 'claude_max_status_title';
        const statusSub = el('small', 'cm-hint');
        statusSub.id = 'claude_max_status_sub';
        statusText.append(statusTitle, statusSub);
        card.append(el('span', 'cm-dot cm-dot-lg'), statusText, iconButton('fa-rotate', '重新检测', refreshAll));
        const connectBtn = el('div', 'menu_button cm-connect');
        connectBtn.id = 'claude_max_connect';
        connectBtn.append(el('i', 'fa-solid fa-plug'), document.createTextNode(' 一键连接'));
        connectBtn.addEventListener('click', () => connect(getSettings()));
        const connectHint = el('small', 'cm-hint cm-center', '自动切到 Chat Completion → Custom 并填好地址，连接后在模型下拉框里选择 Claude 模型。');
        connectHint.id = 'claude_max_connect_hint';
        const conn = connectionFields(getSettings(), () => saveSettingsDebounced());
        conn.id = 'claude_max_status_conn';
        conn.hidden = true;
        block.append(card, connectBtn, connectHint, conn);
        return block;
    }

    function usageNotes() {
        const steps = el('details', 'cm-details');
        steps.append(el('summary', null, '使用说明'));
        const list = el('ol', 'cm-notes');
        for (const line of [
            '代理要一直开着：在代理目录运行 npm start（原版酒馆装了服务器插件时会自动启动）。',
            '点「一键连接」，然后在「API 连接」的模型下拉框里选 Claude 模型。',
            '酒馆自带的「推理强度」保持「自动」，思考深度在本面板「推理」页设置。',
            IS_TAURI
                ? '首次连接时 TauriTavern 会弹出授权框，允许访问代理地址即可。'
                : '从手机等其他设备打开酒馆时，额度和状态经由酒馆服务器转发读取。',
            '订阅通道不支持温度、Top-P 等采样参数（Agent SDK 限制）。',
            '「(1M context)」模型提供 100 万上下文；部分套餐需要开通额外用量，失败时自动退回普通版一小时。',
            '顶部的状态卡只在需要处理时出现（代理没开、没登录、酒馆没连上）；一切正常时，标题旁的绿点就是在线。',
        ]) list.append(el('li', null, line));
        steps.append(list);
        return steps;
    }

    /** Hide the status block once everything is fine; connect button only when ST isn't connected. */
    function renderConnect() {
        const block = document.getElementById('claude_max_status_block');
        const btn = document.getElementById('claude_max_connect');
        const hint = document.getElementById('claude_max_connect_hint');
        if (!block || !btn || !hint) return;
        const { connected } = connectionInfo();
        btn.hidden = connected;
        hint.hidden = connected;
        block.hidden = connected && proxyState === 'online';
        const conn = document.getElementById('claude_max_status_conn');
        if (conn) conn.hidden = proxyState !== 'offline';
        const title = document.getElementById('claude_max_status_title');
        if (title && proxyState === 'online') title.textContent = statusTitleOnline();
    }

    /** Tab 推理: one row — how hard to think (or not at all) — plus「仅下一轮」.
     *  Everything else about thinking follows the preset or SillyTavern. */
    function buildReasonTab(pane, settings, save) {
        pane.append(segmented({
            label: '思考深度',
            options: [...EFFORT_OPTIONS, { value: 'off', label: '不思考', hint: '不思考，回得最快。Fable、Opus 4.7 及以上（含 Opus 5 / 5.5）总会思考，对它们无效。' }],
            current: settings.thinking === 'off' ? 'off' : settings.effort,
            onChange: (v) => {
                if (v === 'off') settings.thinking = 'off';
                else {
                    settings.effort = VALID_EFFORTS.includes(v) ? v : 'auto';
                    if (settings.thinking === 'off') settings.thinking = 'adaptive';
                }
                save();
                renderGlance();
            },
        }));
        pane.append(oneShotEffortRow(settings));
        const cotTip = el('div', 'cm-last-error cm-tip');
        cotTip.id = 'claude_max_cot_tip';
        cotTip.hidden = true;
        pane.append(cotTip);
    }

    /** Tab 统计: quota, usage, last-turn cache, world-info cache tool. */
    function buildStatsTab(pane) {
        const stamp = el('small', 'cm-hint');
        stamp.id = 'claude_max_stats_time';
        const tools = el('div', 'cm-section-tools');
        tools.append(stamp, iconButton('fa-rotate', '刷新', refreshStatsPage));
        pane.append(section('上一轮', tools));
        const lastBox = el('div', 'cm-stats');
        lastBox.id = 'claude_max_lastturn';
        pane.append(lastBox);

        pane.append(section('订阅额度'));
        const quotaBox = el('div', 'cm-quota');
        quotaBox.id = 'claude_max_quota';
        quotaBox.append(el('small', 'cm-hint', '展开面板时自动加载。'));
        pane.append(quotaBox);

        pane.append(section('用量'));
        const statsBox = el('div', 'cm-stats');
        statsBox.id = 'claude_max_stats';
        statsBox.append(el('small', 'cm-hint', '展开面板时自动加载。'));
        pane.append(statsBox);

        pane.append(section('缓存优化 · 世界书'));
        const loreBox = el('div', 'cm-field');
        loreBox.id = 'claude_max_lore';
        pane.append(loreBox);
    }

    async function refreshStatsPage() {
        await Promise.all([refreshQuota(), refreshStats()]);
        const stamp = document.getElementById('claude_max_stats_time');
        if (stamp) stamp.textContent = `更新于 ${new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })}`;
    }

    /** Tab 体检: latest reply check-up and its per-card settings. */
    function buildCheckTab(pane, settings, save) {
        const checkTools = el('div', 'cm-section-tools');
        checkTools.append(iconButton('fa-stethoscope', '重新体检最新回复', () => runCheckup()));
        pane.append(section('最新回复', checkTools));
        const checkBox = el('div', 'cm-stats');
        checkBox.id = 'claude_max_checkup';
        pane.append(checkBox);
        pane.append(el('small', 'cm-hint', '检查字数、禁词、破折号、「不是A，是B」、人称、选项格式、重复段落、数值突变等。字数范围和禁词表自动从当前预设读取。'));

        const auditTools = el('div', 'cm-section-tools');
        auditTools.append(iconButton('fa-user-shield', '重新检查当前角色卡', () => runCardAudit()));
        pane.append(section('角色卡检查', auditTools));
        const auditBox = el('div', 'cm-stats');
        auditBox.id = 'claude_max_card_audit';
        pane.append(auditBox);

        pane.append(section('设置'));
        const leakField = el('div', 'cm-field');
        leakField.append(el('div', 'cm-field-label', '隐藏设定关键词'));
        const leakInput = el('input', 'text_pole');
        leakInput.type = 'text';
        leakInput.id = 'claude_max_leak';
        leakInput.placeholder = '如：植物人, 医学院（只对当前角色卡生效）';
        leakInput.value = settings.leakWords?.[currentCharKey()] ?? '';
        leakInput.addEventListener('input', () => {
            settings.leakWords = { ...(settings.leakWords ?? {}), [currentCharKey()]: leakInput.value };
            save();
        });
        leakField.append(leakInput, el('small', 'cm-hint', '剧情揭示前不该出现的词，正文里出现时提醒。'));
        pane.append(leakField);
        const muted = Object.entries(settings.checkupMuted ?? {}).filter(([, n]) => n >= 2);
        if (muted.length) {
            const unmute = el('a', 'cm-more', `恢复 ${muted.length} 类已静音的体检提示`);
            unmute.href = '#';
            unmute.addEventListener('click', (e) => { e.preventDefault(); settings.checkupMuted = {}; save(); unmute.remove(); });
            pane.append(el('small', 'cm-hint', '同一类问题的提示点掉两次就不再弹出。'), unmute);
        }

        const perfTools = el('div', 'cm-section-tools');
        perfTools.append(iconButton('fa-gauge-high', '测一次（约 4 秒）', () => showPerfDiag()));
        pane.append(section('性能', perfTools));
        pane.append(el('small', 'cm-hint', quietOn()
            ? '省电显示已开（手机上自动开）：最新一楼以外的美化动画只播一遍、不做毛玻璃，聊天外的悬浮挂件也停下来。'
            : '省电显示没开（电脑上不需要，手机上自动开）。'));
        const perfBox = el('div', 'cm-stats');
        perfBox.id = 'claude_max_perf';
        pane.append(perfBox);
    }

    // CSS only reaches the old floors in this document. Endless animations
    // elsewhere (floating widgets, beautifiers inside same-origin frames)
    // are told to finish their current loop instead; the latest floor and
    // anything that looks like a loading indicator keep looping.
    const quieted = new Set();
    const QUIET_KEEP = /spin|load|typing|generat|progress/i;
    const COARSE = window.matchMedia?.('(pointer: coarse)')?.matches ?? false;
    /** 省电显示: on for phones and TauriTavern unless the debug switch says otherwise. */
    function quietOn() {
        const q = getSettings().quietRender;
        return q === 'on' || (q !== 'off' && (IS_TAURI || COARSE));
    }
    function quietSweep() {
        if (!quietOn() || document.hidden) return;
        const docs = [document];
        for (const fr of document.querySelectorAll('iframe')) {
            try { if (fr.contentDocument && !fr.closest('#chat .last_mes')) docs.push(fr.contentDocument); } catch { /* cross-origin */ }
        }
        for (const doc of docs) {
            for (const a of doc.getAnimations?.() ?? []) {
                const t = a.effect?.target;
                if (a.playState !== 'running' || a.effect?.getTiming?.().iterations !== Infinity || !t) continue;
                if (doc === document && (t.closest?.('#chat .last_mes, #send_form, .claude-max, .cm-island') || !t.closest?.('body'))) continue;
                if (QUIET_KEEP.test(`${a.animationName ?? ''} ${t.className?.baseVal ?? t.className ?? ''}`)) continue;
                const done = Math.floor((a.currentTime ?? 0) / (a.effect.getTiming().duration || 1)) + 1;
                a.effect.updateTiming({ iterations: done });
                quieted.add(a);
            }
        }
    }
    function applyQuietRender() {
        const on = quietOn();
        document.body.classList.toggle('cm-quiet', on);
        if (on) return quietSweep();
        for (const a of quieted) {
            try { a.effect.updateTiming({ iterations: Infinity }); a.play(); } catch { /* element gone */ }
        }
        quieted.clear();
    }

    async function showPerfDiag() {
        const box = document.getElementById('claude_max_perf');
        if (!box) return;
        box.replaceChildren(el('small', 'cm-hint', '正在测（约 4 秒，别滑动）…'));
        const r = await runPerfDiag();
        const card = el('div', r.fps < 30 || r.topInfinite.length > 5 ? 'cm-last-error cm-tip' : 'cm-cache');
        card.append(el('div', 'cm-last-error-title', `帧率 ${r.fps}/秒 · 一直在动的元素 ${r.topInfinite.reduce((n, [, c]) => n + c, 0)} 个 · 毛玻璃 ${r.backdropBlur} 个`));
        card.append(el('small', 'cm-hint', `显示 ${r.floorsShown}/${r.chatLength} 楼 · 内嵌窗口 ${r.iframes} 个 · 页面元素 ${r.domNodes} 个 · 卡顿 ${r.longTasks} 次（${r.longTaskMs} ms）`));
        const floors = Object.entries(r.perFloor)
            .map(([f, t]) => [f, (t.infiniteAnimations ?? 0) * 3 + (t.iframes ?? 0) * 2 + (t.backdropBlur ?? 0), t])
            .filter(([, w]) => w > 0).sort((a, b) => b[1] - a[1]).slice(0, 5);
        for (const [f, , t] of floors) {
            card.append(el('small', 'cm-hint', `${f === 'page' ? '聊天之外' : `第 ${f} 楼`}：循环动画 ${t.infiniteAnimations ?? 0} · 内嵌窗口 ${t.iframes ?? 0} · 毛玻璃 ${t.backdropBlur ?? 0}`));
        }
        if (!quietOn() && floors.length > 2) {
            card.append(el('small', 'cm-hint cm-warn', '旧楼层还在播动画：把酒馆助手的「渲染深度」设为 3 左右，或在「更多 → 调试选项」里把省电显示设为「开」。'));
        }
        box.replaceChildren(card);
    }

    // ── Mac（手机遥控）: the proxy's /v1/control routes (lib/control.js) ──

    async function controlFetch(path, body) {
        const settings = getSettings();
        const headers = settings.accessKey ? { 'X-Claude-Max-Key': settings.accessKey } : {};
        if (body) headers['Content-Type'] = 'application/json';
        return fetch(`${proxyBase(settings)}${path}`, {
            method: body ? 'POST' : 'GET', headers, body: body ? JSON.stringify(body) : undefined,
            signal: AbortSignal.timeout(20000),
        });
    }

    async function refreshMac() {
        const box = document.getElementById('claude_max_mac');
        if (!box) return;
        let s;
        try {
            const res = await controlFetch('/v1/control/status');
            s = await res.json();
        } catch {
            box.replaceChildren(el('small', 'cm-hint', '连不上代理，看不到 Mac 的状态。'));
            return;
        }
        if (!s?.supported) {
            box.replaceChildren(el('small', 'cm-hint', '这个代理不是用 Mac 启动器开的，没有遥控。'));
            return;
        }
        const lines = [
            `模式：${s.phoneMode ? '手机模式' : '电脑模式'}${s.watchdog ? '（守护中）' : ''}${s.ip ? ` · ${s.ip}` : ''}`,
            `电量：${s.battery ?? '?'}%${s.onBattery ? '（用电池）' : '（插着电）'} · 盖子${s.lid.closed ? '合着' : '开着'}`,
            `合盖不睡：${!s.lid.installed ? '没安装' : s.lid.paused ? '已暂停' : s.lid.on ? '开着' : '放开了（电量低 / 闲置）'}`,
            `本地生图：${s.comfy ? '运行中' : '没开'} · 正在写的回复：${s.busy}`,
        ];
        const card = el('div', 'cm-cache');
        for (const l of lines) card.append(el('small', 'cm-hint', l));
        for (const e of s.recentErrors ?? []) card.append(el('small', 'cm-hint cm-warn', `最近的错误：${e}`));
        const row = el('div', 'cm-btn-row');
        const act = (label, action, confirmText) => {
            const b = el('button', 'menu_button', label);
            b.type = 'button';
            b.addEventListener('click', async () => {
                if (confirmText && !window.confirm(confirmText)) return;
                b.disabled = true;
                try {
                    const res = await controlFetch('/v1/control/action', { action });
                    const r = await res.json().catch(() => ({}));
                    toastr?.[res.ok ? 'success' : 'warning']?.(r.message ?? `HTTP ${res.status}`, 'Claude Max · Mac');
                } catch {
                    toastr?.warning?.('没发出去：连不上代理', 'Claude Max · Mac');
                } finally {
                    b.disabled = false;
                    setTimeout(refreshMac, action === 'restart-proxy' ? 6000 : 1500);
                }
            });
            row.append(b);
        };
        act('重启代理', 'restart-proxy', '重启 Mac 上的代理？几秒后自动恢复。');
        if (s.lid.installed) act(s.lid.paused ? '恢复合盖不睡' : '暂停合盖不睡', s.lid.paused ? 'lid-resume' : 'lid-pause');
        act(s.comfy ? '关闭本地生图' : '启动本地生图', s.comfy ? 'comfy-stop' : 'comfy-start');
        if (s.phoneMode) act('同步手机', 'phone-sync', '从 Mac 同步这台手机？TauriTavern 会先关闭，同步完自动重新打开。');
        const logBtn = el('button', 'menu_button', '看日志');
        logBtn.type = 'button';
        const pre = el('pre', 'cm-log');
        pre.hidden = true;
        logBtn.addEventListener('click', async () => {
            if (!pre.hidden) { pre.hidden = true; return; }
            try {
                const r = await (await controlFetch('/v1/control/log')).json();
                pre.textContent = [...(r.launcher ?? []), '──', ...(r.proxy ?? [])].join('\n');
                pre.hidden = false;
            } catch {
                toastr?.warning?.('取日志失败', 'Claude Max · Mac');
            }
        });
        row.append(logBtn);
        box.replaceChildren(card, row, pre);
    }

    // ── Performance diagnosis: what in this page keeps the phone busy ──
    // Counts running animations, embedded frames and frosted-glass elements
    // per chat floor, then samples the frame rate and long tasks for a few
    // seconds. Reported to the proxy (the Mac reads it); numbers only.
    async function runPerfDiag() {
        const floorOf = (el) => el?.closest?.('#chat .mes')?.getAttribute('mesid') ?? 'page';
        const tally = {};
        const bump = (floor, key, n = 1) => {
            tally[floor] ??= {};
            tally[floor][key] = (tally[floor][key] ?? 0) + n;
        };
        const selectorOf = (el) => (el && el.nodeType === 1)
            ? `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ''}${[...el.classList].slice(0, 2).map((c) => `.${c}`).join('')}`
            : '?';
        const topAnims = {};
        const countAnims = (doc, floor) => {
            for (const a of doc.getAnimations?.() ?? []) {
                if (a.playState !== 'running') continue;
                const target = a.effect?.target;
                const f = floor ?? floorOf(target);
                const infinite = a.effect?.getTiming?.().iterations === Infinity;
                bump(f, infinite ? 'infiniteAnimations' : 'animations');
                if (infinite) {
                    const k = `${f} ${selectorOf(target)} ${a.animationName ?? ''}`.trim();
                    topAnims[k] = (topAnims[k] ?? 0) + 1;
                }
            }
        };
        countAnims(document, null);
        let crossOrigin = 0;
        for (const fr of document.querySelectorAll('iframe')) {
            const f = floorOf(fr);
            bump(f, 'iframes');
            try {
                const d = fr.contentDocument;
                if (d) countAnims(d, f); else crossOrigin++;
            } catch { crossOrigin++; }
        }
        let blur = 0;
        for (const el of document.querySelectorAll('#chat *')) {
            const cs = getComputedStyle(el);
            if ((cs.backdropFilter && cs.backdropFilter !== 'none') || (cs.webkitBackdropFilter && cs.webkitBackdropFilter !== 'none')) {
                blur++;
                bump(floorOf(el), 'backdropBlur');
            }
        }
        // Frame rate and long tasks over 4 s.
        let frames = 0;
        let longTasks = 0;
        let longMs = 0;
        let po = null;
        try {
            po = new PerformanceObserver((list) => { for (const e of list.getEntries()) { longTasks++; longMs += e.duration; } });
            po.observe({ entryTypes: ['longtask'] });
        } catch { po = null; }
        const t0 = performance.now();
        await new Promise((resolve) => {
            const tick = () => { frames++; if (performance.now() - t0 < 4000) requestAnimationFrame(tick); else resolve(); };
            requestAnimationFrame(tick);
        });
        po?.disconnect();
        const secs = (performance.now() - t0) / 1000;
        const ctx = SillyTavern.getContext();
        return {
            ok: true,
            app: IS_TAURI ? 'TauriTavern' : 'SillyTavern',
            visible: !document.hidden,
            fps: Math.round(frames / secs),
            longTasks, longTaskMs: Math.round(longMs),
            domNodes: document.getElementsByTagName('*').length,
            floorsShown: document.querySelectorAll('#chat .mes').length,
            chatLength: ctx.chat?.length ?? 0,
            iframes: document.querySelectorAll('iframe').length,
            crossOriginFrames: crossOrigin,
            backdropBlur: blur,
            perFloor: tally,
            topInfinite: Object.entries(topAnims).sort((a, b) => b[1] - a[1]).slice(0, 15),
        };
    }

    async function diagIfAsked() {
        try {
            const res = await controlFetch('/v1/control/diag-request');
            if (!res.ok || !(await res.json()).requested) return;
            const result = await runPerfDiag();
            await controlFetch('/v1/control/diag', result);
        } catch { /* proxy unreachable or not the launcher's: nothing to do */ }
    }

    function buildAdvTab(pane, settings, save) {
        pane.append(section('Mac（手机遥控）'));
        const macBox = el('div');
        macBox.id = 'claude_max_mac';
        macBox.append(el('small', 'cm-hint', '正在读取…'));
        pane.append(macBox);
        setTimeout(refreshMac, 0);

        // Everything below decides itself (defaults, the preset's own
        // recommendation, the proxy watching each chat). Kept for chasing
        // problems, folded away so nobody has to think about it.
        const dbg = el('details', 'cm-details cm-debug-box');
        dbg.append(el('summary', null, '调试选项（排查问题时才需要）'));
        dbg.append(el('small', 'cm-hint', '这些都会自动处理：缓存相关的默认开着，代理会按每个聊天的情况决定挪不挪；预设可以自带推荐值，切换预设时自动套用和恢复。'));
        const add = (x) => dbg.append(x);

        add(section('缓存与上下文'));
        add(toggleRow({
            id: 'claudeMaxResume', title: '会话续接', desc: '聊天记录按真实多轮对话发送，能用上缓存。',
            more: '关闭后聊天记录会被压成一整段文字，只在排查问题时关闭。',
            checked: settings.useResume, onChange: (v) => { settings.useResume = v; save(); },
        }));
        add(toggleRow({
            id: 'claudeMaxInlineSystem', title: '深度注入保持原位', desc: '深度条目留在聊天记录里原来的位置（预设可推荐）。',
            more: '预设里「深度 N」的条目、世界书深度条目、作者注释留在原位，和酒馆直连 Claude 的做法一致。关闭则全部提到系统提示词；其中一条变化，整个系统提示词的缓存都会失效。',
            checked: settings.inlineSystem, onChange: (v) => { settings.inlineSystem = v; save(); },
        }));
        add(toggleRow({
            id: 'claudeMaxLoreTail', title: '世界书变化部分移到末尾', desc: '代理发现世界书每轮在变时，挪到本轮消息里。',
            more: '系统提示词和之前的聊天记录每轮一字不差，能读缓存，只重写最近一轮。',
            checked: settings.loreTail, onChange: (v) => { settings.loreTail = v; save(); },
        }));
        add(toggleRow({
            id: 'claudeMaxFoldTail', title: '发言后的注入并进发言', desc: '代理发现卡在你发言后面放了条目时，并进发言里。',
            more: 'MVU 这类变量卡把状态和规则以「深度 0」放在你的发言后面；并进发言后下一轮原样重放，缓存对得上。',
            checked: settings.foldTail, onChange: (v) => { settings.foldTail = v; save(); },
        }));
        add(toggleRow({
            id: 'claudeMaxTailBlock', title: '实验：预设后置条目提前', desc: '只对 Ny、图灵这类预设有用，默认关闭。',
            more: '把每轮一字不差的后置条目挪到对话最前面，旧楼层就能命中缓存；代价是规则离回复更远。',
            checked: settings.tailBlockFront, onChange: (v) => { settings.tailBlockFront = v; save(); },
        }));

        add(section('思考'));
        add(segmented({
            label: '思考模式',
            options: THINKING_OPTIONS,
            current: settings.thinking,
            onChange: (v) => { settings.thinking = VALID_THINKING.includes(v) ? v : 'adaptive'; save(); },
        }));
        add(segmented({
            label: '后台请求的思考深度',
            options: [
                { value: 'low', label: '低', hint: '其他插件在后台发的请求（生图 tag、总结等）用「低」，快、省额度。' },
                { value: 'follow', label: '跟随', hint: '后台请求也用「推理」页的思考深度。' },
            ],
            current: settings.quietEffort === 'follow' ? 'follow' : 'low',
            onChange: (v) => { settings.quietEffort = v === 'follow' ? 'follow' : 'low'; save(); },
        }));
        add(toggleRow({
            id: 'claudeMaxShowReasoning', title: '显示思考过程', desc: '默认跟随酒馆的「显示模型思维」；关掉则总是不显示。',
            checked: settings.showReasoning, onChange: (v) => { settings.showReasoning = v; save(); },
        }));
        add(toggleRow({
            id: 'claudeMaxIdentity', title: '身份模式', desc: '角色扮演建议关闭（预设可推荐）。',
            more: '在角色卡前加上 Claude Code 官方前言，模型能说出自己的型号，但多耗 token，带点编程助手的味道。',
            checked: settings.identityMode, onChange: (v) => { settings.identityMode = v; save(); },
        }));

        add(section('显示'));
        add(segmented({
            label: '省电显示',
            options: [
                { value: 'auto', label: '自动', hint: '手机和 TauriTavern 上开，电脑上关。' },
                { value: 'on', label: '开', hint: '最新一楼以外的美化动画只播一遍、不做毛玻璃，聊天外的悬浮挂件也停下来。' },
                { value: 'off', label: '关', hint: '动画照常循环。' },
            ],
            current: ['on', 'off'].includes(settings.quietRender) ? settings.quietRender : 'auto',
            onChange: (v) => { settings.quietRender = v; applyQuietRender(); save(); },
        }));
        add(toggleRow({
            id: 'claudeMaxCheckupToast', title: '体检发现问题时提示', desc: '同一类问题点掉两次后自动不再提示。',
            checked: settings.checkupToast, onChange: (v) => { settings.checkupToast = v; save(); },
        }));
        add(toggleRow({
            id: 'claudeMaxCompactButtons', title: '输入栏脚本按钮并排', desc: '酒馆助手的脚本按钮排成一行。',
            checked: settings.compactScriptButtons, onChange: (v) => { settings.compactScriptButtons = v; save(); applyCompactButtons(); },
        }));

        add(section('请求'));
        add(toggleRow({
            id: 'claudeMaxDebugDump', title: '保存最近一次完整请求', desc: '存到代理目录 data/debug/（只存本机，每次覆盖）。',
            checked: settings.debugDump, onChange: (v) => { settings.debugDump = v; save(); },
        }));
        const debugBtn = el('div', 'menu_button cm-connect cm-connect-quiet');
        debugBtn.append(el('i', 'fa-solid fa-magnifying-glass'), document.createTextNode(' 查看实际发给模型的内容'));
        debugBtn.addEventListener('click', showDebugRequest);
        add(debugBtn);

        add(section('连接'));
        const info = el('small', 'cm-hint');
        info.id = 'claude_max_proxy_info';
        add(info);
        add(connectionFields(settings, save));
        pane.append(dbg);
        pane.append(usageNotes());
    }

    /** Proxy address + access key. Shown in the status card while the proxy
     *  can't be reached, and in the debug options. */
    function connectionFields(settings, save) {
        const box = el('div', 'cm-conn-fields');
        const endpointField = el('div', 'cm-field');
        endpointField.append(el('div', 'cm-field-label', '代理地址'));
        const endpointInput = el('input', 'text_pole');
        endpointInput.type = 'text';
        endpointInput.value = settings.endpoint;
        endpointInput.placeholder = DEFAULT_ENDPOINT;
        endpointInput.addEventListener('input', () => { settings.endpoint = endpointInput.value || DEFAULT_ENDPOINT; save(); });
        endpointField.append(endpointInput, el('small', 'cm-hint', `默认 ${DEFAULT_ENDPOINT}。手机连 Mac：填 Mac「手机连接」窗口显示的地址（手机同步会自动填好）。`));
        const keyField = el('div', 'cm-field');
        keyField.append(el('div', 'cm-field-label', '访问密码'));
        const keyInput = el('input', 'text_pole');
        keyInput.type = 'password';
        keyInput.autocomplete = 'off';
        keyInput.value = settings.accessKey ?? '';
        keyInput.placeholder = '在本机用时留空';
        keyInput.addEventListener('input', () => { settings.accessKey = keyInput.value.trim(); save(); });
        keyField.append(keyInput);
        const reconnect = el('div', 'menu_button cm-connect cm-connect-quiet');
        reconnect.append(el('i', 'fa-solid fa-plug'), document.createTextNode(' 重新连接'));
        reconnect.addEventListener('click', () => connect(getSettings()));
        box.append(endpointField, keyField, reconnect);
        return box;
    }

    const TABS = [['reason', '推理'], ['stats', '统计'], ['check', '体检'], ['adv', '更多']];

    function addExtensionSettings(settings) {
        const container = document.getElementById('extensions_settings') ?? document.body;
        const save = () => saveSettingsDebounced();

        const drawer = el('div', 'inline-drawer claude-max');
        const toggle = el('div', 'inline-drawer-toggle inline-drawer-header');
        const heading = el('b', 'cm-heading');
        const headSum = el('small', 'cm-head-sum');
        headSum.id = 'claude_max_head_sum';
        heading.append(el('span', 'cm-dot'), el('span', 'cm-heading-name', 'Claude Max'), headSum);
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

        const panes = Object.fromEntries(TABS.map(([k]) => [k, el('div', 'cm-pane')]));
        buildReasonTab(panes.reason, settings, save);
        buildStatsTab(panes.stats);
        buildCheckTab(panes.check, settings, save);
        buildAdvTab(panes.adv, settings, save);

        const bar = el('div', 'cm-tabs');
        bar.setAttribute('role', 'tablist');
        const show = (key) => {
            for (const [k] of TABS) panes[k].hidden = k !== key;
            bar.querySelectorAll('button').forEach((b) => {
                b.classList.toggle('active', b.dataset.tab === key);
                b.setAttribute('aria-selected', String(b.dataset.tab === key));
            });
            if (settings.panelTab !== key) { settings.panelTab = key; save(); }
        };
        for (const [k, label] of TABS) {
            const b = el('button', 'cm-tab', label);
            b.type = 'button';
            b.dataset.tab = k;
            b.setAttribute('role', 'tab');
            b.addEventListener('click', () => {
                show(k);
                // Stats go stale while the panel sits open: re-read on entering the tab
                if (k === 'stats') { refreshStats(); refreshQuota(); }
            });
            bar.append(b);
        }

        const chips = el('div', 'cm-glance');
        chips.id = 'claude_max_glance';
        chips.showTab = show;
        const islandSlot = el('div', 'cm-island-slot');
        islandSlot.id = 'claude_max_island_slot';
        content.append(buildStatusBlock(), islandSlot, chips, bar, ...TABS.map(([k]) => panes[k]));
        island?.mount(islandSlot);
        show(TABS.some(([k]) => k === settings.panelTab) ? settings.panelTab : 'reason');
        renderConnect();
        renderGlance();
    }

    // /图分 1–5: the user's own rating of this reply's images, stored on the
    // latest AI message (extra.cm_img_score) for the turn report. We never
    // look at the images ourselves; the score is the only signal.
    function registerImageScore() {
        const ctx = SillyTavern.getContext();
        const { SlashCommandParser, SlashCommand, SlashCommandArgument, ARGUMENT_TYPE } = ctx;
        if (!SlashCommandParser?.addCommandObject || !SlashCommand?.fromProps) return;
        SlashCommandParser.addCommandObject(SlashCommand.fromProps({
            name: '图分',
            aliases: ['imgscore'],
            helpString: '给最新一楼的图打分（1–5，准不准），记在这条消息上，供逐楼报表统计。例：/图分 4',
            unnamedArgumentList: SlashCommandArgument?.fromProps
                ? [SlashCommandArgument.fromProps({ description: '1–5', typeList: [ARGUMENT_TYPE.NUMBER], isRequired: true })]
                : [],
            callback: async (_args, value) => {
                const n = Number(String(value ?? '').trim());
                if (!Number.isInteger(n) || n < 1 || n > 5) {
                    toastr?.warning?.('图分是 1–5 的整数，例：/图分 4', 'Claude Max');
                    return '';
                }
                const c = SillyTavern.getContext();
                const chat = c.chat ?? [];
                for (let i = chat.length - 1; i >= 0; i--) {
                    const m = chat[i];
                    if (m.is_user || m.is_system) continue;
                    m.extra = { ...(m.extra ?? {}), cm_img_score: n };
                    await c.saveChat?.();
                    notify('ok', `第 ${i} 楼的图：${n} 分`, '', { ms: 2500 });
                    return String(n);
                }
                toastr?.warning?.('还没有 AI 回复', 'Claude Max');
                return '';
            },
        }));
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

    function applyCompactButtons() {
        document.body.classList.toggle('cm-compact-qr', !!getSettings().compactScriptButtons);
    }

    // ── Boot ──

    const settings = getSettings();
    // v2.10 dropped the「附加到请求」switch; nobody should be stuck with it off.
    settings.enabled = true;
    // v2.23: 省电显示 decides itself; the old on/off switch becomes「自动」.
    if (typeof settings.quietRender === 'boolean') settings.quietRender = 'auto';
    applyCompactButtons();
    addExtensionSettings(settings);
    refreshProxyStatus();
    setInterval(heartbeat, HEARTBEAT_MS);
    // Phone app back from the background: check right away, not up to 20 s later.
    document.addEventListener('visibilitychange', () => { if (!document.hidden) { heartbeat(); setTimeout(recoverKeptReply, 1500); } });
    eventSource.on(eventTypes.CHAT_COMPLETION_SETTINGS_READY, onSettingsReady);
    // Keep stats fresh while the panel is open.
    const refreshIfOpen = () => {
        const box = document.getElementById('claude_max_stats');
        if (box && box.offsetParent !== null) setTimeout(refreshStats, 500);
    };
    eventSource.on(eventTypes.MESSAGE_RECEIVED, clearOneShotEffort);
    eventSource.on(eventTypes.CHARACTER_MESSAGE_RENDERED ?? eventTypes.MESSAGE_RECEIVED, () => setTimeout(() => runCheckup({ toast: true }), 200));
    eventSource.on(eventTypes.CHAT_CHANGED, () => setTimeout(recoverKeptReply, 1500));
    eventSource.on(eventTypes.CHAT_CHANGED, () => setTimeout(() => {
        const leak = document.getElementById('claude_max_leak');
        if (leak) leak.value = getSettings().leakWords?.[currentCharKey()] ?? '';
        runCheckup();
        refreshLoreBox();
        runCardAudit({ toast: true });
    }, 200));
    // Model / API switches: keep the header summary and connect button current.
    for (const ev of [eventTypes.CHATCOMPLETION_MODEL_CHANGED, eventTypes.CHATCOMPLETION_SOURCE_CHANGED, eventTypes.MAIN_API_CHANGED, eventTypes.SETTINGS_UPDATED]) {
        if (ev) eventSource.on(ev, () => setTimeout(() => { renderConnect(); renderGlance(); }, 100));
    }
    eventSource.on(eventTypes.MESSAGE_RECEIVED, refreshIfOpen);
    eventSource.on(eventTypes.CHARACTER_MESSAGE_RENDERED ?? eventTypes.MESSAGE_RECEIVED, () => setTimeout(noticeLastTurn, 400));
    eventSource.on(eventTypes.CHAT_CHANGED, refreshIfOpen);
    eventSource.on(eventTypes.OAI_PRESET_CHANGED_AFTER, applyPresetRecommendation);
    if (eventTypes.GENERATION_STARTED) eventSource.on(eventTypes.GENERATION_STARTED, islandGenStart);
    if (eventTypes.STREAM_TOKEN_RECEIVED) eventSource.on(eventTypes.STREAM_TOKEN_RECEIVED, islandToken);
    eventSource.on(eventTypes.MESSAGE_RECEIVED, () => setTimeout(islandGenEnd, 50));
    if (eventTypes.GENERATION_STOPPED) eventSource.on(eventTypes.GENERATION_STOPPED, islandStopped);
    if (eventTypes.GENERATION_ENDED) eventSource.on(eventTypes.GENERATION_ENDED, () => setTimeout(islandGenEnd, 100));
    if (eventTypes.APP_READY) eventSource.on(eventTypes.APP_READY, adoptUnrecordedReco);
    registerImageScore();
    applyQuietRender();
    console.log(`[claude-max] UI extension loaded${IS_TAURI ? ' (TauriTavern mode)' : ''}`);
})();

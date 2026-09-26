// ──────────────────────────────────────────────
// Where Claude comes from: SillyTavern's Chat Completion sources that can
// reach Claude, how each names the models, and what caching each offers.
// ──────────────────────────────────────────────
//
// Read from SillyTavern 1.19 (public/scripts/openai.js, src/endpoints/
// backends/chat-completions.js):
//   • claude       — Anthropic's API (or a reverse proxy set on that source).
//                    Static dropdown #model_claude_select; ids like claude-opus-4-6.
//   • openrouter   — ids like anthropic/claude-opus-4.6 (dots in the version).
//   • electronhub, nanogpt, aimlapi, cometapi — aggregators whose model lists
//                    include Claude; the id format is theirs, so ids are resolved
//                    against the list ST loaded, never guessed.
//   • custom       — any OpenAI-compatible address (this proxy, or a relay).
// Not sources in ST: AWS Bedrock (none at all) and Claude on Google Vertex
// (ST's vertexai source only speaks Gemini). Those reach ST only through a
// relay on the custom source.
// Caching is server-side config.yaml (claude.cachingAtDepth, extendedTTL,
// enableSystemPromptCache), read once when ST starts: the browser can't change it.
// Pure functions; shared by the panel (index.js) and the tests.

/**
 * select / input: the DOM control ST uses for that source's model.
 * cache: which config.yaml claude.* keys ST applies on that source.
 */
export const CLAUDE_SOURCES = {
    claude: { label: 'Claude 官方', billing: 'API 密钥', modelKey: 'claude_model', select: '#model_claude_select', cache: ['cachingAtDepth', 'extendedTTL', 'enableSystemPromptCache'] },
    openrouter: { label: 'OpenRouter', billing: 'OpenRouter 额度', modelKey: 'openrouter_model', select: '#model_openrouter_select', cache: ['cachingAtDepth', 'extendedTTL', 'enableSystemPromptCache'] },
    electronhub: { label: 'Electron Hub', billing: '中转', modelKey: 'electronhub_model', select: '#model_electronhub_select', cache: ['cachingAtDepth', 'extendedTTL', 'enableSystemPromptCache'] },
    nanogpt: { label: 'NanoGPT', billing: '中转', modelKey: 'nanogpt_model', select: '#model_nanogpt_select', cache: ['extendedTTL', 'enableSystemPromptCache'] },
    aimlapi: { label: 'AI/ML API', billing: '中转', modelKey: 'aimlapi_model', select: '#model_aimlapi_select', cache: [] },
    cometapi: { label: 'CometAPI', billing: '中转', modelKey: 'cometapi_model', select: '#model_cometapi_select', cache: [] },
    custom: { label: '自定义地址', billing: '中转', modelKey: 'custom_model', input: '#custom_model_id', cache: [] },
};

/** Claude models newer than SillyTavern 1.19's built-in Claude dropdown knows about. */
export const KNOWN_CLAUDE_MODELS = ['claude-opus-5-5'];

/** Any id naming a Claude model: claude-opus-4-6, anthropic/claude-opus-4.6, us.anthropic.claude-… */
export function isClaudeModel(id) {
    return /(?:^|[/.:])claude[-_.]/i.test(String(id ?? ''));
}

/**
 * The Anthropic API id behind any source's name: anthropic/claude-opus-4.6:thinking → claude-opus-4-6.
 * Drops vendor prefixes, [1m], :variants, -thinking, dates and -latest. Null when not a Claude id.
 */
export function canonicalModel(id) {
    const s = String(id ?? '').trim().toLowerCase();
    const m = s.match(/claude[-_.].*$/);
    if (!m) return null;
    let c = m[0]
        .replace(/\[1m\]$/, '')
        .replace(/:.*$/, '')
        .replace(/_/g, '-')
        .replace(/-v\d+$/, '')
        .replace(/-(thinking|latest)$/, '')
        .replace(/-\d{8}$/, '');
    c = c.replace(/(\d)\.(\d)/g, '$1-$2');
    return c;
}

/** OpenRouter's spelling: claude-opus-4-6 → anthropic/claude-opus-4.6. */
export function openRouterId(canonical) {
    return `anthropic/${String(canonical).replace(/-(\d+)-(\d+)$/, '-$1.$2')}`;
}

/**
 * The id to select on `source` for a canonical model. With the source's list (the
 * dropdown ST filled), the best match in it: the exact id, else the plainest variant
 * (no date, no :thinking). Without a list: this source's known spelling, or null.
 */
export function sourceModelId(source, canonical, available = []) {
    const want = canonicalModel(canonical);
    if (!want) return null;
    const matches = available.filter((id) => canonicalModel(id) === want);
    if (matches.length) {
        if (matches.includes(want)) return want;
        const plain = (id) => (/:|-thinking$|-\d{8}$/i.test(id) ? 1 : 0);
        return [...matches].sort((a, b) => plain(a) - plain(b) || a.length - b.length)[0];
    }
    if (available.length && source !== 'claude') return null; // the list is authoritative
    if (source === 'claude' || source === 'custom') return want;
    if (source === 'openrouter') return openRouterId(want);
    return null;
}

/**
 * Where chat requests go and how they're paid for.
 * @param {{ source: string|null, model: string|null, ours?: boolean, reverseProxy?: string }} p
 * @returns {{ kind: string, where: string, billing: string } | null} null: not Claude
 */
export function describeSource({ source, model, ours = false, reverseProxy = '' }) {
    if (ours) return { kind: 'ours', where: '本机代理', billing: '订阅' };
    const meta = CLAUDE_SOURCES[source];
    if (!meta || !isClaudeModel(model)) return null;
    if (source === 'claude' && String(reverseProxy ?? '').trim()) return { kind: source, where: '反向代理', billing: '中转' };
    return { kind: source, where: meta.label, billing: meta.billing };
}

/** Recommended config.yaml block for SillyTavern's own Claude caching (role-play: long gaps between turns). */
export const CACHE_YAML = 'claude:\n  cachingAtDepth: 0\n  extendedTTL: true';

/**
 * What caching SillyTavern offers on this source, as short lines for the panel.
 * @returns {{ tone: 'info'|'warn', lines: string[], yaml: string|null }}
 */
export function cacheAdvice(source) {
    const meta = CLAUDE_SOURCES[source];
    const keys = meta?.cache ?? [];
    if (keys.includes('cachingAtDepth')) {
        return {
            tone: 'info',
            lines: [
                '酒馆默认不开 Claude 缓存。在酒馆的 config.yaml 里改（面板改不了，酒馆启动时才读），改完重启酒馆：',
                'cachingAtDepth: 0 —— 聊天记录走缓存；extendedTTL: true —— 缓存留 1 小时（写入贵一倍，隔几分钟再回也能命中）。',
                'enableSystemPromptCache 只在预设和世界书每轮不变时开，否则白花钱。',
            ],
            yaml: CACHE_YAML,
        };
    }
    if (keys.length) {
        return {
            tone: 'info',
            lines: [
                `酒馆对 ${meta.label} 只有系统提示词缓存：config.yaml 里 claude.enableSystemPromptCache: true（extendedTTL: true 留 1 小时），改完重启酒馆。`,
                '只在预设和世界书每轮不变时有用。',
            ],
            yaml: 'claude:\n  enableSystemPromptCache: true\n  extendedTTL: true',
        };
    }
    return {
        tone: 'warn',
        lines: [`酒馆对「${meta?.label ?? source}」没有缓存设置，缓存由来源自己决定。想省钱：换 Claude 官方源 / OpenRouter，或连本机代理。`],
        yaml: null,
    };
}

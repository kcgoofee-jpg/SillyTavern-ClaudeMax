// ──────────────────────────────────────────────
// Chinese explanations for common failures
// ──────────────────────────────────────────────
//
// Errors reach the user as a SillyTavern toast / chat error, so they should
// say what happened and what to do — in Chinese — while keeping the raw
// upstream text for debugging. Order matters: first match wins.

const RULES = [
    {
        code: 'not_logged_in',
        test: /not logged in|please run \/login|oauth token has expired|token_expired|invalid_token|authentication_failed|authentication expired/i,
        message: 'Claude 订阅未登录或登录已失效',
        hint: '双击桌面「酒馆工具 → 登录 Claude」重新登录（或在代理目录运行 npm run login），不需要重启代理。',
    },
    {
        code: 'reasoning_extraction',
        test: /reasoning_extraction/i,
        message: '模型的安全分类器判定这条请求在「套取推理过程」（reasoning_extraction），拒绝回答',
        hint: '预设要求模型把思考过程写进回复（<thinking> 思维链、注释草稿、逐段自检注释）时会触发，Opus 5 和 Opus 5.5 都会拦截（实测）。这类拦截即使没有输出也照样计费，别反复重试：换用改成原生思考的预设（如「十四行诗3.0-Claude」）；想看正文里的思维链，改用 Opus 4.6 并把思考模式设为关闭。',
    },
    {
        code: 'safeguards',
        test: /safeguards flagged|stop_reason.{0,5}refusal|refusal/i,
        message: 'Claude 的安全分类器拦下了这条请求',
        hint: '可以重新生成一次；反复出现时调整最近的内容，或换一个模型（错误信息里的 Details 是拦截类别）。',
    },
    {
        code: 'extra_usage',
        test: /extra usage|out of extra usage/i,
        message: '1M 上下文需要订阅开通额外用量，当前不可用',
        hint: '换成不带「(1M context)」的同名模型。',
    },
    {
        code: 'usage_limit',
        test: /usage limit|limit reached|quota|rate.?limit|too many requests|\b429\b/i,
        message: '触发了订阅额度限制（请求太频繁，或 5 小时 / 7 天额度已用完）',
        hint: '稍等几分钟再试；CCST 面板的「订阅额度」里能看到重置时间。',
    },
    {
        code: 'overloaded',
        test: /overloaded|\b529\b|\b503\b|service unavailable/i,
        message: 'Claude 服务端繁忙',
        hint: '过一两分钟重新生成即可，和你的设置无关。',
    },
    {
        code: 'prompt_too_long',
        test: /prompt is too long|context.{0,20}(length|window)|too many tokens|maximum context/i,
        message: '上下文太长，超出了模型的上下文窗口',
        hint: '在酒馆里调小「上下文长度」，或换成「(1M context)」模型。',
    },
    {
        code: 'served_model_guard',
        test: /served-model guard|model substitution refused/i,
        message: 'Fable 当前不可用，上游想换成其他模型，已被拦下',
        hint: '暂时改选其他模型（例如 Opus 5）；Fable 可能被临时关闭，过段时间再试。',
    },
    {
        code: 'idle_timeout',
        test: /idle|deadline exceeded|aborted/i,
        message: 'Claude 长时间没有返回数据，请求已中止',
        hint: '重新生成一次；如果经常发生，检查网络或稍后再试。',
    },
    {
        code: 'network',
        test: /ECONNREFUSED|ENOTFOUND|ETIMEDOUT|ECONNRESET|fetch failed|network|socket hang up/i,
        message: '代理连不上 Claude 服务器（网络问题）',
        hint: '检查这台电脑的网络 / 代理设置后重试。',
    },
    {
        code: 'sdk_unavailable',
        test: /failed to load @anthropic-ai\/claude-agent-sdk|native cli binary/i,
        message: 'Claude SDK 没有装好',
        hint: '双击桌面「酒馆工具 → 修复依赖」，然后「重启酒馆」。',
    },
    {
        code: 'refusal',
        test: /declined|safety/i,
        message: 'Claude 拒绝了这次请求（安全策略）',
        hint: '调整一下最近的内容或换个说法后重新生成。',
    },
];

/**
 * @param {string} raw upstream error text
 * @returns {{ code: string, message: string, hint: string, raw: string }}
 */
export function explainError(raw) {
    const text = String(raw ?? '');
    for (const rule of RULES) {
        if (rule.test.test(text)) {
            return { code: rule.code, message: rule.message, hint: rule.hint, raw: text };
        }
    }
    return {
        code: 'unknown',
        message: 'Claude 请求失败',
        hint: '重新生成一次；仍然失败的话双击「酒馆工具 → 检查状态」查看原因。',
        raw: text,
    };
}

/** One-line user-facing text: 中文说明 + 办法 + 原始错误. */
export function formatErrorForUser(raw) {
    const e = explainError(raw);
    return `【CCST】${e.message}。${e.hint}（原始错误：${e.raw}）`;
}

# SillyTavern — Claude Max（订阅代理）

> 基于 [LukaTheHero/SillyTavern-ClaudeSubscription](https://github.com/LukaTheHero/SillyTavern-ClaudeSubscription)（AGPL-3.0）独立维护，感谢原作者。

Use your **Anthropic Pro / Max subscription** for SillyTavern chat instead of
paying for API credits. A SillyTavern **Server Plugin** routes requests
through the locally-installed [Claude Agent SDK][sdk] — the same subscription
mechanism VS Code, Cursor, and Zed use — and ships with a companion
**"Claude Max" UI extension** for one-click connection and Claude-native
settings.

<img width="954" height="1736" alt="Screenshot 2026-07-01 195136" src="https://github.com/user-attachments/assets/34199be7-9d69-402e-ac98-8589ab40c955" />


[sdk]: https://docs.anthropic.com/en/docs/claude-code/sdk

## 中文快速上手（独立代理 / TauriTavern）

v2.3 起，代理可以**独立运行**，不再依赖 SillyTavern 的 Node 服务器插件。所以它也能配合
[TauriTavern](https://github.com/Darkatse/TauriTavern) 使用。TauriTavern 的后端是 Rust，不支持服务器插件。

1. **安装并登录**（只需一次）：
   ```bash
   git clone https://github.com/kcgoofee-jpg/SillyTavern-ClaudeMax
   cd SillyTavern-ClaudeMax
   npm install        # 不要加 --omit=optional，Claude CLI 就在 optional 依赖里
   npm run login      # 用 SDK 自带的 Claude CLI 登录 Pro/Max 订阅
   npm run auth       # 查看登录状态
   ```
   在 macOS 上，凭据保存在钥匙串（Keychain）里，代理会自动读取。
2. **启动代理**：运行 `npm start`，监听 `http://127.0.0.1:8901/v1`。
3. **TauriTavern**：
   - 打开「扩展 → 安装扩展」，填入本仓库的 git 地址，安装前端面板。
   - 打开扩展抽屉里的 **Claude Max** 面板，点击 Connect。
   - 第一次连接时，TauriTavern 会弹出原生授权框，允许访问 `127.0.0.1:8901` 即可。
   - 面板顶部的状态点显示代理是否在线、是否已登录。
4. **原版 SillyTavern**：照常作为服务器插件安装（见下文英文说明）。
   - 如果已经用 `npm start` 启动了独立代理，插件会自动复用它，不会重复监听端口。

新增模型：Claude Opus 5.5、Claude Sonnet 5（都有 1M 变体）。
Sonnet 5 不支持 thinking 预算，所以「Always on」会按 adaptive 发送。

v2.4：
- **使用统计**：代理每次对话记录一行元数据到 `data/usage.jsonl`（模型、耗时、token、缓存命中；不含聊天内容），
  面板显示今天 / 近 7 天汇总和最近一次失败原因；`GET /v1/usage/stats` 返回同样数据。
- **中文错误提示**：常见失败（未登录、额度限制、服务繁忙、上下文过长、1M 不可用……）带中文原因和解决办法。
- **预设思维链提示**：回复正文里有 `<thinking>` 块而原生思考为空时，面板提示如何让酒馆把它收进折叠框。
- 修复：Fable 请求出错时被误报为「模型被替换」（CLI 的 `<synthetic>` 错误消息）。
- Claude Agent SDK 升级到 0.3.x。
- **预设配合**：第一条用户消息之前的 system 条目全部进入系统提示词（夹在中间的伪造 assistant 回信留在历史里），整个预设可被缓存；之后的深度注入留在原位。
- **预设推荐设置**：预设文件可带 `extensions.claude_max`（effort / thinking / showReasoning / useResume / inlineSystem），切换到该预设时面板自动应用。
- **Opus 5.5 预检**：选了 Opus 5.5 而预设仍要求把 `<thinking>`/`<cot>` 写进回复时，发送前提示会被 reasoning_extraction 拦截。

## What v2 gives you

- **Current models** — Claude Fable 5.1/5, Opus 5/4.8/4.7/4.6/4.5, Sonnet 4.6/4.5,
  Haiku 4.5, plus explicit **"(1M context)"** variants for the tiers that
  support extended context.
- **One-click connect** — the Claude Max panel (Extensions drawer) configures
  SillyTavern's Custom endpoint for you. No URLs to paste.
- **Claude-native reasoning effort** — `low / medium / high / xhigh / max`,
  set in the Claude Max panel. SillyTavern's built-in Reasoning Effort
  dropdown does **not** work for Claude models on Custom endpoints (its
  "Maximum" is downgraded to `high` client-side, and the field is dropped
  server-side for non-OpenAI model IDs) — this panel bypasses all of that.
- **Thinking display** — Claude's reasoning streams into SillyTavern's native
  collapsible "thoughts" block (`reasoning_content`). Toggle in the panel;
  also enable "Show model thoughts" in ST's settings.
- **Real multi-turn context** — chat history is replayed as a genuine Claude
  session (synthetic session resume), not folded into one giant string:
  proper role separation, working prompt caching, better long-RP quality.
- **Roleplay isolation** — no coding system prompt, no host CLAUDE.md /
  settings / MCP connectors leaking into your scenes, no agent tools. Your
  character card and world info are the entire system prompt.
- **Stop sequences enforced** — the Agent SDK has none, so the plugin scans
  the stream server-side (`\n{{user}}:` guards work as expected).
- **Resilience** — automatic OAuth token refresh, rate-limit retries,
  1M-context → base-model fallback with a one-hour probe cooldown.
- **Served-model guard** — an explicit Fable request is NEVER silently
  substituted: if the upstream resolves your `claude-fable-5-1` or `claude-fable-5` pick to
  anything else (e.g. Fable temporarily disabled on your plan), the request
  errors out with a clear message instead of quietly switching to Opus
  mid-roleplay.
- **Quota meter** — live 5-hour / 7-day subscription window utilization in
  the panel, so a long session never hits a surprise lockout.
- **Privacy sweep** — the transcript the Claude CLI writes for each live turn
  is deleted after the request; your roleplay does not persist in plaintext
  under `~/.claude/projects`.

## Prerequisites

On the same machine SillyTavern runs on:

1. **Sign in once** with your Pro / Max account (installs nothing into ST):
   ```
   npm i -g @anthropic-ai/claude-code
   claude login
   ```
   (Headless / Docker: generate a token with `claude setup-token` and set
   `CLAUDE_CODE_OAUTH_TOKEN` instead.)
2. SillyTavern `config.yaml`: `enableServerPlugins: true`.

## Install

From your SillyTavern install directory (the one containing `server.js`):

```
node plugins.js install https://github.com/kcgoofee-jpg/SillyTavern-ClaudeMax
cd plugins/SillyTavern-ClaudeMax
npm install
```

Restart SillyTavern. The server log should show:

```
[claude-subscription] installed UI extension v2.0.1 at public/scripts/extensions/third-party/SillyTavern-ClaudeMax
[claude-subscription] standalone listener: http://127.0.0.1:8901/v1
[claude-subscription] initialised — endpoint http://127.0.0.1:8901/v1
```

> The companion **Claude Max** UI extension is installed/updated
> automatically on startup. Hard-refresh the browser (Ctrl+F5) after the
> first install so SillyTavern loads it. Opt out with
> `CLAUDE_SUBSCRIPTION_NO_UI_INSTALL=1`.

### Alternative: install the panel via the extension dialog

The repo doubles as a regular UI extension (`manifest.json` at the root), so
the **Claude Max panel** can also be installed from **Extensions → Install
extension** by pasting the same GitHub URL. The auto-installer detects a
dialog-installed copy and stands down (and a runtime guard dedupes if both
ever load).

> ⚠️ The dialog installs **only the panel**. The **server plugin** (the
> actual proxy) must still be installed into `plugins/` as above — without
> it, Connect has nothing to connect to.

## Connect

1. Open the **Extensions** drawer → **Claude Max**.
2. Click **Connect to Claude Max**.
3. Pick a model from the normal model dropdown (e.g. *Claude Fable 5.1* or
   *Claude Opus 5 (1M context)*).
4. Chat.

Set effort/thinking in the same panel — changes apply from the next message,
no reconnect needed.

v2.5（这一版的实测数据见仓库外的 `tavern/ab-tests/结果-M1缓存.md`）：
- **聊天记录终于能读缓存**：Claude Code CLI 会把环境、模型、日期等提醒追加在「本轮输入」上；下一轮这条消息变成历史时没有这些提醒，
  缓存对不上，以前无论预设怎么写，聊天记录每轮都整段重写。现在代理在内存里记住每轮 CLI 实际发出的样子，下一轮原样还原（不落盘）。
- **缓存要整段命中，还需要预设配合**（CLI 只在最后一条消息上留一个缓存点，聊天记录里任何一处每轮变化都会让后面整段重写）：
  1. 不要用按楼层改写旧消息的正则（如「5 楼外只发摘要」「仅发送 1 轮」）；
  2. 关闭「深度注入保持原位」，把深度注入提到系统提示词（预设可用 `extensions.claude_max.inlineSystem: false` 自动设置）；
  3. 世界书条目改成常驻，不按关键词触发。
  三条都满足时实测每轮缓存写入约 2.8 万 → 3 千 token，命中 46% → 95%；耗时不变（时间主要花在思考上），按官方计价估算每轮额度约省 43%。
- **缓存卡片**：面板「使用统计」下显示最近一轮读 / 写 / 命中率，以及变化原因和对应的解决办法。
- **下一轮临时加深**：「高 / 超高」只作用于下一条回复，收到后自动恢复。实测高约慢 1/3，超高约慢 3 倍、输出约 3.5 倍。
- **本轮体检**：每条回复生成完自动检查字数（按预设的字数设定）、禁词（读预设禁词表）、破折号、「不是A，是B」、第二人称、
  A–J 选项和路线标签、隐藏设定关键词、重复段落、生命等「当前/上限」数值的突变；有问题弹提示。
- **查看实际发给模型的内容**：打开「调试：保存最近一次完整请求」后，高级设置里可以直接看系统提示词（标出缓存分界）和整理后的聊天记录。
- **隐私**：CLI 子进程的工作目录移出了 git 仓库，并关闭自动记忆（`CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`）——以前会把这台电脑上
  Claude Code 的项目记忆和 git 状态带进角色扮演上下文。聊天文字按原样发送（`verbatimPrompts`），不会把 `@文件名` 当成读取本地文件。

**CLI 固定注入、目前关不掉的内容**：Claude Code CLI 每轮会附带四段提醒——账号邮箱、系统环境（工作目录、是否 git 仓库、系统和 shell）、
模型名称与知识截止日期、今天的日期。按官方文档，Agent SDK 只提供 `settingSources`（不读设置 / CLAUDE.md）、`excludeDynamicSections`
（只对 Claude Code 内置系统提示词有效，自定义系统提示词下无效）和 `verbatimPrompts`，都关不掉这四段；官方没有公开的开关。
它们很短、每天只变一次日期，对剧情没有影响；代理已确保它们不破坏缓存。

### Settings reference (Claude Max panel)

| Setting | Default | What it does |
| --- | --- | --- |
| Reasoning effort | Auto | How hard Claude reasons before replying, `low → max`. Auto sends nothing (model default, ≈high). Higher = better consistency on complex scenes, slower replies, more quota. |
| Thinking mode | Adaptive | Whether extended thinking happens at all. **Adaptive**: model thinks only when the message warrants it. **Always on**: every reply. **Off**: none — except Fable 5/5.1 and Opus 4.7+ / Opus 5 *always* think (can't be disabled), and thinking is auto-disabled on other models when Max response length < 2048 tokens. |
| Show reasoning | On | **Display only** — doesn't change whether thinking happens. On: the thinking summary streams into ST's collapsible "thoughts" box (enable "Show model thoughts" in ST too). Never added to chat history or re-sent as context. |
| Identity mode | Off | Off: your character card is the *entire* system prompt. On: prepends Anthropic's Claude Code preamble (the framing the `claude` CLI uses) — fixes model self-identification ("are you Opus or Sonnet?") at the cost of extra tokens and a coding-assistant flavor. Leave off for RP. |
| Session resume | On | How history reaches Claude. On: replayed as a real multi-turn session — better turn awareness, working prompt caching (faster + less quota burned re-reading context); swipes/edits handled naturally. Off: history flattened to one `User:/Assistant:` text block (troubleshooting only). |

### Known limitations (Agent SDK)

- **Temperature / Top-P / Top-K are not supported** on the subscription path
  — the Agent SDK exposes no sampling controls. (Adaptive-thinking models
  reject them anyway.)
- **Assistant prefill is emulated**: a trailing assistant message ("Start
  Reply With", continue) becomes a continuation instruction rather than true
  Messages-API prefill. Works well in practice; the model occasionally
  paraphrases instead of continuing verbatim.
- Embeddings return `501` — use a separate embedding source.

## Environment overrides

| Variable | Default | Purpose |
| --- | --- | --- |
| `CLAUDE_SUBSCRIPTION_PORT` | `8901` | Listener port |
| `CLAUDE_SUBSCRIPTION_HOST` | `127.0.0.1` | Listener host |
| `CLAUDE_SUBSCRIPTION_USE_RESUME` | `1` | `0` forces the fold path |
| `CLAUDE_SUBSCRIPTION_MAX_TURNS` | `1` | SDK maxTurns |
| `CLAUDE_SUBSCRIPTION_CLAUDE_PATH` | – | Explicit `claude` executable path |
| `CLAUDE_SUBSCRIPTION_NO_UI_INSTALL` | – | `1` skips UI-extension auto-install |
| `CLAUDE_SUBSCRIPTION_TURN_REPLAY` | `1` | `0` disables replaying past turns with the CLI's per-turn attachments (history then never caches) |
| `CLAUDE_SUBSCRIPTION_VERBATIM` | `1` | `0` lets the CLI expand `@path` mentions / slash commands in chat text |
| `CLAUDE_SUBSCRIPTION_SCRATCH_CWD` | `$TMPDIR/claude-max-rp` | Subprocess working directory (keep it outside any git repo) |

> Changing the port or host? Update **Endpoint (advanced)** in the Claude Max
> panel to the new `http://<host>:<port>/v1` before clicking **Connect** —
> the panel's Connect button, per-request settings injection, and quota meter
> all use that stored endpoint.

## Endpoints

| Method | URL | Purpose |
| --- | --- | --- |
| GET | `http://127.0.0.1:8901/status` | SDK + credential health |
| GET | `http://127.0.0.1:8901/v1/models` | Model list (incl. 1M variants) |
| GET | `http://127.0.0.1:8901/v1/usage/quota` | Subscription window utilization |
| GET | `http://127.0.0.1:8901/v1/usage/stats` | Usage summary + last-turn cache explanation |
| GET | `http://127.0.0.1:8901/v1/debug/last` | Last saved request (only when the debug switch is on) |
| POST | `http://127.0.0.1:8901/v1/chat/completions` | Chat (SSE + JSON) |
| POST | `http://127.0.0.1:8901/v1/embeddings` | Always `501` |
| GET | `http://<sillytavern>/api/plugins/claude-subscription/status` | Browser health check |

Direct API users: the plugin accepts the standard `reasoning_effort` body
field, or a `claude_subscription: { effort, thinking, thinking_budget,
show_reasoning, identity_mode, use_resume, system_placement, debug_dump }` object for full control.
`thinking_budget` (tokens) only applies when `thinking: "on"` and the model
is not adaptive-only (Opus 4.7+/Opus 5/Fable ignore it); it is clamped to ≥ 1024
and ≤ `max_tokens − 512`.

## API-billing fallback (optional)

Enter a real `sk-ant-*` key as the Custom API key and the plugin forwards it
as `ANTHROPIC_API_KEY` — billing that key instead of the subscription.
Anything else in the key field is ignored (subscription auth).

## Troubleshooting

**"Failed to load @anthropic-ai/claude-agent-sdk"** — run `npm install`
inside the plugin directory (without `--omit=optional`; the Claude CLI ships
inside the SDK as a platform package) and restart SillyTavern.

**Auth errors mid-chat** — the plugin auto-refreshes the OAuth token once per
request; if it still fails, run `claude login` on the SillyTavern host **as
the same OS user** that runs `server.js`.

**Model list didn't populate** — click Connect again; check
`http://127.0.0.1:8901/status` in a browser.

**1M variant quietly serving 200k** — extended context needs Extra Usage on
some plans; after one failure the plugin serves the base model for an hour,
then probes again. Watch the server log for the cooldown message.

## License

[GNU AGPL v3.0 or later](LICENSE).

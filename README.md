# Claude Max for SillyTavern

用自己的 **Claude Pro / Max 订阅** 在 SillyTavern（酒馆）或 TauriTavern 里聊天，不用另买 API 额度。

它由两部分组成：

- **本地代理**：通过官方 [Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk/overview) 调用你登录的订阅，对外提供 OpenAI 兼容接口（`http://127.0.0.1:8901/v1`）。
- **Claude Max 面板**：酒馆扩展，负责一键连接，并提供思考深度、额度、缓存、回复体检等设置。

> 基于 [LukaTheHero/SillyTavern-ClaudeSubscription](https://github.com/LukaTheHero/SillyTavern-ClaudeSubscription)（AGPL-3.0）独立维护，感谢原作者。

> [!WARNING]
> **使用前请先读完下面的[风险提示](#风险提示)。** 这不是 Anthropic 官方支持的用法，账号有被限制或封禁的可能。

## 需要什么

- Claude **Pro 或 Max** 订阅
- Node.js 18 或更高版本
- SillyTavern（原版）或 TauriTavern，运行在同一台电脑上

## 安装

### 原版 SillyTavern（推荐）

1. 在酒馆的 `config.yaml` 里设置 `enableServerPlugins: true`。
2. 在酒馆目录（有 `server.js` 的那一层）运行：
   ```bash
   node plugins.js install https://github.com/kcgoofee-jpg/SillyTavern-ClaudeMax
   cd plugins/SillyTavern-ClaudeMax
   npm install
   npm run login
   ```
   - 安装依赖时**不要**加 `--omit=optional`，Claude CLI 就在可选依赖里。
   - `npm run login` 会打开浏览器，登录你的订阅账号。只需要登录一次。
3. 重启酒馆，并强制刷新浏览器（Ctrl+F5）。面板会自动安装。

### TauriTavern，或者想单独运行代理

TauriTavern 不支持服务器插件，所以要单独启动代理：

```bash
git clone https://github.com/kcgoofee-jpg/SillyTavern-ClaudeMax
cd SillyTavern-ClaudeMax
npm install
npm run login
npm start
```

- 代理启动后要一直开着。
- 面板从「扩展 → 安装扩展」安装，地址填本仓库的 git 地址。
- 第一次连接时 TauriTavern 会弹出授权框，允许访问 `127.0.0.1:8901` 即可。

### 一键启动脚本（可选）

仓库的 `launcher/` 里有现成的脚本，双击就能启动、关闭、检查状态和登录，不用记命令。脚本会自动识别酒馆位置：仓库装在酒馆的 `plugins/` 下，或者和 `SillyTavern` 文件夹放在一起时，会连酒馆一起启动；找不到酒馆时只启动代理（适合 TauriTavern）。

| 系统 | 位置 | 用法 |
| --- | --- | --- |
| macOS | `launcher/mac/` | 双击 `启动酒馆.command`。第一次运行时如果被系统拦截，右键 → 打开 |
| Windows | `launcher/windows/` | 双击 `启动酒馆.bat` |
| 安卓 Termux | `launcher/termux/claude-max.sh` | 见下文 |

每个系统都有这些脚本：启动酒馆、关闭酒馆、重启酒馆、检查状态、登录 Claude、修复依赖、开机自动启动、打开日志。遇到问题先运行「检查状态」：它会逐项检查环境、登录、端口和日志，并给出解决办法。

想手动指定路径，在 `launcher/` 下新建 `config.local`（macOS）或 `config.local.ps1`（Windows），写入酒馆目录、日志目录或端口，例如 `ST_DIR="/path/to/SillyTavern"`。

#### 安卓（Termux）

Claude CLI 没有安卓版，不能直接在 Termux 里运行。脚本会在 Termux 里装一个 Debian 子系统，让代理跑在里面；酒馆照常跑在 Termux 里，两边共用网络。

```bash
curl -fsSLO https://raw.githubusercontent.com/kcgoofee-jpg/SillyTavern-ClaudeMax/main/launcher/termux/claude-max.sh
bash claude-max.sh install
claude-max login
claude-max start
```

- 安装约需 100MB 流量和几分钟，只需一次。
- 面板从酒馆的「扩展 → 安装扩展」安装，然后点「一键连接」。
- 常用命令：`claude-max start`、`stop`、`status`、`update`、`logs`。
- 安卓会清理后台程序。启动时脚本会申请唤醒锁；另外请在系统设置里关闭 Termux 的电池优化，也不要划掉 Termux 的通知。

## 使用

1. 打开「扩展」抽屉里的 **Claude Max** 面板，点 **一键连接**。
2. 在「API 连接」的模型下拉框里选一个 Claude 模型，比如 Opus 5.5、Sonnet 5 或 Fable 5.1。
3. 开始聊天。

面板分五页：

| 页 | 内容 |
| --- | --- |
| 连接 | 代理状态、一键连接、使用说明 |
| 推理 | 思考深度（低 → 最大）、「下一轮临时加深」、思考模式、是否显示思考过程 |
| 统计 | 5 小时和 7 天额度、用量、上一轮缓存命中情况和原因、一键把世界书设为常驻 |
| 体检 | 每条回复自动检查：字数、禁词、破折号、人称、选项格式、重复段落、数值突变 |
| 高级 | 缓存相关开关、调试（查看实际发给模型的内容）、代理地址 |

面板顶部的四个小卡片显示模型、额度、缓存和体检结果，点一下可以跳到对应的页。

**注意事项**

- 酒馆自带的「推理强度」请保持「自动」，思考深度在面板里设置。
- 「提示词后处理」请设为「无」。点一键连接时会自动改好。

## 省额度：让缓存生效

长对话里，大部分额度花在每轮重新读取整段聊天记录上。缓存命中时，这部分只按约十分之一计费。要让聊天记录整段命中缓存，需要同时满足三个条件：

1. **不要用按楼层改写旧消息的正则**，比如「5 楼外只发摘要」。
2. **世界书改成常驻**，不按关键词触发。面板「统计」页可以一键转换，转换前会自动备份。
3. **深度注入提到系统提示词里**。预设可以在 `extensions.claude_max` 里写 `inlineSystem: false`，切换到该预设时面板会自动应用。

实测三条都满足时，缓存命中率从 46% 提高到 95%，按官方计价折算，每轮约省 43%。

面板「统计」页会显示上一轮哪里没命中，以及怎么改。

## 利弊

**好处**

- 按订阅的包月额度计算，不另外按 token 付费。重度使用时比 API 便宜很多。
- 聊天记录按真实的多轮对话发送，而不是压成一大段文字。角色区分更准，也能用上提示缓存。
- 可以直接设置原生思考深度。酒馆自带的「推理强度」对 Custom 端点上的 Claude 不起作用。
- 不会带入编程助手的系统提示词，也不会带入本机的 CLAUDE.md 或工具。
- 聊天内容不落盘：CLI 生成的对话记录会在请求结束后删除；用量日志只记录耗时和 token 数。

**限制**

- **不支持温度、Top-P、Top-K**，因为 Agent SDK 没有提供采样参数。
- **预填是模拟的**：末尾的 assistant 消息会被改写成「从这里接着写」的指令，偶尔不会逐字接续。
- **额度和 Claude 网页版、Claude Code 共用**，受 5 小时和 7 天窗口限制，用完要等窗口重置。
- **首字等待约 5 秒**，其中绝大部分是 Anthropic 那边的处理时间，比直接调用 API 稍慢。
- CLI 每轮会附带几段固定提醒（账号邮箱、系统环境、模型名、日期），目前关不掉。它们很短，不影响剧情，也不会破坏缓存。
- 不支持向量嵌入（embeddings），需要另配一个来源。

## 风险提示

请在了解以下几点后自行决定是否使用：

- **这不是官方认可的用法。** Agent SDK 的官方文档写明：除非事先获得批准，Anthropic 不允许第三方产品提供 claude.ai 登录或使用订阅额度，要求改用 API 密钥认证。本项目正是用订阅额度驱动第三方前端，Anthropic 随时可能限制这种用法，或者对账号采取措施。
- **内容受 Anthropic 使用政策约束。** [使用政策](https://www.anthropic.com/legal/aup)禁止生成露骨的色情内容，包括色情聊天。任何涉及未成年人的性内容都绝对禁止，包括虚构和角色扮演，Anthropic 会向有关机构报告。通过订阅发出的请求和官方客户端一样受审核，违规可能导致账号被警告、限制或封禁。
- **异常用量更容易被注意到。** 长时间高频请求、大上下文、多个设备共用一个账号都会增加风险。建议不要把代理开放给别人使用，也不要共享账号。
- **被安全分类器拦截的请求照样计入额度。** 例如，Opus 5 / 5.5 会拦截要求把思维链写进正文的预设，面板会在发送前提醒。

作者不对账号被限制、封禁或其他损失负责。介意这些风险的话，请改用 [Anthropic API](https://platform.claude.com/)：在酒馆「API 连接」的 Custom API 密钥栏填入 `sk-ant-` 开头的密钥，代理就会改用这个密钥按量计费。

## 常见问题

**面板显示「连接不到代理」**
原版酒馆：确认 `enableServerPlugins: true`，并已重启酒馆。TauriTavern：确认已在代理目录运行 `npm start`。

**提示「未登录」或聊天中途认证失败**
在代理目录运行 `npm run login`，要用运行酒馆的同一个系统用户。运行 `npm run auth` 可以查看登录状态。

**提示「Failed to load @anthropic-ai/claude-agent-sdk」**
在插件目录重新运行 `npm install`，不要加 `--omit=optional`，然后重启。

**1M 模型实际只有 200k 上下文**
部分套餐需要开通额外用量才能用 1M 上下文。1M 请求失败后，代理会改用普通版一小时，之后再重试。

**模型列表是空的**
再点一次一键连接，或者在浏览器里打开 `http://127.0.0.1:8901/status` 查看代理状态。

<details>
<summary>高级：环境变量与接口</summary>

| 环境变量 | 默认值 | 作用 |
| --- | --- | --- |
| `CLAUDE_SUBSCRIPTION_PORT` | `8901` | 监听端口（改了之后同步修改面板「高级」里的代理地址） |
| `CLAUDE_SUBSCRIPTION_HOST` | `127.0.0.1` | 监听地址 |
| `CLAUDE_SUBSCRIPTION_USE_RESUME` | `1` | `0` 表示把聊天记录压成一段文字发送 |
| `CLAUDE_SUBSCRIPTION_TURN_REPLAY` | `1` | `0` 表示关闭逐轮还原（聊天记录将无法命中缓存） |
| `CLAUDE_SUBSCRIPTION_VERBATIM` | `1` | `0` 表示允许 CLI 展开聊天文字里的 `@路径` 和斜杠命令 |
| `CLAUDE_SUBSCRIPTION_SCRATCH_CWD` | `$TMPDIR/claude-max-rp` | CLI 子进程的工作目录（应放在任何 git 仓库之外） |
| `CLAUDE_SUBSCRIPTION_AUX_THINKING` | `off` | 没带面板设置的辅助请求是否思考 |
| `CLAUDE_SUBSCRIPTION_CLAUDE_PATH` | – | 指定 `claude` 可执行文件的路径 |
| `CLAUDE_SUBSCRIPTION_NO_UI_INSTALL` | – | `1` 表示不自动安装面板 |

| 方法 | 地址 | 用途 |
| --- | --- | --- |
| GET | `/status` | SDK 和登录状态 |
| GET | `/v1/models` | 模型列表 |
| GET | `/v1/usage/quota` | 订阅额度 |
| GET | `/v1/usage/stats` | 用量统计和上一轮缓存分析 |
| GET | `/v1/debug/last` | 最近一次完整请求（需打开调试开关） |
| POST | `/v1/chat/completions` | 聊天（SSE 和 JSON） |

直接调用接口时，可以在请求体里加 `claude_subscription: { effort, thinking, show_reasoning, use_resume, system_placement, debug_dump }` 字段来控制这些设置。

预设文件可以带 `extensions.claude_max` 字段（`effort`、`thinking`、`showReasoning`、`useResume`、`inlineSystem`、`tailBlockFront`），切换到该预设时面板会自动应用，切走时恢复。

</details>

## 许可证

[GNU AGPL v3.0 或更高版本](LICENSE)

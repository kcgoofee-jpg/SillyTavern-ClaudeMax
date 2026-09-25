# Claude Max for SillyTavern

用自己的 **Claude Pro / Max 订阅** 在 SillyTavern（酒馆）或 TauriTavern 里聊天，不用另买 API 额度。

- **本地代理**：通过官方 [Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk/overview) 调用你登录的订阅，对外提供 OpenAI 兼容接口 `http://127.0.0.1:8901/v1`。
- **Claude Max 面板**：酒馆扩展，一键连接，并提供思考深度、额度、缓存、回复体检等设置。

> 基于 [LukaTheHero/SillyTavern-ClaudeSubscription](https://github.com/LukaTheHero/SillyTavern-ClaudeSubscription)（AGPL-3.0）独立维护，感谢原作者。

> [!WARNING]
> 这不是 Anthropic 官方认可的用法，账号有被限制或封禁的可能。**使用前请先读[风险提示](#风险提示)。**

## 需要什么

- Claude **Pro 或 Max** 订阅
- Node.js 18 或更高版本
- SillyTavern 或 TauriTavern，和代理运行在同一台电脑上（目前只在 macOS 上实测过）

## 安装

### 原版 SillyTavern

1. 在酒馆的 `config.yaml` 里设置 `enableServerPlugins: true`。
2. 在酒馆目录（有 `server.js` 的那一层）运行：
   ```bash
   node plugins.js install https://github.com/kcgoofee-jpg/SillyTavern-ClaudeMax
   cd plugins/SillyTavern-ClaudeMax
   npm install
   npm run login
   ```
   - `npm install` **不要**加 `--omit=optional`，Claude CLI 在可选依赖里。
   - `npm run login` 会打开浏览器登录订阅账号，只需一次。
3. 重启酒馆，强制刷新浏览器（Ctrl+F5）。面板会自动安装。

### TauriTavern，或单独运行代理

```bash
git clone https://github.com/kcgoofee-jpg/SillyTavern-ClaudeMax
cd SillyTavern-ClaudeMax
npm install
npm run login
npm start
```

代理要一直开着。面板从「扩展 → 安装扩展」安装，地址填本仓库。TauriTavern 第一次连接时会弹出授权框，允许访问 `127.0.0.1:8901` 即可。

macOS 用户也可以用 `launcher/mac/` 里的脚本：双击「启动酒馆」「检查状态」「登录 Claude」等，不用记命令。

## 使用

1. 打开「扩展」里的 **Claude Max** 面板，点 **一键连接**。
2. 在「API 连接」的模型下拉框里选 Claude 模型，比如 Opus 5.5、Sonnet 5、Fable 5.1。
3. 开始聊天。

酒馆自带的「推理强度」保持「自动」，思考深度在面板里设置。「提示词后处理」要设为「无」，一键连接时会自动改好。

| 面板页 | 内容 |
| --- | --- |
| 连接 | 代理状态、一键连接 |
| 推理 | 思考深度、「下一轮临时加深」、思考模式、是否显示思考过程 |
| 统计 | 上一轮缓存命中和原因、5 小时 / 7 天额度、用量、一键把世界书设为常驻 |
| 体检 | 每条回复自动检查字数、禁词、破折号、人称、选项格式、重复段落 |
| 高级 | 缓存开关、查看实际发给模型的内容、代理地址 |

## 省额度：让缓存生效

长对话里，大部分额度花在每轮重新读取整段聊天记录上；命中缓存时这部分只按约十分之一计费。要整段命中，需要同时满足：

1. 不用按楼层改写旧消息的正则（如「5 楼外只发摘要」）；
2. 世界书改为常驻，不按关键词触发（面板「统计」页可一键转换，会先备份）；
3. 深度注入提到系统提示词里（预设可写 `extensions.claude_max.inlineSystem: false` 自动设置）。

实测三条都满足时，缓存命中率从 46% 提高到 95%，每轮约省 43% 额度。没命中时，面板会写明原因。

## 利弊

**好处**

- 用包月订阅额度，不另外按 token 付费，重度使用比 API 便宜得多。
- 聊天记录按真实多轮对话发送，角色区分更准，能用上提示缓存。
- 能直接设置原生思考深度（酒馆自带的「推理强度」对这种连接无效）。
- 不带编程助手提示词，也不读本机的 CLAUDE.md 和工具。
- 聊天内容不落盘；用量日志只记耗时和 token 数。代理只监听本机，并拒绝其他网站发来的请求。

**限制**

- 不支持温度、Top-P、Top-K（Agent SDK 不提供）。
- 预填是模拟的：末尾的 assistant 消息会变成「接着写」的指令，偶尔不会逐字接续。
- 额度和 Claude 网页版、Claude Code 共用，受 5 小时和 7 天窗口限制。
- 首字等待约 5 秒，比直接调用 API 稍慢。
- CLI 每轮会附带几段固定提醒（账号邮箱、系统环境、模型名、日期），关不掉；它们只发给 Anthropic，不影响剧情和缓存。
- 不支持向量嵌入（embeddings）。

## 风险提示

- **不是官方认可的用法。** Agent SDK 官方文档写明：除非事先获得批准，不允许第三方产品使用 claude.ai 登录或订阅额度。Anthropic 随时可能限制这种用法，或对账号采取措施。
- **内容受 Anthropic [使用政策](https://www.anthropic.com/legal/aup)约束。** 政策禁止露骨的色情内容（包括色情聊天）；任何涉及未成年人的性内容，包括虚构和角色扮演，都绝对禁止并会被上报。订阅请求和官方客户端一样受审核，违规可能导致警告、限制或封号。
- **异常用量更容易被注意到。** 不要把代理开放给别人用，不要共享账号。
- **被拦截的请求也计入额度。** 例如 Opus 5 / 5.5 会拦截要求把思维链写进正文的预设（面板会提前提醒）。

作者不对账号被限制、封禁或其他损失负责。介意的话请改用 [Anthropic API](https://platform.claude.com/)：在酒馆「API 连接」的 Custom API 密钥栏填入 `sk-ant-` 开头的密钥，代理就改按该密钥计费。

## 常见问题

**面板显示「连接不到代理」**：原版酒馆确认 `enableServerPlugins: true` 并已重启；单独运行时确认 `npm start` 在运行。

**「未登录」或聊天中途认证失败**：在代理目录运行 `npm run login`（用运行酒馆的同一个系统用户），`npm run auth` 查看状态。

**「Failed to load @anthropic-ai/claude-agent-sdk」**：在代理目录重新 `npm install`（不加 `--omit=optional`），然后重启。

**1M 模型只有 200k 上下文**：部分套餐要开通额外用量才能用 1M。失败后代理会改用普通版一小时再重试。

**模型列表是空的**：再点一次一键连接，或在浏览器打开 `http://127.0.0.1:8901/status` 看代理状态。

<details>
<summary>高级：环境变量、接口、预设字段</summary>

| 环境变量 | 默认值 | 作用 |
| --- | --- | --- |
| `CLAUDE_SUBSCRIPTION_PORT` | `8901` | 监听端口（改了要同步改面板「高级」里的代理地址） |
| `CLAUDE_SUBSCRIPTION_HOST` | `127.0.0.1` | 监听地址。改成 `0.0.0.0` 会让同一网络的任何人都能用你的订阅 |
| `CLAUDE_SUBSCRIPTION_ALLOWED_HOSTS` | – | 额外允许的访问域名，逗号分隔（默认只接受本机地址，防 DNS 重绑定） |
| `CLAUDE_SUBSCRIPTION_USE_RESUME` | `1` | `0` 表示把聊天记录压成一段文字发送 |
| `CLAUDE_SUBSCRIPTION_TURN_REPLAY` | `1` | `0` 表示关闭逐轮还原（聊天记录将无法命中缓存） |
| `CLAUDE_SUBSCRIPTION_VERBATIM` | `1` | `0` 表示允许 CLI 展开聊天文字里的 `@路径` 和斜杠命令 |
| `CLAUDE_SUBSCRIPTION_SCRATCH_CWD` | `$TMPDIR/claude-max-rp` | CLI 子进程的工作目录（应在任何 git 仓库之外） |
| `CLAUDE_SUBSCRIPTION_AUX_THINKING` | `off` | 没带面板设置的辅助请求是否思考 |
| `CLAUDE_SUBSCRIPTION_CLAUDE_PATH` | – | 指定 `claude` 可执行文件路径 |
| `CLAUDE_SUBSCRIPTION_NO_UI_INSTALL` | – | `1` 表示不自动安装面板 |

| 方法 | 地址 | 用途 |
| --- | --- | --- |
| GET | `/status` | SDK 和登录状态 |
| GET | `/v1/models` | 模型列表 |
| GET | `/v1/usage/quota` | 订阅额度 |
| GET | `/v1/usage/stats` | 用量统计和上一轮缓存分析 |
| GET | `/v1/debug/last` | 最近一次完整请求（需打开调试开关） |
| POST | `/v1/chat/completions` | 聊天（SSE 和 JSON） |

请求体可带 `claude_subscription: { effort, thinking, show_reasoning, use_resume, system_placement, debug_dump }` 控制这些设置。预设文件可带 `extensions.claude_max`（`effort`、`thinking`、`showReasoning`、`useResume`、`inlineSystem`、`tailBlockFront`），切到该预设时面板自动应用，切走时恢复。

</details>

<details>
<summary>实验性：Windows 与安卓 Termux 脚本（未经实测）</summary>

以下脚本只做过语法检查，没有在真机上运行过，可能需要自己排错。欢迎反馈。

- **Windows**：`launcher/windows/` 里双击 `启动酒馆.bat`、`检查状态.bat` 等。自定义路径写在 `launcher/config.local.ps1`，例如 `$ST_DIR = 'D:\SillyTavern'`。
- **安卓 Termux**：Claude CLI 没有安卓版，脚本会在 Termux 里装一个 Debian 子系统（约 100MB），代理跑在里面，酒馆照常跑在 Termux 里。
  ```bash
  curl -fsSLO https://raw.githubusercontent.com/kcgoofee-jpg/SillyTavern-ClaudeMax/main/launcher/termux/claude-max.sh
  bash claude-max.sh install
  claude-max login
  claude-max start
  ```
  面板从酒馆「扩展 → 安装扩展」安装。安卓会清理后台程序，请关闭 Termux 的电池优化，也不要划掉 Termux 的通知。

</details>

## 许可证

[GNU AGPL v3.0 或更高版本](LICENSE)

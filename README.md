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

macOS 用户双击 `launcher/mac/酒馆工具.command` 打开菜单：启动 / 关闭 / 重启、检查状态、登录 Claude、手机模式、手机同步、本地生图、提示词拆分等都在里面，输入编号回车（说明见 `launcher/使用说明.txt`）。各项也能单独双击。

`launcher/提示词拆分.html` 是一个本机网页（macOS 双击「提示词拆分」打开）：拖入 NAI 原图，像官方 inspect 一样显示图里的全部生成信息；再把提示词（或别人分享的一整段）拆成柏宝绘的画师串 / 正面质量词 / 负面提示词，可以导出成配方文件，再用「导入柏宝绘配方」（`launcher/baibai_import.py`）一键写进柏宝绘。不联网。

## 使用

1. 打开「扩展」里的 **Claude Max** 面板，点 **一键连接**。
2. 在「API 连接」的模型下拉框里选 Claude 模型，比如 Opus 5.5、Sonnet 5、Fable 5.1。
3. 开始聊天。

酒馆自带的「推理强度」保持「自动」，思考深度在面板里设置。「提示词后处理」要设为「无」，一键连接时会自动改好。

面板顶部的四张小卡片显示模型、额度、上轮缓存和体检结果。代理没开、没登录或酒馆没连上时，最上面会出现状态卡和「一键连接」按钮（连不上代理时还会出现代理地址和访问密码）；一切正常时它会自动隐藏。

**灵动岛**：输入栏上方一个会变形的小胶囊，替代弹窗提示。平时是一个小点（绿 = 代理在线，红 = 连不上）；发出消息后展开成「思考中 · 秒数」，出字后显示实时字数，写完变成打勾「字数 · 用时 · 缓存命中」，几秒后缩回小点。回复补回、体检问题、断线 / 恢复、换了模型、被截断也在这里显示，点一下收起。形状和圆角按弹簧曲线过渡（几乎不回弹），文字切换带一下模糊；除了生成中的小圆点，平时完全静止，不耗电。系统开了「减少动态效果」时直接切换。

**设置项只剩一个**：「推理」页的思考深度（自动 / 低 / 中 / 高 / 超高 / 最大 / 不思考）加「仅下一轮」。其余都自动处理：

| 以前的开关 | 现在 |
| --- | --- |
| 会话续接、深度注入保持原位、世界书移到末尾、注入并进发言、预设后置条目提前 | 默认值 + 预设自带的推荐（切预设自动套用、切走恢复）；世界书和发言后注入由代理按每个聊天的实际变化决定挪不挪 |
| 思考模式 | 并进思考深度（「不思考」）；「始终思考」在调试选项里 |
| 显示思考过程 | 跟随酒馆的「显示模型思维」 |
| 后台请求的思考深度 | 固定「低」 |
| 省电显示 | 手机和 TauriTavern 上自动开，电脑上关 |
| 体检弹出提示 | 同一类问题点掉两次就不再弹（体检页照样列出，可一键恢复） |
| 身份模式、脚本按钮并排、保存完整请求、代理地址 | 调试选项 / 状态卡 |

原来的开关都还在「更多 → 调试选项」里（默认折叠），排查问题时用。

| 面板页 | 内容 |
| --- | --- |
| 推理 | 思考深度、「仅下一轮」 |
| 统计 | 上一轮缓存命中和原因、5 小时 / 7 天额度、用量、一键把世界书设为常驻 |
| 体检 | 每条回复自动检查字数、段数（按预设的段落计划）、镜头卡、界面代码大小、禁词、破折号、人称、选项格式、重复段落；角色卡检查（未成年人物、幼态化描写，切卡时自动查）；性能自测 |
| 更多 | Mac（手机遥控）、调试选项（折叠）、使用说明 |

聊天框里输入 `/图分 1–5` 给最新一楼的配图打分（记在消息上，给逐楼报表用）。

## 省额度：让缓存生效

长对话里，大部分额度花在每轮重新读取整段聊天记录上；命中缓存时这部分只按约十分之一计费。要整段命中，需要同时满足：

1. 不用按楼层改写旧消息的正则（如「5 楼外只发摘要」）；
2. 世界书改为常驻，不按关键词触发（面板「统计」页可一键转换，会先备份）；
3. 深度注入提到系统提示词里（预设可写 `extensions.claude_max.inlineSystem: false` 自动设置）。

实测三条都满足时，缓存命中率从 46% 提高到 95%，每轮约省 43% 额度。没命中时，面板会写明原因。

做不到的时候代理会自己补救：按关键词触发、每轮变化的世界书块移到本轮消息开头（系统提示词里留一行固定说明；新聊天从第一轮起就这样做，不再先整段重写两轮来「学」），角色卡的深度 0 注入接到你的发言末尾，深度 3 以上的注入（「保持原位」模式下原本会并进旧消息、每轮挪位置）移到本轮发言前，分界点按实际发出的提示词计算，学到的规律跨代理重启保留。用真实聊天的连续楼层空跑检查（不调用模型）：两种深度注入模式下每轮都能读到约 96% 的缓存。代理重启后，CLI 会把它的环境信息补在第一轮的末尾、之后又变成中间消息，以前重启后的第二轮必定整段重写；现在把这段信息固定放在历史开头（按模型存一份在 `data/cli-context.json`，只有账号和环境信息，没有聊天内容），重启后第二轮起就能命中。缓存有效期是 1 小时（订阅走 Claude Code 的默认），两楼之间隔十几分钟也能命中。

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
| `CLAUDE_SUBSCRIPTION_PORT` | `8901` | 监听端口（改了要同步改面板状态卡或「更多 → 调试选项」里的代理地址） |
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
<summary>手机上的 TauriTavern 连 Mac 的代理（同一 Wi-Fi）</summary>

1. Mac 上菜单选「手机模式」（电脑模式 ↔ 手机模式切换）。它会生成一个访问密码，让代理接受局域网请求，并显示代理地址（`http://<Mac 的局域网 IP>:8901/v1`）和密码。
2. 手机 TauriTavern → Claude Max 面板顶部状态卡（连不上时出现）或「更多 → 调试选项 → 连接」：「代理地址」「访问密码」分别填上，点「重新连接」。用「手机同步」同步过的话已经填好。
3. Mac 首次弹出「允许 node 接受传入连接」时点允许。

手机模式下后台有一个守护进程：Mac 不空闲睡眠（`caffeinate`），代理退出后 30 秒内自动重启，Mac 断网或局域网地址变了会发通知（Mac 通知中心，以及通过 adb 连着的手机）。手机上的面板每 20 秒探测一次代理，断线时提示、连回来后提示「已恢复」。切回电脑模式时守护一起停止。

**合盖不睡**（菜单「合盖不睡」，可选）：macOS 合盖就睡，`caffeinate` 挡不住，只有 `pmset -a disablesleep 1` 可以。安装时输一次 Mac 密码，写入 `/etc/sudoers.d/claudemax-lid`，只允许免密执行 `pmset -a disablesleep 0/1` 这两条命令；之后守护在手机模式下自动打开，并在这些情况下放开（合盖就睡）并通知：用电池且电量低于 25%、低电量模式、合盖 3 小时没有请求、切回电脑模式或守护退出。守护被强杀或死机时，下次启动时恢复。可在 `launcher/config.local` 设 `LID_BATTERY_FLOOR`、`LID_IDLE_HOURS`、`LID_AWAKE=0`。思路参考 [Sleepless](https://github.com/Aboudjem/Sleepless)、[Awake](https://github.com/Koomook/awake)。合盖运行会发热，开着时别装进包里。

**手机同步**（菜单「手机同步」，需要 adb 和手机 root）：电脑 SillyTavern ↔ 手机 TauriTavern 双向同步聊天、角色卡、世界书、预设、头像、背景、生图图片、主题和快速回复；按上次同步的状态判断哪边改过，两边都改过时用较新的、另一份存进 `backups/`，从不删除文件。第三方扩展只从电脑推到手机（git 版本不同时）。设置和密钥不同步，只把手机上的代理地址改成 Mac 现在的 IP。插线时可以顺手开无线调试，之后同一 Wi-Fi 不插线也能同步。

**本机 TT 导入**（菜单「本机TT导入」）：电脑 SillyTavern → 同一台 Mac 上的 TauriTavern，一键导入聊天、角色卡、世界书、预设、图片和第三方扩展，可选连扩展设置（柏宝绘、MVU、小白X、正则、Claude Max）和当前预设一起导入。单向：TT 独有的文件保留，TT 上更新过的不覆盖，被覆盖的先备份。

**回复不会再丢**：手机上的 TauriTavern 退到后台时，系统会暂停它的网页，收到的回复可能来不及存；中途被关掉也会断在一半。现在每次请求带一个「槽位」（聊天和你那句话的哈希，不含内容），代理写完后把回复按槽位存在内存里（不落盘，最多 40 个聊天，6 小时）。对方中途断开时代理照样写完。重新打开聊天、切回 App 或连回代理时，最后一楼如果是空的、「...」或只写了一半，面板自动补回并提示。

**手机遥控 Mac**（面板「更多」页顶部，手机模式下）：看 Mac 的状态（模式、地址、电量、盖子、合盖不睡、本地生图、正在写的回复、最近的错误），按钮只有这几个：重启代理（有回复正在写时拒绝）、暂停 / 恢复合盖不睡、启动 / 关闭本地生图、从 Mac 同步这台手机（TT 会先关再开）、看日志最后几十行。走现有代理和访问密码，不能执行任意命令；每次操作记进启动器日志，并在 Mac 上弹通知。

其他设备的请求必须带访问密码（`Authorization: Bearer <密码>` 或 `X-Claude-Max-Key`），本机不需要。没开手机模式时，就算代理绑到 `0.0.0.0` 也会拒绝所有局域网请求。不要在公共 Wi-Fi 开启，密码不要外传：拿到密码的人用的是你的订阅。手动启动时对应的环境变量是 `CLAUDE_SUBSCRIPTION_HOST=0.0.0.0`、`CLAUDE_SUBSCRIPTION_LAN_KEY=<密码>`。

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

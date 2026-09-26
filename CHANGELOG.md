# 更新记录

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号规则见 [docs/版本规范.md](docs/版本规范.md)。

## 未发布

## 3.0.0 - 2026-09-26

重新整理项目结构和版本规范。**老用户要做的**：Mac 上「重启酒馆」一次（代理换了代码位置）；桌面快捷方式、`npm start`、`npm run login` 不变。

### 变更
- **改名 CCST**（Claude Code × SillyTavern）：扩展列表、面板标题、启动器、文档都改了；设置和已安装的文件夹名不变，老设置照常生效。Windows 开机启动的快捷方式改叫「CCST 启动器」，旧的也认。
- 面板和代理版本不一致时，状态卡说明哪边旧、怎么更新。
- 代码搬进 `src/`：`src/panel/`（面板）、`src/proxy/`（代理）、`src/shared/`（共用）；根目录只留入口（`manifest.json`、`package.json`、`server.js`）和文档。
- 登录工具 `scripts/claude-cli.js` → `bin/claude-cli.js`（启动脚本已跟着改；`npm run login` 不变）。
- 版本号只写在 `package.json`，`scripts/version.mjs` 同步到 `manifest.json`；代理和测试从 `package.json` 读。
- 同步脚本的 Python 测试移到 `test/launcher/`（`npm run test:py`）。

### 修复
- 缓存：换预设后，代理把固定段的分界记在新旧预设第一处不同的位置，之后 3 轮都把中间没变的几万字重写（实测 5 万字 × 3 轮）。现在系统提示词大部分换了时（新内容超过三成）当作换预设，切分点清零、从下一轮重新学。

### 新增
- 文档：[产品定位](docs/产品定位.md)、[架构](docs/架构.md)、[版本规范](docs/版本规范.md)、[参与开发](CONTRIBUTING.md)、本更新记录。

## 2.x（2026-07-01 → 2026-09-26）

独立维护期，每个次版本一次提交。主要里程碑：

- **2.29** 不用代理也能用：酒馆直连 Claude / OpenRouter 时面板照样工作；手机同步全自动，内容没变的文件不算改动。
- **2.28** 预设可以推荐模型，切预设自动换；去掉不准的「思考字数」；API 密钥模式用 1 小时缓存。
- **2.27** 「推理」页一键切 Opus 5.5 / 4.6；发送前检查也读世界书里「把思考写进正文」的条目。
- **2.26** Mac 上的 TauriTavern 可以当同步中心；两边各自往下聊的聊天保留冲突副本。
- **2.25** 角色卡标签跟手机同步；角色卡检查识别伪装和约数写法的年龄。
- **2.23** 灵动岛；**2.21–2.22** 省电显示。
- **2.20** 页面性能自检；安卓保活模块（后来独立成 tt-root-module）。
- **2.19** 代理保存每个聊天的最后一条回复，App 丢了就补回。
- **2.17–2.18** 手机模式（防睡眠、掉线自启、通知）、双向同步、手机遥控 Mac。
- **2.15** 手机 TauriTavern 通过局域网用 Mac 上的代理（访问密码）。
- **2.11–2.16** 缓存排布：每轮变化的世界书挪到当前消息，历史保持缓存；深度 0 注入并进发言；按聊天记住哪些块会变。
- **2.12** 角色卡检查（未成年、幼态化）。
- **2.9** Mac / Windows / Android（Termux）一键脚本。
- **2.0** 原作者的大改版：Fable 5、1M 上下文、思考深度、会话续接、Claude Max 面板。

## 1.x

原作者 [LukaTheHero/SillyTavern-ClaudeSubscription](https://github.com/LukaTheHero/SillyTavern-ClaudeSubscription) 的版本。

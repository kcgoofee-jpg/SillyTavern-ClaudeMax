# 参与开发

## 准备

```bash
git clone https://github.com/kcgoofee-jpg/SillyTavern-ClaudeMax
cd SillyTavern-ClaudeMax
npm install
git config core.hooksPath .githooks   # 提交 / 推送前自动跑门控
```

Node 18 以上。代理本地运行：`npm start`（默认 `127.0.0.1:8901`）；登录订阅：`npm run login`。

## 目录和约定

先读 [docs/架构.md](docs/架构.md)。要点：

- 面板在 `src/panel/`，代理在 `src/proxy/`，两边共用的纯函数在 `src/shared/`。
- 路径从 `src/proxy/paths.js` 取；面板不静态导入酒馆模块。
- 挪动面板文件时同时改 `manifest.json` 和 `src/proxy/plugin.js` 的 `UI_EXTENSION_FILES`。
- 写法跟周围代码一致：注释说明「为什么」，界面文字用中文，日志前缀 `[claude-subscription]`。

## 测试

```bash
npm test          # JS 单元测试（test/*.test.js）
npm run test:py   # 同步脚本的 Python 测试（test/launcher/）
zsh scripts/gate.sh   # 门控：测试 + 语法 + 版本一致 + 密钥扫描（提交时自动跑）
```

改了面板：在酒馆里实际点一遍（连本代理、直连 Claude 两种都看）。改了缓存或提示词排布：看代理日志里的缓存诊断，至少连续两轮。

## 版本和提交

见 [docs/版本规范.md](docs/版本规范.md)：版本号只写在 `package.json`（`npm run version -- x.y.z`），改动记在 `CHANGELOG.md` 的「未发布」，提交信息用 Conventional Commits。

## 不接受的改动

订阅共享 / 多账号轮换 / 对外服务；拒绝后自动换模型重试等规避安全机制的做法；导入或调整涉及未成年人的内容。见 [docs/产品定位.md](docs/产品定位.md) 的「不做的事」。

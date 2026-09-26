# TauriTavern 后台保活（KernelSU / Magisk 模块）

手机上的 TauriTavern 退到后台时，系统会冻结它、在内存紧张时先杀它：正在收的回复可能丢掉（Claude Max 2.19 起代理会暂存并自动补回，但 App 活着更稳）。这个模块只对 `com.tauritavern.client` 做四件 Android 自带的事：

| 做什么 | 怎么做 | 持久吗 | 卸载后 |
|---|---|---|---|
| 电池优化白名单：息屏打盹时不冻结、网络不断 | `dumpsys deviceidle whitelist +包名`，每 10 分钟核对，丢了就补（比如重装过 TT） | 持久 | `uninstall.sh` 移除 |
| 允许后台运行 | `cmd appops set 包名 RUN_IN_BACKGROUND / RUN_ANY_IN_BACKGROUND allow`，同样每 10 分钟核对 | 持久 | 还原为 default |
| 待机分组不掉下去 | 只在被系统降到「活跃」（10）以下时 `am set-standby-bucket 包名 active`；在白名单里时是 5「豁免」，不去碰 | 运行时 | 重启即恢复 |
| 后台时晚一点被杀、也不被冻结 | TT 开着时每 15 秒把 `oom_score_adj` 从 700–900 降到 250（前台时系统设的 0 不动）。Android 只冻结 900 及以上的进程（`freezer_cutoff_adj`），降下来也就不会被冻结 | 运行时 | 重启即恢复 |
| 冻结记录（只看不改） | TT 被 Android（cgroup v2 `cgroup.events` 的 `frozen 1`）或 ColorOS（`/dev/freezer/frozen`）冻结、解冻时记一行，含冻了多久 | — | — |

ColorOS / OxygenOS 还有自家的后台管控（athena）。另外到「设置 → 电池 → 应用耗电管理 → TauriTavern」打开「允许后台行为」「允许自启动」，两层一起才稳。

## 安装

1. Mac 上运行 `launcher/android/build-ksu-module.sh`，得到 `launcher/android/dist/claudemax-tt-keepalive-1.1.zip`（也可以用酒馆工具把它推到手机的「下载」文件夹）。
2. 手机：KernelSU 管理器 → 模块 → 从本地安装 → 选这个 zip → 重启。
3. 模块卡片上的「执行」按钮（`action.sh`，只读）显示 TT 当前是否在白名单、后台是否允许、待机分组、回收优先级、是否被冻结和最近的日志。

从 1.0 升级：同样「从本地安装」选新的 zip，再重启，设置不用动。

卸载：KernelSU 管理器里删除模块并重启，`uninstall.sh` 会撤掉白名单和后台运行设置。

## 安全自查（1.1）

- **范围**：只动一个包名 `com.tauritavern.client`，写死在脚本里；没装 TT 时什么都不做直接退出。
- **权限用途**：root 只用来执行上表四类命令，以及写 TT 自己进程的 `/proc/<pid>/oom_score_adj`（写之前检查是数字、只往低调、只在当前值高于 250 时写）。
- **不做的事**：不联网、不下载、不含任何可执行文件或库；没有 `system/` 目录（不覆盖系统文件）；不改 SELinux 策略；不改系统属性（`resetprop`）；不读取任何应用的数据或聊天内容；不装 LSPosed / Zygisk 钩子。
- **外部输入**：脚本不读取任何用户或网络输入，没有可被注入的变量；日志只写模块自己目录里的 `service.log`（时间和做了什么），只保留 200 行。
- **资源占用**：常驻一个 shell 循环：TT 开着时每 15 秒一次 `pidof` 和读几个 /proc、cgroup 文件，没开时每 60 秒一次；每 10 分钟核对一次白名单、后台运行和待机分组（只在不对时才改）。
- **冻结检测只读**：读 cgroup 的状态文件，不解冻、不写 freezer。
- **日志**：每次写入后超过 240 行就只留最近 200 行。
- **副作用**：TT 在后台不再被省电冻结，挂在后台时会比原来多耗一点电；如果 TT 自己在后台持续跑动画（美化界面），耗电更明显——Claude Max 的「省电渲染」设置可以降下来。
- **回滚**：删除模块并重启即可；持久的两项由 `uninstall.sh` 还原。
- 打包出的 zip 只有四个文本文件：`module.prop`、`service.sh`、`uninstall.sh`、`action.sh`，安装前可以用任何文本编辑器看一遍。

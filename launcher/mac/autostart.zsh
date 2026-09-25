#!/bin/zsh
# 登录 macOS 时由 launchd 调用：启动 Claude 代理和酒馆（已在运行则跳过）；手机模式开着时启动守护
source "${0:A:h}/lib.zsh"
banner "开机自动启动"
sleep 5   # 等网络和钥匙串就绪
start_proxy
start_st
# 手机模式开着：把守护也拉起来（防睡眠、掉线自动重启）
[[ -s "$LAN_KEY_FILE" ]] && watchdog_start && ok "手机模式守护已启动"
summary

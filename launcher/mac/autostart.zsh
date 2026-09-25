#!/bin/zsh
# 登录 macOS 时由 launchd 调用：启动 Claude 代理和酒馆（已在运行则跳过）
source "${0:A:h}/lib.zsh"
banner "开机自动启动"
sleep 5   # 等网络和钥匙串就绪
start_proxy
start_st
summary

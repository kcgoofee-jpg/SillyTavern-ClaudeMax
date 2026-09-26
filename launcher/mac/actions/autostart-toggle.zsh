#!/bin/zsh
# 开机自动启动：开 / 关切换
source "${0:A:h}/../lib.zsh"
banner "开机自动启动（开关）"
explain "开启后，每次登录 Mac 都会在后台自动启动 Claude 代理和酒馆，"
explain "适合经常用 TauriTavern、不想每次先选「启动酒馆」的情况。"
explain "两个程序空闲时几乎不占资源。随时可以在菜单里再选一次这项来关闭。"
step "当前状态"
if autostart_enabled; then
    ok "开机自动启动：已开启"
    if ask_yes "要关闭开机自动启动吗？"; then
        autostart_disable
    else
        explain "保持开启。"
    fi
else
    explain "· 开机自动启动：未开启"
    explain "开启时会马上在后台启动一次（和登录时一样；已经在运行的跳过）。"
    if ask_yes "要开启开机自动启动吗？"; then
        autostart_enable
        explain "开机后的启动记录在日志文件夹的 autostart.log 里。"
    else
        explain "保持关闭。"
    fi
fi
summary
pause_end

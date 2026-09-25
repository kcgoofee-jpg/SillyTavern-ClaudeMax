#!/bin/zsh
# 重启：先关闭再启动。更新了扩展代码、改了配置、或者遇到卡顿时用。
source "${0:A:h}/lib.zsh"
banner "重启酒馆"
explain "先关闭酒馆和 Claude 代理，再重新启动。适用于："
explain "  · 更新了代理 / 扩展代码    · 修改了酒馆设置文件    · 对话一直失败或卡住"
stop_all
self_check
if (( FAIL_COUNT > 0 )) && ! ask_yes "自检发现问题，仍然尝试启动吗？"; then
    summary; pause_end 1
fi
FAIL_COUNT=0
start_proxy
st_ok=0
start_st && st_ok=1
health_check
summary
(( st_ok )) && open "http://127.0.0.1:$ST_PORT"
pause_end

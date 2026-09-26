#!/bin/zsh
# 重启：先自检，再关闭、再启动。更新了扩展代码、改了配置、或者遇到卡顿时用。
source "${0:A:h}/lib.zsh"
banner "重启酒馆"
explain "先自检，再关闭酒馆和 Claude 代理、重新启动。适用于："
explain "  · 更新了代理 / 扩展代码    · 修改了酒馆设置文件    · 对话一直失败或卡住"
# 先自检、后关闭：自检不过又不想硬启动时，正在运行的酒馆和代理保持原样
self_check
if (( FAIL_COUNT > 0 )) && ! ask_yes "自检发现问题，仍然要重启吗？（现在运行着的会先关掉）"; then
    warn "没有重启，正在运行的保持原样。"
    summary; pause_end 1
fi
if ! confirm_proxy_idle "重启"; then
    warn "没有重启。等这条回复写完再来。"
    summary; pause_end 0
fi
stop_all
# 不把自检的错误清零：选了「仍然重启」的问题照样算进最后的结果里
spawn_st
start_proxy
st_ok=0
start_st && st_ok=1
health_check
summary
if (( st_ok )); then open "http://127.0.0.1:$ST_PORT"
elif ! st_managed && ! mac_tt_running; then mac_tt_open; fi
pause_end

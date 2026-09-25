#!/bin/zsh
# 启动酒馆：自检 → 启动 Claude 代理 → 启动酒馆 → 检查 → 打开浏览器
source "${0:A:h}/lib.zsh"
banner "启动酒馆"
explain "这个脚本会依次："
explain "  ① 自检运行环境  ② 启动 Claude 代理  ③ 启动酒馆  ④ 检查是否正常  ⑤ 打开浏览器"
explain "启动后两个程序都在后台运行，关掉这个窗口不影响使用。"

self_check
if (( FAIL_COUNT > 0 )); then
    print
    print -r -- "${C_RED}自检发现 $FAIL_COUNT 个问题，先按上面的「解决办法」处理。${C_RESET}"
    if ! ask_yes "仍然尝试启动吗？"; then
        summary; pause_end 1
    fi
    FAIL_COUNT=0
fi

start_proxy
st_ok=0
start_st && st_ok=1
health_check
summary

if ! has_st; then
    print
    print -r -- "  代理已就绪。打开 TauriTavern（或你的酒馆），在 Claude Max 面板里点「一键连接」。"
elif (( st_ok )); then
    print
    print -r -- "  正在打开浏览器：${C_BOLD}http://127.0.0.1:$ST_PORT${C_RESET}"
    print -r -- "${C_DIM}  使用 TauriTavern 的话，直接打开 TauriTavern App 即可，它会连这个代理。${C_RESET}"
    open "http://127.0.0.1:$ST_PORT"
fi
pause_end

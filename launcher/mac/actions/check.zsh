#!/bin/zsh
# 检查状态：不启动也不关闭任何东西，只做体检，并从日志里找错误原因（缺依赖时会问要不要装，不答应就不装）
source "${0:A:h}/../lib.zsh"
banner "检查状态（体检）"
explain "这个脚本只做检查，不启动也不关闭任何程序：看环境是否完整、程序有没有在运行、日志里有没有报错。"
explain "（唯一的例外：发现缺依赖时会问你要不要现在安装，答 N 就什么都不动。）"
explain "对话出问题时先运行这个，把结果截图就能看出问题在哪。"
self_check
show_running
if [[ -n "$(our_pids $PROXY_PORT)$(our_pids $ST_PORT)" ]]; then
    health_check
fi
step "日志诊断：在最近的日志里查找已知错误"
diagnose_log "$PROXY_LOG" "代理"
diagnose_log "$ST_LOG" "酒馆"
summary
print
if ask_yes "要打开日志文件夹吗？"; then
    open "$LOG_DIR"
fi
pause_end

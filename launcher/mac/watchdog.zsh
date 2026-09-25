#!/bin/zsh
# 手机模式的后台守护（由「手机模式」和开机自动启动拉起，不要直接双击）：
#   · 防止 Mac 空闲睡眠（caffeinate，随本进程退出而结束；合盖仍会睡，除非接了外接显示器和电源）
#   · 每 30 秒检查一次：代理掉了就重启并发通知；Mac 的局域网地址变了或断网也发通知
#   · 手机模式关闭（访问密码文件不在了）时自己退出
source "${0:A:h}/lib.zsh"

print $$ >"$WATCHDOG_PID_FILE"
trap 'rm -f "$WATCHDOG_PID_FILE"' EXIT
caffeinate -i -s -w $$ &!
log_event "[守护] 手机模式守护启动（防睡眠开启）"

last_ip=$(lan_ip)
fails=0
while [[ -s "$LAN_KEY_FILE" ]]; do
    sleep 30
    if [[ -z "$(our_pids $PROXY_PORT)" ]]; then
        if start_proxy >/dev/null 2>&1; then
            notify "Claude 代理已自动重启" "代理刚才退出了，已经重新启动。手机上重新发送那条消息即可。"
            fails=0
        elif (( ++fails == 1 )); then
            notify "Claude 代理启动失败" "自动重启没有成功。请在 Mac 上打开「酒馆工具」→「检查状态」。"
        fi
    fi
    ip=$(lan_ip)
    if [[ "$ip" != "$last_ip" ]]; then
        if [[ -z "$ip" ]]; then
            notify "Mac 断开了 Wi-Fi" "手机暂时连不上代理，Mac 重新连上 Wi-Fi 后会再通知。"
        else
            notify "Mac 的地址变了" "新的代理地址：http://$ip:$PROXY_PORT/v1 。手机 Claude Max 面板「高级 → 连接」里改成这个地址。"
        fi
        last_ip=$ip
    fi
done
log_event "[守护] 手机模式已关闭，守护退出"

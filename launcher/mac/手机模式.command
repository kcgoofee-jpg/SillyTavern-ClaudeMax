#!/bin/zsh
# 手机模式 / 电脑模式切换
#   手机模式：同一 Wi-Fi 下手机上的 TauriTavern 用这台 Mac 的代理（要访问密码）；
#             Mac 保持不睡眠，代理掉了自动重启，Mac 地址变了发通知（Mac 通知中心 + 已连接的手机）
#   电脑模式：代理只给这台 Mac 自己用，守护关闭，Mac 正常睡眠
source "${0:A:h}/lib.zsh"
banner "手机模式 / 电脑模式"

restart_proxy_if_idle() {
    if [[ -z "$(our_pids $PROXY_PORT)" ]]; then
        start_proxy
    elif proxy_busy; then
        warn "代理正在生成回复，这次先不重启。等这一轮写完再双击一次「手机模式」，或双击「重启酒馆」。"
    else
        stop_one $PROXY_PORT "Claude 代理"
        start_proxy
    fi
}

show_phone_setup() {
    local ip=$(lan_ip)
    step "手机上的设置"
    if [[ -z "$ip" ]]; then
        warn "没找到这台 Mac 的局域网 IP：确认 Wi-Fi 已连接。"
    else
        ok "代理地址：http://$ip:$PROXY_PORT/v1"
    fi
    print -r -- "  ${C_GREEN}✓${C_RESET} 访问密码：$(<"$LAN_KEY_FILE")"   # 只显示，不写进日志
    explain "手机 TauriTavern → 扩展 → Claude Max → 高级 → 连接：填「代理地址」和「访问密码」，点「重新连接」。"
    explain "已经用「手机同步」同步过设置的话，手机上已经填好了，不用再填。"
}

if [[ -s "$LAN_KEY_FILE" ]]; then
    step "现在是：手机模式"
    watchdog_running && ok "守护在运行：防睡眠、掉线自动重启、地址变化通知" || {
        warn "守护没在运行，现在启动"
        watchdog_start && ok "守护已启动"
    }
    show_phone_setup
    if ask_yes "要切回电脑模式吗？（手机连不上，Mac 恢复正常睡眠）"; then
        mv "$LAN_KEY_FILE" "$LAN_KEY_FILE.off"
        watchdog_stop
        restart_proxy_if_idle
        ok "已切到电脑模式。"
    fi
    summary; pause_end; exit 0
fi

step "现在是：电脑模式"
explain "切到手机模式后："
explain "· 和这台 Mac 连同一个 Wi-Fi 的手机，带上访问密码就能用你的订阅；"
explain "· Mac 不会空闲睡眠（合盖仍会睡，除非接着电源和外接显示器），代理掉了会自动重启；"
explain "· Mac 的地址变了、断网、代理重启时，Mac 和插着线或开了无线调试的手机都会收到通知。"
explain "不要在公共 Wi-Fi（咖啡店、学校、公司）开启；密码别发给别人。"
if ! ask_yes "切到手机模式吗？"; then
    warn "没有改动。"
    summary; pause_end; exit 0
fi
if [[ -s "$LAN_KEY_FILE.off" ]]; then
    mv "$LAN_KEY_FILE.off" "$LAN_KEY_FILE"
else
    (umask 077; LC_ALL=C tr -dc 'A-HJ-NP-Za-km-z2-9' </dev/urandom | head -c 20 > "$LAN_KEY_FILE")
fi
chmod 600 "$LAN_KEY_FILE"
restart_proxy_if_idle
watchdog_start && ok "守护已启动：防睡眠、掉线自动重启、地址变化通知" || warn "守护没有启动成功，看日志文件夹里的 watchdog.log"
show_phone_setup
explain "如果 Mac 弹出「是否允许 node 接受传入的网络连接」，点「允许」。"
summary
pause_end

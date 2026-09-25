#!/bin/zsh
# 开 / 关「手机连接」：让同一 Wi-Fi 下手机上的 TauriTavern 用这台 Mac 的代理（要访问密码）
source "${0:A:h}/lib.zsh"
banner "手机连接"

restart_proxy_if_idle() {
    if [[ -z "$(our_pids $PROXY_PORT)" ]]; then
        start_proxy
    elif proxy_busy; then
        warn "代理正在生成回复，这次先不重启。等这一轮写完再双击一次「手机连接」，或双击「重启酒馆」。"
    else
        stop_one $PROXY_PORT "Claude 代理"
        start_proxy
    fi
}

if [[ -s "$LAN_KEY_FILE" ]]; then
    step "手机连接现在是开启的"
    ip=$(lan_ip)
    explain "代理地址：http://${ip:-这台Mac的局域网IP}:$PROXY_PORT/v1"
    explain "访问密码：$(<"$LAN_KEY_FILE")"
    if ask_yes "要关闭手机连接吗？（只允许这台 Mac 自己用）"; then
        mv "$LAN_KEY_FILE" "$LAN_KEY_FILE.off"
        restart_proxy_if_idle
        ok "已关闭。之后其他设备都连不上这个代理。"
    fi
    summary; pause_end; exit 0
fi

step "开启手机连接"
explain "开启后，和这台 Mac 连同一个 Wi-Fi 的设备，带上访问密码就能用你的订阅。"
explain "不要在公共 Wi-Fi（咖啡店、学校、公司）开启；密码别发给别人。"
if ! ask_yes "开启吗？"; then
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

ip=$(lan_ip)
step "在手机上这样设置"
if [[ -z "$ip" ]]; then
    warn "没找到这台 Mac 的局域网 IP：确认 Wi-Fi 已连接。"
else
    ok "代理地址：http://$ip:$PROXY_PORT/v1"
fi
print -r -- "  ${C_GREEN}✓${C_RESET} 访问密码：$(<"$LAN_KEY_FILE")"   # 只显示，不写进日志
explain "1. 手机和 Mac 连同一个 Wi-Fi，Mac 上的代理保持运行（Mac 别合盖睡眠）。"
explain "2. 手机 TauriTavern → 扩展 → Claude Max → 高级 → 连接：「代理地址」填上面的地址，「访问密码」填上面的密码。"
explain "3. 点「重新连接」，然后在「API 连接」里选 Claude 模型。"
explain "如果 Mac 弹出「是否允许 node 接受传入的网络连接」，点「允许」。"
explain "Mac 的 IP 换了（换 Wi-Fi、重启路由器）时，再双击这里看新地址。"
summary
pause_end

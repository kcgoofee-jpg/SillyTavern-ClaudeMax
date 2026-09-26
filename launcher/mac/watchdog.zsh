#!/bin/zsh
# 手机模式的后台守护（由「手机模式」和开机自动启动拉起，不要直接双击）：
#   · 防止 Mac 空闲睡眠（caffeinate，随本进程退出而结束）
#   · 合盖不睡（装了「合盖不睡」才有）：打开 pmset disablesleep；电量低、低电量模式、
#     合盖后长时间没人用、手机上按了暂停、LID_AWAKE=0 时自动放开；守护退出时一定关掉
#   · 每 30 秒检查一次：代理掉了就重启并发通知；Mac 的局域网地址变了或断网也发通知
#   · 代理还只听本机（切到手机模式时它在忙、没重启）：等它空闲了重启一次，手机就能连
#   · 手机模式关闭（访问密码文件不在了）时自己退出
# 只有 TERM（「关闭酒馆」「手机模式」停守护时发的）会让它退出；INT / HUP 忽略：
# 在启动它的终端窗口里按 Ctrl-C、关窗口都不该把它带走（它本来也在自己的会话里）。
source "${0:A:h}/lib.zsh"

print $$ >"$WATCHDOG_PID_FILE"
cleanup() {
    [[ -f "$LID_OWNED_FILE" ]] && lid_set 0 && log_event "[守护] 已恢复合盖睡眠"
    [[ "$(<"$WATCHDOG_PID_FILE" 2>/dev/null)" == $$ ]] && rm -f "$WATCHDOG_PID_FILE"
}
trap cleanup EXIT
trap '' INT HUP
trap 'exit 0' TERM
caffeinate -i -s -w $$ &!
log_event "[守护] 手机模式守护启动（防空闲睡眠开启）"

# 合盖不睡：该开就开，该放就放；状态变化时才通知
lid_why=""
lid_tick() {
    lid_supported || return 0
    local why=$(lid_release_reason)
    if [[ -z "$why" ]]; then
        if ! lid_awake_on; then
            lid_set 1 && log_event "[守护] 合盖不睡：开启"
            [[ -n "$lid_why" && "$lid_why" != off ]] && notify "合盖不睡已恢复" "合上盖子 Mac 也会继续给手机提供代理。"
        fi
    elif [[ "$why" != "$lid_why" && -f "$LID_OWNED_FILE" ]]; then
        lid_set 0 && log_event "[守护] 合盖不睡：放开（$why）"
        case $why in
            off) ;;
            合盖*) notify "Mac 要睡了" "$why，Mac 马上睡眠省电，手机暂时连不上。打开盖子后自动恢复。" ;;
            手机上*) notify "合盖不睡已暂停" "现在合上盖子 Mac 会睡，手机连不上。在手机上点「恢复」就重新打开。" ;;
            *) notify "合盖会睡眠了" "$why，现在合上盖子 Mac 会睡，手机连不上。插上电源后自动恢复。" ;;
        esac
    fi
    lid_why=$why
}
lid_tick

last_ip=$(lan_ip)
fails=0
foreign_noted=""     # 端口被别的程序占着：只通知一次
rebind_failed=0      # 为了改监听范围重启过一次还不对：不再反复重启
adb_next_try=0       # adb 连手机报 No route to host 后，10 分钟内不再试
while [[ -s "$LAN_KEY_FILE" ]]; do
    sleep 30 & wait $!   # 这样 TERM 能立刻打断，不用等满 30 秒
    [[ -s "$LAN_KEY_FILE" ]] || break
    if [[ -z "$(our_pids $PROXY_PORT)" ]]; then
        owner=$(foreign_owner $PROXY_PORT)
        if [[ -n "$owner" ]]; then
            # 别的程序占着端口：重启也起不来，每 30 秒报一次「已重启」只会误导
            if [[ "$foreign_noted" != "$owner" ]]; then
                notify "Claude 代理启动不了" "端口 $PROXY_PORT 被「$owner」占着。关掉它后守护会自动启动代理。"
                log_event "[守护] 端口 $PROXY_PORT 被 $owner 占着，暂不重启代理"
                foreign_noted=$owner
            fi
        elif restart_mark_fresh; then
            :   # 有人（遥控重启、手机模式切换）刚关了代理、正在自己启动：不抢
        elif start_proxy >/dev/null 2>&1; then
            notify "Claude 代理已自动重启" "代理刚才退出了，已经重新启动。手机上重新发送那条消息即可。"
            fails=0; foreign_noted=""
        elif (( ++fails == 1 )); then
            notify "Claude 代理启动失败" "自动重启没有成功。请在 Mac 上打开「酒馆工具」→「检查状态」。"
        fi
    else
        foreign_noted=""
        scope=$(proxy_listen_scope)
        [[ "$scope" == lan ]] && rebind_failed=0
        # 手机模式开着，代理却只听本机（切换时它在忙，没能重启）：空闲时重启一次
        if [[ "$scope" == local ]] && (( ! rebind_failed )) && ! restart_mark_fresh && ! proxy_busy; then
            log_event "[守护] 代理还只接受本机连接，现在空闲，重启它以打开手机连接"
            stop_one $PROXY_PORT "Claude 代理" >/dev/null 2>&1
            if start_proxy >/dev/null 2>&1 && [[ "$(proxy_listen_scope)" == lan ]]; then
                notify "手机可以连了" "代理已重启并打开了手机连接（局域网）。"
            else
                rebind_failed=1
                notify "代理没能打开手机连接" "请在 Mac 上打开「酒馆工具」→「检查状态」。"
            fi
        fi
    fi
    ip=$(lan_ip)
    if [[ "$ip" != "$last_ip" ]]; then
        if [[ -z "$ip" ]]; then
            notify "Mac 断开了 Wi-Fi" "手机暂时连不上代理，Mac 重新连上 Wi-Fi 后会再通知。"
        else
            notify "Mac 的地址变了" "新的代理地址：http://$ip:$PROXY_PORT/v1 。手机上 Claude Max 面板顶部的状态卡（连不上时出现）里改成这个地址，或在 Mac 上跑一次「手机同步」自动改好。"
        fi
        last_ip=$ip
    fi
    lid_tick
    # 手机一台都没连着（USB 和无线调试都没有）时，按上次的无线调试地址重连（手机同步、遥控同步都靠它）。
    # No route to host = 后台的 adb 没有「本地网络」权限，30 秒试一次也没用：10 分钟后再试，「检查状态」里有修法
    if [[ -s "$PHONE_FILE" ]] && (( $(date +%s) >= adb_next_try )) && adb=$(find_adb) && [[ -z "$(phone_serial)" ]]; then
        adb_reconnect "$adb"
        (( $? == 2 )) && adb_next_try=$(( $(date +%s) + 600 ))
    fi
done
log_event "[守护] 手机模式已关闭，守护退出"

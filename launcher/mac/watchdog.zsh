#!/bin/zsh
# 手机模式的后台守护（由「手机模式」和开机自动启动拉起，不要直接双击）：
#   · 防止 Mac 空闲睡眠（caffeinate，随本进程退出而结束）
#   · 合盖不睡（装了「合盖不睡」才有）：打开 pmset disablesleep；电量低、低电量模式、
#     合盖后长时间没人用时自动放开；守护退出时一定关掉
#   · 每 30 秒检查一次：代理掉了就重启并发通知；Mac 的局域网地址变了或断网也发通知
#   · 手机模式关闭（访问密码文件不在了）时自己退出
source "${0:A:h}/lib.zsh"

print $$ >"$WATCHDOG_PID_FILE"
cleanup() {
    [[ -f "$LID_OWNED_FILE" ]] && lid_set 0 && log_event "[守护] 已恢复合盖睡眠"
    [[ "$(<"$WATCHDOG_PID_FILE" 2>/dev/null)" == $$ ]] && rm -f "$WATCHDOG_PID_FILE"
}
trap cleanup EXIT
trap 'exit 0' TERM INT HUP
caffeinate -i -s -w $$ &!
log_event "[守护] 手机模式守护启动（防空闲睡眠开启）"

# 合盖不睡：该开就开，该放就放；状态变化时才通知
lid_why=""
lid_tick() {
    lid_supported || return 0
    local why="" pct
    if [[ "$LID_AWAKE" == 0 ]]; then
        why=off
    elif on_battery; then
        pct=$(battery_pct)
        if (( pct < LID_BATTERY_FLOOR )); then
            why="电池只剩 ${pct}%（低于 ${LID_BATTERY_FLOOR}%）"
        elif low_power; then
            why="开了低电量模式"
        fi
    fi
    if [[ -z "$why" ]] && lid_closed && [[ -f "$PROXY_LOG" ]] && ! proxy_busy &&
       (( $(date +%s) - $(stat -f %m "$PROXY_LOG") > LID_IDLE_HOURS * 3600 )); then
        why="合盖后 ${LID_IDLE_HOURS} 小时没有请求"
    fi
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
            *) notify "合盖会睡眠了" "$why，现在合上盖子 Mac 会睡，手机连不上。插上电源后自动恢复。" ;;
        esac
    fi
    lid_why=$why
}
lid_tick

last_ip=$(lan_ip)
fails=0
while [[ -s "$LAN_KEY_FILE" ]]; do
    sleep 30 & wait $!   # 这样 TERM 能立刻打断，不用等满 30 秒
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
    lid_tick
done
log_event "[守护] 手机模式已关闭，守护退出"

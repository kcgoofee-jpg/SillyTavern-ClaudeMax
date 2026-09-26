#!/bin/zsh
# 手机 TauriTavern ↔ 同步中心（这台 Mac 的 TauriTavern，或电脑酒馆；config.local 的 SYNC_HUB，见 lib.zsh）双向同步：
# 聊天、角色卡、世界书、预设、图片、角色卡标签等；扩展代码只从 Mac 推出去（中心是 Mac TT 时先推给 Mac TT 再推给手机）。
# 其他设置和 API 密钥不同步；只改手机设置里的一处：Claude Max 的代理地址对准这台 Mac 的 IP，
# 手机模式开着时顺便填上 Mac 的访问密码（lan-key.local）。
# 手机用 USB 线连着（开了 USB 调试），或者之前在这里开过无线调试
source "${0:A:h}/lib.zsh"
banner "手机同步（$(hub_label) ↔ 手机）"
TT_PKG=com.tauritavern.client   # 无线调试时手机的地址在 $PHONE_FILE（lib.zsh）
HUB=$(sync_hub)
if ! why=$(hub_ready); then
    fail "$why"
    summary; pause_end 1
fi

step "找手机"
adb=$(find_adb) || {
    fail "没找到 adb（安卓调试工具）"
    fix "终端运行 brew install --cask android-platform-tools，或把 platform-tools 放到 ${PROXY_DIR:h}/tools/ 下。"
    summary; pause_end 1
}
serial=$(phone_serial)
if [[ -z "$serial" && -s "$PHONE_FILE" ]]; then
    explain "没插线，试无线调试：$(<"$PHONE_FILE")"
    adb_reconnect "$adb"
    if (( $? == 2 )); then
        # 后台（守护 / 开机启动）拉起的 adb 服务没有 macOS「本地网络」权限，连不了局域网；
        # 从这个终端窗口重新启动它就有了，之后守护也用这个服务
        explain "adb 报 No route to host：从终端重新启动 adb 服务再试（macOS 本地网络权限）"
        "$adb" kill-server >/dev/null 2>&1
        "$adb" start-server >/dev/null 2>&1
        adb_reconnect "$adb"
        (( $? == 2 )) && warn "还是 No route to host：确认手机和 Mac 在同一个 Wi-Fi；「系统设置 → 隐私与安全性 → 本地网络」里允许「终端」。"
    fi
    sleep 1
    serial=$(phone_serial)
fi
if [[ -z "$serial" ]]; then
    case "$(phone_problem)" in
        unauthorized) fail "手机连上了，但还没允许这台 Mac 调试"
                      fix "看手机屏幕：弹出「允许 USB 调试吗」时点允许（勾选始终允许），然后再选一次「手机同步」。"
                      summary; pause_end 1 ;;
        offline)      fail "手机处于离线状态（常见于锁屏或刚插线）"
                      fix "解锁手机，拔插一次 USB 线，再选一次「手机同步」。"
                      summary; pause_end 1 ;;
    esac
    fail "没连上手机"
    fix "用 USB 线连上手机，手机上打开「开发者选项 → USB 调试」，弹出「允许 USB 调试吗」时点允许（勾选始终允许）。"
    fix "手机重启过的话无线调试会失效，要插线再开一次。"
    summary; pause_end 1
fi
ok "已连接：$serial"

if [[ "$serial" != *:* ]] && ask_yes "要开启无线调试吗？（以后不插线、同一个 Wi-Fi 也能同步；手机重启后要插线再开一次）"; then
    pip=$("$adb" -s "$serial" shell ip -f inet addr show wlan0 2>/dev/null | awk '/inet /{sub(/\/.*/,"",$2); print $2; exit}')
    if [[ -n "$pip" ]] && "$adb" -s "$serial" tcpip 5555 >/dev/null 2>&1; then
        sleep 2
        "$adb" connect "$pip:5555" >/dev/null 2>&1
        # 真的连上了（adb devices 里这个地址是 device）才记下地址、才算开启
        for i in {1..5}; do
            "$adb" devices 2>/dev/null | awk -v a="$pip:5555" '$1==a && $2=="device" {f=1} END {exit !f}' && break
            sleep 1
        done
        if "$adb" devices 2>/dev/null | awk -v a="$pip:5555" '$1==a && $2=="device" {f=1} END {exit !f}'; then
            print -r -- "$pip:5555" >"$PHONE_FILE"
            rm -f "$ADB_NOROUTE_FILE"
            ok "无线调试已开启：$pip:5555（下次没插线会自动连这个地址）"
        else
            warn "手机那边打开了无线调试，但 Mac 连不上 $pip:5555：确认手机和 Mac 在同一个 Wi-Fi。这次先用 USB 线同步。"
        fi
    else
        warn "没开成：确认手机连着 Wi-Fi。"
    fi
fi

if [[ $HUB == st ]] && [[ -n "$(our_pids $ST_PORT)" ]]; then
    step "电脑上的酒馆在运行"
    explain "同步会改写聊天文件。浏览器里开着的酒馆页面可能把旧内容再存回去，先把酒馆网页都关掉（酒馆程序可以不关）。"
    ask_yes "酒馆网页都关好了吗？" || { warn "没有同步。"; summary; pause_end; }
fi

step "预览要同步的文件"
state_file=${${(@0)$(hub_sync_args)}[(r)*sync-state*]}
if [[ ! -s "$state_file" ]]; then
    explain "第一次按「$(hub_label) ↔ 手机」同步：还没有同步记录，两边不一样的文件都会列出来，按较新的一份来，"
    explain "另一份进备份；聊天记录两边各自往下聊过的，另存一份「冲突副本」，不会丢楼。以后只列真的两边都改过的。"
fi
args=("${(@0)$(hub_sync_args)}" --adb "$adb" --serial "$serial")
[[ -s "$LAN_KEY_FILE" && -n "$(lan_ip)" ]] && args+=(--mac-ip "$(lan_ip)" --lan-key-file "$LAN_KEY_FILE")
hub_update_mac_tt_ext --dry-run
python3 "$LAUNCHER_DIR/../phone_sync.py" "${args[@]}" --dry-run || { fail "读取数据失败"; summary; pause_end 1; }
tt_was=0
if [[ $HUB == tt ]] && mac_tt_running; then
    explain "Mac 上的 TauriTavern 开着：开始同步时会先让它正常退出（它开着会把旧内容存回去），同步完再打开。"
fi
if ask_yes "开始同步吗？（会先关掉手机上的 TauriTavern$([[ $HUB == tt ]] && print "和 Mac 上的 TauriTavern")，同步完可以再打开）"; then
    # 同步要先关掉手机上的 TT：它正在用、或者有一条回复还没存盘（在后台）时，关掉会丢内容
    # 判断不了（检查脚本不在、出错、读不到状态）也按「忙」处理：宁可多问一句
    if ! busy=$(phone_tt_busy_reason "$serial" "$adb"); then
        warn "手机现在不方便关 TT：$busy"
        explain "先在手机上打开 TT，等最新一楼显示完整（有回复、有图），再回来同步。"
        ask_yes "仍然要现在同步吗？（可能丢掉还没存盘的回复）" || { warn "没有同步，手机上的 TT 没动。"; summary; pause_end; }
    fi
    if [[ $HUB == tt ]] && mac_tt_running; then
        # Mac TT 可能正在写回复（经过同一个代理）：先确认，再正常退出
        confirm_proxy_idle "退出 Mac 上的 TauriTavern" || { warn "没有同步，两边的 TT 都没动。"; summary; pause_end; }
        mac_tt_quit || { fail "Mac 上的 TauriTavern 没能退出，先手动退出再同步"; summary; pause_end 1; }
        tt_was=1
        explain "已退出 Mac 上的 TauriTavern。"
    fi
    "$adb" -s "$serial" shell am force-stop $TT_PKG >/dev/null 2>&1
    explain "已关掉手机上的 TauriTavern（它开着时会把旧设置写回去）。"
    if [[ $HUB == tt ]]; then
        step "更新 Mac TT 上的扩展"
        hub_update_mac_tt_ext || warn "有扩展没更新成，看上面的说明"
    fi
    step "同步"
    if python3 "$LAUNCHER_DIR/../phone_sync.py" "${args[@]}"; then
        ok "同步完成"
        log_event "[同步] $(hub_label) ↔ 手机同步完成"
    else
        warn "有文件没同步成功，看上面的列表"
    fi
    [[ -s "$LAN_KEY_FILE" ]] || explain "现在是电脑模式：手机要连这台 Mac 的代理，先在菜单里打开「手机模式」。"
else
    warn "没有同步，手机上的 TT 没动。"
    summary; pause_end
fi
if ask_yes "打开手机上的 TauriTavern 吗？"; then
    "$adb" -s "$serial" shell monkey -p $TT_PKG -c android.intent.category.LAUNCHER 1 >/dev/null 2>&1 && ok "已打开"
fi
(( tt_was )) && mac_tt_open && ok "已重新打开 Mac 上的 TauriTavern"
summary
pause_end

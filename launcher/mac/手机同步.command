#!/bin/zsh
# 电脑酒馆 ↔ 手机 TauriTavern 双向同步：聊天、角色卡、世界书、预设、图片等（不同步设置和密钥）
# 手机用 USB 线连着（开了 USB 调试），或者之前在这里开过无线调试
source "${0:A:h}/lib.zsh"
banner "手机同步"
PHONE_FILE="$PROXY_DIR/launcher/phone.local"   # 无线调试时手机的地址
TT_PKG=com.tauritavern.client

step "找手机"
adb=$(find_adb) || {
    fail "没找到 adb（安卓调试工具）"
    fix "终端运行 brew install --cask android-platform-tools，或把 platform-tools 放到 ${PROXY_DIR:h}/tools/ 下。"
    summary; pause_end 1
}
serial=$(phone_serial)
if [[ -z "$serial" && -s "$PHONE_FILE" ]]; then
    explain "没插线，试无线调试：$(<"$PHONE_FILE")"
    "$adb" connect "$(<"$PHONE_FILE")" >/dev/null 2>&1
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
        print -r -- "$pip:5555" >"$PHONE_FILE"
        ok "无线调试已开启：$pip:5555（下次没插线会自动连这个地址）"
    else
        warn "没开成：确认手机连着 Wi-Fi。"
    fi
fi

if has_st && [[ -n "$(our_pids $ST_PORT)" ]]; then
    step "电脑上的酒馆在运行"
    explain "同步会改写聊天文件。浏览器里开着的酒馆页面可能把旧内容再存回去，先把酒馆网页都关掉（酒馆程序可以不关）。"
    ask_yes "酒馆网页都关好了吗？" || { warn "没有同步。"; summary; pause_end; }
fi

step "预览要同步的文件"
# 同步要先关掉手机上的 TT：它正在用、或者有一条回复还没存盘（在后台）时，关掉会丢内容
busy=$(python3 "${PROXY_DIR:h}/scripts/apply_settings.py" --why-busy 2>/dev/null)
if [[ -n "$busy" ]]; then
    warn "手机现在不方便关 TT：$busy"
    explain "先在手机上打开 TT，等最新一楼显示完整（有回复、有图），再回来同步。"
    ask_yes "仍然要现在同步吗？（可能丢掉还没存盘的回复）" || { warn "没有同步。"; summary; pause_end; }
fi
"$adb" -s "$serial" shell am force-stop $TT_PKG >/dev/null 2>&1
explain "已先关掉手机上的 TauriTavern（它开着时会把旧设置写回去）。"
args=(--st "$ST_DIR/data/default-user" --adb "$adb" --serial "$serial"
      --state "$PROXY_DIR/launcher/phone-sync-state.local.json" --backups "${PROXY_DIR:h}/backups" --port $PROXY_PORT
      --ext-dir "$ST_DIR/public/scripts/extensions/third-party")
[[ -s "$LAN_KEY_FILE" && -n "$(lan_ip)" ]] && args+=(--mac-ip "$(lan_ip)" --lan-key-file "$LAN_KEY_FILE")
python3 "$LAUNCHER_DIR/../phone_sync.py" "${args[@]}" --dry-run || { fail "读取手机数据失败"; summary; pause_end 1; }
if ask_yes "开始同步吗？"; then
    step "同步"
    if python3 "$LAUNCHER_DIR/../phone_sync.py" "${args[@]}"; then
        ok "同步完成"
        log_event "[同步] 电脑 ↔ 手机同步完成"
    else
        warn "有文件没同步成功，看上面的列表"
    fi
    [[ -s "$LAN_KEY_FILE" ]] || explain "现在是电脑模式：手机要连这台 Mac 的代理，先在菜单里打开「手机模式」。"
else
    warn "没有同步。"
fi
if ask_yes "打开手机上的 TauriTavern 吗？"; then
    "$adb" -s "$serial" shell monkey -p $TT_PKG -c android.intent.category.LAUNCHER 1 >/dev/null 2>&1 && ok "已打开"
fi
summary
pause_end

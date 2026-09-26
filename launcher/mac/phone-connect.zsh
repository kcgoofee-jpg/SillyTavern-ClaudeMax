#!/bin/zsh
# 给「同步手机」（launcher/phone.mjs）找手机：USB 优先，没插线就按上次的无线调试地址连；
# 插着线、还没开过无线调试时顺手开（以后同一 Wi-Fi 不插线也能同步）。
# 说明打在标准错误（用户看得到），结果打在标准输出，一行一个「键<TAB>值」：ADB、SERIAL、MAC_IP（手机模式开着时）。
# 找不到手机就退出码 1。从不运行 adb kill-server：TT 守护的自动拉备份每分钟都在用 adb。
source "${0:A:h}/lib.zsh"
{
adb=$(find_adb) || {
    fail "没找到 adb（安卓调试工具）"
    fix "终端运行 brew install --cask android-platform-tools，或把 platform-tools 放到 ${PROXY_DIR:h}/tools/ 下。"
    exit 1
}
serial=$(phone_serial)
if [[ -z "$serial" && -s "$PHONE_FILE" ]]; then
    explain "没插线，试无线调试：$(<"$PHONE_FILE")"
    adb_reconnect "$adb"
    if (( $? == 2 )); then
        warn "adb 报 No route to host：确认手机和 Mac 在同一个 Wi-Fi；「系统设置 → 隐私与安全性 → 本地网络」里允许「终端」。"
        fix "还不行就插一次 USB 线。"
    fi
    sleep 1
    serial=$(phone_serial)
fi
if [[ -z "$serial" ]]; then
    case "$(phone_problem)" in
        unauthorized) fail "手机连上了，但还没允许这台 Mac 调试"
                      fix "看手机屏幕：弹出「允许 USB 调试吗」时点允许（勾选始终允许），然后再同步一次。"
                      exit 1 ;;
        offline)      fail "手机处于离线状态（常见于锁屏或刚插线）"
                      fix "解锁手机，拔插一次 USB 线，再同步一次。"
                      exit 1 ;;
    esac
    fail "没连上手机"
    fix "用 USB 线连上手机，手机上打开「开发者选项 → USB 调试」，弹出「允许 USB 调试吗」时点允许（勾选始终允许）。"
    fix "手机重启过的话无线调试会失效，要插线再开一次。"
    exit 1
fi
ok "已连接：$serial"

if [[ "$serial" != *:* ]] && { [[ ! -s "$PHONE_FILE" ]] || ! "$adb" devices 2>/dev/null | grep -q "^$(<"$PHONE_FILE")[[:space:]]*device"; }; then
    explain "顺手开启无线调试（以后不插线、同一个 Wi-Fi 也能同步；手机重启后要插线再开一次）"
    pip=$("$adb" -s "$serial" shell ip -f inet addr show wlan0 2>/dev/null | awk '/inet /{sub(/\/.*/,"",$2); print $2; exit}')
    if [[ -n "$pip" ]] && "$adb" -s "$serial" tcpip 5555 >/dev/null 2>&1; then
        sleep 2
        "$adb" connect "$pip:5555" >/dev/null 2>&1
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
        warn "没开成无线调试：确认手机连着 Wi-Fi。"
    fi
fi
} >&2
print -r -- "ADB	$adb"
print -r -- "SERIAL	$serial"
[[ -s "$LAN_KEY_FILE" ]] && ip=$(lan_ip) && [[ -n "$ip" ]] && print -r -- "MAC_IP	$ip"
exit 0

#!/bin/zsh
# 给菜单（launcher/core.mjs 的 readState）用：只打印这台 Mac 特有、Node 不好跨系统查的状态，一行一个「键<TAB>值」。
# 代理状态、版本、装了什么、端口、上次同步都由 core.mjs 自己查（Mac / Windows / Termux 同一份）。
source "${0:A:h}/lib.zsh" >/dev/null 2>&1

kv() { print -r -- "$1	$2"; }

kv mactt_running "$(mac_tt_running && print 1 || print 0)"
kv watchdog "$(watchdog_running && print 1 || print 0)"
kv lid_installed "$([[ -e "$LID_SUDOERS" ]] && print 1 || print 0)"
kv lid_on "$(lid_awake_on 2>/dev/null && print 1 || print 0)"
kv ip "$(lan_ip)"
kv adb_noroute "$([[ -f "$ADB_NOROUTE_FILE" ]] && print 1 || print 0)"
kv mode_mismatch "$(proxy_mode_mismatch)"

phone=none
if adb=$(find_adb 2>/dev/null); then
    devs=$("$adb" devices 2>/dev/null)
    serial=$(print -r -- "$devs" | pick_serial)
    if [[ -n "$serial" ]]; then
        [[ "$serial" == *:* ]] && phone=wifi || phone=usb
    elif [[ "$devs" == *unauthorized* ]]; then
        phone=unauthorized
    fi
else
    phone=noadb
fi
kv phone "$phone"
kv adb "$adb"
kv serial "$serial"
exit 0

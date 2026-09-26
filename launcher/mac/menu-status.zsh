#!/bin/zsh
# 给菜单（launcher/menu.mjs）用：打印这台 Mac 上菜单要知道的状态，一行一个「键<TAB>值」。
# 代理本身的状态菜单直接问代理（HTTP），这里只给代理不知道的：手机连接、同步、这台机器有什么。
source "${0:A:h}/lib.zsh" >/dev/null 2>&1

kv() { print -r -- "$1	$2"; }

kv hub "$(sync_hub)"
kv hub_label "$(hub_label)"
kv st_managed "$(st_managed && print 1 || print 0)"
kv has_st "$(has_st && print 1 || print 0)"
kv st_running "$([[ -n "$(our_pids $ST_PORT)" ]] && print 1 || print 0)"
kv proxy_pid "$([[ -n "$(our_pids $PROXY_PORT)" ]] && print 1 || print 0)"
kv has_tt "$([[ -d /Applications/TauriTavern.app ]] && print 1 || print 0)"
kv mactt_running "$(mac_tt_running && print 1 || print 0)"
kv phone_mode "$([[ -s "$LAN_KEY_FILE" ]] && print 1 || print 0)"
kv watchdog "$(watchdog_running && print 1 || print 0)"
kv lid_installed "$([[ -e "$LID_SUDOERS" ]] && print 1 || print 0)"
kv lid_on "$(lid_awake_on 2>/dev/null && print 1 || print 0)"
kv ip "$(lan_ip)"
kv has_comfy "$(has_comfy && print 1 || print 0)"
kv comfy_running "$([[ -d "$COMFY_DIR" && -n "$(our_pids $COMFY_PORT)" ]] && print 1 || print 0)"
kv has_module "$([[ -f "${TT_MODULE_DIR:-${PROXY_DIR:h}/tt-root-module}/build-ksu-module.sh" ]] && print 1 || print 0)"
kv can_tt_import "$({ has_st && [[ -d "$MAC_TT_DATA/default-user" ]]; } && print 1 || print 0)"
kv autostart "$(autostart_enabled && print 1 || print 0)"

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
sync_file="$PROXY_DIR/launcher/phone-sync-state$([[ "$(sync_hub)" == tt ]] && print -- -tt).local.json"
[[ -s "$sync_file" ]] && kv last_sync "$(stat -f '%Sm' -t '%m-%d %H:%M' "$sync_file")"
exit 0

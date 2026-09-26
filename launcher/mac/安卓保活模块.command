#!/bin/zsh
# 手机 TauriTavern 后台保活（KernelSU / Magisk 模块）：打包 → 放进手机「下载」→ 你在 KernelSU 管理器里装；
# 装好后在这里看它的状态（只读）。模块本身的说明和安全自查见 launcher/android/README.md
source "${0:A:h}/lib.zsh"
banner "安卓保活模块"
ANDROID="$LAUNCHER_DIR/../android"
MOD_ID=claudemax_tt_keepalive

step "打包"
zip_path=$(/bin/zsh "$ANDROID/build-ksu-module.sh" 2>&1 | tail -1)
[[ -f "$zip_path" ]] || { fail "没打包成：$zip_path"; summary; pause_end 1; }
ver=$(sed -n 's/^version=//p' "$ANDROID/ksu-tt-keepalive/module.prop")
ok "${zip_path:t}（版本 $ver，只有 4 个文本文件，不联网、不含程序）"

step "找手机"
adb=$(find_adb) || { fail "没找到 adb"; fix "先用「手机同步」把手机连上一次。"; summary; pause_end 1; }
serial=$(phone_serial)
if [[ -z "$serial" && -s "$PROXY_DIR/launcher/phone.local" ]]; then
    "$adb" connect "$(<"$PROXY_DIR/launcher/phone.local")" >/dev/null 2>&1; sleep 1; serial=$(phone_serial)
fi
[[ -n "$serial" ]] || { fail "没连上手机"; fix "插上 USB 线（或先用「手机同步」开无线调试），再选一次这一项。"; summary; pause_end 1; }
ok "已连接：$serial"

step "手机上现在的状态"
installed=$("$adb" -s "$serial" shell "su -c 'grep ^version= /data/adb/modules/$MOD_ID/module.prop 2>/dev/null'" 2>/dev/null | tr -d '\r')
installed=${installed#version=}
if [[ -n "$installed" ]]; then
    ok "已安装：版本 $installed"
    "$adb" -s "$serial" shell "su -c 'sh /data/adb/modules/$MOD_ID/action.sh'" 2>/dev/null | tr -d '\r' | sed 's/^/     /'
else
    explain "还没安装（或手机没有 root）。"
fi

if [[ "$installed" == "$ver" ]]; then
    ok "手机上已经是最新版本，不用再装。"
    summary; pause_end
fi

step "放进手机的「下载」文件夹"
if "$adb" -s "$serial" push "$zip_path" /sdcard/Download/ >/dev/null 2>&1; then
    ok "已放好：下载/${zip_path:t}"
else
    fail "没放进去"; summary; pause_end 1
fi
step "接下来在手机上操作（root 安装要你自己点）"
explain "1. 打开 KernelSU 管理器 →「模块」→「从本地安装」→ 选「下载」里的 ${zip_path:t}"
explain "2. 装完点「重启」。旧版本会被直接覆盖，设置不用动。"
explain "3. 重启后再选一次这一项，就能看到它在不在工作。"
explain "另外到「设置 → 电池 → 应用耗电管理 → TauriTavern」打开「允许后台行为」（ColorOS 自己的管控，模块管不到）。"
summary
pause_end

#!/bin/zsh
# 手机 TauriTavern 后台保活（KernelSU / Magisk 模块）：打包 → 放进手机「下载」→ 你在 KernelSU 管理器里装；
# 装好后在这里看它的状态（只读），拷回手机上的日志和崩溃记录，用模块仓库的 pc/pull-backups.sh 同步备份
# （可开启每 30 分钟自动同步），还可以选一份备份恢复（恢复前模块会先保存当前数据；不会替你强制停止 TT）。
# 电脑上的备份放在 ${PROXY_DIR:h}/phone-backups/tt（config.local 里 TT_PHONE_BACKUP_DIR 可改），按 14 天 / 8 周 / 24 个月保留。
# 模块在单独的仓库里开发（默认和本仓库同级的 tt-root-module，可在 launcher/config.local 里写
# TT_MODULE_DIR="目录" 改），说明和安全自查见那里的 README.md；这里只负责打包、推送和看状态。
source "${0:A:h}/../lib.zsh"
banner "安卓保活模块"
MODULE_REPO=${TT_MODULE_DIR:-${PROXY_DIR:h}/tt-root-module}
MOD_ID=claudemax_tt_keepalive
MOD=/data/adb/modules/$MOD_ID
MAC_BK=${TT_PHONE_BACKUP_DIR:-${PROXY_DIR:h}/phone-backups/tt}

step "打包"
[[ -f "$MODULE_REPO/build-ksu-module.sh" ]] || {
    fail "找不到模块仓库：$MODULE_REPO"
    fix "git clone https://github.com/kcgoofee-jpg/tt-root-module 到酒馆扩展的同级目录，或在 launcher/config.local 里写 TT_MODULE_DIR=\"模块仓库目录\"。"
    summary; pause_end 1
}
zip_path=$(/bin/zsh "$MODULE_REPO/build-ksu-module.sh" 2>&1 | tail -1)
[[ -f "$zip_path" ]] || { fail "没打包成：$zip_path"; summary; pause_end 1; }
ver=$(sed -n 's/^version=//p' "$MODULE_REPO/ksu-tt-keepalive/module.prop")
ok "${zip_path:t}（版本 $ver，只有几个文本脚本，不联网、不含程序）"

step "找手机"
adb=$(find_adb) || {
    fail "没找到 adb（安卓调试工具）"
    fix "终端运行 brew install --cask android-platform-tools，或把 platform-tools 放到 ${PROXY_DIR:h}/tools/ 下。"
    summary; pause_end 1
}
serial=$(phone_serial)
if [[ -z "$serial" && -s "$PHONE_FILE" ]]; then
    adb_reconnect "$adb"
    (( $? == 2 )) && explain "adb 报 No route to host：先选一次「手机同步」（它会从终端重启 adb），再来这里。"
    sleep 1; serial=$(phone_serial)
fi
[[ -n "$serial" ]] || { fail "没连上手机"; fix "插上 USB 线（或先用「手机同步」开无线调试），再选一次这一项。"; summary; pause_end 1; }
ok "已连接：$serial"

step "手机上现在的状态"
installed=$("$adb" -s "$serial" shell "su -c 'grep ^version= /data/adb/modules/$MOD_ID/module.prop 2>/dev/null'" 2>/dev/null | tr -d '\r')
installed=${installed#version=}
if [[ -n "$installed" ]]; then
    ok "已安装：版本 $installed"
    "$adb" -s "$serial" shell "su -c 'sh /data/adb/modules/$MOD_ID/action.sh'" 2>/dev/null | tr -d '\r' | sed 's/^/     /'
    # 把手机上的日志、统计和崩溃记录存一份到模块仓库的 logs/（不进 git），方便在电脑上看
    logdir="$MODULE_REPO/logs/$(date +%Y%m%d-%H%M%S)"; mkdir -p "$logdir"
    for f in service.log stats.txt; do
        "$adb" -s "$serial" shell "su -c 'cat $MOD/$f'" 2>/dev/null | tr -d '\r' > "$logdir/$f"
        [[ -s "$logdir/$f" ]] || rm -f "$logdir/$f"
    done
    "$adb" -s "$serial" exec-out "su -c 'cd $MOD && [ -d crash ] && tar -cf - crash'" 2>/dev/null | tar -xf - -C "$logdir" 2>/dev/null
    rmdir "$logdir" 2>/dev/null || ok "日志存到了 ${logdir/#$HOME/~}"
    [[ -d "$logdir/crash" ]] && explain "里面有 TT 的崩溃记录（crash 文件夹）。"

    step "同步备份到电脑"
    if [[ -f "$MODULE_REPO/pc/pull-backups.sh" ]] && [[ -n "$("$adb" -s "$serial" shell "su -c '[ -f $MOD/ui.sh ] && echo y'" 2>/dev/null | tr -d '\r')" ]]; then
        ADB="$adb" zsh "$MODULE_REPO/pc/pull-backups.sh" 2>&1 | sed 's/^/     /'
        case ${pipestatus[1]} in
            0) ok "已同步到 ${MAC_BK/#$HOME/~}" ;;
            2) explain "未同步：未连接手机或模块版本低于 1.6" ;;
            *) fail "同步未完成，详见 ${MAC_BK/#$HOME/~}/pull.log" ;;
        esac
        if ! launchctl print "gui/$(id -u)/com.ttguard.pull-backups" >/dev/null 2>&1; then
            explain "自动同步未开启（开启后每 30 分钟同步一次，连接手机时生效）。"
            if [[ -t 0 ]] && ask_yes "开启自动同步？"; then
                zsh "$MODULE_REPO/pc/install-mac.sh" 2>&1 | sed 's/^/     /'
            fi
        fi
    else
        explain "手机上的模块版本低于 1.6，安装新版后可同步。"
    fi
    backups=(${(f)"$("$adb" -s "$serial" shell "su -c 'sh $MOD/ui.sh list-backups 2>/dev/null'" 2>/dev/null | tr -d '\r' | awk '$1 ~ /^tt-default-user-.*\.tar\.gz$/ { print $1 }')"})

    if [[ -t 0 ]] && (( ${#backups} > 0 )) && [[ -n "$("$adb" -s "$serial" shell "su -c '[ -f $MOD/restore.sh ] && echo y'" 2>/dev/null | tr -d '\r')" ]]; then
        step "从备份恢复（不需要就直接回车）"
        explain "手机上的备份（新的在前）："
        for i in {1..${#backups}}; do print -r -- "     $i  ${backups[$i]}"; done
        print -n -- "  要恢复就输入编号，直接回车跳过："
        read -r pick
        if [[ "$pick" == <-> ]] && (( pick >= 1 && pick <= ${#backups} )); then
            b=${backups[$pick]}
            explain "将用 $b 覆盖同名的聊天、角色卡、世界书、设置和扩展；之后新建的内容不删除；不影响 API 密钥。"
            explain "恢复前自动保存当前数据（-prerestore）。"
            if ask_yes "确定恢复 $b？"; then
                tries=0
                while [[ -n "$("$adb" -s "$serial" shell pidof com.tauritavern.client 2>/dev/null | tr -d '\r')" ]] && (( tries < 3 )); do
                    explain "请先在手机的最近任务中关闭 TauriTavern，然后按回车。"
                    read -r _; (( tries++ ))
                done
                out=$("$adb" -s "$serial" shell "su -c 'sh $MOD/restore.sh $b'; echo rc=\$?" 2>&1 | tr -d '\r')
                print -r -- "$out" | grep -v '^rc=' | sed 's/^/     /'
                if [[ "$out" == *"rc=0"* ]]; then
                    ok "恢复完成"
                else
                    fail "未恢复（原因见上）"
                fi
            fi
        elif [[ -n "$pick" ]]; then
            explain "没有这个编号，跳过恢复。"
        fi
    fi
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

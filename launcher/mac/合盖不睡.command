#!/bin/zsh
# 合盖不睡：手机模式下合上 MacBook 盖子也继续给手机提供代理
#   macOS 合盖就睡，caffeinate 挡不住；唯一的开关是 pmset disablesleep，需要管理员权限。
#   这里装一条 sudoers 规则，只允许免密执行「pmset -a disablesleep 0/1」这两条命令，
#   之后由手机模式的守护自动开关，不用每次输密码。卸载就是删掉这条规则。
source "${0:A:h}/lib.zsh"
banner "合盖不睡"

show_state() {
    step "现在的状态"
    if lid_supported; then ok "已安装（免密开关 pmset disablesleep）"; else explain "未安装"; fi
    if lid_awake_on; then ok "合盖不睡：开着"; else explain "合盖不睡：关着（合盖会睡）"; fi
    [[ -s "$LAN_KEY_FILE" ]] && explain "手机模式：开" || explain "手机模式：关（合盖不睡只在手机模式下生效）"
    explain "自动放开：用电池且电量低于 ${LID_BATTERY_FLOOR}%、低电量模式、合盖后 ${LID_IDLE_HOURS} 小时没有请求、手机上暂停了、"
    explain "  config.local 里写了 LID_AWAKE=0、守护没在运行（切回电脑模式、关闭酒馆时守护会停）。"
    explain "（在 launcher/config.local 里写 LID_BATTERY_FLOOR=… / LID_IDLE_HOURS=… / LID_AWAKE=0 可改）"
}
show_state

if lid_supported; then
    if ask_yes "要卸载吗？（需要输入 Mac 登录密码；卸载后合盖就会睡）"; then
        sudo /usr/bin/pmset -a disablesleep 0 && rm -f "$LID_OWNED_FILE"
        if sudo /bin/rm -f "$LID_SUDOERS"; then ok "已卸载，合盖恢复正常睡眠"; else fail "卸载没有成功"; fi
    else
        warn "没有改动。"
    fi
    summary; pause_end; exit 0
fi

step "安装前请知道"
explain "· 合盖运行会发热、耗电：尽量插电，放在通风的桌面上，${C_RESET}${C_BOLD}开着时不要装进包里${C_RESET}${C_DIM}。"
explain "· 只在手机模式下开启；切回电脑模式、关闭酒馆、守护退出时自动关掉。"
explain "· 电量低于 ${LID_BATTERY_FLOOR}%、开了低电量模式、合盖 ${LID_IDLE_HOURS} 小时没人用、手机上按了暂停、"
explain "  config.local 里写了 LID_AWAKE=0 时自动放开，Mac 会睡，并通知手机；守护没在运行时也不会开。"
explain "· 需要输入一次 Mac 登录密码，写入 $LID_SUDOERS（只允许 pmset -a disablesleep 0/1 这两条命令免密）。"
if ! ask_yes "安装吗？"; then
    warn "没有改动。"
    summary; pause_end; exit 0
fi

tmp=$(mktemp)
print -r -- "$USER ALL=(root) NOPASSWD: /usr/bin/pmset -a disablesleep 0, /usr/bin/pmset -a disablesleep 1" >"$tmp"
if sudo /usr/sbin/visudo -cf "$tmp" >/dev/null && sudo /usr/bin/install -m 0440 -o root -g wheel "$tmp" "$LID_SUDOERS"; then
    ok "已安装"
    if [[ -s "$LAN_KEY_FILE" ]]; then
        if watchdog_running || watchdog_start; then
            explain "守护 30 秒内会打开合盖不睡。"
        else
            warn "手机模式开着，但守护没有启动成功，合盖不睡暂时不会打开"
            fix "看日志文件夹里的 watchdog.log，再选一次「手机模式」。"
        fi
    else
        explain "切到手机模式后自动生效。"
    fi
else
    fail "安装没有成功（密码不对或被取消），没有改动"
fi
rm -f "$tmp"
summary
pause_end

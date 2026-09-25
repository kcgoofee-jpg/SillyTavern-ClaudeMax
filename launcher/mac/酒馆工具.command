#!/bin/zsh
# 酒馆工具：所有启动 / 关闭 / 检查 / 小工具放在一个菜单里，输入编号回车
source "${0:A:h}/lib.zsh"
HERE=${0:A:h}
[[ "$LANG" == *UTF-8* ]] || export LANG=zh_CN.UTF-8   # 对齐按显示宽度算，需要 UTF-8 区域设置

# 分组|脚本名|一句话说明（编号按这里的顺序）
ITEMS=(
    "日常|启动酒馆|启动代理和酒馆，打开浏览器"
    "日常|关闭酒馆|关闭酒馆和代理"
    "日常|重启酒馆|更新代码、改设置、一直出错时用"
    "日常|检查状态|只检查不改动：运行、登录、日志错误"
    "手机|手机模式|电脑模式 ↔ 手机模式（防睡眠、掉线重启、通知）"
    "手机|手机同步|电脑 ↔ 手机双向同步聊天、角色、世界书、预设"
    "手机|本机TT导入|电脑酒馆 → 这台 Mac 的 TauriTavern（内容、扩展、设置）"
    "手机|合盖不睡|装 / 卸：手机模式下合上盖子也不睡（一次性输密码）"
    "生图|启动生图|本地 ComfyUI（用 NovelAI 时不需要）"
    "生图|关闭生图|关闭本地 ComfyUI"
    "生图|提示词拆分|读 NAI 原图，拆成柏宝绘的画师串和质量词"
    "生图|导入柏宝绘配方|把拆分工具导出的配方写进柏宝绘"
    "维护|登录 Claude|打开浏览器登录 Claude 订阅"
    "维护|修复依赖|启动报「缺少依赖」时重装程序库"
    "维护|打开日志|打开日志文件夹"
    "维护|开机自动启动|开 / 关：登录 Mac 时自动在后台启动"
)

running() { [[ -n "$(our_pids $1)" ]] && print -n "${C_GREEN}运行中${C_RESET}" || print -n "${C_DIM}未运行${C_RESET}"; }

# 按显示宽度补空格（中文占两格）
pad() {
    local s=$1 w=$2 n=${(m)#1}
    print -rn -- "$s"
    (( w > n )) && printf '%*s' $(( w - n )) ''
    return 0
}

item_no() {   # 脚本名 → 编号
    local i
    for i in {1..${#ITEMS}}; do [[ "${${(@s:|:)ITEMS[$i]}[2]}" == "$1" ]] && { print $i; return; }; done
}

status_lines() {
    local line="${C_BOLD}酒馆工具${C_RESET}   代理 $(running $PROXY_PORT)"
    has_st && line+="  ·  酒馆 $(running $ST_PORT)"
    [[ -d "$COMFY_DIR" && -n "$(our_pids $COMFY_PORT)" ]] && line+="  ·  生图 ${C_GREEN}运行中${C_RESET}"
    print -r -- "$line"
    local mode serial adb ip sync_file="$PROXY_DIR/launcher/phone-sync-state.local.json"
    if [[ -s "$LAN_KEY_FILE" ]]; then
        ip=$(lan_ip)
        mode="${C_GREEN}手机模式${C_RESET}"
        watchdog_running && { mode+="（守护中"; lid_awake_on && mode+="，合盖不睡"; mode+="）"; } || mode+="${C_YELLOW}（守护没在运行：选 $(item_no 手机模式) 修复）${C_RESET}"
        mode+="  ·  Mac ${ip:-${C_YELLOW}没连 Wi-Fi${C_RESET}}"
    else
        mode="电脑模式"
    fi
    if adb=$(find_adb); then
        serial=$(phone_serial)
        if [[ -n "$serial" ]]; then
            [[ "$serial" == *:* ]] && mode+="  ·  手机 ${C_GREEN}无线已连${C_RESET}" || mode+="  ·  手机 ${C_GREEN}USB 已连${C_RESET}"
        elif "$adb" devices 2>/dev/null | grep -q "unauthorized"; then
            mode+="  ·  手机 ${C_YELLOW}待授权：手机上点「允许」${C_RESET}"
        fi
    fi
    [[ -s "$sync_file" ]] && mode+="  ·  上次同步 $(stat -f '%Sm' -t '%m-%d %H:%M' "$sync_file")"
    print -r -- "  $mode"
}

msg=""
while true; do
    clear 2>/dev/null
    status_lines
    group=""
    for i in {1..${#ITEMS}}; do
        parts=("${(@s:|:)ITEMS[$i]}")
        if [[ "${parts[1]}" != "$group" ]]; then
            group=${parts[1]}
            print
            print -r -- "  ${C_DIM}${group}${C_RESET}"
        fi
        print -r -- "  $(printf '%2d' $i)  $(pad "${parts[2]}" 16)${C_DIM}${parts[3]}${C_RESET}"
    done
    print
    print -r -- "   h  使用说明      q  退出"
    [[ -n "$msg" ]] && { print; print -r -- "  ${C_YELLOW}${msg}${C_RESET}"; msg=""; }
    print
    print -n -- "输入编号回车："
    read -r choice || { print; close_terminal_window; exit 0; }   # 输入结束（Ctrl-D）
    choice=${${choice##[[:space:]]#}%%[[:space:]]#}
    case "$choice" in
        '') continue ;;                      # 误按回车：只刷新，不退出
        q|Q) close_terminal_window; exit 0 ;;
        h|H) open "$HERE/../使用说明.txt" 2>/dev/null || msg="没找到使用说明（launcher/使用说明.txt）"; continue ;;
        <->)
            if (( choice >= 1 && choice <= ${#ITEMS} )); then
                parts=("${(@s:|:)ITEMS[$choice]}")
                if [[ -f "$HERE/${parts[2]}.command" ]]; then
                    CM_MENU=1 /bin/zsh "$HERE/${parts[2]}.command"
                else
                    msg="找不到「${parts[2]}」脚本，可能被移动或删除了。"
                fi
            else
                msg="没有第 $choice 项，请输入 1–${#ITEMS}、h 或 q。"
            fi
            ;;
        *) msg="「$choice」不是编号，请输入 1–${#ITEMS}、h 或 q。" ;;
    esac
done

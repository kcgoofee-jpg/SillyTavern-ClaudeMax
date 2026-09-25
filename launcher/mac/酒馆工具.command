#!/bin/zsh
# 酒馆工具：所有启动 / 关闭 / 检查 / 小工具放在一个菜单里，输入编号回车
source "${0:A:h}/lib.zsh"
HERE=${0:A:h}

ITEMS=(
    "启动酒馆|启动代理和酒馆，打开浏览器"
    "关闭酒馆|关闭酒馆和代理"
    "重启酒馆|先关再开：更新代码、改设置、一直出错时用"
    "检查状态|只检查不改动：运行状态、登录、日志里的错误"
    "登录 Claude|打开浏览器登录 Claude 订阅"
    "修复依赖|启动报「缺少依赖」时重装程序库"
    "打开日志|打开日志文件夹"
    "开机自动启动|开 / 关：登录 Mac 时自动在后台启动"
    "手机模式|电脑模式 ↔ 手机模式：手机 TT 走 Wi-Fi 用这台 Mac（防睡眠、掉线自动重启、通知）"
    "手机同步|电脑酒馆 ↔ 手机 TT 双向同步聊天、角色、世界书、预设（USB 或无线）"
    "启动生图|启动本地 ComfyUI（用 NovelAI 时不需要）"
    "关闭生图|关闭本地 ComfyUI"
    "提示词拆分|读 NAI 原图 / 拆提示词给柏宝绘"
    "导入柏宝绘配方|把拆分工具导出的配方写进柏宝绘"
)

running() { [[ -n "$(our_pids $1)" ]] && print -n "${C_GREEN}运行中${C_RESET}" || print -n "${C_DIM}未运行${C_RESET}"; }

while true; do
    clear
    print -r -- "${C_BOLD}酒馆工具${C_RESET}   代理 $(running $PROXY_PORT)$( [[ -n "$ST_DIR" ]] && print -n "  ·  酒馆 $(running $ST_PORT)")  ·  $( [[ -s "$LAN_KEY_FILE" ]] && print -n "${C_GREEN}手机模式${C_RESET}$(watchdog_running && print -n "（守护中）")" || print -n "电脑模式")"
    print
    for i in {1..${#ITEMS}}; do
        print -r -- "  $(printf '%2d' $i)  ${ITEMS[$i]%%|*}${C_DIM}  —  ${ITEMS[$i]#*|}${C_RESET}"
    done
    print
    print -r -- "   h  使用说明      q  退出"
    print
    print -n -- "输入编号回车："
    read -r choice
    case "$choice" in
        q|Q|'') close_terminal_window; exit 0 ;;
        h|H) open "$HERE/../使用说明.txt" 2>/dev/null || warn "没找到使用说明"; continue ;;
        <->)
            if (( choice >= 1 && choice <= ${#ITEMS} )); then
                name=${ITEMS[$choice]%%|*}
                CM_MENU=1 /bin/zsh "$HERE/$name.command"
            fi
            ;;
    esac
done

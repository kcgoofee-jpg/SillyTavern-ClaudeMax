# ──────────────────────────────────────────────
# Claude Max 启动器 · macOS 公共函数
# 被同目录的 .command 脚本引用，不要直接双击这个文件。
#
# 路径自动识别：
#   代理目录 = 本仓库根目录
#   酒馆目录 = 仓库装在 SillyTavern/plugins/ 下时取上两级；
#              否则找仓库旁边的 SillyTavern 文件夹；都没有就只管理代理（TauriTavern 用户）
# 想手动指定，在 launcher/config.local 里写（该文件不会被提交）：
#   ST_DIR="/path/to/SillyTavern"   LOG_DIR="/path/to/logs"   ST_PORT=8000   PROXY_PORT=8901
# ──────────────────────────────────────────────

export PATH="/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"

LAUNCHER_DIR=${${(%):-%x}:A:h}
PROXY_DIR=${LAUNCHER_DIR:h:h}
ST_DIR=""
LOG_DIR="$PROXY_DIR/data/logs"
ST_PORT=8000
PROXY_PORT=8901
COMFY_DIR="${PROXY_DIR:h}/ComfyUI"   # 可选：本地生图（ComfyUI），没装就忽略
COMFY_PORT=8188
LAN_KEY_FILE="$PROXY_DIR/launcher/lan-key.local"   # 有这个文件 = 手机连接（局域网访问）已开启
[[ -f "$PROXY_DIR/launcher/config.local" ]] && source "$PROXY_DIR/launcher/config.local"
if [[ -z "$ST_DIR" ]]; then
    if [[ ${PROXY_DIR:h:t} == plugins && -f ${PROXY_DIR:h:h}/server.js ]]; then
        ST_DIR=${PROXY_DIR:h:h}
    elif [[ -f ${PROXY_DIR:h}/SillyTavern/server.js ]]; then
        ST_DIR=${PROXY_DIR:h}/SillyTavern
    fi
fi
ST_LOG="$LOG_DIR/sillytavern.log"
COMFY_LOG="$LOG_DIR/comfyui.log"
PROXY_LOG="$LOG_DIR/proxy.log"
LAUNCHER_LOG="$LOG_DIR/launcher.log"
LOG_MAX_BYTES=$((5 * 1024 * 1024))

mkdir -p "$LOG_DIR"

# ── 输出 ─────────────────────────────────────

if [[ -t 1 ]]; then
    C_RESET=$'\e[0m'; C_BOLD=$'\e[1m'; C_DIM=$'\e[2m'
    C_GREEN=$'\e[32m'; C_YELLOW=$'\e[33m'; C_RED=$'\e[31m'; C_CYAN=$'\e[36m'
else
    C_RESET=; C_BOLD=; C_DIM=; C_GREEN=; C_YELLOW=; C_RED=; C_CYAN=
fi

plan_name() {
    case $1 in
        max) print "Max" ;; pro) print "Pro" ;; team) print "Team" ;; enterprise) print "Enterprise" ;;
        "") print "未知" ;; *) print "$1" ;;
    esac
}

WARN_COUNT=0
FAIL_COUNT=0

log_event() {
    print -r -- "$(date '+%Y-%m-%d %H:%M:%S') $*" >>"$LAUNCHER_LOG"
}

banner() {
    print
    print -r -- "${C_BOLD}${C_CYAN}════════════════════════════════════════════${C_RESET}"
    print -r -- "${C_BOLD}  $1${C_RESET}"
    print -r -- "${C_BOLD}${C_CYAN}════════════════════════════════════════════${C_RESET}"
    log_event "===== $1 ====="
}

step() {
    print
    print -r -- "${C_BOLD}▶ $1${C_RESET}"
    log_event "[步骤] $1"
}

explain() { print -r -- "${C_DIM}  $*${C_RESET}"; }
ok()      { print -r -- "  ${C_GREEN}✓${C_RESET} $*"; log_event "[正常] $*"; }
warn()    { print -r -- "  ${C_YELLOW}!${C_RESET} $*"; log_event "[提醒] $*"; (( WARN_COUNT++ )); }
fail()    { print -r -- "  ${C_RED}✗${C_RESET} $*"; log_event "[错误] $*"; (( FAIL_COUNT++ )); }
fix()     { print -r -- "    ${C_YELLOW}解决办法：${C_RESET}$*"; }

ask_yes() {
    # ask_yes "问题" → 输入 y 返回 0，其他返回 1
    print -n -- "  ${C_BOLD}$1 (y/N) ${C_RESET}"
    local ans
    read -r ans
    [[ "$ans" == [yY]* ]]
}

pause_end() {
    # 按任意键后关闭这个终端窗口，并结束脚本
    local code=${1:-0}
    if [[ ! -t 0 ]]; then
        exit $code
    fi
    print
    if [[ -n "$CM_MENU" ]]; then
        # 从「酒馆工具」菜单进来的：回到菜单，不关窗口
        print -n -- "${C_BOLD}按任意键回到菜单…${C_RESET}"
        read -k 1 -s
        print
        exit $code
    fi
    print -n -- "${C_BOLD}按任意键关闭窗口…${C_RESET}"
    read -k 1 -s
    print
    close_terminal_window
    exit $code
}

close_terminal_window() {
    # 脚本退出后，由后台的 AppleScript 关掉当前这个 Terminal 窗口。
    # 等脚本先退出再关，Terminal 就不会弹出「是否终止进程」的确认框。
    [[ -n "$CM_MENU" ]] && return   # 菜单里运行时窗口留给菜单
    local my_tty=$(tty 2>/dev/null)
    [[ "$TERM_PROGRAM" == "Apple_Terminal" && "$my_tty" == /dev/* ]] || return
    (
        sleep 0.4
        osascript \
            -e 'on run argv' \
            -e '  tell application "Terminal"' \
            -e '    repeat with w in windows' \
            -e '      repeat with t in tabs of w' \
            -e '        if tty of t is (item 1 of argv) then' \
            -e '          close w' \
            -e '          return' \
            -e '        end if' \
            -e '      end repeat' \
            -e '    end repeat' \
            -e '  end tell' \
            -e 'end run' \
            "$my_tty" >/dev/null 2>&1
    ) &!
}

# ── 日志 ─────────────────────────────────────

rotate_log() {
    # 单个日志超过 5MB 时改名为 .old，只保留一份旧日志
    local file=$1 size
    [[ -f "$file" ]] || return
    size=$(stat -f%z "$file" 2>/dev/null || echo 0)
    if (( size > LOG_MAX_BYTES )); then
        mv -f "$file" "$file.old"
        log_event "[日志] $(basename "$file") 超过 5MB，已归档为 .old"
    fi
}

mark_log() {
    # 在程序日志里写一条分隔线，方便区分每次启动
    print -r -- "" >>"$1"
    print -r -- "──────── $(date '+%Y-%m-%d %H:%M:%S') 由酒馆工具箱启动 ────────" >>"$1"
}

# 在日志末尾查找已知错误，用中文解释原因和解决办法
diagnose_log() {
    local file=$1 label=$2 tail_text found=0
    [[ -f "$file" ]] || { explain "（还没有 $label 日志）"; return; }
    # 只看这次启动以来的日志，并且只看最后一次成功回复之后的：之前的错误已经过去了
    # （额度查询接口偶尔返回 429，只影响面板上的额度显示，不算对话出错）
    tail_text=$(tail -n 2000 "$file" | awk '/由酒馆工具箱启动/ {buf = ""; next} /\] ✓ / {buf = ""; next} {buf = buf $0 "\n"} END {printf "%s", buf}' | tail -n 300 | grep -v "quota endpoint")

    _diag() {
        local pattern=$1 reason=$2 remedy=$3
        if print -r -- "$tail_text" | grep -qiE "$pattern"; then
            fail "$label：$reason"
            fix "$remedy"
            found=1
        fi
    }

    _diag 'EADDRINUSE|address already in use' \
        "端口被占用，程序无法监听" \
        "先双击「关闭酒馆」，再双击「启动酒馆」；如果还不行，重启电脑。"
    _diag 'ERR_MODULE_NOT_FOUND|Cannot find module|Cannot find package' \
        "缺少依赖文件（node_modules 不完整）" \
        "双击「修复依赖」重新安装。"
    _diag 'Native CLI binary|claude-agent-sdk-darwin' \
        "找不到 Claude 命令行程序（SDK 安装不完整）" \
        "双击「修复依赖」重新安装。"
    _diag 'Not logged in|Please run /login|authentication_failed|invalid_token|token has expired' \
        "Claude 订阅未登录或登录已失效" \
        "双击「登录 Claude」重新登录。"
    _diag 'rate.limit|(^|[^0-9.,k])429([^0-9.,k]|$)|Too many requests' \
        "触发了订阅额度限流（请求太频繁或额度用完）" \
        "稍等几分钟再试；在酒馆的 Claude Max 面板里可以看到额度重置时间。"
    _diag 'Extra Usage|out of extra usage' \
        "1M 上下文需要额外用量，当前套餐不可用" \
        "改用不带「(1M context)」的模型。"
    _diag 'YAMLException|config\.yaml.*(error|invalid|fail)|(error|fail).*config\.yaml' \
        "酒馆配置文件 config.yaml 格式有误" \
        "检查 $ST_DIR/config.yaml 最近的改动。"

    if (( found == 0 )); then
        explain "$label 日志里没有发现已知错误。最后几行："
        tail -n 8 "$file" | sed "s/^/    ${C_DIM}│${C_RESET} /"
    fi
}

# ── 进程 / 端口 ───────────────────────────────

port_pids() {
    lsof -nP -iTCP:$1 -sTCP:LISTEN -t 2>/dev/null
}

# 监听该端口、且工作目录是代理或酒馆目录的进程（只动我们自己的程序）
our_pids() {
    local pid cwd
    for pid in $(port_pids $1); do
        cwd=$(lsof -a -p $pid -d cwd -Fn 2>/dev/null | sed -n 's/^n//p')
        [[ "$cwd" == "$PROXY_DIR"* || ( -n "$ST_DIR" && "$cwd" == "$ST_DIR"* ) || "$cwd" == "$COMFY_DIR"* ]] && print $pid
    done
}

has_st() { [[ -n "$ST_DIR" ]]; }

foreign_owner() {
    # 端口被别的程序占着时，返回该程序名
    local pid
    for pid in $(port_pids $1); do
        [[ -n "$(our_pids $1 | grep -x $pid)" ]] && continue
        ps -o comm= -p $pid 2>/dev/null | xargs basename
        return
    done
}

port_busy() { [[ -n "$(port_pids $1)" ]]; }

wait_port() {
    local port=$1 secs=$2 i
    for ((i = 0; i < secs; i++)); do
        port_busy $port && return 0
        sleep 1
        (( i > 0 && i % 10 == 0 )) && explain "已等待 ${i} 秒…"
    done
    return 1
}

# ── 自检 ─────────────────────────────────────

self_check() {
    step "自检：确认运行环境是否完整"
    explain "逐项检查 Node.js、程序文件、依赖、登录状态和端口，发现问题会告诉你怎么处理。"

    # 1. Node.js
    if ! command -v node >/dev/null; then
        fail "没有找到 Node.js（酒馆和代理都靠它运行）"
        fix "到 https://nodejs.org 下载安装 LTS 版本，装好后重新双击本脚本。"
        return
    fi
    local nv=$(node -v) major
    major=${${nv#v}%%.*}
    if (( major < 18 )); then
        fail "Node.js 版本太旧：$nv（需要 18 或更高）"
        fix "到 https://nodejs.org 安装新版 LTS。"
    else
        ok "Node.js $nv"
    fi

    # 2. 程序文件
    if has_st; then
        [[ -f "$ST_DIR/server.js" ]] && ok "酒馆程序：$ST_DIR" \
            || { fail "找不到酒馆程序（$ST_DIR/server.js）"; fix "检查 launcher/config.local 里的 ST_DIR。"; }
    else
        explain "· 没有找到酒馆目录，只管理 Claude 代理（TauriTavern 用户不需要酒馆）"
        explain "  需要一起启动酒馆的话，在 launcher/config.local 里写 ST_DIR=\"酒馆目录\""
    fi
    ok "Claude 代理程序：$PROXY_DIR"

    # 3. 依赖
    has_st && check_deps "$ST_DIR" "酒馆"
    check_deps "$PROXY_DIR" "Claude 代理"

    # 4. Claude CLI（随 SDK 一起安装）
    if (cd "$PROXY_DIR" && node -e "require.resolve('@anthropic-ai/claude-agent-sdk-'+process.platform+'-'+process.arch+'/package.json')" >/dev/null 2>&1); then
        ok "Claude 命令行程序（SDK 自带）"
    else
        fail "缺少 Claude 命令行程序（SDK 的平台包没装上）"
        fix "双击「修复依赖」重新安装。"
    fi

    # 5. 登录状态
    check_login

    # 6. 酒馆服务器插件开关
    if ! has_st; then
        :
    elif grep -qE '^enableServerPlugins:[[:space:]]*true' "$ST_DIR/config.yaml" 2>/dev/null; then
        ok "酒馆已开启服务器插件（酒馆页面也能读取额度和状态）"
    else
        warn "酒馆 config.yaml 里没有开启 enableServerPlugins"
        explain "  不影响对话（代理是独立启动的），只是酒馆页面会直接连代理读取状态。"
    fi

    # 7. 端口
    has_st && check_port $ST_PORT "酒馆"
    check_port $PROXY_PORT "Claude 代理"
}

check_deps() {
    local dir=$1 name=$2
    if [[ -d "$dir/node_modules" ]]; then
        ok "$name 依赖已安装"
        return
    fi
    fail "$name 缺少依赖（没有 node_modules 文件夹）"
    if ask_yes "现在自动安装 $name 的依赖吗？需要联网，约 1 分钟"; then
        print -r -- "${C_DIM}"
        if (cd "$dir" && npm install --no-audit --no-fund 2>&1 | tail -n 5); then
            print -r -- "${C_RESET}"
            ok "$name 依赖安装完成"
            (( FAIL_COUNT-- ))
        else
            print -r -- "${C_RESET}"
            fail "$name 依赖安装失败"
            fix "检查网络后重试，或在终端进入 $dir 运行 npm install 查看详细报错。"
        fi
    else
        fix "在终端进入 $dir 运行 npm install。"
    fi
}

check_login() {
    local json logged plan
    json=$(cd "$PROXY_DIR" && node scripts/claude-cli.js auth status 2>/dev/null)
    logged=$(print -r -- "$json" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{const j=JSON.parse(s);console.log(j.loggedIn?'yes':'no', j.subscriptionType||'')}catch{console.log('unknown')}})" 2>/dev/null)
    plan=${logged#* }
    case ${logged%% *} in
        yes) ok "Claude 订阅已登录（$(plan_name "$plan") 套餐）" ;;
        no)
            warn "Claude 订阅还没有登录 —— 酒馆能打开，但发消息会失败"
            fix "双击「登录 Claude」，在浏览器里完成授权。"
            ;;
        *)
            warn "无法读取 Claude 登录状态"
            explain "  可能是代理依赖不完整，先处理上面的错误。"
            ;;
    esac
}

check_port() {
    local port=$1 name=$2 owner
    if ! port_busy $port; then
        ok "端口 $port 空闲（留给$name）"
    elif [[ -n "$(our_pids $port)" ]]; then
        ok "$name 已经在运行（端口 $port）"
    else
        owner=$(foreign_owner $port)
        fail "端口 $port 被其他程序占用：${owner:-未知程序}"
        fix "关闭「${owner:-该程序}」后再试，或重启电脑。"
    fi
}

# ── 手机连接（局域网） ─────────────────────────

lan_ip() {
    local ip
    for ifc in en0 en1 en2; do
        ip=$(ipconfig getifaddr $ifc 2>/dev/null) && [[ -n "$ip" ]] && { print $ip; return; }
    done
}

# 代理在忙（正在生成回复）时不重启
proxy_busy() {
    local pid
    for pid in $(our_pids $PROXY_PORT); do
        [[ -n "$(pgrep -P $pid)" ]] && return 0
    done
    return 1
}

# ── 通知 / 手机（adb） ─────────────────────────

# adb：PATH 里的、Android Studio 的、或放在酒馆目录 tools/platform-tools 下的
find_adb() {
    local p
    for p in "$(command -v adb 2>/dev/null)" "$HOME/Library/Android/sdk/platform-tools/adb" "${PROXY_DIR:h}/tools/platform-tools/adb"; do
        [[ -n "$p" && -x "$p" ]] && { print -r -- "$p"; return 0; }
    done
    return 1
}

# 已连接（USB 或无线调试）且已授权的手机序列号，没有就空
phone_serial() {
    local adb; adb=$(find_adb) || return 1
    # USB 优先（同一台手机开了无线调试会出现两次）
    "$adb" devices 2>/dev/null | awk 'NR>1 && $2=="device" { if ($1 ~ /:/) w = w ? w : $1; else { print $1; found = 1; exit } } END { if (!found && w) print w }'
}

# 连着但没授权 / 离线的手机（给出具体提示用）
phone_problem() {
    local adb; adb=$(find_adb) || return 1
    "$adb" devices 2>/dev/null | awk 'NR>1 && ($2=="unauthorized" || $2=="offline") {print $2; exit}'
}

# Mac 通知中心 + 已连接手机的通知栏
notify() {
    local title=$1 msg=$2 adb serial
    osascript -e "display notification \"${msg//\"/\\\"}\" with title \"${title//\"/\\\"}\"" >/dev/null 2>&1
    log_event "[通知] $title：$msg"
    serial=$(phone_serial) || return 0
    [[ -z "$serial" ]] && return 0
    adb=$(find_adb)
    "$adb" -s "$serial" shell "cmd notification post -S bigtext -t '${title//\'/}' claudemax '${msg//\'/}'" >/dev/null 2>&1
}

# ── 手机模式：防睡眠 + 掉线自动重启 + 地址变化通知 ─────

WATCHDOG_PID_FILE="$PROXY_DIR/launcher/watchdog.pid.local"

watchdog_running() {
    [[ -s "$WATCHDOG_PID_FILE" ]] && kill -0 "$(<"$WATCHDOG_PID_FILE")" 2>/dev/null
}

watchdog_start() {
    watchdog_running && return 0
    nohup /bin/zsh "$LAUNCHER_DIR/watchdog.zsh" >>"$LOG_DIR/watchdog.log" 2>&1 &!
    sleep 1
    watchdog_running
}

watchdog_stop() {
    local pid i
    if watchdog_running; then
        pid=$(<"$WATCHDOG_PID_FILE")
        kill $pid 2>/dev/null
        for i in {1..10}; do kill -0 $pid 2>/dev/null || break; sleep 0.3; done
    fi
    rm -f "$WATCHDOG_PID_FILE"
    lid_cleanup_stale
}

# ── 合盖不睡（可选，手机模式下由守护开关） ─────────────
# 合盖睡眠不受 caffeinate 管，只有 pmset 的 disablesleep 能挡。它要 root，
# 所以「合盖不睡」工具装一条只允许这两条命令免密的 sudoers 规则；没装就不启用。
# 守护在这些情况下自动放开（合盖就会睡）：用电池且电量低于 LID_BATTERY_FLOOR、
# 低电量模式、合盖且代理 LID_IDLE_HOURS 小时没有请求、手机模式关闭、守护退出。
LID_SUDOERS=/etc/sudoers.d/claudemax-lid
LID_OWNED_FILE="$PROXY_DIR/launcher/lid-awake.local"   # 有 = 这个开关是我们打开的
LID_PAUSE_FILE="$PROXY_DIR/launcher/lid-pause.local"   # 有 = 手机上按了「暂停合盖不睡」
: ${LID_BATTERY_FLOOR:=25}
: ${LID_IDLE_HOURS:=3}

lid_supported() { sudo -n -l /usr/bin/pmset -a disablesleep 1 >/dev/null 2>&1; }
lid_awake_on()  { [[ "$(pmset -g | awk '/SleepDisabled/ {print $2}')" == 1 ]]; }
lid_closed()    { ioreg -r -k AppleClamshellState -d 1 | grep -q '"AppleClamshellState" = Yes'; }
on_battery()    { pmset -g batt | head -1 | grep -q "Battery Power"; }
battery_pct()   { pmset -g batt | grep -o '[0-9]*%' | head -1 | tr -d %; }
low_power()     { [[ "$(pmset -g | awk '/lowpowermode/ {print $2}')" == 1 ]]; }

lid_set() {   # lid_set 1|0
    sudo -n /usr/bin/pmset -a disablesleep $1 >/dev/null 2>&1 || return 1
    if (( $1 )); then : >"$LID_OWNED_FILE"; else rm -f "$LID_OWNED_FILE"; fi
}

# 手机遥控「同步」：不问问题直接双向同步（关掉手机上的 TT → 同步 → 再打开），结果发通知
phone_sync_auto() {
    local adb serial args out
    adb=$(find_adb) || { notify "手机同步没做成" "Mac 上找不到 adb"; return 1; }
    serial=$(phone_serial)
    if [[ -z "$serial" && -s "$PROXY_DIR/launcher/phone.local" ]]; then
        "$adb" connect "$(<"$PROXY_DIR/launcher/phone.local")" >/dev/null 2>&1; sleep 1; serial=$(phone_serial)
    fi
    [[ -n "$serial" ]] || { notify "手机同步没做成" "Mac 连不上手机的无线调试"; return 1; }
    has_st || { notify "手机同步没做成" "Mac 上没有酒馆数据"; return 1; }
    "$adb" -s "$serial" shell am force-stop com.tauritavern.client >/dev/null 2>&1
    args=(--st "$ST_DIR/data/default-user" --adb "$adb" --serial "$serial"
          --state "$PROXY_DIR/launcher/phone-sync-state.local.json" --backups "${PROXY_DIR:h}/backups" --port $PROXY_PORT
          --ext-dir "$ST_DIR/public/scripts/extensions/third-party")
    [[ -s "$LAN_KEY_FILE" && -n "$(lan_ip)" ]] && args+=(--mac-ip "$(lan_ip)" --lan-key-file "$LAN_KEY_FILE")
    out=$(python3 "$LAUNCHER_DIR/../phone_sync.py" "${args[@]}" 2>&1 | grep '✓ 同步完成\|✗' | head -2)
    log_event "[同步] 手机遥控触发：${out//$'\n'/；}"
    "$adb" -s "$serial" shell monkey -p com.tauritavern.client -c android.intent.category.LAUNCHER 1 >/dev/null 2>&1
    notify "手机同步完成" "${out:-已同步}"
}

# 守护被强杀、死机重启后，我们打开的开关可能还开着：没有守护在跑就关掉
lid_cleanup_stale() {
    [[ -f "$LID_OWNED_FILE" ]] || return 0
    watchdog_running && return 0
    lid_awake_on && lid_set 0 && log_event "[守护] 守护不在运行，已恢复合盖睡眠"
    rm -f "$LID_OWNED_FILE"
}

# ── 启动 / 关闭 ───────────────────────────────

start_proxy() {
    step "启动 Claude 代理（端口 $PROXY_PORT）"
    explain "代理负责把酒馆 / TauriTavern 的请求转给 Claude，走你的订阅额度。"
    if [[ -n "$(our_pids $PROXY_PORT)" ]]; then
        ok "代理已经在运行，跳过"
        return 0
    fi
    rotate_log "$PROXY_LOG"
    mark_log "$PROXY_LOG"
    if [[ -s "$LAN_KEY_FILE" ]]; then
        explain "手机连接已开启：同一 Wi-Fi 下的设备带访问密码可以连这个代理。"
        (cd "$PROXY_DIR" && CLAUDE_SUBSCRIPTION_HOST=0.0.0.0 CLAUDE_SUBSCRIPTION_LAN_KEY="$(<"$LAN_KEY_FILE")" nohup node server.js >>"$PROXY_LOG" 2>&1 &!)
    else
        (cd "$PROXY_DIR" && nohup node server.js >>"$PROXY_LOG" 2>&1 &!)
    fi
    if wait_port $PROXY_PORT 20; then
        ok "代理已启动：http://127.0.0.1:$PROXY_PORT/v1"
        [[ -s "$LAN_KEY_FILE" ]] && watchdog_start && ok "手机模式守护在运行：防睡眠、掉线自动重启"
        return 0
    fi
    fail "代理 20 秒内没有启动成功"
    diagnose_log "$PROXY_LOG" "代理"
    return 1
}

start_st() {
    has_st || return 1
    step "启动酒馆（端口 $ST_PORT）"
    explain "首次启动或更新后需要编译前端，可能要 10–60 秒，请耐心等待。"
    if [[ -n "$(our_pids $ST_PORT)" ]]; then
        ok "酒馆已经在运行，跳过"
        return 0
    fi
    rotate_log "$ST_LOG"
    mark_log "$ST_LOG"
    (cd "$ST_DIR" && nohup node server.js >>"$ST_LOG" 2>&1 &!)
    if wait_port $ST_PORT 120; then
        ok "酒馆已启动：http://127.0.0.1:$ST_PORT"
        return 0
    fi
    fail "酒馆 120 秒内没有启动成功"
    diagnose_log "$ST_LOG" "酒馆"
    return 1
}

stop_one() {
    local port=$1 name=$2 pids i
    pids=($(our_pids $port))
    if (( ${#pids} == 0 )); then
        ok "$name 本来就没有运行"
        return
    fi
    kill $pids 2>/dev/null
    for ((i = 0; i < 10; i++)); do
        sleep 1
        pids=($(our_pids $port))
        if (( ${#pids} == 0 )); then
            ok "已关闭$name"
            return
        fi
    done
    kill -9 $pids 2>/dev/null
    sleep 1
    if [[ -z "$(our_pids $port)" ]]; then
        warn "$name 没有正常退出，已强制关闭"
    else
        fail "$name 无法关闭（进程 $pids）"
        fix "重启电脑即可。"
    fi
}

stop_all() {
    step "关闭酒馆和 Claude 代理"
    explain "关闭后 TauriTavern 也会连不上代理，直到下次启动。"
    watchdog_running && { watchdog_stop; ok "手机模式守护已停止（下次启动时自动恢复）"; }
    has_st && stop_one $ST_PORT "酒馆"
    stop_one $PROXY_PORT "Claude 代理"
}

# ── 启动后检查 ────────────────────────────────

health_check() {
    step "启动后检查：确认服务真的能用"
    local body parsed code

    body=$(curl -s --max-time 5 "http://127.0.0.1:$PROXY_PORT/status")
    if [[ -z "$body" ]]; then
        fail "代理没有响应"
        diagnose_log "$PROXY_LOG" "代理"
    else
        parsed=$(print -r -- "$body" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{const j=JSON.parse(s);const c=j.credential||{};console.log([j.ok?'ok':'bad',j.version,c.present?'yes':'no',c.subscriptionType||'',c.source||''].join(' '))}catch{console.log('bad')}})")
        local -a f=(${=parsed})
        if [[ "${f[1]}" != ok ]]; then
            fail "代理有响应，但报告异常（SDK 未加载）"
            diagnose_log "$PROXY_LOG" "代理"
        elif [[ "${f[3]}" == yes ]]; then
            ok "代理正常（v${f[2]}，$(plan_name "${f[4]}") 订阅，凭据来自${${f[5]/keychain/钥匙串}/file/凭据文件}）"
            local repo_v=$(node -p "require('$PROXY_DIR/package.json').version" 2>/dev/null)
            if [[ -n "$repo_v" && "${f[2]}" != "$repo_v" ]]; then
                warn "代理还在跑旧版本 v${f[2]}，程序已经更新到 v$repo_v"
                fix "没在生成回复时双击「重启酒馆」（手机模式下代理会自动重启，手机不用动）。"
            fi
        else
            warn "代理正常，但没有找到 Claude 登录凭据"
            fix "双击「登录 Claude」。"
        fi
    fi

    has_st || return 0
    if [[ -z "$(our_pids $ST_PORT)" ]]; then
        explain "· 酒馆没在运行，不检查网页（只用 TauriTavern 的话不需要它）"
        return 0
    fi
    code=$(curl -s -o /dev/null --max-time 5 -w '%{http_code}' "http://127.0.0.1:$ST_PORT/")
    case $code in
        200|302|401) ok "酒馆网页可以打开（HTTP $code）" ;;
        000) fail "酒馆网页打不开（没有响应）"; diagnose_log "$ST_LOG" "酒馆" ;;
        *) warn "酒馆网页返回 HTTP $code，可能还在加载中，稍后刷新试试" ;;
    esac
}

show_running() {
    step "当前运行状态"
    if has_st; then
        if [[ -n "$(our_pids $ST_PORT)" ]]; then ok "酒馆：运行中 → http://127.0.0.1:$ST_PORT"
        else explain "· 酒馆：未运行"; fi
    fi
    if [[ -n "$(our_pids $PROXY_PORT)" ]]; then ok "Claude 代理：运行中 → http://127.0.0.1:$PROXY_PORT/v1"
    else explain "· Claude 代理：未运行（TauriTavern 需要它才能对话）"; fi
    if [[ -s "$LAN_KEY_FILE" ]]; then
        if watchdog_running; then ok "手机模式守护：运行中"; else warn "手机模式开着，但守护没在运行：双击「手机模式」修复"; fi
        if lid_awake_on; then ok "合盖不睡：开着"
        elif lid_supported; then explain "· 合盖不睡：已安装，暂时放开（电量低 / 低电量模式 / 长时间没请求）"
        else explain "· 合盖不睡：未安装（合盖会睡，手机连不上）"; fi
    fi
    lid_awake_on && [[ ! -s "$LAN_KEY_FILE" ]] && warn "合盖不睡开着，但手机模式是关的：合盖不会睡，注意发热耗电"
}

summary() {
    print
    print -r -- "${C_BOLD}──────── 结果 ────────${C_RESET}"
    if (( FAIL_COUNT > 0 )); then
        print -r -- "  ${C_RED}有 $FAIL_COUNT 个问题需要处理${C_RESET}，见上面标 ✗ 的项目和「解决办法」。"
    elif (( WARN_COUNT > 0 )); then
        print -r -- "  ${C_YELLOW}可以使用，但有 $WARN_COUNT 条提醒${C_RESET}，见上面标 ! 的项目。"
    else
        print -r -- "  ${C_GREEN}一切正常。${C_RESET}"
    fi
    print -r -- "  日志文件夹：$LOG_DIR"
    print -r -- "${C_DIM}    launcher.log = 本工具箱的操作记录 · proxy.log = 代理 · sillytavern.log = 酒馆${C_RESET}"
    log_event "结果：错误 $FAIL_COUNT，提醒 $WARN_COUNT"
}

# ── 修复依赖 ─────────────────────────────────

reinstall_deps() {
    local dir=$1 name=$2
    step "重新安装$name的依赖"
    explain "目录：$dir"
    if (cd "$dir" && npm install --no-audit --no-fund 2>&1 | tee -a "$LAUNCHER_LOG" | tail -n 6 | sed "s/^/    ${C_DIM}│${C_RESET} /"; exit ${pipestatus[1]}); then
        ok "$name依赖安装完成"
    else
        fail "$name依赖安装失败"
        fix "检查网络连接后再双击一次；详细输出在 launcher.log 里。"
    fi
}

# ── 开机自动启动（LaunchAgent）──────────────────

AUTOSTART_LABEL="com.claudemax.autostart"
AUTOSTART_PLIST="$HOME/Library/LaunchAgents/$AUTOSTART_LABEL.plist"

autostart_enabled() { [[ -f "$AUTOSTART_PLIST" ]]; }

autostart_enable() {
    mkdir -p "$HOME/Library/LaunchAgents"
    /bin/cat >"$AUTOSTART_PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key><string>$AUTOSTART_LABEL</string>
    <key>ProgramArguments</key>
    <array>
        <string>/bin/zsh</string>
        <string>$LAUNCHER_DIR/autostart.zsh</string>
    </array>
    <key>RunAtLoad</key><true/>
    <!-- 脚本本身很快结束；它启动的酒馆和代理要继续运行，不能被一起结束 -->
    <key>AbandonProcessGroup</key><true/>
    <key>StandardOutPath</key><string>$LOG_DIR/autostart.log</string>
    <key>StandardErrorPath</key><string>$LOG_DIR/autostart.log</string>
</dict>
</plist>
PLIST
    launchctl bootout "gui/$UID/$AUTOSTART_LABEL" >/dev/null 2>&1
    if launchctl bootstrap "gui/$UID" "$AUTOSTART_PLIST" 2>/dev/null; then
        ok "已开启：以后登录 Mac 时会自动启动 Claude 代理${ST_DIR:+和酒馆}"
    else
        fail "写入了启动项，但系统没有接受"
        fix "打开「系统设置 → 通用 → 登录项」，确认允许 zsh 在后台运行。"
    fi
}

autostart_disable() {
    launchctl bootout "gui/$UID/$AUTOSTART_LABEL" >/dev/null 2>&1
    rm -f "$AUTOSTART_PLIST"
    ok "已关闭开机自动启动（现在正在运行的酒馆和代理不受影响）"
}

# ── 本地生图（ComfyUI，可选）───────────────────────

has_comfy() { [[ -x "$COMFY_DIR/.venv/bin/python" && -f "$COMFY_DIR/main.py" ]]; }

start_comfy() {
    step "启动本地生图 ComfyUI（端口 $COMFY_PORT）"
    if ! has_comfy; then
        warn "没有找到 ComfyUI（$COMFY_DIR）"
        return 1
    fi
    if [[ -n "$(our_pids $COMFY_PORT)" ]]; then
        ok "ComfyUI 已经在运行，跳过"
        return 0
    fi
    explain "首次启动要加载模型，约 20–60 秒；出图时会占用约 8GB 内存。"
    rotate_log "$COMFY_LOG"
    mark_log "$COMFY_LOG"
    # --use-pytorch-cross-attention：M5 上实测 SDXL 832×1216 24 步 131s → 78s。只监听本机；柏宝绘在浏览器直连失败时会经由酒馆后端转发，不需要打开跨域
    (cd "$COMFY_DIR" && PYTORCH_ENABLE_MPS_FALLBACK=1 nohup .venv/bin/python main.py --listen 127.0.0.1 --port $COMFY_PORT --use-pytorch-cross-attention >>"$COMFY_LOG" 2>&1 &!)
    if wait_port $COMFY_PORT 90; then
        ok "ComfyUI 已启动：http://127.0.0.1:$COMFY_PORT"
        return 0
    fi
    fail "ComfyUI 90 秒内没有启动成功，最后几行日志："
    tail -n 8 "$COMFY_LOG" | sed "s/^/    ${C_DIM}│${C_RESET} /"
    return 1
}

stop_comfy() {
    step "关闭本地生图 ComfyUI"
    stop_one $COMFY_PORT "ComfyUI"
}

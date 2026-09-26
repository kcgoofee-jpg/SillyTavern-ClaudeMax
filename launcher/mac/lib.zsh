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
#   ST_AUTOSTART=0   启动 / 重启 / 开机启动时不启动酒馆（平时用 TauriTavern，酒馆只拿来测试）
#   SYNC_HUB=tt      「手机同步」以这台 Mac 的 TauriTavern 为中心（Mac TT ↔ 手机）；st = 以电脑酒馆为中心
#                    不写时：有酒馆就是 st，没有就是 tt
# ──────────────────────────────────────────────

export PATH="/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"
zmodload zsh/datetime   # EPOCHSECONDS：等端口时按真实经过的时间算
# Xcode 更新后还没同意许可协议时，/usr/bin 下的 git、python3 都会拒绝运行（整个工具箱跟着失灵）。
# 这时让它们改用「命令行工具」里的同一套程序；自检会提示去同意许可。
if [[ -z "$DEVELOPER_DIR" && -d /Library/Developer/CommandLineTools ]] && /usr/bin/git --version 2>&1 | grep -q license; then
    export DEVELOPER_DIR=/Library/Developer/CommandLineTools
    XCODE_LICENSE_PENDING=1
fi

LAUNCHER_DIR=${${(%):-%x}:A:h}
PROXY_DIR=${LAUNCHER_DIR:h:h}
ST_DIR=""
LOG_DIR="$PROXY_DIR/data/logs"
ST_PORT=8000
PROXY_PORT=8901
COMFY_DIR="${PROXY_DIR:h}/ComfyUI"   # 可选：本地生图（ComfyUI），没装就忽略
COMFY_PORT=8188
ST_AUTOSTART=1
SYNC_HUB=""
MAC_TT_DATA="$HOME/Library/Application Support/com.tauritavern.client/data"
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

# 监听该端口、且工作目录是代理或酒馆目录的进程（只动我们自己的程序）。
# 所有监听进程的工作目录用一次 lsof 读完（菜单每次刷新要查三个端口，逐个查会慢）
our_pids() {
    local -a pids=($(port_pids $1))
    local pid line   # 管道最后一段在当前 shell 里跑：变量要 local，不能漏给调用方
    (( ${#pids} )) || return 0
    lsof -a -p ${(j:,:)pids} -d cwd -Fpn 2>/dev/null |
        while IFS= read -r line; do
            case $line in
                p*) pid=${line#p} ;;
                n*) line=${line#n}
                    [[ "$line" == "$PROXY_DIR"* || ( -n "$ST_DIR" && "$line" == "$ST_DIR"* ) || "$line" == "$COMFY_DIR"* ]] && print $pid ;;
            esac
        done
}

has_st() { [[ -n "$ST_DIR" ]]; }
# 启动器要不要管酒馆的启动（ST_AUTOSTART=0：只在测试时手动开；关闭酒馆时照样会关）
st_managed() { has_st && [[ "$ST_AUTOSTART" != 0 ]]; }

foreign_owner() {
    # 端口被别的程序占着时，返回该程序名
    local pid ours=" ${(f)$(our_pids $1)} "
    for pid in $(port_pids $1); do
        [[ "$ours" == *" $pid "* ]] && continue
        local comm=$(ps -o comm= -p $pid 2>/dev/null)
        print -r -- "${comm:t}"   # 程序名可能带空格（如 Google Chrome Helper），不能交给 xargs
        return
    done
}

port_busy() { [[ -n "$(port_pids $1)" ]]; }

# 等到端口上出现「我们自己的」进程（别的程序占着端口不算启动成功）。
# 每 0.3 秒看一次；给了 PID 时那个进程退出了就不再干等（启动失败，马上去看日志）
wait_port() {
    local port=$1 secs=$2 pid=$3 start=$EPOCHSECONDS next=10
    while (( EPOCHSECONDS - start < secs )); do
        [[ -n "$(our_pids $port)" ]] && return 0
        [[ -n "$pid" ]] && ! kill -0 $pid 2>/dev/null && return 1
        sleep 0.3
        (( EPOCHSECONDS - start >= next )) && { explain "已等待 ${next} 秒…"; (( next += 10 )); }
    done
    [[ -n "$(our_pids $port)" ]]
}

# 启动失败时说清楚是「马上退出了」还是「一直没好」
start_failed() {   # start_failed 名字 秒数 PID
    if [[ -n "$3" ]] && ! kill -0 $3 2>/dev/null; then
        fail "$1启动后马上退出了"
    else
        fail "$1 $2 秒内没有启动成功"
    fi
}

# 在自己的会话 / 进程组里后台运行长期程序（代理、酒馆、生图、守护）。
# 菜单窗口里按 Ctrl-C 会给整个前台进程组发 SIGINT；node 启动时会把信号处理恢复成默认，
# nohup 只挡 SIGHUP，所以不单独分组的话，Ctrl-C 会把刚启动的代理 / 酒馆 / 守护一起杀掉。
# 用法：( cd 目录 && detach 命令 参数… >>日志 2>&1 &! )
detach() {
    if [[ -x /usr/bin/perl ]]; then
        /usr/bin/perl -MPOSIX -e 'POSIX::setsid(); exec @ARGV or die "exec $ARGV[0]: $!\n"' -- nohup "$@"
    else
        nohup "$@"
    fi
}

# 在目录里后台启动一个长期程序，打印它的 PID（perl → nohup → 程序一路 exec，PID 不变）
# 用法：pid=$(spawn 目录 日志 命令 参数…)；要带环境变量就写在前面：pid=$(变量=值 spawn …)
# 必须放在 $( ) 里用：里面的 cd 只影响这个子 shell
spawn() {
    local dir=$1 log=$2; shift 2
    cd "$dir" 2>/dev/null || return 1
    detach "$@" >>"$log" 2>&1 </dev/null &!
    print $!
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

    if [[ -n "$XCODE_LICENSE_PENDING" ]]; then
        warn "Xcode 更新后还没同意许可协议：git、python3 暂时改用「命令行工具」里的，工具箱照常能用"
        fix "有空时在「终端」运行 sudo xcodebuild -license accept（输一次 Mac 密码），或打开一次 Xcode 点同意。"
    fi

    # 2. 程序文件
    if st_managed; then
        [[ -f "$ST_DIR/server.js" ]] && ok "酒馆程序：$ST_DIR" \
            || { fail "找不到酒馆程序（$ST_DIR/server.js）"; fix "检查 launcher/config.local 里的 ST_DIR。"; }
    elif has_st; then
        explain "· 酒馆不随启动器启动（config.local 里 ST_AUTOSTART=0），只管理 Claude 代理"
    else
        explain "· 没有找到酒馆目录，只管理 Claude 代理（TauriTavern 用户不需要酒馆）"
        explain "  需要一起启动酒馆的话，在 launcher/config.local 里写 ST_DIR=\"酒馆目录\""
    fi
    ok "Claude 代理程序：$PROXY_DIR"

    # 3. 依赖
    st_managed && check_deps "$ST_DIR" "酒馆"
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
    if ! st_managed; then
        :
    elif grep -qE '^enableServerPlugins:[[:space:]]*true' "$ST_DIR/config.yaml" 2>/dev/null; then
        ok "酒馆已开启服务器插件（酒馆页面也能读取额度和状态）"
    else
        warn "酒馆 config.yaml 里没有开启 enableServerPlugins"
        explain "  不影响对话（代理是独立启动的），只是酒馆页面会直接连代理读取状态。"
    fi

    # 7. 端口
    st_managed && check_port $ST_PORT "酒馆"
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
        # 看 npm 自己的退出码，不是 tail 的
        if (cd "$dir" || exit 1; npm install --no-audit --no-fund 2>&1 | tail -n 5; exit ${pipestatus[1]}); then
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
    local json logged=unknown plan
    json=$(cd "$PROXY_DIR" && node scripts/claude-cli.js auth status 2>/dev/null)
    # 不再为解析这点 JSON 单独起一个 node
    if [[ "$json" =~ '"loggedIn"[[:space:]]*:[[:space:]]*(true|false)' ]]; then
        [[ $match[1] == true ]] && logged=yes || logged=no
    fi
    [[ "$json" =~ '"subscriptionType"[[:space:]]*:[[:space:]]*"([^"]*)"' ]] && plan=$match[1]
    case $logged in
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
    # 先看默认路由走的网卡（Wi-Fi 或有线，不一定是 en0–en2），再挨个试其他 en* 网卡。
    # 默认路由是 VPN（utun）时不用它：手机在局域网里连不到 VPN 地址。
    local ip ifc def
    def=$(route -n get default 2>/dev/null | awk '/interface:/ {print $2; exit}')
    for ifc in ${def:#utun*} ${(z)$(ifconfig -l 2>/dev/null)}; do
        [[ "$ifc" == en<-> ]] || continue
        ip=$(ipconfig getifaddr $ifc 2>/dev/null) && [[ -n "$ip" && "$ip" != 169.254.* ]] && { print $ip; return; }
    done
}

# 代理正在写的回复条数（代理自己数的，/v1/control/status 的 busy）；读不到就什么都不打印
proxy_inflight() {
    curl -s --max-time 5 "http://127.0.0.1:$PROXY_PORT/v1/control/status" 2>/dev/null |
        sed -n 's/.*"busy":\([0-9][0-9]*\).*/\1/p'
}

# 代理在忙（正在生成回复）时不重启
proxy_busy() {
    local pid n pids
    pids=($(our_pids $PROXY_PORT))
    (( ${#pids} )) || return 1
    n=$(proxy_inflight)
    [[ -n "$n" ]] && { (( n > 0 )); return; }
    # 读不到代理的计数（旧版本代理 / 代理卡住）：退回旧办法——代理下面有子进程（Claude 命令行）就算在忙
    for pid in $pids; do
        [[ -n "$(pgrep -P $pid)" ]] && return 0
    done
    return 1
}

# 代理实际监听的范围：lan（*:端口，手机能连）/ local（只有本机）；没在运行就什么都不打印
proxy_listen_scope() {
    local pid name
    pid=$(our_pids $PROXY_PORT | head -1)
    [[ -n "$pid" ]] || return 1
    name=$(lsof -nP -a -p $pid -iTCP:$PROXY_PORT -sTCP:LISTEN -Fn 2>/dev/null | sed -n 's/^n//p' | head -1)
    case $name in
        '') return 1 ;;
        127.*|\[::1\]:*|localhost:*) print local ;;
        *) print lan ;;
    esac
}

# 手机模式开关和代理实际监听的不一致时，打印一句说明（一致或代理没在运行时什么都不打印）
proxy_mode_mismatch() {
    local scope=$(proxy_listen_scope)
    if [[ -s "$LAN_KEY_FILE" && "$scope" == local ]]; then
        print -r -- "手机模式开着，但代理还只接受本机连接（切换时代理在忙，没重启）：手机暂时连不上"
    elif [[ ! -s "$LAN_KEY_FILE" && "$scope" == lan ]]; then
        print -r -- "已经是电脑模式，但代理还在接受局域网连接（切换时代理在忙，没重启）：带访问密码的手机仍能连"
    fi
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

# 从 adb devices 的输出里挑已授权的手机：USB 优先（同一台手机开了无线调试会出现两次）
pick_serial() {
    awk 'NR>1 && $2=="device" { if ($1 ~ /:/) w = w ? w : $1; else { print $1; found = 1; exit } } END { if (!found && w) print w }'
}

# 已连接（USB 或无线调试）且已授权的手机序列号，没有就空
phone_serial() {
    local adb; adb=$(find_adb) || return 1
    "$adb" devices 2>/dev/null | pick_serial
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

RESTART_MARK="$PROXY_DIR/launcher/restarting.local"   # 有且不到 60 秒 = 有人正在重启代理，守护别插手
ADB_NOROUTE_FILE="$PROXY_DIR/launcher/adb-noroute.local"   # 有 = 守护的 adb 连手机报 No route to host

# PID 文件里的进程真的是守护才算（死机重启后 PID 可能被别的程序用了）
watchdog_pid() {
    local pid
    [[ -s "$WATCHDOG_PID_FILE" ]] || return 1
    pid=$(<"$WATCHDOG_PID_FILE")
    [[ "$pid" == <-> ]] || return 1
    [[ "$(ps -o command= -p $pid 2>/dev/null)" == *watchdog.zsh* ]] || return 1
    print $pid
}

watchdog_running() { watchdog_pid >/dev/null; }

watchdog_start() {
    local i
    watchdog_running && return 0
    detach /bin/zsh "$LAUNCHER_DIR/watchdog.zsh" >>"$LOG_DIR/watchdog.log" 2>&1 &!
    for i in {1..6}; do sleep 0.5; watchdog_running && return 0; done
    return 1
}

watchdog_stop() {
    local pid i
    if pid=$(watchdog_pid); then
        kill $pid 2>/dev/null
        # 守护可能正在跑一条命令（启动代理、adb connect），zsh 要等它结束才处理 TERM：多等一会儿
        for i in {1..50}; do kill -0 $pid 2>/dev/null || break; sleep 0.3; done
        if kill -0 $pid 2>/dev/null && [[ "$(ps -o command= -p $pid 2>/dev/null)" == *watchdog.zsh* ]]; then
            kill -9 $pid 2>/dev/null   # 它自己的收尾没跑：下面的 lid_cleanup_stale 替它恢复合盖睡眠
            sleep 0.5
            log_event "[守护] 15 秒没退出，已强制结束（PID $pid）"
        fi
    fi
    # 只删还指着死进程 / 别的进程的 PID 文件；守护自己退出时也会删
    watchdog_running || rm -f "$WATCHDOG_PID_FILE"
    lid_cleanup_stale
}

# 代理重启标记：stop_one 关代理前打上，start_proxy 成功后擦掉；守护看到新标记就不插手
restart_mark_fresh() {
    local mt
    [[ -f "$RESTART_MARK" ]] || return 1
    mt=$(stat -f %m "$RESTART_MARK" 2>/dev/null) || return 1
    (( $(date +%s) - mt < 60 ))
}

# ── 合盖不睡（可选，手机模式下由守护开关） ─────────────
# 合盖睡眠不受 caffeinate 管，只有 pmset 的 disablesleep 能挡。它要 root，
# 所以「合盖不睡」工具装一条只允许这两条命令免密的 sudoers 规则；没装就不启用。
# 守护在这些情况下自动放开（合盖就会睡）：用电池且电量低于 LID_BATTERY_FLOOR、
# 低电量模式、合盖且代理 LID_IDLE_HOURS 小时没有请求、手机上按了暂停、config.local 里 LID_AWAKE=0、
# 手机模式关闭、守护退出。
LID_SUDOERS=/etc/sudoers.d/claudemax-lid
LID_OWNED_FILE="$PROXY_DIR/launcher/lid-awake.local"   # 有 = 这个开关是我们打开的
LID_PAUSE_FILE="$PROXY_DIR/launcher/lid-pause.local"   # 有 = 手机上按了「暂停合盖不睡」
: ${LID_BATTERY_FLOOR:=25}
: ${LID_IDLE_HOURS:=3}

# 装了规则才算：-k 让 sudo 不拿刚输过密码的缓存凭据当「免密」
lid_supported() { [[ -e "$LID_SUDOERS" ]] && sudo -k -n -l /usr/bin/pmset -a disablesleep 1 >/dev/null 2>&1; }
lid_awake_on()  { [[ "$(pmset -g | awk '/SleepDisabled/ {print $2}')" == 1 ]]; }
lid_closed()    { ioreg -r -k AppleClamshellState -d 1 | grep -q '"AppleClamshellState" = Yes'; }
on_battery()    { pmset -g batt | head -1 | grep -q "Battery Power"; }
battery_pct()   { pmset -g batt | grep -o '[0-9]*%' | head -1 | tr -d %; }
low_power()     { [[ "$(pmset -g | awk '/lowpowermode/ {print $2}')" == 1 ]]; }

# 合盖不睡现在该不该放开：该放开就打印原因（off = config.local 里 LID_AWAKE=0），不该就什么都不打印。
# 守护和「检查状态」共用同一套规则
lid_release_reason() {
    local pct mt
    if [[ "$LID_AWAKE" == 0 ]]; then
        print off; return
    elif [[ -f "$LID_PAUSE_FILE" ]]; then
        print "手机上暂停了合盖不睡"; return
    elif on_battery; then
        pct=$(battery_pct)
        if [[ -n "$pct" ]] && (( pct < LID_BATTERY_FLOOR )); then   # 读不到电量不当成电量低
            print "电池只剩 ${pct}%（低于 ${LID_BATTERY_FLOOR}%）"; return
        elif low_power; then
            print "开了低电量模式"; return
        fi
    fi
    # 日志可能刚好被归档（改名）：读不到修改时间就不算「没请求」
    if lid_closed && mt=$(stat -f %m "$PROXY_LOG" 2>/dev/null) && [[ -n "$mt" ]] &&
       (( $(date +%s) - mt > LID_IDLE_HOURS * 3600 )) && ! proxy_busy; then
        print "合盖后 ${LID_IDLE_HOURS} 小时没有请求"
    fi
}

lid_set() {   # lid_set 1|0
    sudo -n /usr/bin/pmset -a disablesleep $1 >/dev/null 2>&1 || return 1
    if (( $1 )); then : >"$LID_OWNED_FILE"; else rm -f "$LID_OWNED_FILE"; fi
}

PHONE_FILE="$PROXY_DIR/launcher/phone.local"   # 无线调试时手机的地址（「手机同步」里开无线调试时写的）

# 按上次的无线调试地址重连手机：0 = 连上了；2 = No route to host；1 = 其他原因没连上。
# No route to host 多半是 macOS「本地网络」权限：后台（守护 / 开机启动）拉起的 adb 服务没有这个权限，
# 连不了局域网；从终端（酒馆工具）启动的才有。留个标记，「检查状态」据此提示怎么修。
adb_reconnect() {
    local adb=$1 out
    [[ -n "$adb" && -s "$PHONE_FILE" ]] || return 1
    out=$("$adb" connect "$(<"$PHONE_FILE")" 2>&1)
    if [[ "$out" == *"No route to host"* ]]; then
        if [[ ! -f "$ADB_NOROUTE_FILE" ]]; then
            : >"$ADB_NOROUTE_FILE"
            log_event "[adb] 连手机报 No route to host（多半是 macOS 本地网络权限挡住了后台启动的 adb 服务）"
        fi
        return 2
    fi
    [[ "$out" == *"connected to"* ]] || return 1   # 包括 already connected to
    rm -f "$ADB_NOROUTE_FILE"
    return 0
}

# 手机上的 TT 现在能不能关（force-stop）：能关返回 0；不能关返回 1 并打印原因。判断不了也算不能关。
# 用 scripts/apply_settings.py --why-busy（0 = 空闲；1 = 忙，打印原因；2 = 判断不了）；
# 没有这个脚本（不是开发目录）就自己看：代理在写的回复条数 + TT 的窗口是否可见。
phone_tt_busy_reason() {
    local serial=$1 adb=$2 script="${PROXY_DIR:h}/scripts/apply_settings.py" out rc n tasks vis
    if [[ -f "$script" ]]; then
        out=$(python3 "$script" --why-busy --serial "$serial" --adb "$adb" 2>&1); rc=$?
        (( rc == 0 )) && [[ -z "$out" ]] && return 0
        print -r -- "${out:-判断不了手机是否在用（检查脚本退出码 $rc）}"
        return 1
    fi
    n=$(proxy_inflight)
    if tasks=$("$adb" -s "$serial" shell "dumpsys activity activities" 2>/dev/null) && [[ -n "$tasks" ]]; then
        vis=$(print -r -- "$tasks" | grep -E 'visible=true' | grep -c com.tauritavern.client)
        # 屏幕关着时「可见」的窗口没人在看（和 apply_settings.py 一样）；读不到亮屏状态就当亮着
        local wake=$("$adb" -s "$serial" shell "dumpsys power 2>/dev/null | grep -m1 mWakefulness" 2>/dev/null)
        [[ "$wake" == *mWakefulness=* && "$wake" != *Awake* ]] && vis=0
    fi
    if [[ -n "$n" ]] && (( n > 0 )); then
        print -r -- "Mac 上的代理正在写回复"; return 1
    elif [[ -n "$vis" ]] && (( vis > 0 )); then
        print -r -- "TT 在屏幕上开着（全屏、小窗或分屏）"; return 1
    elif [[ -z "$n" && -z "$vis" ]]; then
        print -r -- "读不到代理状态，也读不到手机上的窗口，保险起见不动手机"; return 1
    fi
    return 0
}

# ── 手机同步的「中心」 ─────────────────────────
# tt：这台 Mac 的 TauriTavern ↔ 手机；st：电脑酒馆 ↔ 手机（见文件开头 SYNC_HUB）。
# 扩展代码的来源：有酒馆就用酒馆的第三方扩展目录（开发时的源码都在那里，也会先推给 Mac TT），
# 没有就用 Mac TT 自己的。
sync_hub() {
    case $SYNC_HUB in
        tt|st) print $SYNC_HUB ;;
        *) if has_st; then print st; else print tt; fi ;;
    esac
}
ext_source_dir() {
    if has_st && [[ -d "$ST_DIR/public/scripts/extensions/third-party" ]]; then
        print -r -- "$ST_DIR/public/scripts/extensions/third-party"
    else
        print -r -- "$MAC_TT_DATA/extensions/third-party"
    fi
}
hub_label() { [[ "$(sync_hub)" == tt ]] && print "Mac TT" || print "电脑酒馆"; }
hub_ready() {   # 中心的数据在不在：不在就打印原因
    if [[ "$(sync_hub)" == tt ]]; then
        [[ -d "$MAC_TT_DATA/default-user" ]] || { print -r -- "这台 Mac 上没找到 TauriTavern 的数据（装好并打开过一次才有）"; return 1; }
    else
        has_st || { print -r -- "Mac 上没有酒馆数据"; return 1; }
    fi
}
# phone_sync.py 的参数（手机那边的 --adb / --serial 另外加）
hub_sync_args() {
    local -a a
    if [[ "$(sync_hub)" == tt ]]; then
        a=(--st "$MAC_TT_DATA/default-user" --local-name "Mac TT"
           --state "$PROXY_DIR/launcher/phone-sync-state-tt.local.json")
    else
        a=(--st "$ST_DIR/data/default-user" --state "$PROXY_DIR/launcher/phone-sync-state.local.json")
    fi
    a+=(--backups "${PROXY_DIR:h}/backups" --port $PROXY_PORT --ext-dir "$(ext_source_dir)")
    print -rn -- "${(pj:\0:)a}"
}

mac_tt_running() { pgrep -xq tauritavern; }
# 正常退出 Mac 上的 TT（它开着时会把旧内容存回去）；10 秒没退出返回 1
mac_tt_quit() {
    local i
    mac_tt_running || return 0
    osascript -e 'quit app "TauriTavern"' >/dev/null 2>&1
    for i in {1..20}; do mac_tt_running || return 0; sleep 0.5; done
    return 1
}
mac_tt_open() { [[ -d /Applications/TauriTavern.app ]] && open -a TauriTavern; }

# 中心是 Mac TT 时：扩展源码 → Mac TT（只在 Mac TT 上是旧版本时推；和手机同一套规则）。Mac TT 要先退出
hub_update_mac_tt_ext() {
    local src=$(ext_source_dir)
    [[ "$(sync_hub)" == tt && "$src" != "$MAC_TT_DATA/extensions/third-party" ]] || return 0
    python3 "$LAUNCHER_DIR/../phone_sync.py" --ext-only --local-tt "$MAC_TT_DATA/default-user" --ext-dir "$src" "$@"
}

# 手机遥控「同步」：不问问题直接双向同步（关掉手机上的 TT → 同步 → 再打开），结果发通知。
# 同步前照样检查手机忙不忙；只有「TT 在屏幕上」这一条不算——按钮就是在 TT 里按的，
# 这时再单独确认代理没在写回复（检查脚本看到 TT 在屏幕上就不往下查了）。
phone_sync_auto() {
    local adb serial args out busy rc n
    adb=$(find_adb) || { notify "手机同步没做成" "Mac 上找不到 adb"; return 1; }
    serial=$(phone_serial)
    if [[ -z "$serial" ]]; then
        adb_reconnect "$adb"; sleep 1; serial=$(phone_serial)
    fi
    [[ -n "$serial" ]] || { notify "手机同步没做成" "Mac 连不上手机的无线调试"; return 1; }
    local why tt_was=0
    why=$(hub_ready) || { notify "手机同步没做成" "$why"; return 1; }
    if ! busy=$(phone_tt_busy_reason "$serial" "$adb"); then
        if [[ "$busy" == *屏幕上* ]]; then
            n=$(proxy_inflight)
            if [[ -z "$n" ]] || (( n > 0 )); then
                notify "手机同步没做成" "Mac 上的代理正在写回复（或读不到它的状态），写完再同步。"
                log_event "[同步] 手机遥控触发：没做（代理在写回复或读不到状态）"
                return 1
            fi
            log_event "[同步] 手机遥控触发：TT 在屏幕上（就是在 TT 里按的），代理空闲，照常同步"
        else
            notify "手机同步没做成" "手机现在不方便关 TT：$busy"
            log_event "[同步] 手机遥控触发：没做（$busy）"
            return 1
        fi
    fi
    # 中心是 Mac TT：它开着会把旧内容存回去，先正常退出（上面已确认代理没在写回复），同步完再打开
    if [[ "$(sync_hub)" == tt ]] && mac_tt_running; then
        tt_was=1
        mac_tt_quit || { notify "手机同步没做成" "Mac 上的 TauriTavern 没能退出，先手动退出再同步。"; return 1; }
    fi
    "$adb" -s "$serial" shell am force-stop com.tauritavern.client >/dev/null 2>&1
    hub_update_mac_tt_ext >/dev/null 2>&1
    args=("${(@0)$(hub_sync_args)}" --adb "$adb" --serial "$serial")
    [[ -s "$LAN_KEY_FILE" && -n "$(lan_ip)" ]] && args+=(--mac-ip "$(lan_ip)" --lan-key-file "$LAN_KEY_FILE")
    out=$(python3 "$LAUNCHER_DIR/../phone_sync.py" "${args[@]}" 2>&1)
    rc=$?
    out=$(print -r -- "$out" | grep '✓ 同步完成\|✗' | head -2)
    log_event "[同步] 手机遥控触发（$(hub_label) ↔ 手机，退出码 $rc）：${out//$'\n'/；}"
    "$adb" -s "$serial" shell monkey -p com.tauritavern.client -c android.intent.category.LAUNCHER 1 >/dev/null 2>&1
    (( tt_was )) && mac_tt_open
    if (( rc == 0 )); then
        notify "手机同步完成" "${out:-已同步}"
    else
        notify "手机同步没有全部完成" "${out:-同步程序出错（退出码 $rc）}。在 Mac 上用酒馆工具「手机同步」再做一次可以看到详情。"
        return 1
    fi
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
    local owner
    step "启动 Claude 代理（端口 $PROXY_PORT）"
    explain "代理负责把酒馆 / TauriTavern 的请求转给 Claude，走你的订阅额度。"
    if [[ -n "$(our_pids $PROXY_PORT)" ]]; then
        rm -f "$RESTART_MARK"
        ok "代理已经在运行，跳过"
        return 0
    fi
    if owner=$(foreign_owner $PROXY_PORT) && [[ -n "$owner" ]]; then
        fail "端口 $PROXY_PORT 被其他程序占着：$owner，代理启动不了"
        fix "关闭「$owner」后再试，或重启电脑。"
        return 1
    fi
    rotate_log "$PROXY_LOG"
    mark_log "$PROXY_LOG"
    local pid
    if [[ -s "$LAN_KEY_FILE" ]]; then
        explain "手机连接已开启：同一 Wi-Fi 下的设备带访问密码可以连这个代理。"
        pid=$(CLAUDE_SUBSCRIPTION_HOST=0.0.0.0 CLAUDE_SUBSCRIPTION_LAN_KEY="$(<"$LAN_KEY_FILE")" spawn "$PROXY_DIR" "$PROXY_LOG" node server.js)
    else
        pid=$(spawn "$PROXY_DIR" "$PROXY_LOG" node server.js)
    fi
    if wait_port $PROXY_PORT 20 $pid; then
        rm -f "$RESTART_MARK"
        ok "代理已启动：http://127.0.0.1:$PROXY_PORT/v1"
        if [[ -s "$LAN_KEY_FILE" ]]; then
            if watchdog_start; then
                ok "手机模式守护在运行：防睡眠、掉线自动重启"
            else
                warn "手机模式守护没有启动成功：看日志文件夹里的 watchdog.log，或再选一次「手机模式」"
            fi
        fi
        return 0
    fi
    start_failed "代理" 20 "$pid"
    diagnose_log "$PROXY_LOG" "代理"
    return 1
}

# 酒馆编译前端要十几秒到一分钟：先把它在后台拉起来，再去启动代理，两边同时进行；
# 之后 start_st 只负责等它就绪。酒馆已在运行、端口被别的程序占着时这里什么都不做，交给 start_st 报告
ST_SPAWNED=0
ST_PID=""
spawn_st() {
    st_managed && (( ! ST_SPAWNED )) || return 0
    port_busy $ST_PORT && return 0
    rotate_log "$ST_LOG"
    mark_log "$ST_LOG"
    ST_PID=$(spawn "$ST_DIR" "$ST_LOG" node server.js)
    ST_SPAWNED=1
}

start_st() {
    st_managed || return 1
    local owner
    step "启动酒馆（端口 $ST_PORT）"
    explain "首次启动或更新后需要编译前端，可能要 10–60 秒，请耐心等待。"
    if (( ! ST_SPAWNED )); then
        if [[ -n "$(our_pids $ST_PORT)" ]]; then
            ok "酒馆已经在运行，跳过"
            return 0
        fi
        if owner=$(foreign_owner $ST_PORT) && [[ -n "$owner" ]]; then
            fail "端口 $ST_PORT 被其他程序占着：$owner，酒馆启动不了"
            fix "关闭「$owner」后再试，或重启电脑。"
            return 1
        fi
        spawn_st
    fi
    if wait_port $ST_PORT 120 $ST_PID; then
        ok "酒馆已启动：http://127.0.0.1:$ST_PORT"
        return 0
    fi
    start_failed "酒馆" 120 "$ST_PID"
    diagnose_log "$ST_LOG" "酒馆"
    return 1
}

# 关一个或几个程序：先一起发 TERM，再一起等（每 0.2 秒看一次，一共最多 10 秒），没退出的强制结束
# 用法：stop_one 端口 名字 [端口 名字 …]
stop_one() {
    local -A left
    local port pids start=$EPOCHREALTIME
    while (( $# >= 2 )); do
        pids=$(our_pids $1)
        if [[ -z "$pids" ]]; then
            ok "$2 本来就没有运行"
        else
            # 关代理前打个标记：守护 60 秒内不去「自动重启」它（遥控重启、手机模式切换会马上自己启动）
            [[ "$1" == "$PROXY_PORT" ]] && : >"$RESTART_MARK"
            kill ${=pids} 2>/dev/null
            left[$1]=$2
        fi
        shift 2
    done
    while (( ${#left} && EPOCHREALTIME - start < 10 )); do
        sleep 0.2
        for port in ${(k)left}; do
            [[ -z "$(our_pids $port)" ]] && { ok "已关闭${left[$port]}"; unset "left[$port]"; }
        done
    done
    (( ${#left} )) || return 0
    for port in ${(k)left}; do
        pids=$(our_pids $port)
        kill -9 ${=pids} 2>/dev/null
    done
    sleep 1
    for port in ${(k)left}; do
        pids=$(our_pids $port)
        if [[ -z "$pids" ]]; then
            warn "${left[$port]} 没有正常退出，已强制关闭"
        else
            fail "${left[$port]} 无法关闭（进程 ${pids//$'\n'/ }）"
            fix "重启电脑即可。"
        fi
    done
}

# 代理正在写回复时，关掉 / 重启会把这条回复掐断：先问（没在写就直接返回 0）
confirm_proxy_idle() {
    local what=$1 n
    proxy_busy || return 0
    n=$(proxy_inflight)
    warn "代理正在写${n:+ $n 条}回复，现在${what}会把它掐断（那条回复要重新生成）"
    ask_yes "仍然现在${what}吗？（选 N 就等写完再来）"
}

stop_all() {
    step "关闭酒馆和 Claude 代理"
    explain "关闭后 TauriTavern 也会连不上代理，直到下次启动。"
    watchdog_running && { watchdog_stop; ok "手机模式守护已停止（下次启动时自动恢复）"; }
    if has_st; then stop_one $ST_PORT "酒馆" $PROXY_PORT "Claude 代理"; else stop_one $PROXY_PORT "Claude 代理"; fi
}

# ── 启动后检查 ────────────────────────────────

cred_source_name() {
    case $1 in
        keychain) print "钥匙串" ;; file) print "凭据文件" ;; env) print "环境变量" ;;
        "") print "未知" ;; *) print -r -- "$1" ;;
    esac
}

health_check() {
    step "启动后检查：确认服务真的能用"
    local body parsed code

    body=$(curl -s --max-time 5 "http://127.0.0.1:$PROXY_PORT/status")
    if [[ -z "$body" ]]; then
        fail "代理没有响应"
        diagnose_log "$PROXY_LOG" "代理"
    else
        # 顺便读仓库里的版本号（第 6 个字段），省一次 node 启动
        parsed=$(print -r -- "$body" | node -e "let v='';try{v=require(process.argv[1]+'/package.json').version}catch{}let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{const j=JSON.parse(s);const c=j.credential||{};console.log([j.ok?'ok':'bad',j.version,c.present?'yes':'no',c.subscriptionType||'',c.source||'',v].map(v=>String(v??'').replace(/[|\\n]/g,' ')).join('|'))}catch{console.log('bad')}})" "$PROXY_DIR")
        local -a f=("${(@s:|:)parsed}")   # 按 | 分，空字段（没有套餐类型等）也占位，后面的字段不会错位
        if [[ "${f[1]}" != ok ]]; then
            fail "代理有响应，但报告异常（SDK 未加载）"
            diagnose_log "$PROXY_LOG" "代理"
        elif [[ "${f[3]}" == yes ]]; then
            ok "代理正常（v${f[2]}，$(plan_name "${f[4]}") 订阅，凭据来自$(cred_source_name "${f[5]}")）"
            local repo_v=${f[6]}
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
    if st_managed || { has_st && [[ -n "$(our_pids $ST_PORT)" ]]; }; then
        if [[ -n "$(our_pids $ST_PORT)" ]]; then ok "酒馆：运行中 → http://127.0.0.1:$ST_PORT"
        else explain "· 酒馆：未运行"; fi
    fi
    if [[ -n "$(our_pids $PROXY_PORT)" ]]; then ok "Claude 代理：运行中 → http://127.0.0.1:$PROXY_PORT/v1"
    else explain "· Claude 代理：未运行（TauriTavern 需要它才能对话）"; fi
    local mismatch why
    if mismatch=$(proxy_mode_mismatch) && [[ -n "$mismatch" ]]; then
        warn "$mismatch"
        if [[ -s "$LAN_KEY_FILE" ]]; then
            fix "守护会在代理空闲时自动重启它；也可以没在生成回复时选「重启酒馆」。"
        else
            fix "没在生成回复时选「重启酒馆」，重启后手机就连不上了。"
        fi
    fi
    if [[ -s "$LAN_KEY_FILE" ]]; then
        if watchdog_running; then ok "手机模式守护：运行中"; else warn "手机模式开着，但守护没在运行：双击「手机模式」修复"; fi
        if lid_awake_on; then ok "合盖不睡：开着"
        elif lid_supported; then
            if ! watchdog_running; then why="守护没在运行"
            else why=$(lid_release_reason); [[ "$why" == off ]] && why="config.local 里写了 LID_AWAKE=0"; fi
            explain "· 合盖不睡：已安装，现在放开着（${why:-条件刚恢复，守护 30 秒内会打开}）"
        else explain "· 合盖不睡：未安装（合盖会睡，手机连不上）"; fi
    fi
    lid_awake_on && [[ ! -s "$LAN_KEY_FILE" ]] && warn "合盖不睡开着，但手机模式是关的：合盖不会睡，注意发热耗电"
    if [[ -f "$ADB_NOROUTE_FILE" ]]; then
        warn "后台连手机的无线调试时报「No route to host」：多半是 macOS 的「本地网络」权限挡住了后台启动的 adb"
        fix "在「酒馆工具」里选一次「手机同步」：它从终端重新启动 adb，之后守护也能连上手机（Mac 重启后可能要再来一次）。"
    fi
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
    # 目录为空时 cd "" 会成功、npm 会装到当前目录（常常是家目录）：先确认是个真的程序目录
    [[ -n "$dir" && -f "$dir/package.json" ]] || return 0
    step "重新安装$name的依赖"
    explain "目录：$dir"
    if (cd "$dir" || exit 1; npm install --no-audit --no-fund 2>&1 | tee -a "$LAUNCHER_LOG" | tail -n 6 | sed "s/^/    ${C_DIM}│${C_RESET} /"; exit ${pipestatus[1]}); then
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
        explain "现在也会马上在后台启动一次（已经在运行的跳过；手机模式开着的话守护也一起），几秒后菜单上就能看到。"
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
    local pid=$(PYTORCH_ENABLE_MPS_FALLBACK=1 spawn "$COMFY_DIR" "$COMFY_LOG" .venv/bin/python main.py --listen 127.0.0.1 --port $COMFY_PORT --use-pytorch-cross-attention)
    if wait_port $COMFY_PORT 90 $pid; then
        ok "ComfyUI 已启动：http://127.0.0.1:$COMFY_PORT"
        return 0
    fi
    start_failed "ComfyUI" 90 "$pid"
    explain "最后几行日志："
    tail -n 8 "$COMFY_LOG" | sed "s/^/    ${C_DIM}│${C_RESET} /"
    return 1
}

stop_comfy() {
    step "关闭本地生图 ComfyUI"
    stop_one $COMFY_PORT "ComfyUI"
}

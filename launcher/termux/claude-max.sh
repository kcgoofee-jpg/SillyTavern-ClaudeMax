#!/data/data/com.termux/files/usr/bin/bash
# ──────────────────────────────────────────────
# CCST 启动器 · Android（Termux）
#
# Claude CLI 没有安卓版，不能直接在 Termux 里运行。这个脚本在 Termux 里装一个
# Debian 子系统（proot-distro），代理跑在 Debian 里；酒馆照常跑在 Termux 里，
# 两边共用网络，酒馆连 http://127.0.0.1:8901/v1 即可。
#
# 用法：
#   bash claude-max.sh install   首次安装（之后可以直接用 claude-max 命令）
#   claude-max login             登录 Claude 订阅（只需一次）
#   claude-max start | stop | restart | status | logs | update
# ──────────────────────────────────────────────

DISTRO=debian
REPO_URL=https://github.com/kcgoofee-jpg/CCST
GUEST_DIR=/root/CCST
PORT=8901
STATE_DIR="$HOME/.claude-max"
LOG="$STATE_DIR/proxy.log"
PID_FILE="$STATE_DIR/proxy.pid"
ROOTFS="$PREFIX/var/lib/proot-distro/installed-rootfs/$DISTRO"

mkdir -p "$STATE_DIR"

G=$'\e[32m'; Y=$'\e[33m'; R=$'\e[31m'; D=$'\e[2m'; B=$'\e[1m'; N=$'\e[0m'
step() { printf '\n%s▶ %s%s\n' "$B" "$1" "$N"; }
ok()   { printf '  %s✓%s %s\n' "$G" "$N" "$1"; }
warn() { printf '  %s!%s %s\n' "$Y" "$N" "$1"; }
fail() { printf '  %s✗%s %s\n' "$R" "$N" "$1"; }
hint() { printf '  %s%s%s\n' "$D" "$1" "$N"; }

in_debian() { proot-distro login "$DISTRO" --shared-tmp -- bash -lc "$1"; }

proxy_up() { curl -s --max-time 3 "http://127.0.0.1:$PORT/status" 2>/dev/null | grep -q '"ok":true'; }

need_install() {
    if [[ ! -d "$ROOTFS$GUEST_DIR" ]]; then
        fail "还没有安装，先运行：bash claude-max.sh install"
        exit 1
    fi
}

cmd_install() {
    step "安装 Termux 需要的工具"
    pkg update -y && pkg install -y proot-distro curl || { fail "pkg 安装失败，检查网络或换源（termux-change-repo）后重试"; exit 1; }
    ok "proot-distro、curl 已安装"

    step "安装 Debian 子系统（约 100MB，只需一次）"
    if [[ -d "$ROOTFS" ]]; then
        ok "Debian 已安装，跳过"
    else
        proot-distro install "$DISTRO" || { fail "Debian 安装失败：要能访问 Docker Hub（国内一般要开代理 / VPN；DNS 被污染时 auth.docker.io 会解析到错误地址）。开好后重跑 install"; exit 1; }
        ok "Debian 已安装"
    fi

    step "在 Debian 里安装 Node.js 和 git"
    in_debian "apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y nodejs npm git ca-certificates" \
        || { fail "安装失败，检查网络后重试"; exit 1; }
    local major
    major=$(in_debian "node -p 'process.versions.node.split(\".\")[0]'" | tr -dc '0-9')
    if (( major < 18 )); then
        fail "Debian 自带的 Node.js 版本太旧（$major），需要 18 或更高"
        exit 1
    fi
    ok "Node.js $major"

    step "下载 CCST 代理"
    in_debian "if [ -d $GUEST_DIR/.git ]; then cd $GUEST_DIR && git pull --ff-only; else git clone --depth 1 $REPO_URL $GUEST_DIR; fi" \
        || { fail "下载失败，检查能否访问 GitHub"; exit 1; }
    in_debian "cd $GUEST_DIR && npm install --no-audit --no-fund" || { fail "npm install 失败"; exit 1; }
    ok "代理已安装在 Debian 的 $GUEST_DIR"

    step "安装 claude-max 命令"
    install -m 755 "$0" "$PREFIX/bin/claude-max" 2>/dev/null || cp "$0" "$PREFIX/bin/claude-max"
    chmod +x "$PREFIX/bin/claude-max"
    ok "以后在 Termux 里直接输入 claude-max start / stop / status"

    printf '\n%s下一步：%s\n' "$B" "$N"
    hint "1. claude-max login    登录 Claude 订阅（只需一次）"
    hint "2. claude-max start    启动代理"
    hint "3. 在酒馆「扩展 → 安装扩展」填 $REPO_URL 装上面板，点「一键连接」"
}

cmd_login() {
    need_install
    step "登录 Claude 订阅"
    hint "终端里会显示一个网址：长按复制，到手机浏览器里打开并授权；网页给出授权码后，粘贴回这里。"
    in_debian "cd $GUEST_DIR && node bin/claude-cli.js auth login"
    step "确认登录结果"
    if in_debian "cd $GUEST_DIR && node bin/claude-cli.js auth status" | grep -q '"loggedIn": *true'; then
        ok "已登录"
    else
        warn "没有登录成功，再运行一次 claude-max login"
    fi
}

cmd_start() {
    need_install
    step "启动 Claude 代理（端口 $PORT）"
    if proxy_up; then ok "代理已经在运行"; return 0; fi
    command -v termux-wake-lock >/dev/null && termux-wake-lock
    [[ -f "$LOG" ]] && (( $(stat -c %s "$LOG" 2>/dev/null || echo 0) > 5242880 )) && mv -f "$LOG" "$LOG.old"
    printf '\n──────── %s 启动 ────────\n' "$(date '+%F %T')" >>"$LOG"
    nohup proot-distro login "$DISTRO" --shared-tmp -- bash -lc "cd $GUEST_DIR && exec node $GUEST_DIR/server.js" >>"$LOG" 2>&1 &
    echo $! >"$PID_FILE"
    for _ in $(seq 1 30); do
        sleep 1
        if proxy_up; then
            ok "代理已启动：http://127.0.0.1:$PORT/v1"
            hint "已申请唤醒锁，防止锁屏后被系统休眠。通知栏里的 Termux 通知不要划掉。"
            return 0
        fi
    done
    fail "30 秒内没有启动成功，最后几行日志："
    tail -n 10 "$LOG" | sed 's/^/    │ /'
    return 1
}

cmd_stop() {
    step "关闭 Claude 代理"
    local pid
    # 只按进程号关：启动时记下的，和代理自己在 /status 里报的；不按名字找（会误关别的 node 程序）
    pid=$(cat "$PID_FILE" 2>/dev/null)
    [[ -n "$pid" ]] && kill "$pid" 2>/dev/null
    pid=$(curl -s --max-time 3 "http://127.0.0.1:$PORT/status" 2>/dev/null | sed -n 's/.*"pid":\([0-9][0-9]*\).*/\1/p')
    [[ -n "$pid" ]] && kill "$pid" 2>/dev/null
    sleep 1
    if proxy_up; then fail "代理还在运行，重启 Termux 即可"; else ok "已关闭"; fi
    rm -f "$PID_FILE"
    command -v termux-wake-unlock >/dev/null && termux-wake-unlock
}

cmd_status() {
    step "检查状态"
    if [[ -d "$ROOTFS$GUEST_DIR" ]]; then ok "代理已安装"; else fail "还没有安装：bash claude-max.sh install"; return; fi
    if in_debian "cd $GUEST_DIR && node bin/claude-cli.js auth status" 2>/dev/null | grep -q '"loggedIn": *true'; then
        ok "Claude 订阅已登录"
    else
        warn "还没有登录：claude-max login"
    fi
    if proxy_up; then ok "代理运行中：http://127.0.0.1:$PORT/v1"; else warn "代理没有运行：claude-max start"; fi
    if [[ -f "$LOG" ]] && tail -n 200 "$LOG" | grep -v "quota endpoint" | grep -qiE 'rate_limit|Too many requests'; then
        warn "日志里有额度限流记录，稍等几分钟再试"
    fi
    hint "日志：$LOG"
}

cmd_update() {
    need_install
    step "更新代理"
    in_debian "cd $GUEST_DIR && git pull --ff-only && npm install --no-audit --no-fund" || { fail "更新失败"; return 1; }
    ok "已更新"
    if proxy_up; then cmd_stop; cmd_start; fi
    hint "酒馆里的面板在「扩展 → 管理扩展」里点更新，然后刷新页面。"
}

case "${1:-status}" in
    install) cmd_install ;;
    login) cmd_login ;;
    start) cmd_start ;;
    stop) cmd_stop ;;
    restart)
        # 代理在写回复时不重启（会把回复掐断）；和菜单的 core.mjs 同一条规则
        busy=$(curl -s --max-time 3 "http://127.0.0.1:$PORT/v1/control/status" 2>/dev/null | sed -n 's/.*"busy":\([0-9][0-9]*\).*/\1/p')
        if [[ -n "$busy" ]] && (( busy > 0 )); then warn "代理正在写 $busy 条回复，现在重启会把它掐断。等写完再来。"; exit 0; fi
        cmd_stop; cmd_start ;;
    status) cmd_status ;;
    update) cmd_update ;;
    logs) tail -n 50 "$LOG" ;;
    *) echo "用法：claude-max install | login | start | stop | restart | status | logs | update" ;;
esac

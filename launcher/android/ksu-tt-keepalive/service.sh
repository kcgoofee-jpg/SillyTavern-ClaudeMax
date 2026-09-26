#!/system/bin/sh
# TauriTavern 后台保活（KernelSU / Magisk 模块，开机后以 root 运行，常驻一个很轻的循环）
#
# 只动 com.tauritavern.client 这一个应用，全部是 Android 自带的开关：
#   1. 电池优化白名单（deviceidle）：息屏打盹时网络不断、不被冻结
#   2. 允许后台运行（appops RUN_IN_BACKGROUND / RUN_ANY_IN_BACKGROUND）
#   1、2 每 10 分钟核对一次，丢了就补（比如重装过 TT）
#   3. 待机分组：只在被系统降到「活跃」以下时拉回「活跃」（在白名单里时是 5「豁免」，更好，不去碰）
#   4. TT 在后台时，把它的内存回收优先级（oom_score_adj）从 700–900 降到 250：
#      内存紧张时先杀别的后台应用；Android 只冻结 900 及以上的进程，降下来也就不会被冻结。
#      TT 开着时每 15 秒看一次，前台时系统自己设的 0 不去碰
#   5. 只记录、不干预：TT 被 Android 或 ColorOS 冻结 / 解冻时记一行，便于判断回复为什么停住
# 不联网、不下载、不含可执行文件；日志写在本模块目录的 service.log（只有时间和做了什么），最多 200 行。
# 卸载模块时 uninstall.sh 撤掉 1、2；3、4 本来就只在运行时有效，重启即恢复。

PKG=com.tauritavern.client
MODDIR=${0%/*}
LOG=$MODDIR/service.log
OOM_BG=250
FAST=15      # TT 在运行时的检查间隔（秒）
SLOW=60      # TT 没在运行时
CHECK=600    # 白名单 / 后台运行 / 待机分组的核对间隔

log() {
    echo "$(date '+%m-%d %H:%M:%S') $*" >> "$LOG"
    # 超过 240 行就只留最近 200 行
    if [ "$(wc -l < "$LOG" 2>/dev/null)" -gt 240 ] 2>/dev/null; then
        tail -n 200 "$LOG" > "$LOG.tmp" && mv "$LOG.tmp" "$LOG"
    fi
}

# 等开机完成
until [ "$(getprop sys.boot_completed)" = "1" ]; do sleep 5; done
sleep 20

ensure() {
    if ! pm path "$PKG" >/dev/null 2>&1; then
        [ "$installed" != "no" ] && log "没装 $PKG，先不做，装上后自动生效"
        installed=no
        return 1
    fi
    installed=yes
    if ! dumpsys deviceidle whitelist 2>/dev/null | grep -q ",$PKG,"; then
        dumpsys deviceidle whitelist +"$PKG" >/dev/null 2>&1 && log "已加入电池优化白名单"
    fi
    if ! cmd appops get "$PKG" RUN_ANY_IN_BACKGROUND 2>/dev/null | grep -q allow; then
        cmd appops set "$PKG" RUN_IN_BACKGROUND allow >/dev/null 2>&1
        cmd appops set "$PKG" RUN_ANY_IN_BACKGROUND allow >/dev/null 2>&1 && log "已允许后台运行"
    fi
    b=$(am get-standby-bucket "$PKG" 2>/dev/null)
    case "$b" in ''|*[!0-9]*) ;; *)
        if [ "$b" -gt 10 ]; then
            am set-standby-bucket "$PKG" active >/dev/null 2>&1
            am set-inactive "$PKG" false >/dev/null 2>&1
            log "待机分组 $b → 10（活跃）"
        fi ;;
    esac
    uid=$(stat -c %u "/data/data/$PKG" 2>/dev/null)
    return 0
}

# 冻结状态：Android 的冻结器（cgroup v2：apps/uid_*/pid_*/cgroup.events 里 frozen 1）
# 或 ColorOS 自己的（cgroup v1：/dev/freezer/frozen/cgroup.procs 里有这个进程）
frozen_by() {
    ev=/sys/fs/cgroup/apps/uid_$uid/pid_$1/cgroup.events
    [ -n "$uid" ] && [ -r "$ev" ] && grep -q '^frozen 1' "$ev" && { echo Android; return; }
    [ -r /dev/freezer/frozen/cgroup.procs ] && grep -qx "$1" /dev/freezer/frozen/cgroup.procs && { echo ColorOS; return; }
}

installed=""
last_check=0
last_pid=""
frozen_since=""
while true; do
    now=$(date +%s)
    if [ $((now - last_check)) -ge $CHECK ]; then
        ensure
        last_check=$now
    fi

    pids=$(pidof "$PKG")
    for pid in $pids; do
        f=/proc/$pid/oom_score_adj
        [ -w "$f" ] || continue
        cur=$(cat "$f" 2>/dev/null)
        case "$cur" in ''|*[!0-9-]*) continue ;; esac
        if [ "$cur" -gt "$OOM_BG" ]; then
            echo "$OOM_BG" > "$f" 2>/dev/null
            [ "$pid" != "$last_pid" ] && log "TT（$pid）在后台：回收优先级 $cur → $OOM_BG"
            last_pid=$pid
        fi
        by=$(frozen_by "$pid")
        if [ -n "$by" ] && [ -z "$frozen_since" ]; then
            frozen_since=$now
            log "TT（$pid）被 $by 冻结了"
        elif [ -z "$by" ] && [ -n "$frozen_since" ]; then
            log "TT（$pid）解冻，冻了 $((now - frozen_since)) 秒"
            frozen_since=""
        fi
    done
    [ -z "$pids" ] && frozen_since=""

    if [ -n "$pids" ]; then sleep $FAST; else sleep $SLOW; fi
done

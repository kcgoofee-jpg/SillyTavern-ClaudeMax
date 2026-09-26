#!/system/bin/sh
# TauriTavern 后台保活（KernelSU / Magisk 模块，开机后以 root 运行一次，然后常驻一个很轻的循环）
#
# 只动 com.tauritavern.client 这一个应用，全部是 Android 自带的开关：
#   1. 加进「电池优化」白名单（deviceidle），息屏打盹时网络不断、不被冻结
#   2. 允许后台运行（appops RUN_IN_BACKGROUND / RUN_ANY_IN_BACKGROUND）
#   3. 待机分组设为「活跃」，并标记为非闲置（每 10 分钟重设一次，系统会慢慢调低）
#   4. TT 在后台时，把它的内存回收优先级（oom_score_adj）从默认的 700–900 降到 250：
#      内存紧张时先杀别的后台应用。TT 在前台时系统自己会设成 0，不去碰
# 不联网、不下载、不含可执行文件；日志写在本模块目录的 service.log（只有时间和做了什么）。
# 卸载模块时 uninstall.sh 撤掉 1、2，3、4 本来就只在运行时有效，重启即恢复。

PKG=com.tauritavern.client
MODDIR=${0%/*}
LOG=$MODDIR/service.log
OOM_BG=250

log() { echo "$(date '+%m-%d %H:%M:%S') $*" >> "$LOG"; }

# 日志只留最近 200 行
[ -f "$LOG" ] && tail -n 200 "$LOG" > "$LOG.tmp" && mv "$LOG.tmp" "$LOG"

# 等开机完成
until [ "$(getprop sys.boot_completed)" = "1" ]; do sleep 5; done
sleep 20

if ! pm path "$PKG" >/dev/null 2>&1; then
    log "没装 $PKG，什么都不做"
    exit 0
fi

dumpsys deviceidle whitelist +"$PKG" >/dev/null 2>&1 && log "已加入电池优化白名单"
cmd appops set "$PKG" RUN_IN_BACKGROUND allow >/dev/null 2>&1
cmd appops set "$PKG" RUN_ANY_IN_BACKGROUND allow >/dev/null 2>&1 && log "已允许后台运行"

last_pid=""
n=0
while true; do
    # 每 10 分钟：待机分组保持活跃
    if [ $((n % 10)) -eq 0 ]; then
        am set-standby-bucket "$PKG" active >/dev/null 2>&1
        am set-inactive "$PKG" false >/dev/null 2>&1
    fi
    n=$((n + 1))

    # 每分钟：TT 在后台时降低被回收的优先级（只调低到 OOM_BG，不动前台时系统设的值）
    for pid in $(pidof "$PKG"); do
        f=/proc/$pid/oom_score_adj
        [ -w "$f" ] || continue
        cur=$(cat "$f" 2>/dev/null)
        case "$cur" in ''|*[!0-9-]*) continue ;; esac
        if [ "$cur" -gt "$OOM_BG" ]; then
            echo "$OOM_BG" > "$f" 2>/dev/null
            [ "$pid" != "$last_pid" ] && log "TT（$pid）在后台：回收优先级 $cur → $OOM_BG"
            last_pid=$pid
        fi
    done
    sleep 60
done

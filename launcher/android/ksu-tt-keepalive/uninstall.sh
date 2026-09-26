#!/system/bin/sh
# 卸载模块时把 service.sh 改过的设置还原成装模块之前的值（记在 prior.txt；没记的按 Android 默认）。
# KernelSU / Magisk 在开机早期（系统服务还没起来）运行这个脚本、随后删掉模块目录：
# 所以先把 prior.txt 读进变量，再在后台等开机完成后才执行 dumpsys / cmd / am。
PKG=com.tauritavern.client
MODDIR=${0%/*}
get() { sed -n "s/^$1=//p" "$MODDIR/prior.txt" 2>/dev/null | head -1; }
WL=$(get whitelist)
RIB=$(get RUN_IN_BACKGROUND)
RAIB=$(get RUN_ANY_IN_BACKGROUND)
BUCKET=$(get bucket)
(
    until [ "$(getprop sys.boot_completed)" = "1" ]; do sleep 5; done
    sleep 10
    # 原来就在白名单里（用户自己加的）就留着，否则撤掉
    [ "$WL" = "yes" ] || dumpsys deviceidle whitelist -"$PKG" >/dev/null 2>&1
    cmd appops set "$PKG" RUN_IN_BACKGROUND "${RIB:-default}" >/dev/null 2>&1
    cmd appops set "$PKG" RUN_ANY_IN_BACKGROUND "${RAIB:-default}" >/dev/null 2>&1
    # 待机分组：只在模块改过时还原（系统之后会按使用情况自己调整）
    case "$BUCKET" in
        20) am set-standby-bucket "$PKG" working_set >/dev/null 2>&1 ;;
        30) am set-standby-bucket "$PKG" frequent >/dev/null 2>&1 ;;
        40) am set-standby-bucket "$PKG" rare >/dev/null 2>&1 ;;
        45) am set-standby-bucket "$PKG" restricted >/dev/null 2>&1 ;;
    esac
) </dev/null >/dev/null 2>&1 &

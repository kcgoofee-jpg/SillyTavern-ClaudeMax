#!/system/bin/sh
# KernelSU 管理器里点模块的「执行」按钮：只读，显示 TT 现在的后台状态和最近的日志
PKG=com.tauritavern.client
MODDIR=${0%/*}
echo "== TauriTavern 后台状态 =="
if dumpsys deviceidle whitelist | grep -q ",$PKG,"; then echo "电池优化白名单：在"; else echo "电池优化白名单：不在"; fi
echo "后台运行：$(cmd appops get "$PKG" RUN_ANY_IN_BACKGROUND 2>/dev/null | head -1)"
b=$(am get-standby-bucket "$PKG" 2>/dev/null)
case "$b" in 5) m="豁免，最好" ;; 10) m="活跃" ;; 20) m="常用" ;; 30) m="偶尔" ;; 40) m="很少" ;; 45) m="受限" ;; *) m="?" ;; esac
echo "待机分组：$b（$m）"
uid=$(stat -c %u "/data/data/$PKG" 2>/dev/null)
for pid in $(pidof "$PKG"); do
    fz="没冻结"
    grep -q '^frozen 1' "/sys/fs/cgroup/apps/uid_$uid/pid_$pid/cgroup.events" 2>/dev/null && fz="被 Android 冻结"
    grep -qx "$pid" /dev/freezer/frozen/cgroup.procs 2>/dev/null && fz="被 ColorOS 冻结"
    echo "进程 $pid：回收优先级 $(cat /proc/$pid/oom_score_adj 2>/dev/null)（越小越晚被杀，900 以上会被冻结），$fz"
done
[ -z "$(pidof "$PKG")" ] && echo "TT 没在运行"
echo "== 最近的日志 =="
tail -n 10 "$MODDIR/service.log" 2>/dev/null

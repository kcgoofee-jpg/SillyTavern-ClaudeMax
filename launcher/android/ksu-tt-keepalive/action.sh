#!/system/bin/sh
# KernelSU 管理器里点模块的「执行」按钮：只读，显示 TT 现在的后台状态和最近的日志
PKG=com.tauritavern.client
MODDIR=${0%/*}
echo "== TauriTavern 后台状态 =="
if dumpsys deviceidle whitelist | grep -q "$PKG"; then echo "电池优化白名单：在"; else echo "电池优化白名单：不在"; fi
echo "后台运行：$(cmd appops get "$PKG" RUN_ANY_IN_BACKGROUND 2>/dev/null | head -1)"
echo "待机分组：$(am get-standby-bucket "$PKG" 2>/dev/null)（10 = 活跃）"
for pid in $(pidof "$PKG"); do echo "进程 $pid 回收优先级：$(cat /proc/$pid/oom_score_adj 2>/dev/null)（越小越晚被杀）"; done
[ -z "$(pidof "$PKG")" ] && echo "TT 没在运行"
echo "== 最近的日志 =="
tail -n 8 "$MODDIR/service.log" 2>/dev/null

#!/system/bin/sh
# 卸载模块时撤掉 service.sh 做的持久改动（待机分组和回收优先级重启后本来就会恢复）
PKG=com.tauritavern.client
dumpsys deviceidle whitelist -"$PKG" >/dev/null 2>&1
cmd appops set "$PKG" RUN_IN_BACKGROUND default >/dev/null 2>&1
cmd appops set "$PKG" RUN_ANY_IN_BACKGROUND default >/dev/null 2>&1

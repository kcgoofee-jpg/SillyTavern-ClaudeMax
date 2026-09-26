#!/bin/zsh
# 打包模块：launcher/android/ksu-tt-keepalive → launcher/android/dist/claudemax-tt-keepalive-<版本>.zip
# KernelSU 直接用；也带了 Magisk 要的 META-INF（按 Magisk 文档写的安装器，Magisk 上没实测过）。
set -e
HERE=${0:A:h}
cd "$HERE/ksu-tt-keepalive"
v=$(sed -n "s/^version=//p" module.prop)
out="$HERE/dist"; mkdir -p "$out"
rm -f "$out/claudemax-tt-keepalive-$v.zip"
for f in service.sh uninstall.sh action.sh customize.sh META-INF/com/google/android/update-binary; do sh -n "$f"; done
COPYFILE_DISABLE=1 zip -q -X "$out/claudemax-tt-keepalive-$v.zip" module.prop service.sh uninstall.sh action.sh customize.sh \
    META-INF/com/google/android/update-binary META-INF/com/google/android/updater-script
print -r -- "$out/claudemax-tt-keepalive-$v.zip"

#!/bin/zsh
# 打包 KernelSU / Magisk 模块：launcher/android/ksu-tt-keepalive → launcher/android/dist/claudemax-tt-keepalive-<版本>.zip
set -e
HERE=${0:A:h}
cd "$HERE/ksu-tt-keepalive"
v=$(sed -n "s/^version=//p" module.prop)
out="$HERE/dist"; mkdir -p "$out"
rm -f "$out/claudemax-tt-keepalive-$v.zip"
COPYFILE_DISABLE=1 zip -q -X "$out/claudemax-tt-keepalive-$v.zip" module.prop service.sh uninstall.sh action.sh
print -r -- "$out/claudemax-tt-keepalive-$v.zip"

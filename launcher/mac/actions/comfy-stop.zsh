#!/bin/zsh
# 关闭本地生图（ComfyUI）
source "${0:A:h}/../lib.zsh"
banner "关闭生图"
stop_comfy
summary
pause_end

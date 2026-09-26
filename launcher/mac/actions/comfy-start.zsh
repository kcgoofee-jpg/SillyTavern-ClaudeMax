#!/bin/zsh
# 启动本地生图（ComfyUI），给柏宝绘用
source "${0:A:h}/../lib.zsh"
banner "启动生图"
explain "启动本机的 ComfyUI（端口 8188）。柏宝绘的出图渠道选 ComfyUI、地址填 http://127.0.0.1:8188。"
explain "生图很占内存，不用时在酒馆工具里选「关闭生图」。"
start_comfy
summary
pause_end

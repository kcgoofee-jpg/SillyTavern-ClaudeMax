#!/bin/zsh
# 关闭酒馆和 Claude 代理
source "${0:A:h}/lib.zsh"
banner "关闭酒馆"
explain "会关闭酒馆网页服务和 Claude 代理，聊天记录都已保存在本地，不会丢失。"
explain "只会关闭本工具箱管理的程序，不影响电脑上的其他程序。"
stop_all
show_running
summary
pause_end

#!/bin/zsh
# 修复依赖：重新安装酒馆和 Claude 代理的 npm 依赖（不会动聊天记录和设置）
source "${0:A:h}/lib.zsh"
banner "修复依赖"
explain "重新安装${ST_DIR:+酒馆和 }Claude 代理需要的程序库（npm 依赖），用于："
explain "  · 日志里提示 Cannot find module / 缺少依赖    · 更新代码之后启动失败"
explain "不会动你的聊天记录、角色卡和设置。需要联网，约 1–2 分钟。"
if [[ -n "$(our_pids $ST_PORT)$(our_pids $PROXY_PORT)" ]]; then
    warn "酒馆或代理正在运行，安装完成后需要双击「重启酒馆」才会生效"
fi
if ! ask_yes "开始安装吗？"; then
    pause_end 0
fi
reinstall_deps "$PROXY_DIR" "Claude 代理"
has_st && reinstall_deps "$ST_DIR" "酒馆"   # 没有酒馆（TauriTavern 用户）就不装：ST_DIR 为空时 npm 会装进家目录
step "安装后自检"
self_check
summary
pause_end

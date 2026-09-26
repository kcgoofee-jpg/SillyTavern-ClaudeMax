#!/bin/zsh
# 登录 / 重新登录 Claude 订阅账号
source "${0:A:h}/../lib.zsh"
banner "登录 Claude 订阅"
explain "会打开浏览器，用你的 Claude（Pro / Max）账号授权。"
explain "登录信息保存在 macOS 钥匙串里，代理会自动读取，一般只需要登录一次。"
explain "如果浏览器没有自动打开，把终端里显示的网址复制到浏览器；网页给出授权码时，粘贴回这个窗口。"
step "开始登录"
(cd "$PROXY_DIR" && node bin/claude-cli.js auth login)
step "确认登录结果"
check_login
if [[ -n "$(our_pids $PROXY_PORT)" ]]; then
    explain "代理正在运行，会自动使用新的登录信息，不需要重启。"
fi
summary
pause_end

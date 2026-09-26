#!/bin/zsh
# 首次安装（macOS）：下载或 git clone 本仓库后，双击这个文件，按提示一步步来。
#   ① Node.js  ② 程序依赖  ③ 登录 Claude  ④ 桌面放「酒馆工具」快捷方式  ⑤ 启动代理，打开 TauriTavern / 酒馆
# 可以重复运行：已经做好的步骤会跳过。
source "${0:A:h}/lib.zsh"
banner "首次安装"
explain "装好以后，平时只用桌面上的「酒馆工具」：启动、关闭、检查、手机连接都在里面。"

step "1/5 Node.js（代理靠它运行）"
if ! command -v node >/dev/null; then
    fail "没有找到 Node.js"
    if command -v brew >/dev/null && ask_yes "用 Homebrew 安装 Node.js 吗？（需要联网，几分钟）"; then
        brew install node || { fail "安装失败"; fix "到 https://nodejs.org 下载 LTS 安装包，装好后再双击本脚本。"; summary; pause_end 1; }
        (( FAIL_COUNT-- ))
    else
        fix "浏览器会打开 Node.js 官网：下载 LTS 版本的 macOS 安装包，装好后再双击本脚本。"
        open "https://nodejs.org/zh-cn/download"
        summary; pause_end 1
    fi
fi
nv=$(node -v)
if (( ${${nv#v}%%.*} < 18 )); then
    fail "Node.js 版本太旧：$nv（需要 18 或更高）"
    fix "到 https://nodejs.org 安装新版 LTS，再双击本脚本。"
    summary; pause_end 1
fi
ok "Node.js $nv"

step "2/5 程序依赖"
if [[ -d "$PROXY_DIR/node_modules" ]] && (cd "$PROXY_DIR" && node -e "require.resolve('@anthropic-ai/claude-agent-sdk-'+process.platform+'-'+process.arch+'/package.json')" >/dev/null 2>&1); then
    ok "已经装好"
else
    explain "第一次要从网上下载，约 1–2 分钟。"
    reinstall_deps "$PROXY_DIR" "Claude 代理"
    (( FAIL_COUNT > 0 )) && { summary; pause_end 1; }
fi

step "3/5 登录 Claude 订阅（Pro / Max）"
if [[ "$(login_state)" == yes* ]]; then
    check_login
elif ask_yes "还没登录。现在登录吗？（会打开浏览器，用你的 Claude 账号授权，只需要一次）"; then
    (cd "$PROXY_DIR" && node scripts/claude-cli.js auth login)
    check_login
else
    warn "没有登录：代理能启动，但发消息会失败"
    fix "以后在「酒馆工具」里选「登录 Claude」。"
fi

step "4/5 桌面快捷方式"
shortcut="$HOME/Desktop/酒馆工具.command"
MARK="# 酒馆工具菜单（转到仓库里的脚本"
make_shortcut() {
    local t="$LAUNCHER_DIR/酒馆工具.command"
    print -r -- "#!/bin/zsh
$MARK，仓库更新后自动跟着更新）
t=${(q)t}
[[ -f \"\$t\" ]] || { print \"找不到酒馆工具：\$t\"; print \"下载的文件夹被移动或删掉了。到新位置双击 launcher/mac/首次安装.command，会重新放一个快捷方式。\"; read -k 1 -s 2>/dev/null; exit 1; }
exec /bin/zsh \"\$t\"" >"$shortcut" && chmod +x "$shortcut"
}
if [[ -f "$shortcut" ]] && grep -qF "$LAUNCHER_DIR/酒馆工具.command" "$shortcut"; then
    ok "桌面上已经有「酒馆工具」"
elif [[ -f "$shortcut" ]] && grep -qF "$MARK" "$shortcut"; then
    make_shortcut && ok "桌面上的「酒馆工具」指向旧位置，已经换成现在这个文件夹"
elif [[ -e "$shortcut" ]]; then
    warn "桌面上已经有一个别的「酒馆工具.command」，没有覆盖"
    explain "  菜单本体在：$LAUNCHER_DIR/酒馆工具.command"
elif ask_yes "在桌面放一个「酒馆工具」快捷方式吗？（平时双击它就行）"; then
    make_shortcut && ok "已放到桌面：酒馆工具（以后别移动下载的这个文件夹；移动了就再运行一次首次安装）"
fi

step "5/5 启动"
start_proxy
have_tt=0; [[ -d /Applications/TauriTavern.app ]] && have_tt=1
if st_managed; then
    start_st && open "http://127.0.0.1:$ST_PORT"
    explain "酒馆里：「扩展」→ Claude Max 面板 →「一键连接」。面板没出现就强制刷新一次（Cmd+Shift+R）。"
elif (( have_tt )); then
    mac_tt_open
    explain "TauriTavern 里（只需第一次）："
    explain "  ① 扩展 → 安装扩展，地址填 https://github.com/kcgoofee-jpg/SillyTavern-ClaudeMax"
    explain "  ② 打开 Claude Max 面板，点「一键连接」；弹出授权框时允许访问 127.0.0.1:$PROXY_PORT"
else
    warn "这台 Mac 上没找到 TauriTavern，也没找到酒馆（SillyTavern）"
    fix "推荐装 TauriTavern（桌面 App）：https://github.com/Darkatse/TauriTavern/releases ；装好后再双击本脚本。"
    explain "  用原版酒馆的话，把本仓库放在酒馆目录旁边（和 SillyTavern 文件夹同级），或在 launcher/config.local 里写 ST_DIR=\"酒馆目录\"。"
fi

if ! autostart_enabled && ask_yes "登录 Mac 时自动在后台启动代理吗？（以后开机就能直接用，随时可以在菜单里关）"; then
    autostart_enable
fi
explain "手机上用：菜单里的「手机模式」（同一 Wi-Fi 下手机 TauriTavern 连这台 Mac），说明见 launcher/使用说明.txt。"
summary
pause_end

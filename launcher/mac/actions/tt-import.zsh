#!/bin/zsh
# （测试用）电脑酒馆 → 这台 Mac 上的 TauriTavern：一键导入 / 更新。平时以 TT 为中心时用「手机同步」就够了
#   内容：聊天、角色卡、世界书、预设、头像、背景、图片、主题、快速回复、角色卡标签（只加不删）
#   扩展：电脑酒馆里的第三方扩展（git 版本不同就更新）
#   设置（可选，问你）：柏宝绘、MVU、小白X、酒馆助手、提示词模板（EJS）、正则（含预设 / 角色正则的允许名单）、
#         CCST 面板的扩展设置，以及对话补全设置（当前预设、模型、各项开关）
#         （以 launcher/phone_sync.py 的 EXT_SETTING_KEYS / copy_settings 为准）
# 单向：TT 独有的文件留着，TT 上更新过的文件不覆盖；被覆盖的旧文件和旧设置先备份。
source "${0:A:h}/../lib.zsh"
banner "本机 TT 导入"
TT_USER="$HOME/Library/Application Support/com.tauritavern.client/data/default-user"

if ! has_st; then
    fail "没找到电脑上的酒馆（SillyTavern），没有可导入的内容"
    summary; pause_end 1
fi
if [[ ! -d "$TT_USER" ]]; then
    fail "这台 Mac 上没找到 TauriTavern 的数据"
    fix "先安装 TauriTavern 并打开一次，再回来导入。"
    summary; pause_end 1
fi
if [[ -n "$(our_pids $ST_PORT)" ]]; then
    explain "酒馆在运行：浏览器里开着的酒馆页面可能还没保存最新改动，导入的是已经存盘的内容。"
fi

args=(--st "$ST_DIR/data/default-user" --local-tt "$TT_USER" --push-only --port $PROXY_PORT
      --state "$PROXY_DIR/launcher/local-tt-sync-state.local.json" --backups "${PROXY_DIR:h}/backups"
      --ext-dir "$ST_DIR/public/scripts/extensions/third-party")

step "预览"
python3 "$LAUNCHER_DIR/../phone_sync.py" "${args[@]}" --dry-run || { fail "读取数据失败"; summary; pause_end 1; }
settings=()
ask_yes "扩展设置和对话补全设置（当前预设、模型）也一起导入吗？（TT 上的旧设置会先备份）" && settings=(--settings)
ask_yes "开始导入吗？（会先关掉 TauriTavern，导入完再打开）" || { warn "没有导入。"; summary; pause_end; }

step "导入"
if pgrep -xq tauritavern; then
    osascript -e 'quit app "TauriTavern"' >/dev/null 2>&1
    for i in {1..20}; do pgrep -xq tauritavern || break; sleep 0.5; done
    pgrep -xq tauritavern && { fail "TauriTavern 没有关掉，先手动退出再导入"; summary; pause_end 1; }
    explain "已关掉 TauriTavern（它开着时会把旧设置写回去）"
fi
if python3 "$LAUNCHER_DIR/../phone_sync.py" "${args[@]}" "${settings[@]}"; then
    ok "导入完成"
    log_event "[同步] 电脑 → 本机 TT 导入完成"
else
    warn "有文件没导入成功，看上面的列表"
fi
[[ -z "$(our_pids $PROXY_PORT)" ]] && explain "代理没在运行：TT 要对话前，先在菜单里「启动酒馆」。"
open -a TauriTavern && ok "已打开 TauriTavern"
summary
pause_end

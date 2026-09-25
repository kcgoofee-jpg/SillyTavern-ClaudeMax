#!/bin/zsh
# 把「提示词拆分」导出的最新柏宝绘配方（下载文件夹里的 柏宝绘配方-*.json）写进柏宝绘
source "${0:A:h}/lib.zsh"
banner "导入柏宝绘配方"
explain "新建一个画师串配方（画师串 + 质量词 + 负面提示词）并选中，参数写到 NovelAI 渠道；尺寸和种子不动。"
explain "只显示 tag 数量，不显示提示词内容。"

step "找配方文件"
preset=( ~/Downloads/柏宝绘配方-*.json(N.om[1]) )
if [[ -z "$preset" ]]; then
    fail "下载文件夹里没有「柏宝绘配方-*.json」"
    fix "先在「提示词拆分」里点「导出柏宝绘配方」。"
    summary; pause_end; exit 1
fi
ok "${preset:t}"

step "写入柏宝绘"
explain "柏宝绘会把网页里的设置整份存回去：先关掉所有酒馆网页和 TT 窗口，否则会被覆盖。"
if ! ask_yes "已经关掉了吗？"; then
    warn "没有改动。关掉网页后再双击一次。"
    summary; pause_end; exit 0
fi
targets=()
[[ -n "$ST_DIR" ]] && targets+=( "$ST_DIR/data/default-user/settings.json" )
tt="$HOME/Library/Application Support/com.tauritavern.client/data/default-user/settings.json"
[[ -f "$tt" ]] && targets+=( "$tt" )
if python3 "${0:A:h}/../baibai_import.py" "$preset" "${targets[@]}"; then
    ok "完成。打开酒馆 → 柏宝绘 → 渠道 → NovelAI，画师串已选中「${${preset:t:r}#柏宝绘配方-}」。"
else
    fail "写入失败，上面有原因。"
fi
summary
pause_end

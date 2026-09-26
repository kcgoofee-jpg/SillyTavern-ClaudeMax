#!/bin/zsh
# 本地门控：提交 / 推送前自动跑（.githooks），也可以手动跑：
#   zsh scripts/gate.sh          检查暂存区（= 下一次提交的内容）
#   zsh scripts/gate.sh --push   检查还没推上去的提交（手动跑时按 @{u}..HEAD 算）
# 检查项：
#   1. 单元测试 —— 跑在「要提交的快照」上，不是工作区：
#      提交模式 = 暂存区（git checkout-index），推送模式 = HEAD（git archive）
#   2. 语法：所有 .js/.mjs/.cjs（node --check）、.sh（sh/bash -n）、.zsh/.command（zsh -n）、.py（ast 解析，不写 __pycache__）
#   3. 版本号：manifest.json 和 package.json 一致（scripts/version.mjs --check）
#   4. 密钥扫描：要提交 / 推送的「新增行」里不能有 API 密钥、令牌、私钥，
#      也不能出现 launcher/*.local 里的任何值（只报文件名，不打印值）；
#      本机文件（*.local、data/、secrets.json）不能进提交
#   --push 时另外检查：工作区干净（没有漏提交的改动）
# 注意：本文件里的正则都用了字符类（如 github[_]pat_），这样扫描自己时不会误报。
set -u
setopt extendedglob
cd "${0:A:h}/.."
root=$PWD
mode=commit; [[ "${1:-}" == --push ]] && mode=push
# pre-push 钩子会把 <远端名> <地址> 跟在 --push 后面传进来，并在 stdin 里给出要推的 ref
from_hook=0; [[ $mode == push && -n "${2:-}" ]] && from_hook=1
fail=0
say()  { print -r -- "gate: $*"; }
bad()  { print -r -- "gate: ✗ $*"; fail=1; }
ZERO=0000000000000000000000000000000000000000

[[ "$(git config core.hooksPath)" == .githooks ]] || say "提示：还没启用自动门控，运行一次 git config core.hooksPath .githooks"

snap=$(mktemp -d "${TMPDIR:-/tmp}/cm-gate.XXXXXX") || { say "mktemp 失败"; exit 1; }
trap 'rm -rf -- "$snap"' EXIT INT TERM

# ---------- 0. 取快照 ----------
if [[ $mode == commit ]]; then
    git checkout-index -a --prefix="$snap/" || bad "暂存区导出失败"
else
    git archive HEAD | tar -x -C "$snap" || bad "HEAD 导出失败"
fi
[[ -d node_modules && ! -e "$snap/node_modules" ]] && ln -s "$root/node_modules" "$snap/node_modules"

# ---------- 1. 单元测试（在快照里跑）----------
log=/tmp/cm-gate-test.log
if ! (cd "$snap" && npm test --silent) >"$log" 2>&1; then
    bad "单元测试失败（$log）"; tail -20 "$log"
fi

# ---------- 2. 语法（快照里只有被跟踪的文件；** 不跟进 node_modules 链接）----------
cd "$snap"
js=( **/*.(js|mjs|cjs)(N.) )
if (( ${#js} )); then
    print -rN -- $js | xargs -0 -P 8 -n 1 sh -c 'node --check "$1" 2>/dev/null || echo "$1"' _ >"$snap/.js-bad"
    for f in ${(f)"$(<"$snap/.js-bad")"}; do bad "JS 语法错误：$f"; done
fi
for f in **/*.sh(N.); do
    case "$(head -1 "$f")" in                  # 按 shebang 选解释器
        *zsh*)  zsh -n "$f"  2>/dev/null || bad "语法错误：$f" ;;
        *bash*) bash -n "$f" 2>/dev/null || bad "语法错误：$f" ;;
        *)      sh -n "$f"   2>/dev/null || bad "语法错误：$f" ;;
    esac
done
for f in **/*.(zsh|command)(N.); do
    zsh -n "$f" 2>/dev/null || bad "语法错误：$f"
done
py=( **/*.py(N.) )
if (( ${#py} )); then
    python3 - $py <<'EOF' | while IFS= read -r f; do bad "语法错误：$f"; done
import ast, sys
for f in sys.argv[1:]:
    try:
        ast.parse(open(f, 'rb').read(), f)
    except Exception:
        print(f)
EOF
fi

# ---------- 3. 版本号（快照里的文件）----------
# 版本号只写在 package.json（docs/版本规范.md），manifest.json 由 scripts/version.mjs 同步
node scripts/version.mjs --check || bad "版本号不一致（见上一行）"
cd "$root"

# ---------- 4. 密钥 / 本机文件：只看要提交 / 推送的内容 ----------
# names = 新增或改动的文件名；added = 新增行（去掉 +++ 文件头）
G=(git -c core.quotepath=off)
if [[ $mode == commit ]]; then
    names=$($G diff --cached --name-only --diff-filter=ACMR)
    patch=$($G diff --cached --no-color --no-ext-diff)
else
    # pre-push 的 stdin：<本地 ref> <本地 sha> <远端 ref> <远端 sha>
    # 手动跑时自己按 @{u}..HEAD 造一行（没有上游就看所有不在任何远端分支上的提交）
    if (( ! from_hook )); then
        up=$(git rev-parse -q --verify '@{u}' 2>/dev/null) || up=$ZERO
        refs="HEAD $(git rev-parse HEAD) @{u} $up"
    else
        refs=$(cat)
    fi
    names= patch=
    while read -r lref lsha rref rsha; do
        [[ -n "${lsha:-}" && $lsha != $ZERO ]] || continue            # 删除远端分支：没有新内容
        if [[ $rsha != $ZERO ]] && git cat-file -e "$rsha^{commit}" 2>/dev/null; then
            excl=(--not "$rsha")                                       # 已有分支：只看新提交
        else
            excl=(--not --remotes)                                     # 新分支 / 远端提交本地没有
        fi
        names+=$($G log --format= --name-only --diff-filter=ACMR "$lsha" $excl)$'\n'
        patch+=$($G log --format= -p --no-color --no-ext-diff "$lsha" $excl)$'\n'
    done <<< "$refs"
fi
added=$(print -r -- "$patch" | grep -E '^\+' | grep -vE '^\+\+\+ ')

PAT='sk-ant-[A-Za-z0-9_-]{10,}|sk-[A-Za-z0-9]{24,}|sk-(proj|svcacct|admin)-[A-Za-z0-9_-]{20,}'
PAT+='|gh[pousr]_[A-Za-z0-9]{20,}|github[_]pat_'
PAT+='|AIza[0-9A-Za-z_-]{30}|pst-[A-Za-z0-9]{20,}'
PAT+='|-----BEGIN [A-Z ]*PRIVATE KEY-----|BEGIN (RSA|OPENSSH) PRIVATE'
PAT+='|AKIA[0-9A-Z]{16}|xox[bpars]-[A-Za-z0-9-]{10,}'
PAT+='|eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+'
print -r -- "$added" | grep -qE "$PAT" && { [[ $mode == commit ]] && bad "要提交的内容里像有密钥（git diff --cached 自己看看）" \
                                || bad "要推送的提交里像有密钥（git log -p @{u}..HEAD 自己看看）"; }

# launcher/*.local 里的每个值（KEY=VALUE 取值，否则整行）；太短的、纯 IP/端口的跳过；绝不打印值
for f in launcher/*.local(N.); do
    while IFS= read -r line || [[ -n $line ]]; do
        line=${line%$'\r'}
        [[ $line == \#* || -z $line ]] && continue
        [[ $line == [A-Za-z_][A-Za-z0-9_]#=* ]] && line=${line#*=}
        line=${${line#[\"\']}%[\"\']}
        (( ${#line} >= 12 )) || continue
        [[ $line == [0-9.:]## ]] && continue
        if print -r -- "$added" | grep -qF -e "$line"; then
            bad "$f 里的某个值出现在要提交的内容里（值不显示）"; break
        fi
    done < "$f"
done

print -r -- "$names" | grep -E '\.local(\.|$)|(^|/)data/|secrets\.json' && bad "本机文件被加进了提交"

if [[ $mode == push ]]; then
    [[ -z "$(git status --porcelain)" ]] || bad "还有没提交的改动"
fi

(( fail )) && { say "没通过"; exit 1; }
say "✓ 通过"

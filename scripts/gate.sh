#!/bin/zsh
# 本地门控：提交 / 推送前自动跑（.githooks），也可以手动跑：zsh scripts/gate.sh [--push]
#   1. 单元测试
#   2. 启动器脚本语法（zsh -n）、Python 语法
#   3. 版本号四处一致（manifest / package / status.js / 测试）
#   4. 密钥扫描：要提交的内容里不能有 API 密钥、访问密码、手机地址等本机文件
#   --push 时另外检查：工作区干净（没有漏提交的改动）
set -u
cd "${0:A:h}/.."
fail=0
say()  { print -r -- "gate: $*"; }
bad()  { print -r -- "gate: ✗ $*"; fail=1; }

# 1
if ! npm test --silent >/tmp/cm-gate-test.log 2>&1; then
    bad "单元测试失败（/tmp/cm-gate-test.log）"; tail -20 /tmp/cm-gate-test.log
fi

# 2
for f in launcher/mac/*.zsh launcher/mac/*.command; do
    zsh -n "$f" 2>/dev/null || bad "语法错误：$f"
done
for f in launcher/android/*/*.sh; do
    [[ -f "$f" ]] && { sh -n "$f" 2>/dev/null || bad "语法错误：$f"; }
done
for f in launcher/*.py; do
    python3 -m py_compile "$f" 2>/dev/null || bad "语法错误：$f"
done
node --check index.js server.js plugin.js 2>/dev/null || bad "JS 语法错误"

# 3
v=$(node -p "require('./package.json').version")
[[ "$(node -p "require('./manifest.json').version")" == "$v" ]] || bad "manifest.json 版本 ≠ package.json $v"
grep -q "'$v'" lib/status.js || bad "lib/status.js 里的版本不是 $v"
grep -q "$v" test/models.test.js || bad "test/models.test.js 里的版本不是 $v"

# 4：只看要提交 / 推送的内容
if [[ "${1:-}" == --push ]]; then
    range="@{u}..HEAD"; git rev-parse -q --verify '@{u}' >/dev/null || range=HEAD
    content=$(git log -p "$range" 2>/dev/null)
else
    content=$(git diff --cached)
fi
PAT='sk-ant-[A-Za-z0-9_-]{10,}|sk-[A-Za-z0-9]{24,}|ghp_[A-Za-z0-9]{20,}|github[_]pat_|AIza[0-9A-Za-z_-]{30}|pst-[A-Za-z0-9]{20,}|BEGIN (RSA|OPENSSH) PRIVATE'
if print -r -- "$content" | /usr/bin/grep -qE "^\+.*($PAT)"; then bad "要提交的内容里像有密钥"; fi
for f in launcher/*.local launcher/*.local.*; do
    [[ -f "$f" ]] || continue
    if [[ "$f" == *lan-key* && -s "$f" ]] && print -r -- "$content" | /usr/bin/grep -qF -- "$(<"$f")"; then bad "访问密码出现在要提交的内容里"; fi
done
git diff --cached --name-only | /usr/bin/grep -E '\.local(\.|$)|/data/|secrets\.json' && bad "本机文件被加进了提交"

if [[ "${1:-}" == --push ]]; then
    [[ -z "$(git status --porcelain)" ]] || bad "还有没提交的改动"
fi

(( fail )) && { say "没通过"; exit 1; }
say "✓ 通过"

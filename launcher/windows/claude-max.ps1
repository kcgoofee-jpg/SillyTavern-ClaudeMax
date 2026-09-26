# ──────────────────────────────────────────────
# CCST 启动器 · Windows
# 由菜单（launcher/menu.mjs，入口 酒馆工具.bat）调用：claude-max.ps1 <login|repair|autostart|autostart-run|logs>
# 只剩 Windows 自己的事。检查状态、启动 / 关闭 / 重启在 launcher/core.mjs（和 Mac、Termux 同一份）；
# 这里的 start|stop|restart|status 只是转给它，留着给直接运行这个脚本的老用法。
#
# 路径自动识别：
#   代理目录 = 本仓库根目录
#   酒馆目录 = 仓库装在 SillyTavern\plugins\ 下时取上两级；否则找仓库旁边的 SillyTavern 文件夹；
#              都没有就只管理代理（TauriTavern 用户）
# 手动指定：在 launcher\config.local.ps1 里写（该文件不会被提交）
#   $ST_DIR = 'D:\SillyTavern'; $LOG_DIR = 'D:\logs'; $ST_PORT = 8000; $PROXY_PORT = 8901
# ──────────────────────────────────────────────

param([string]$Action = 'status')

$ErrorActionPreference = 'Continue'
try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch {}

$PROXY_DIR = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$ST_DIR = ''
$LOG_DIR = Join-Path $PROXY_DIR 'data\logs'
$ST_PORT = 8000
$PROXY_PORT = 8901
$cfg = Join-Path $PROXY_DIR 'launcher\config.local.ps1'
if (Test-Path $cfg) { . $cfg }
if (-not $ST_DIR) {
    $parent = Split-Path $PROXY_DIR -Parent
    if ((Split-Path $parent -Leaf) -eq 'plugins' -and (Test-Path (Join-Path (Split-Path $parent -Parent) 'server.js'))) {
        $ST_DIR = Split-Path $parent -Parent
    } elseif (Test-Path (Join-Path $parent 'SillyTavern\server.js')) {
        $ST_DIR = Join-Path $parent 'SillyTavern'
    }
}
New-Item -ItemType Directory -Force -Path $LOG_DIR | Out-Null
$LAUNCHER_LOG = Join-Path $LOG_DIR 'launcher.log'

$script:Warn = 0
$script:Fail = 0

function Log($t) { Add-Content -Path $LAUNCHER_LOG -Value "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') $t" -Encoding UTF8 }
function Banner($t) { Write-Host ''; Write-Host '════════════════════════════════════════════' -ForegroundColor Cyan; Write-Host "  $t"; Write-Host '════════════════════════════════════════════' -ForegroundColor Cyan; Log "===== $t =====" }
function Step($t) { Write-Host ''; Write-Host "▶ $t" -ForegroundColor White; Log "[步骤] $t" }
function Explain($t) { Write-Host "  $t" -ForegroundColor DarkGray }
function Ok($t) { Write-Host '  ✓ ' -ForegroundColor Green -NoNewline; Write-Host $t; Log "[正常] $t" }
function Warn($t) { Write-Host '  ! ' -ForegroundColor Yellow -NoNewline; Write-Host $t; Log "[提醒] $t"; $script:Warn++ }
function Fail($t) { Write-Host '  ✗ ' -ForegroundColor Red -NoNewline; Write-Host $t; Log "[错误] $t"; $script:Fail++ }
function Fix($t) { Write-Host '    解决办法：' -ForegroundColor Yellow -NoNewline; Write-Host $t }
function AskYes($q) { (Read-Host "  $q (y/N)") -match '^[yY]' }
function HasSt { [bool]$ST_DIR }

function Summary {
    Write-Host ''
    Write-Host '──────── 结果 ────────'
    if ($script:Fail -gt 0) { Write-Host "  有 $($script:Fail) 个问题需要处理，见上面标 ✗ 的项目和「解决办法」。" -ForegroundColor Red }
    elseif ($script:Warn -gt 0) { Write-Host "  可以使用，但有 $($script:Warn) 条提醒，见上面标 ! 的项目。" -ForegroundColor Yellow }
    else { Write-Host '  一切正常。' -ForegroundColor Green }
    Write-Host "  日志文件夹：$LOG_DIR"
    Log "结果：错误 $($script:Fail)，提醒 $($script:Warn)"
}

# ── 交给共用的 core.mjs ──

$CORE = Join-Path $PROXY_DIR 'launcher\core.mjs'
# Start-Process：node 直接用这个控制台（颜色、提问照常），它的输出也不会混进函数返回值
function Core([string[]]$argv) {
    $p = Start-Process -FilePath 'node' -ArgumentList (@("`"$CORE`"") + $argv) -NoNewWindow -Wait -PassThru
    return $p.ExitCode
}

function CheckLogin {
    Push-Location $PROXY_DIR
    $json = node bin/claude-cli.js auth status 2>$null | Out-String
    Pop-Location
    try { $j = $json | ConvertFrom-Json } catch { $j = $null }
    if ($j -and $j.loggedIn) { Ok "Claude 订阅已登录（$($j.subscriptionType) 套餐）" }
    elseif ($j) { Warn 'Claude 订阅还没有登录 —— 酒馆能打开，但发消息会失败'; Fix '在酒馆工具「维护」里选「登录 Claude」。' }
    else { Warn '无法读取 Claude 登录状态'; Explain '  可能是代理依赖不完整，先选「修复依赖」。' }
}

# ── 开机自动启动（启动文件夹里的快捷方式）──

$STARTUP_LNK = Join-Path ([Environment]::GetFolderPath('Startup')) 'CCST 启动器.lnk'
# 3.0 之前叫「Claude Max 启动器」：开着旧的也算开启，关闭时一起删
$OLD_STARTUP_LNK = Join-Path ([Environment]::GetFolderPath('Startup')) 'Claude Max 启动器.lnk'

function AutostartToggle {
    Step '当前状态'
    if ((Test-Path $STARTUP_LNK) -or (Test-Path $OLD_STARTUP_LNK)) {
        Ok '开机自动启动：已开启'
        if (AskYes '要关闭开机自动启动吗？') { Remove-Item $STARTUP_LNK, $OLD_STARTUP_LNK -ErrorAction SilentlyContinue; Ok '已关闭（现在正在运行的程序不受影响）' }
    } else {
        Explain '· 开机自动启动：未开启'
        if (AskYes '要开启开机自动启动吗？') {
            $sh = New-Object -ComObject WScript.Shell
            $l = $sh.CreateShortcut($STARTUP_LNK)
            $l.TargetPath = 'powershell.exe'
            $l.Arguments = "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$PSCommandPath`" autostart-run"
            $l.WorkingDirectory = $PSScriptRoot
            $l.Save()
            Ok '已开启：以后登录 Windows 时会在后台自动启动'
        }
    }
}

function PauseEnd { Write-Host ''; Read-Host '按回车键关闭窗口' | Out-Null }

switch ($Action) {
    'start' { exit (Core @('start')) }
    'stop' { exit (Core @('stop')) }
    'restart' { exit (Core @('restart')) }
    'status' { exit (Core @('check')) }
    'login' {
        Banner '登录 Claude 订阅'
        Explain '会打开浏览器，用你的 Claude（Pro / Max）账号授权。登录信息保存在 %USERPROFILE%\.claude 里，一般只需要登录一次。'
        Explain '如果浏览器没有自动打开，把窗口里显示的网址复制到浏览器；网页给出授权码时，粘贴回这个窗口。'
        Push-Location $PROXY_DIR; node bin/claude-cli.js auth login; Pop-Location
        Step '确认登录结果'; CheckLogin; Summary; PauseEnd
    }
    'repair' {
        Banner '修复依赖'
        Explain '重新安装程序库（npm 依赖）。不会动聊天记录、角色卡和设置。需要联网，约 1–2 分钟。'
        if (AskYes '开始安装吗？') {
            foreach ($d in @($PROXY_DIR) + @(if (HasSt) { $ST_DIR })) {
                Step "重新安装依赖：$d"
                Push-Location $d; npm install --no-audit --no-fund; $code = $LASTEXITCODE; Pop-Location
                if ($code -eq 0) { Ok '安装完成' } else { Fail '安装失败'; Fix '检查网络后再试一次。' }
            }
            Explain '如果程序正在运行，需要运行「重启」才会生效。'
        }
        Summary; PauseEnd
    }
    'autostart' { Banner '开机自动启动（开关）'; AutostartToggle; Summary; PauseEnd }
    'autostart-run' { Start-Sleep -Seconds 5; Core @('start', '--auto') | Out-Null }
    'logs' { Invoke-Item $LOG_DIR }
    default { Write-Host "未知操作：$Action" }
}

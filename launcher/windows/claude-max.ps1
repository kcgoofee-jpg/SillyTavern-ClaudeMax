# ──────────────────────────────────────────────
# Claude Max 启动器 · Windows
# 由同目录的 .bat 调用：claude-max.ps1 <start|stop|restart|status|login|repair|autostart|autostart-run|logs>
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

# ── 进程 / 端口 ──
# 自己启动的进程把 PID 记在日志目录里，关闭时只关这些，不影响电脑上的其他 node 程序。

function PidFile($name) { Join-Path $LOG_DIR "$name.pid" }

function PortPids($port) {
    @(Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique)
}

function OurPid($name, $port) {
    $f = PidFile $name
    if (-not (Test-Path $f)) { return $null }
    $id = [int](Get-Content $f -ErrorAction SilentlyContinue | Select-Object -First 1)
    if ($id -and (PortPids $port) -contains $id) { return $id }
    return $null
}

function CheckPort($port, $name, $key) {
    $pids = PortPids $port
    if (-not $pids) { Ok "端口 $port 空闲（留给$name）"; return }
    if (OurPid $key $port) { Ok "$name 已经在运行（端口 $port）"; return }
    $owner = (Get-Process -Id $pids[0] -ErrorAction SilentlyContinue).ProcessName
    if ($owner -eq 'node') { Warn "端口 $port 已被一个 node 程序占用（可能是你手动启动的$name，或者酒馆插件自带的代理）"; return }
    Fail "端口 $port 被其他程序占用：$owner"
    Fix "关闭「$owner」后再试，或重启电脑。"
}

function WaitPort($port, $secs) {
    for ($i = 0; $i -lt $secs; $i++) {
        if (PortPids $port) { return $true }
        Start-Sleep -Seconds 1
        if ($i -gt 0 -and $i % 10 -eq 0) { Explain "已等待 $i 秒…" }
    }
    return $false
}

# ── 自检 ──

function CheckDeps($dir, $name) {
    if (Test-Path (Join-Path $dir 'node_modules')) { Ok "$name 依赖已安装"; return }
    Fail "$name 缺少依赖（没有 node_modules 文件夹）"
    if (AskYes "现在自动安装 $name 的依赖吗？需要联网，约 1 分钟") {
        Push-Location $dir; npm install --no-audit --no-fund; $code = $LASTEXITCODE; Pop-Location
        if ($code -eq 0) { Ok "$name 依赖安装完成"; $script:Fail-- } else { Fail "$name 依赖安装失败"; Fix "检查网络后重试，或在 $dir 运行 npm install 查看报错。" }
    } else { Fix "在 $dir 运行 npm install。" }
}

function CheckLogin {
    Push-Location $PROXY_DIR
    $json = node bin/claude-cli.js auth status 2>$null | Out-String
    Pop-Location
    try { $j = $json | ConvertFrom-Json } catch { $j = $null }
    if ($j -and $j.loggedIn) { Ok "Claude 订阅已登录（$($j.subscriptionType) 套餐）" }
    elseif ($j) { Warn 'Claude 订阅还没有登录 —— 酒馆能打开，但发消息会失败'; Fix '双击「登录 Claude」。' }
    else { Warn '无法读取 Claude 登录状态'; Explain '  可能是代理依赖不完整，先处理上面的错误。' }
}

function SelfCheck {
    Step '自检：确认运行环境是否完整'
    if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
        Fail '没有找到 Node.js（酒馆和代理都靠它运行）'
        Fix '到 https://nodejs.org 下载安装 LTS 版本，装好后重新双击。'
        return
    }
    $nv = node -v
    if ([int]($nv.TrimStart('v').Split('.')[0]) -lt 18) { Fail "Node.js 版本太旧：$nv（需要 18 或更高）"; Fix '到 https://nodejs.org 安装新版 LTS。' } else { Ok "Node.js $nv" }
    if (HasSt) {
        if (Test-Path (Join-Path $ST_DIR 'server.js')) { Ok "酒馆程序：$ST_DIR" } else { Fail "找不到酒馆程序（$ST_DIR\server.js）"; Fix '检查 launcher\config.local.ps1 里的 $ST_DIR。' }
    } else {
        Explain '· 没有找到酒馆目录，只管理 Claude 代理（TauriTavern 用户不需要酒馆）'
        Explain '  需要一起启动酒馆的话，在 launcher\config.local.ps1 里写 $ST_DIR = ''酒馆目录'''
    }
    Ok "Claude 代理程序：$PROXY_DIR"
    if (HasSt) { CheckDeps $ST_DIR '酒馆' }
    CheckDeps $PROXY_DIR 'Claude 代理'
    $arch = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'arm64' } else { 'x64' }
    if (Test-Path (Join-Path $PROXY_DIR "node_modules\@anthropic-ai\claude-agent-sdk-win32-$arch")) { Ok 'Claude 命令行程序（SDK 自带）' }
    else { Fail '缺少 Claude 命令行程序（SDK 的平台包没装上）'; Fix '双击「修复依赖」重新安装。' }
    CheckLogin
    if (HasSt) {
        $yaml = Join-Path $ST_DIR 'config.yaml'
        if ((Test-Path $yaml) -and (Select-String -Path $yaml -Pattern '^enableServerPlugins:\s*true' -Quiet)) { Ok '酒馆已开启服务器插件' }
        else { Warn '酒馆 config.yaml 里没有开启 enableServerPlugins'; Explain '  不影响对话（代理是独立启动的），只是酒馆页面会直接连代理读取状态。' }
        CheckPort $ST_PORT '酒馆' 'sillytavern'
    }
    CheckPort $PROXY_PORT 'Claude 代理' 'proxy'
}

# ── 启动 / 关闭 ──

function StartNode($name, $dir, $port, $secs, $label) {
    if (OurPid $name $port) { Ok "$label 已经在运行，跳过"; return $true }
    if (PortPids $port) { Warn "端口 $port 已被占用，跳过启动$label"; return $true }
    $out = Join-Path $LOG_DIR "$name.log"
    $err = Join-Path $LOG_DIR "$name.err.log"
    $p = Start-Process -FilePath 'node' -ArgumentList 'server.js' -WorkingDirectory $dir -WindowStyle Hidden `
        -RedirectStandardOutput $out -RedirectStandardError $err -PassThru
    Set-Content -Path (PidFile $name) -Value $p.Id
    if (WaitPort $port $secs) { Ok "$label 已启动：http://127.0.0.1:$port"; return $true }
    Fail "$label $secs 秒内没有启动成功"
    Explain "最后几行日志（$err）："
    Get-Content $err -Tail 8 -ErrorAction SilentlyContinue | ForEach-Object { Explain "  │ $_" }
    return $false
}

function StartProxy {
    Step "启动 Claude 代理（端口 $PROXY_PORT）"
    # 端口要告诉代理：config.local.ps1 里改了 $PROXY_PORT 时，代理自己的默认值还是 8901（子进程继承环境变量）
    $env:CLAUDE_SUBSCRIPTION_PORT = "$PROXY_PORT"
    StartNode 'proxy' $PROXY_DIR $PROXY_PORT 20 'Claude 代理' | Out-Null
}

function StartSt {
    if (-not (HasSt)) { return $false }
    Step "启动酒馆（端口 $ST_PORT）"
    Explain '首次启动或更新后需要编译前端，可能要 10–60 秒。'
    return (StartNode 'sillytavern' $ST_DIR $ST_PORT 120 '酒馆')
}

function StopOne($name, $port, $label) {
    $id = OurPid $name $port
    if (-not $id) { Ok "$label 本来就没有运行（或不是本启动器启动的）"; return }
    Stop-Process -Id $id -ErrorAction SilentlyContinue
    for ($i = 0; $i -lt 10 -and (Get-Process -Id $id -ErrorAction SilentlyContinue); $i++) { Start-Sleep -Seconds 1 }
    if (Get-Process -Id $id -ErrorAction SilentlyContinue) { Stop-Process -Id $id -Force -ErrorAction SilentlyContinue; Warn "$label 没有正常退出，已强制关闭" }
    else { Ok "已关闭$label" }
    Remove-Item (PidFile $name) -ErrorAction SilentlyContinue
}

function StopAll {
    Step '关闭酒馆和 Claude 代理'
    if (HasSt) { StopOne 'sillytavern' $ST_PORT '酒馆' }
    StopOne 'proxy' $PROXY_PORT 'Claude 代理'
}

function HealthCheck {
    Step '启动后检查：确认服务真的能用'
    try {
        $s = Invoke-RestMethod -Uri "http://127.0.0.1:$PROXY_PORT/status" -TimeoutSec 5
        if (-not $s.ok) { Fail '代理有响应，但报告异常（SDK 未加载）' }
        elseif ($s.credential.present) { Ok "代理正常（v$($s.version)，$($s.credential.subscriptionType) 订阅）" }
        else { Warn '代理正常，但没有找到 Claude 登录凭据'; Fix '双击「登录 Claude」。' }
    } catch { Fail '代理没有响应'; Fix '看日志文件夹里的 proxy.err.log。' }
    if (HasSt) {
        try { Invoke-WebRequest -Uri "http://127.0.0.1:$ST_PORT/" -UseBasicParsing -TimeoutSec 5 | Out-Null; Ok '酒馆网页可以打开' }
        catch { if ($_.Exception.Response) { Ok '酒馆网页有响应' } else { Fail '酒馆网页打不开（没有响应）' } }
    }
}

# ── 开机自动启动（启动文件夹里的快捷方式）──

$STARTUP_LNK = Join-Path ([Environment]::GetFolderPath('Startup')) 'Claude Max 启动器.lnk'

function AutostartToggle {
    Step '当前状态'
    if (Test-Path $STARTUP_LNK) {
        Ok '开机自动启动：已开启'
        if (AskYes '要关闭开机自动启动吗？') { Remove-Item $STARTUP_LNK; Ok '已关闭（现在正在运行的程序不受影响）' }
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
    'start' {
        Banner '启动'
        SelfCheck
        if ($script:Fail -gt 0 -and -not (AskYes "自检发现 $($script:Fail) 个问题，仍然尝试启动吗？")) { Summary; PauseEnd; exit 1 }
        $script:Fail = 0
        StartProxy
        $stOk = StartSt
        HealthCheck
        Summary
        if ($stOk) { Start-Process "http://127.0.0.1:$ST_PORT" }
        elseif (-not (HasSt)) { Write-Host ''; Write-Host '  代理已就绪。打开 TauriTavern（或你的酒馆），在 Claude Max 面板里点「一键连接」。' }
        PauseEnd
    }
    'stop' { Banner '关闭'; StopAll; Summary; PauseEnd }
    'restart' {
        Banner '重启'
        StopAll; SelfCheck; $script:Fail = 0
        StartProxy; $stOk = StartSt; HealthCheck; Summary
        if ($stOk) { Start-Process "http://127.0.0.1:$ST_PORT" }
        PauseEnd
    }
    'status' {
        Banner '检查状态（体检）'
        Explain '只检查、不改动。对话出问题时先运行这个，把结果截图就能看出问题在哪。'
        SelfCheck
        if (PortPids $PROXY_PORT) { HealthCheck }
        Summary
        if (AskYes '要打开日志文件夹吗？') { Invoke-Item $LOG_DIR }
        PauseEnd
    }
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
    'autostart-run' { Start-Sleep -Seconds 5; StartProxy; StartSt | Out-Null }
    'logs' { Invoke-Item $LOG_DIR }
    default { Write-Host "未知操作：$Action" }
}

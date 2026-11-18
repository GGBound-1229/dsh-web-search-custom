<#
.SYNOPSIS
    安装 / 升级 / 修复 dsh-web-search-custom 到 DSH profile。

.DESCRIPTION
    重装 DSH 后 profile 会被重建，插件也随之丢失。重新跑一遍本脚本即可恢复：
      备份 -> 复制插件 -> 写 package.json 依赖与 bundle -> 写 cordis.patch.yml 覆盖 -> pnpm install

.PARAMETER ProfilePath
    DSH profile 目录，默认 %USERPROFILE%\.dsh\profiles\desktop

.PARAMETER Engine
    搜索引擎：chain（默认）/ auto / bing / bocha / tavily / searxng / generic / 单个 keyless 引擎

.PARAMETER Chain
    engine=chain 时的链路顺序，默认 exa,firecrawl,parallel,tinyfish,bing

.EXAMPLE
    .\install.ps1 -DryRun

.EXAMPLE
    .\install.ps1 -Engine chain -Chain exa,firecrawl,bing

.EXAMPLE
    .\install.ps1 -Engine auto
#>
[CmdletBinding()]
param(
    [string]$ProfilePath = (Join-Path $env:USERPROFILE '.dsh\profiles\desktop'),
    [ValidateSet('chain', 'auto', 'bing', 'bocha', 'tavily', 'searxng', 'generic', 'exa', 'firecrawl', 'parallel', 'tinyfish')]
    [string]$Engine = 'chain',
    [string[]]$Chain = @('exa', 'firecrawl', 'parallel', 'tinyfish', 'bing'),
    [int]$MaxResults = 10,
    [int]$TimeoutMs = 20000,
    [switch]$SkipPnpm,
    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
$PluginName = 'dsh-web-search-custom'
$Root = Split-Path -Parent $PSScriptRoot
$Utf8NoBom = New-Object System.Text.UTF8Encoding($false)

# -Chain 从 cmd/快捷方式传入时可能是单个 "a,b,c" 字符串，统一拆成数组
$chainList = @()
foreach ($item in $Chain) {
    foreach ($part in ($item -split ',')) {
        $t = $part.Trim()
        if ($t) { $chainList += $t }
    }
}
$Chain = $chainList

function Write-Step($msg) { Write-Host "==> $msg" -ForegroundColor Cyan }
function Write-Ok($msg) { Write-Host "    $msg" -ForegroundColor Green }
function Write-Warn2($msg) { Write-Host "    $msg" -ForegroundColor Yellow }
function Write-Dry($msg) { Write-Host "    [dry-run] $msg" -ForegroundColor DarkGray }

function Backup-File([string]$path) {
    if (-not (Test-Path -LiteralPath $path)) { return $null }
    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
    $bak = "$path.bak-$stamp"
    if (-not $DryRun) { Copy-Item -LiteralPath $path -Destination $bak -Force }
    Write-Ok "备份 $([System.IO.Path]::GetFileName($bak))"
    return $bak
}

function Read-Text([string]$path) {
    return [System.IO.File]::ReadAllText($path, [System.Text.Encoding]::UTF8)
}

function Write-Text([string]$path, [string]$text) {
    if ($DryRun) { Write-Dry "写入 $path"; return }
    [System.IO.File]::WriteAllText($path, $text, $Utf8NoBom)
}

function Remove-PatchEntry([System.Collections.Generic.List[string]]$lines, [string]$id) {
    $out = New-Object System.Collections.Generic.List[string]
    $i = 0
    while ($i -lt $lines.Count) {
        if ($lines[$i] -match ("^- id:\s*" + [regex]::Escape($id) + "\s*$")) {
            $i++
            while ($i -lt $lines.Count -and $lines[$i] -notmatch '^- ') { $i++ }
            continue
        }
        $out.Add($lines[$i])
        $i++
    }
    return $out.ToArray()
}

Write-Step "目标 profile: $ProfilePath"

$profilePkg = Join-Path $ProfilePath 'package.json'
$profilePatch = Join-Path $ProfilePath 'cordis.patch.yml'

if (-not (Test-Path -LiteralPath $ProfilePath)) {
    throw "profile 目录不存在：$ProfilePath。先启动一次 DSH，让它生成 profile，再运行本脚本。"
}
if (-not (Test-Path -LiteralPath $profilePkg)) {
    throw "找不到 $profilePkg。先启动一次 DSH，让它生成 profile，再运行本脚本。"
}
if (-not (Test-Path -LiteralPath (Join-Path $Root 'index.js'))) {
    throw "仓库不完整：$Root\index.js 不存在。"
}

# 1. 复制插件
Write-Step '复制插件文件'
$destDir = Join-Path $ProfilePath "plugins\$PluginName"
if ($DryRun) {
    Write-Dry "mkdir $destDir"
    Write-Dry "copy index.js / package.json / cordis.patch.yml"
} else {
    New-Item -ItemType Directory -Force -Path $destDir | Out-Null
    Copy-Item -LiteralPath (Join-Path $Root 'index.js') -Destination $destDir -Force
    Copy-Item -LiteralPath (Join-Path $Root 'package.json') -Destination $destDir -Force
    Copy-Item -LiteralPath (Join-Path $Root 'cordis.patch.yml') -Destination $destDir -Force
    Write-Ok $destDir
}

# 2. 更新 profile 的 package.json
Write-Step '更新 profile package.json'
Backup-File $profilePkg | Out-Null
$pkg = (Read-Text $profilePkg) | ConvertFrom-Json

if (-not ($pkg.PSObject.Properties.Name -contains 'dependencies') -or $null -eq $pkg.dependencies) {
    $pkg | Add-Member -NotePropertyName dependencies -NotePropertyValue (New-Object psobject) -Force
}
$pkg.dependencies | Add-Member -NotePropertyName $PluginName -NotePropertyValue "file:./plugins/$PluginName" -Force

if (-not ($pkg.PSObject.Properties.Name -contains 'dsh') -or $null -eq $pkg.dsh) {
    $pkg | Add-Member -NotePropertyName dsh -NotePropertyValue (New-Object psobject) -Force
}
if (-not ($pkg.dsh.PSObject.Properties.Name -contains 'profile') -or $null -eq $pkg.dsh.profile) {
    $pkg.dsh | Add-Member -NotePropertyName profile -NotePropertyValue (New-Object psobject) -Force
}

$bundles = @()
if ($pkg.dsh.profile.PSObject.Properties.Name -contains 'bundles' -and $null -ne $pkg.dsh.profile.bundles) {
    $bundles = @($pkg.dsh.profile.bundles)
}
if ($bundles -notcontains $PluginName) {
    $bundles = @($bundles + $PluginName)
    Write-Ok "bundles += $PluginName"
} else {
    Write-Ok "bundles 已包含 $PluginName"
}
$pkg.dsh.profile | Add-Member -NotePropertyName bundles -NotePropertyValue $bundles -Force

Write-Text $profilePkg ($pkg | ConvertTo-Json -Depth 20)

# 3. 更新 cordis.patch.yml
Write-Step '更新 cordis.patch.yml'
Backup-File $profilePatch | Out-Null
$lines = New-Object System.Collections.Generic.List[string]
foreach ($l in [System.IO.File]::ReadAllLines($profilePatch, [System.Text.Encoding]::UTF8)) { $lines.Add($l) }

foreach ($id in @('web', 'web-search-custom')) {
    $kept = Remove-PatchEntry $lines $id
    $lines = New-Object System.Collections.Generic.List[string]
    foreach ($x in $kept) { $lines.Add($x) }
}

# 去掉上次安装留下的标记注释与尾部空行，保证重复执行不堆叠
$filtered = New-Object System.Collections.Generic.List[string]
foreach ($x in $lines) {
    if ($x -ne '# dsh-web-search-custom (managed by install.ps1)') { $filtered.Add($x) }
}
$lines = $filtered
while ($lines.Count -gt 0 -and [string]::IsNullOrWhiteSpace($lines[$lines.Count - 1])) {
    $lines.RemoveAt($lines.Count - 1)
}

$block = New-Object System.Collections.Generic.List[string]
$block.Add('')
$block.Add('# dsh-web-search-custom (managed by install.ps1)')
$block.Add('- id: web')
$block.Add("  name: '@deepseek-ai/dsh-web'")
$block.Add('  config:')
$block.Add('    searchProvider: custom')
$block.Add('    fetchProvider: http')
$block.Add('')
$block.Add('- id: web-search-custom')
$block.Add("  name: '$PluginName'")
$block.Add('  config:')
$block.Add('    providerId: custom')
$block.Add("    engine: $Engine")
if ($Engine -eq 'chain') {
    $block.Add('    chain:')
    foreach ($c in $Chain) { $block.Add("      - $c") }
}
$block.Add("    maxResults: $MaxResults")
$block.Add("    timeoutMs: $TimeoutMs")

foreach ($l in $block) { $lines.Add($l) }
Write-Text $profilePatch (($lines -join "`r`n") + "`r`n")
Write-Ok "engine=$Engine"
if ($Engine -eq 'chain') { Write-Ok ("chain=" + ($Chain -join ' > ')) }

# 4. 链接 / 安装依赖
Write-Step '安装依赖'
$linkPath = Join-Path $ProfilePath "node_modules\$PluginName"
$pnpm = Get-Command pnpm -ErrorAction SilentlyContinue

if ($DryRun) {
    Write-Dry "pnpm install（若有 pnpm），否则建立 junction：$linkPath"
} elseif (-not $SkipPnpm -and $null -ne $pnpm) {
    Push-Location $ProfilePath
    try {
        & pnpm install
        if ($LASTEXITCODE -ne 0) { Write-Warn2 "pnpm install 退出码 $LASTEXITCODE，尝试 junction 兜底" }
    } finally {
        Pop-Location
    }
}

if (-not (Test-Path -LiteralPath $linkPath) -and -not $DryRun) {
    $nm = Join-Path $ProfilePath 'node_modules'
    if (-not (Test-Path -LiteralPath $nm)) { New-Item -ItemType Directory -Force -Path $nm | Out-Null }
    try {
        New-Item -ItemType Junction -Path $linkPath -Target $destDir | Out-Null
        Write-Ok "已建立 junction: node_modules\$PluginName"
    } catch {
        Write-Warn2 "无法建立 junction：$($_.Exception.Message)"
        Write-Warn2 "请手动在 profile 目录执行 pnpm install"
    }
} elseif (Test-Path -LiteralPath $linkPath) {
    Write-Ok "node_modules\$PluginName 已就绪"
}

Write-Host ''
Write-Step '完成，重启 DSH 生效'
Write-Host '  验证：在 DSH 里问「希音 SHEIN 上市 招股书」' -ForegroundColor Gray
Write-Host '        返回港交所 PDF / 财经媒体 = 正常；返回「希」字字典 = 还在用 bing' -ForegroundColor Gray
if ($DryRun) { Write-Host '  (dry-run，未落盘)' -ForegroundColor DarkGray }

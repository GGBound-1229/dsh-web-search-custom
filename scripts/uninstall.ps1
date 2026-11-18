<#
.SYNOPSIS
    从 DSH profile 移除 dsh-web-search-custom。

.DESCRIPTION
    备份后移除：插件目录、package.json 依赖与 bundle 条目、cordis.patch.yml 里的两条覆盖
    （- id: web 与 - id: web-search-custom）。移除后 DSH 会回到默认 provider，
    在没有官方账号的环境里搜索会不可用——这是预期行为。

.PARAMETER ProfilePath
    DSH profile 目录，默认 %USERPROFILE%\.dsh\profiles\desktop

.PARAMETER RestoreFrom
    可选：用指定的 cordis.patch.yml 备份覆盖当前配置（例如 install.ps1 自动生成的 .bak-*）

.EXAMPLE
    .\uninstall.ps1 -DryRun

.EXAMPLE
    .\uninstall.ps1 -RestoreFrom "$env:USERPROFILE\.dsh\profiles\desktop\cordis.patch.yml.bak-20261118-chain"
#>
[CmdletBinding()]
param(
    [string]$ProfilePath = (Join-Path $env:USERPROFILE '.dsh\profiles\desktop'),
    [string]$RestoreFrom,
    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
$PluginName = 'dsh-web-search-custom'
$Utf8NoBom = New-Object System.Text.UTF8Encoding($false)

function Write-Step($msg) { Write-Host "==> $msg" -ForegroundColor Cyan }
function Write-Ok($msg) { Write-Host "    $msg" -ForegroundColor Green }
function Write-Warn2($msg) { Write-Host "    $msg" -ForegroundColor Yellow }
function Write-Dry($msg) { Write-Host "    [dry-run] $msg" -ForegroundColor DarkGray }

function Backup-File([string]$path) {
    if (-not (Test-Path -LiteralPath $path)) { return $null }
    $bak = "$path.bak-$(Get-Date -Format 'yyyyMMdd-HHmmss')"
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
$pluginDir = Join-Path $ProfilePath "plugins\$PluginName"
$linkPath = Join-Path $ProfilePath "node_modules\$PluginName"

# 1. package.json
if (Test-Path -LiteralPath $profilePkg) {
    Write-Step '清理 package.json'
    Backup-File $profilePkg | Out-Null
    $pkg = (Read-Text $profilePkg) | ConvertFrom-Json

    if (($pkg.PSObject.Properties.Name -contains 'dependencies') -and $null -ne $pkg.dependencies) {
        if ($pkg.dependencies.PSObject.Properties.Name -contains $PluginName) {
            $pkg.dependencies.PSObject.Properties.Remove($PluginName)
            Write-Ok "dependencies -= $PluginName"
        }
    }
    if (($pkg.PSObject.Properties.Name -contains 'dsh') -and $null -ne $pkg.dsh) {
        if (($pkg.dsh.PSObject.Properties.Name -contains 'profile') -and $null -ne $pkg.dsh.profile) {
            if ($pkg.dsh.profile.PSObject.Properties.Name -contains 'bundles') {
                $kept = @($pkg.dsh.profile.bundles | Where-Object { $_ -ne $PluginName })
                $pkg.dsh.profile | Add-Member -NotePropertyName bundles -NotePropertyValue $kept -Force
                Write-Ok "bundles -= $PluginName"
            }
        }
    }
    Write-Text $profilePkg ($pkg | ConvertTo-Json -Depth 20)
}

# 2. cordis.patch.yml
if (Test-Path -LiteralPath $profilePatch) {
    if ($RestoreFrom) {
        if (-not (Test-Path -LiteralPath $RestoreFrom)) { throw "找不到备份文件：$RestoreFrom" }
        Write-Step "从备份恢复 cordis.patch.yml"
        Backup-File $profilePatch | Out-Null
        if (-not $DryRun) { Copy-Item -LiteralPath $RestoreFrom -Destination $profilePatch -Force }
        Write-Ok $RestoreFrom
    } else {
        Write-Step '清理 cordis.patch.yml'
        Backup-File $profilePatch | Out-Null
        $lines = New-Object System.Collections.Generic.List[string]
        foreach ($l in [System.IO.File]::ReadAllLines($profilePatch, [System.Text.Encoding]::UTF8)) { $lines.Add($l) }
        foreach ($id in @('web', 'web-search-custom')) {
            $kept = Remove-PatchEntry $lines $id
            $lines = New-Object System.Collections.Generic.List[string]
            foreach ($x in $kept) { $lines.Add($x) }
        }
        $filtered = New-Object System.Collections.Generic.List[string]
        foreach ($x in $lines) {
            if ($x -ne '# dsh-web-search-custom (managed by install.ps1)') { $filtered.Add($x) }
        }
        $lines = $filtered
        while ($lines.Count -gt 0 -and [string]::IsNullOrWhiteSpace($lines[$lines.Count - 1])) {
            $lines.RemoveAt($lines.Count - 1)
        }
        Write-Text $profilePatch (($lines -join "`r`n") + "`r`n")
        Write-Ok '已移除 - id: web / - id: web-search-custom'
    }
}

# 3. 插件目录与链接
Write-Step '移除插件文件'
if (Test-Path -LiteralPath $linkPath) {
    if ($DryRun) { Write-Dry "删除连接 $linkPath" } else {
        (Get-Item -LiteralPath $linkPath -Force).Delete()
        Write-Ok "已删除 node_modules\$PluginName"
    }
}
if (Test-Path -LiteralPath $pluginDir) {
    if ($DryRun) { Write-Dry "删除目录 $pluginDir" } else {
        Remove-Item -LiteralPath $pluginDir -Recurse -Force
        Write-Ok "已删除 plugins\$PluginName"
    }
}

Write-Host ''
Write-Step '完成，重启 DSH 生效'
Write-Host '  注意：移除后 searchProvider=custom 已不存在，DSH 会回到默认 provider；' -ForegroundColor Gray
Write-Host '        在第三方中转环境下默认 provider 不可用，这是预期行为。' -ForegroundColor Gray

param(
    [Parameter(Mandatory = $true)]
    [string]$ApkPath,

    [Parameter(Mandatory = $true)]
    [string]$ApkUrl,

    [Parameter(Mandatory = $true)]
    [string]$SigningCertSha256,

    [Parameter(Mandatory = $true)]
    [string]$OutputPath
)

$ErrorActionPreference = 'Stop'
$resolvedApk = (Resolve-Path -LiteralPath $ApkPath).Path
if (-not $ApkUrl.StartsWith('https://', [System.StringComparison]::OrdinalIgnoreCase)) {
    throw 'ApkUrl 必须使用 HTTPS'
}
if ($SigningCertSha256 -notmatch '^[A-Fa-f0-9]{64}$') {
    throw 'SigningCertSha256 必须是 64 位 SHA-256 十六进制值'
}

$buildTools = Get-ChildItem 'D:\AndroidSDK\build-tools' -Directory -ErrorAction Stop |
    Sort-Object Name -Descending |
    Select-Object -First 1
$aapt = Join-Path $buildTools.FullName 'aapt2.exe'
if (-not (Test-Path -LiteralPath $aapt)) {
    throw '未找到 aapt2.exe，请在 Android SDK Build-Tools 中安装它'
}

$badging = & $aapt dump badging $resolvedApk
$packageLine = $badging | Select-String "^package: name='([^']+)' versionCode='([^']+)' versionName='([^']+)'"
if (-not $packageLine) {
    throw '无法从 APK 读取包信息'
}
$match = [regex]::Match($packageLine.Line, "^package: name='([^']+)' versionCode='([^']+)' versionName='([^']+)'")
$hash = (Get-FileHash -LiteralPath $resolvedApk -Algorithm SHA256).Hash.ToUpperInvariant()
$size = (Get-Item -LiteralPath $resolvedApk).Length

$payload = [ordered]@{
    format = 'catcheck-update-v1'
    versionCode = [long]$match.Groups[2].Value
    versionName = $match.Groups[3].Value
    packageName = $match.Groups[1].Value
    apkUrl = $ApkUrl
    sha256 = $hash
    signingCertSha256 = $SigningCertSha256.ToUpperInvariant()
    size = $size
}
$destination = [System.IO.Path]::GetFullPath($OutputPath)
$directory = Split-Path -Parent $destination
if ($directory) {
    New-Item -ItemType Directory -Force -Path $directory | Out-Null
}
$payload | ConvertTo-Json | Set-Content -LiteralPath $destination -Encoding utf8NoBOM
Write-Output "已生成更新清单：$destination"
Write-Output "版本：$($payload.versionName) ($($payload.versionCode))"
Write-Output "APK SHA-256：$hash"


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
    throw 'ApkUrl must use HTTPS'
}
if ($SigningCertSha256 -notmatch '^[A-Fa-f0-9]{64}$') {
    throw 'SigningCertSha256 must be a 64-character SHA-256 hexadecimal value'
}

$buildTools = Get-ChildItem 'D:\AndroidSDK\build-tools' -Directory -ErrorAction Stop |
    Sort-Object Name -Descending |
    Select-Object -First 1
$aapt = Join-Path $buildTools.FullName 'aapt2.exe'
if (-not (Test-Path -LiteralPath $aapt)) {
    throw 'aapt2.exe was not found. Install Android SDK Build-Tools first.'
}

$badging = & $aapt dump badging $resolvedApk
$packageLine = $badging | Select-String "^package: name='([^']+)' versionCode='([^']+)' versionName='([^']+)'"
if (-not $packageLine) {
    throw 'Unable to read package information from the APK'
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
[System.IO.File]::WriteAllText($destination, (($payload | ConvertTo-Json) + [Environment]::NewLine), [System.Text.UTF8Encoding]::new($false))
Write-Output "Generated update manifest: $destination"
Write-Output "Version: $($payload.versionName) ($($payload.versionCode))"
Write-Output "APK SHA-256: $hash"


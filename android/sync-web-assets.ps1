$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent $PSScriptRoot
$webAssets = Join-Path $projectRoot 'dist-android'
$androidAssets = Join-Path $PSScriptRoot 'app/src/main/assets/www'

if (-not (Test-Path $webAssets)) {
    throw "dist 目录不存在，请先执行 npm run build"
}

New-Item -ItemType Directory -Force -Path $androidAssets | Out-Null
Get-ChildItem -LiteralPath $androidAssets -Force | Remove-Item -Recurse -Force
Copy-Item -Path (Join-Path $webAssets '*') -Destination $androidAssets -Recurse -Force
Write-Output "已同步 Web 资源到 $androidAssets"

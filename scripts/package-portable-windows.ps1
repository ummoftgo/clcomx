param(
  [string]$ProjectDir = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path,
  [string]$ProductName = "CLCOMX"
)

$ErrorActionPreference = "Stop"

$packageJsonPath = Join-Path $ProjectDir "package.json"
$packageJson = Get-Content -Raw -Path $packageJsonPath | ConvertFrom-Json
$version = $packageJson.version

$releaseDir = Join-Path $ProjectDir "src-tauri\target\release"
$exePath = Join-Path $releaseDir "clcomx.exe"
$portableRoot = Join-Path $releaseDir "bundle\portable"
$portableStageDir = Join-Path $portableRoot $ProductName
$portableZipPath = Join-Path $portableRoot "${ProductName}_${version}_x64-portable.zip"
$portableReadmePath = Join-Path $portableStageDir "README-portable.txt"

if (-not (Test-Path $exePath)) {
  throw "Portable packaging requires an existing release exe: $exePath"
}

if (Test-Path $portableStageDir) {
  Remove-Item -Recurse -Force $portableStageDir
}

New-Item -ItemType Directory -Force -Path $portableStageDir | Out-Null
Copy-Item -Path $exePath -Destination (Join-Path $portableStageDir "clcomx.exe") -Force

@"
CLCOMX Portable $version

Contents:
- clcomx.exe

Usage:
1. Extract the CLCOMX folder anywhere on Windows.
2. Run clcomx.exe.

Notes:
- Microsoft Edge WebView2 Runtime is required on Windows.
- Runtime state files (setting.json, workspace.json, tab_history.json, temp/) are created in the working directory where CLCOMX runs.
- This portable zip is intended for direct execution without installation.
"@ | Set-Content -Encoding UTF8 -Path $portableReadmePath

if (Test-Path $portableZipPath) {
  Remove-Item -Force $portableZipPath
}

Compress-Archive -Path $portableStageDir -DestinationPath $portableZipPath -Force

Write-Output "PortableZip=$portableZipPath"

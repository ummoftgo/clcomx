[CmdletBinding()]
param(
  [switch]$InstallTools,
  [switch]$SkipBuild,
  [string]$Project,
  [switch]$HelpText
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

function Show-Usage {
  @"
Run CLCOMX Windows smoke E2E from a local Windows checkout.

Usage:
  powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\e2e-smoke-windows.ps1
  powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\e2e-smoke-windows.ps1 -InstallTools
  powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\e2e-smoke-windows.ps1 -SkipBuild
  powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\e2e-smoke-windows.ps1 -Project image-paste

Options:
  -InstallTools  Install Windows npm dependencies, tauri-driver, and Edge WebDriver first.
  -SkipBuild     Reuse the existing debug exe without rebuilding it first.
  -Project       Run only one Vitest E2E project (for example: smoke, settings, windows-tabs, workspace-restore, image-paste).
  -HelpText      Show this help text.

Important:
  Run this script from a local Windows path such as C:\work\clcomx.
  Do not run it from \\wsl.localhost\... or other UNC paths.
"@
}

function Require-Command([string]$CommandName, [string]$Hint) {
  if (-not (Get-Command $CommandName -ErrorAction SilentlyContinue)) {
    throw "Required command not found: $CommandName`n$Hint"
  }
}

function Add-ToPath([string]$DirectoryPath) {
  if ([string]::IsNullOrWhiteSpace($DirectoryPath)) {
    return
  }

  $existing = @($env:Path -split ';' | Where-Object { $_ -ne "" })
  if ($existing -notcontains $DirectoryPath) {
    $env:Path = "$DirectoryPath;$env:Path"
  }
}

function Resolve-EdgeDriverPath([string]$ProjectRoot) {
  $command = Get-Command "msedgedriver.exe" -ErrorAction SilentlyContinue
  if ($command) {
    return $command.Source
  }

  $candidates = @(
    (Join-Path $ProjectRoot ".tools\windows\e2e\msedgedriver.exe"),
    (Join-Path $ProjectRoot "msedgedriver.exe")
  )

  foreach ($candidate in $candidates) {
    if (Test-Path $candidate) {
      return (Resolve-Path $candidate).Path
    }
  }

  return $null
}

if ($HelpText) {
  Show-Usage
  exit 0
}

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$projectRoot = (Resolve-Path (Join-Path $scriptDir "..")).Path
$edgeDriverDir = Join-Path $projectRoot ".tools\windows\e2e"

if ($projectRoot.StartsWith("\\")) {
  throw "Run the Windows E2E script from a local Windows path, not a UNC path: $projectRoot"
}

Write-Host "=== CLCOMX Windows E2E Smoke ==="
Write-Host ""
Write-Host "[Windows] Project root: $projectRoot"
Write-Host ""

Push-Location $projectRoot
try {
  Require-Command "cargo.exe" "Install Rust on Windows first."
  Require-Command "node.exe" "Install Node.js on Windows first."
  Require-Command "npm.cmd" "Install Node.js/npm on Windows first."

  if ($InstallTools) {
    Write-Host "[Windows] Installing npm dependencies..."
    & npm.cmd ci --no-fund --no-audit
    if ($LASTEXITCODE -ne 0) {
      throw "npm ci failed with exit code $LASTEXITCODE"
    }

    Write-Host "[Windows] Installing tauri-driver..."
    & cargo.exe install tauri-driver --locked
    if ($LASTEXITCODE -ne 0) {
      throw "cargo install tauri-driver failed with exit code $LASTEXITCODE"
    }

    $msEdgeDriverTool = Join-Path $HOME ".cargo\bin\msedgedriver-tool.exe"
    if (-not (Test-Path $msEdgeDriverTool)) {
      Write-Host "[Windows] Installing msedgedriver-tool..."
      & cargo.exe install --git https://github.com/chippers/msedgedriver-tool
      if ($LASTEXITCODE -ne 0) {
        throw "cargo install msedgedriver-tool failed with exit code $LASTEXITCODE"
      }
    }

    if (-not (Test-Path $msEdgeDriverTool)) {
      throw "msedgedriver-tool.exe was not found after installation: $msEdgeDriverTool"
    }

    New-Item -ItemType Directory -Force -Path $edgeDriverDir | Out-Null

    Write-Host "[Windows] Installing Edge WebDriver..."
    Push-Location $edgeDriverDir
    try {
      & $msEdgeDriverTool
      if ($LASTEXITCODE -ne 0) {
        throw "msedgedriver-tool failed with exit code $LASTEXITCODE"
      }
    }
    finally {
      Pop-Location
    }

    Write-Host ""
  }

  Require-Command "tauri-driver.exe" "Install it with: cargo install tauri-driver --locked"

  $edgeDriverPath = Resolve-EdgeDriverPath $projectRoot
  if (-not $edgeDriverPath) {
    throw "msedgedriver.exe was not found.`nRun: npm run test:e2e:windows -- -InstallTools"
  }

  Add-ToPath (Split-Path -Parent $edgeDriverPath)
  Write-Host "[Windows] Edge WebDriver: $edgeDriverPath"
  Write-Host ""

  if (-not $SkipBuild) {
    Write-Host "[Windows] Building frontend..."
    & npm.cmd run build
    if ($LASTEXITCODE -ne 0) {
      throw "npm run build failed with exit code $LASTEXITCODE"
    }

    Write-Host ""
    Write-Host "[Windows] Building debug app for E2E..."
    $env:CARGO_INCREMENTAL = "0"
    & cargo.exe tauri build --debug --no-bundle
    if ($LASTEXITCODE -ne 0) {
      throw "cargo tauri build failed with exit code $LASTEXITCODE"
    }
    Write-Host ""
  }

  $binaryPath = Join-Path $projectRoot "src-tauri\target\debug\clcomx.exe"
  if (-not (Test-Path $binaryPath)) {
    throw "CLCOMX debug binary not found: $binaryPath"
  }

  $env:CLCOMX_E2E_BINARY = $binaryPath

  $vitestArgs = @("run", "--config", ".\vitest.e2e.config.ts")
  if (-not [string]::IsNullOrWhiteSpace($Project)) {
    $vitestArgs += @("--project", $Project)
    Write-Host "[Windows] Running E2E project: $Project"
  } else {
    Write-Host "[Windows] Running all E2E projects..."
  }
  & node.exe .\node_modules\vitest\vitest.mjs @vitestArgs
  if ($LASTEXITCODE -ne 0) {
    exit $LASTEXITCODE
  }
}
finally {
  Pop-Location
}

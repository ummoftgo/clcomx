#!/bin/bash
# Build and run CLCOMX in debug mode for development testing
#
# 1. WSL에서 프론트엔드 빌드 (npm run build → dist/)
# 2. Windows에서 Rust debug 빌드 (cargo tauri build --debug)
#    - CARGO_INCREMENTAL=0: WSL 파일시스템에서 Windows cargo 호환성
# 3. 생성된 debug exe 실행
#
# Usage: ./scripts/build-dev.sh

set -e

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
WIN_PATH="$(wslpath -w "$PROJECT_DIR")"
WIN_EXE="$(wslpath -w "$PROJECT_DIR/src-tauri/target/debug/clcomx.exe")"

source "$(dirname "$0")/win-env.sh"

echo "=== CLCOMX Dev Build ==="
echo ""

# Step 1: Build frontend in WSL
echo "[WSL] Building frontend..."
cd "$PROJECT_DIR"
npm run build
echo "[WSL] Frontend build complete → dist/"
echo ""

# Step 2: Build Rust debug binary via Windows PowerShell
echo "[Windows] Building Tauri (debug)..."
powershell.exe -NoProfile -Command "
  $WIN_ENV_CMD
  \$env:CARGO_INCREMENTAL = '0'
  Set-Location '$WIN_PATH'
  cargo.exe tauri build --debug
"

echo ""
echo "[Windows] Launching clcomx.exe..."
powershell.exe -NoProfile -Command "Start-Process '$WIN_EXE'"
echo "Done."

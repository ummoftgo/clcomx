#!/bin/bash
# Build CLCOMX for Windows from WSL
#
# 1. WSL에서 프론트엔드 빌드 (npm run build → dist/)
# 2. Windows에서 Tauri 빌드 (Rust 컴파일 + NSIS 설치본 생성)
# 3. release exe를 portable staging 디렉토리에 모아서 zip 생성
#
# Usage: ./scripts/build-windows.sh

set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
WIN_PATH="$(wslpath -w "$PROJECT_DIR")"
VERSION="$(node -p "require('$PROJECT_DIR/package.json').version")"
PRODUCT_NAME="CLCOMX"
PORTABLE_ROOT="$PROJECT_DIR/src-tauri/target/release/bundle/portable"
PORTABLE_ZIP="$PORTABLE_ROOT/${PRODUCT_NAME}_${VERSION}_x64-portable.zip"
WIN_PACKAGE_SCRIPT="$(wslpath -w "$PROJECT_DIR/scripts/package-portable-windows.ps1")"

source "$(dirname "$0")/win-env.sh"

echo "=== Building CLCOMX for Windows ==="
echo ""

# Step 1: Build frontend in WSL (fast, native filesystem)
echo "[WSL] Building frontend..."
cd "$PROJECT_DIR"
npm run build
echo "[WSL] Frontend build complete → dist/"
echo ""

# Step 2: Build Tauri app via Windows PowerShell
echo "[Windows] Building Tauri app..."
powershell.exe -NoProfile -Command "
  $WIN_ENV_CMD
  Set-Location '$WIN_PATH'
  cargo tauri build
"

echo "[Windows] Creating portable zip..."
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$WIN_PACKAGE_SCRIPT" -ProjectDir "$WIN_PATH" | tr -d '\r'

echo ""
echo "=== Build complete! ==="
echo "Installer: src-tauri/target/release/bundle/nsis/CLCOMX_${VERSION}_x64-setup.exe"
echo "Portable:  src-tauri/target/release/bundle/portable/CLCOMX_${VERSION}_x64-portable.zip"

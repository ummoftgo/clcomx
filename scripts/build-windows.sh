#!/bin/bash
# Build CLCOMX for Windows from WSL
#
# 1. WSL에서 프론트엔드 빌드 (npm run build → dist/)
# 2. Windows에서 Tauri 빌드 (Rust 컴파일 + 번들링)
#
# Usage: ./scripts/build-windows.sh

set -e

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
WIN_PATH="$(wslpath -w "$PROJECT_DIR")"

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

echo ""
echo "=== Build complete! ==="
echo "Output: src-tauri/target/release/bundle/"

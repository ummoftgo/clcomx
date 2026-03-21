#!/bin/bash
# Development mode for CLCOMX
#
# 1. WSL에서 Vite dev server 실행 (프론트엔드)
# 2. Windows에서 Tauri dev 실행 (Rust 백엔드, devUrl로 Vite에 연결)
#
# Usage: ./scripts/dev.sh

set -e

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
WIN_PATH="$(wslpath -w "$PROJECT_DIR")"

source "$(dirname "$0")/win-env.sh"

echo "=== CLCOMX Development Mode ==="
echo "Project: $PROJECT_DIR"
echo ""

# Step 1: Start Vite dev server in background (WSL)
echo "[WSL] Starting Vite dev server on localhost:1420..."
cd "$PROJECT_DIR"
npm run dev &
VITE_PID=$!

# Wait for Vite to be ready
echo "[WSL] Waiting for Vite..."
for i in $(seq 1 30); do
  if curl -s http://localhost:1420 > /dev/null 2>&1; then
    echo "[WSL] Vite is ready!"
    break
  fi
  sleep 1
done

# Step 2: Start Tauri dev via Windows PowerShell (connects to Vite devUrl)
echo "[Windows] Starting Tauri dev..."
powershell.exe -NoProfile -Command "
  $WIN_ENV_CMD
  Set-Location '$WIN_PATH'
  cargo tauri dev
"

# Cleanup: kill Vite when Tauri exits
kill $VITE_PID 2>/dev/null
echo "Done."

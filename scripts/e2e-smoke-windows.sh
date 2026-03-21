#!/bin/bash
# Run Windows Tauri E2E smoke tests from WSL by syncing into a Windows-local mirror.
#
# Default mirror:
#   Windows: C:\temp\clcomx
#   WSL:     /mnt/c/temp/clcomx

set -euo pipefail

usage() {
  cat <<'EOF'
Run CLCOMX Windows smoke E2E from WSL.

This syncs the current workspace into the Windows-local mirror first and then
invokes the PowerShell runner from that local mirror.

Usage:
  bash scripts/e2e-smoke-windows.sh [--skip-build] [--install-tools] [--project <name>]

Options:
  --skip-build     Reuse the existing debug exe in the mirror without rebuilding it first.
  --install-tools  Install Windows npm dependencies, tauri-driver, and Edge WebDriver first.
  --project <name> Run only one Vitest E2E project in the Windows runner.
  -h, --help       Show this help text.

Mirror path:
  - Windows: C:\temp\clcomx
  - WSL: /mnt/c/temp/clcomx
EOF
}

BUILD_FIRST=1
INSTALL_TOOLS=0
PROJECT_NAME=""
MIRROR_DIR="/mnt/c/temp/clcomx"
WIN_MIRROR_SCRIPT='C:\temp\clcomx\scripts\e2e-smoke-windows.ps1'

while [ $# -gt 0 ]; do
  case "$1" in
    --skip-build)
      BUILD_FIRST=0
      ;;
    --install-tools)
      INSTALL_TOOLS=1
      ;;
    --project)
      shift
      if [ $# -eq 0 ]; then
        echo "Missing value for --project" >&2
        exit 1
      fi
      PROJECT_NAME="$1"
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      echo "" >&2
      usage >&2
      exit 1
      ;;
  esac
  shift
done

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
MIRROR_SCRIPT="$MIRROR_DIR/scripts/e2e-smoke-windows.ps1"

echo "=== CLCOMX Windows E2E Smoke (from WSL) ==="
echo ""

echo "[WSL] Syncing project into local Windows mirror..."
bash "$SCRIPT_DIR/sync-e2e-mirror.sh" --mirror "$MIRROR_DIR"
echo ""

if [ ! -f "$MIRROR_SCRIPT" ]; then
  echo "[WSL] Mirror PowerShell runner was not found: $MIRROR_SCRIPT" >&2
  exit 1
fi

PS_ARGS=()
if [ "$INSTALL_TOOLS" -eq 1 ]; then
  PS_ARGS+=("-InstallTools")
fi
if [ "$BUILD_FIRST" -eq 0 ]; then
  PS_ARGS+=("-SkipBuild")
fi
if [ -n "$PROJECT_NAME" ]; then
  PS_ARGS+=("-Project" "$PROJECT_NAME")
fi

echo "[Windows] Launching local mirror PowerShell runner..."
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$WIN_MIRROR_SCRIPT" "${PS_ARGS[@]}"

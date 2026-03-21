#!/bin/bash
# Sync the current WSL workspace into the Windows-local E2E mirror.

set -euo pipefail

usage() {
  cat <<'EOF'
Sync CLCOMX into the Windows-local E2E mirror.

Usage:
  bash scripts/sync-e2e-mirror.sh
  bash scripts/sync-e2e-mirror.sh --mirror /mnt/c/temp/clcomx

Options:
  --mirror <path>  Override the default mirror path.
  -h, --help       Show this help text.
EOF
}

MIRROR_DIR="/mnt/c/temp/clcomx"

while [ $# -gt 0 ]; do
  case "$1" in
    --mirror)
      shift
      if [ $# -eq 0 ]; then
        echo "Missing value for --mirror" >&2
        exit 1
      fi
      MIRROR_DIR="$1"
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

if ! command -v rsync >/dev/null 2>&1; then
  echo "rsync is required for sync-e2e-mirror.sh" >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

mkdir -p "$MIRROR_DIR"

echo "[WSL] Syncing project to mirror: $MIRROR_DIR"

rsync -a --delete \
  --exclude '.git/' \
  --exclude 'node_modules/' \
  --exclude 'dist/' \
  --exclude '.svelte-kit/' \
  --exclude '.vite/' \
  --exclude 'coverage/' \
  --exclude 'temp/' \
  --exclude 'src-tauri/target/' \
  --exclude 'src-tauri/gen/' \
  --exclude 'src-tauri/.tauri/' \
  "$PROJECT_DIR/" "$MIRROR_DIR/"

echo "[WSL] Mirror sync complete."

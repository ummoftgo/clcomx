#!/bin/bash
# Detect Windows-side Rust and Node.js paths for build scripts.
# Sources into the calling script and sets WIN_ENV_CMD (PowerShell snippet).

_detect_win_path() {
  local name="$1"
  local exe="$2"
  local result

  result="$(powershell.exe -NoProfile -Command "(Get-Command '$exe' -ErrorAction SilentlyContinue).Source" 2>/dev/null | tr -d '\r')"

  if [ -n "$result" ]; then
    dirname "$result" | sed 's|\\|/|g'
    return 0
  fi
  return 1
}

echo "[env] Detecting Windows build tools..."

WIN_EXTRA_PATHS=""

# Detect cargo/rustc
CARGO_DIR="$(_detect_win_path "Rust" "cargo.exe")" || {
  # Fallback: check common location
  CARGO_DIR="$(powershell.exe -NoProfile -Command "
    \$p = Join-Path \$env:USERPROFILE '.cargo\bin\cargo.exe'
    if (Test-Path \$p) { Split-Path \$p }
  " 2>/dev/null | tr -d '\r')"
}

if [ -n "$CARGO_DIR" ]; then
  echo "[env] Found Rust: $CARGO_DIR"
  WIN_EXTRA_PATHS="$CARGO_DIR"
else
  echo "[env] WARNING: Rust not found on Windows side!"
fi

# Detect node
NODE_DIR="$(_detect_win_path "Node.js" "node.exe")" || {
  # Fallback: search common nvm/fnm locations
  NODE_DIR="$(powershell.exe -NoProfile -Command "
    \$candidates = @(
      (Get-ChildItem \"\$env:LOCALAPPDATA\nvm\" -Filter 'node.exe' -Recurse -Depth 2 -ErrorAction SilentlyContinue | Select-Object -First 1),
      (Get-ChildItem \"\$env:LOCALAPPDATA\fnm\" -Filter 'node.exe' -Recurse -Depth 3 -ErrorAction SilentlyContinue | Select-Object -First 1),
      (Get-ChildItem 'C:\Program Files\nodejs' -Filter 'node.exe' -ErrorAction SilentlyContinue | Select-Object -First 1)
    )
    \$found = \$candidates | Where-Object { \$_ -ne \$null } | Select-Object -First 1
    if (\$found) { Split-Path \$found.FullName }
  " 2>/dev/null | tr -d '\r')"
}

if [ -n "$NODE_DIR" ]; then
  echo "[env] Found Node.js: $NODE_DIR"
  if [ -n "$WIN_EXTRA_PATHS" ]; then
    WIN_EXTRA_PATHS="$WIN_EXTRA_PATHS;$NODE_DIR"
  else
    WIN_EXTRA_PATHS="$NODE_DIR"
  fi
else
  echo "[env] WARNING: Node.js not found on Windows side!"
fi

# Build the PowerShell PATH prepend command
if [ -n "$WIN_EXTRA_PATHS" ]; then
  WIN_ENV_CMD="\$env:Path = '$WIN_EXTRA_PATHS;' + \$env:Path"
else
  WIN_ENV_CMD=""
fi

export WIN_ENV_CMD
echo "[env] Done."

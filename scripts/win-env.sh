#!/bin/bash
# Detect Windows-side Rust and Node.js paths for build scripts.
# Sources into the calling script and sets WIN_ENV_CMD (PowerShell snippet).
#
# Optional overrides:
#   CLCOMX_WIN_CARGO_DIR=<Windows or WSL path to cargo.exe directory>
#   CLCOMX_WIN_NODE_DIR=<Windows or WSL path to node.exe directory>
#   CLCOMX_WIN_EXTRA_PATHS=<extra Windows path list joined by ;>

_run_powershell() {
  powershell.exe -NoProfile -Command "$1" 2>/dev/null | tr -d '\r'
}

_normalize_override_dir() {
  local value="$1"
  if [ -z "$value" ]; then
    return 1
  fi

  if [[ "$value" == /* ]]; then
    wslpath -w "$value" 2>/dev/null | tr -d '\r'
  else
    printf '%s' "$value"
  fi
}

_normalize_windows_dir() {
  local value="$1"
  printf '%s' "$value" | sed 's|\\|/|g' | sed 's|/$||'
}

_resolve_win_bin_dir() {
  local label="$1"
  local override_var="$2"
  local probe_script="$3"
  local override_value=""
  local result=""

  override_value="${!override_var:-}"
  if [ -n "$override_value" ]; then
    local normalized_override
    normalized_override="$(_normalize_override_dir "$override_value")"
    if [ -n "$normalized_override" ]; then
      result="$(_run_powershell "
        \$candidate = '$normalized_override'
        if (Test-Path \$candidate) {
          try {
            (Resolve-Path \$candidate).Path
          } catch {
            \$candidate
          }
        }
      ")"
      result="$(_normalize_windows_dir "$result")"
      if [ -n "$result" ]; then
        printf '%s' "$result"
        return 0
      fi
      echo "[env] WARNING: $override_var was set but the path was not found on Windows: $override_value" >&2
    fi
  fi

  result="$(_run_powershell "$probe_script")"
  result="$(_normalize_windows_dir "$result")"
  if [ -n "$result" ]; then
    printf '%s' "$result"
    return 0
  fi

  return 1
}

_join_win_path() {
  local first="$1"
  local second="$2"
  if [ -z "$first" ]; then
    printf '%s' "$second"
  elif [ -z "$second" ]; then
    printf '%s' "$first"
  else
    printf '%s;%s' "$first" "$second"
  fi
}

echo "[env] Detecting Windows build tools..."

CARGO_PROBE_SCRIPT='
  $commands = @(
    (Get-Command cargo.exe -ErrorAction SilentlyContinue),
    (Get-Command cargo -ErrorAction SilentlyContinue),
    (Get-Command rustup.exe -ErrorAction SilentlyContinue)
  ) | Where-Object { $_ -ne $null } | Select-Object -First 1

  if ($commands) {
    Split-Path $commands.Source
    return
  }

  $candidates = @(
    (Join-Path $env:USERPROFILE ".cargo\bin"),
    (Join-Path $env:LOCALAPPDATA "Programs\Rust\bin")
  )

  foreach ($candidate in $candidates) {
    if ((Test-Path (Join-Path $candidate "cargo.exe")) -or (Test-Path (Join-Path $candidate "rustup.exe"))) {
      $candidate
      return
    }
  }
'

NODE_PROBE_SCRIPT='
  $commands = @(
    (Get-Command node.exe -ErrorAction SilentlyContinue),
    (Get-Command node -ErrorAction SilentlyContinue),
    (Get-Command npm.cmd -ErrorAction SilentlyContinue)
  ) | Where-Object { $_ -ne $null } | Select-Object -First 1

  if ($commands) {
    Split-Path $commands.Source
    return
  }

  $candidates = @(
    (Join-Path $env:ProgramFiles "nodejs"),
    (Join-Path ${env:ProgramFiles(x86)} "nodejs"),
    (Join-Path $env:LOCALAPPDATA "nvm"),
    (Join-Path $env:LOCALAPPDATA "fnm"),
    (Join-Path $env:LOCALAPPDATA "Programs\nodejs")
  ) | Where-Object { $_ -and (Test-Path $_) }

  foreach ($candidate in $candidates) {
    $node = Get-ChildItem $candidate -Filter "node.exe" -Recurse -Depth 4 -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($node) {
      Split-Path $node.FullName
      return
    }
  }
'

WIN_EXTRA_PATHS=""
WIN_CARGO_DIR=""
WIN_NODE_DIR=""

if WIN_CARGO_DIR="$(_resolve_win_bin_dir "Rust" "CLCOMX_WIN_CARGO_DIR" "$CARGO_PROBE_SCRIPT")"; then
  echo "[env] Found Rust: $WIN_CARGO_DIR"
  WIN_EXTRA_PATHS="$(_join_win_path "$WIN_EXTRA_PATHS" "$WIN_CARGO_DIR")"
else
  echo "[env] ERROR: Rust tools were not found on Windows." >&2
  echo "[env]        Install Rust on Windows or set CLCOMX_WIN_CARGO_DIR." >&2
fi

if WIN_NODE_DIR="$(_resolve_win_bin_dir "Node.js" "CLCOMX_WIN_NODE_DIR" "$NODE_PROBE_SCRIPT")"; then
  echo "[env] Found Node.js: $WIN_NODE_DIR"
  WIN_EXTRA_PATHS="$(_join_win_path "$WIN_EXTRA_PATHS" "$WIN_NODE_DIR")"
else
  echo "[env] ERROR: Node.js was not found on Windows." >&2
  echo "[env]        Install Node.js on Windows or set CLCOMX_WIN_NODE_DIR." >&2
fi

if [ -n "${CLCOMX_WIN_EXTRA_PATHS:-}" ]; then
  WIN_EXTRA_PATHS="$(_join_win_path "$WIN_EXTRA_PATHS" "${CLCOMX_WIN_EXTRA_PATHS}")"
fi

if [ -z "$WIN_CARGO_DIR" ] || [ -z "$WIN_NODE_DIR" ]; then
  echo "[env] Build tools detection failed." >&2
  echo "[env] Example override usage:" >&2
  echo "[env]   export CLCOMX_WIN_CARGO_DIR='C:\\Users\\<user>\\.cargo\\bin'" >&2
  echo "[env]   export CLCOMX_WIN_NODE_DIR='C:\\Program Files\\nodejs'" >&2
  return 1 2>/dev/null || exit 1
fi

WIN_ENV_CMD="\$env:Path = '$WIN_EXTRA_PATHS;' + \$env:Path"

export WIN_CARGO_DIR
export WIN_NODE_DIR
export WIN_ENV_CMD
echo "[env] Done."

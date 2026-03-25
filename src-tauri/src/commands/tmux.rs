use crate::app_env::ensure_parent_dir;
use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as BASE64;
use serde::{Deserialize, Serialize};
use std::fs;
use std::io::{BufRead, BufReader, Write};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::process::{ChildStdin, Command, Stdio};
use std::sync::{Arc, Mutex, atomic::{AtomicBool, AtomicUsize, Ordering}};
#[cfg(windows)]
use std::os::windows::process::CommandExt;
use tauri::{AppHandle, Emitter, State};

const TMUX_SESSION_PREFIX: &str = "clcomx";
const TMUX_CONTROL_START: &str = "\u{1b}P1000p";
const TMUX_CONTROL_END: &str = "\u{1b}\\";
const TMUX_PROXY_SCRIPT: &str = include_str!("../../scripts/tmux_proxy.py");

#[derive(Default)]
pub struct TmuxState {
    sessions: Mutex<HashMap<String, TmuxSessionRegistration>>,
}

struct TmuxSessionRegistration {
    pub distro: String,
    pub session_name: String,
    pub history_lines: u32,
    pub subscribers: HashSet<String>,
    pub controller_started: bool,
    pub controller_alive: Arc<AtomicBool>,
    pub controller_writer: Option<Arc<Mutex<ChildStdin>>>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TmuxPaneSnapshot {
    pub pane_id: String,
    pub active: bool,
    pub dead: bool,
    pub left: u16,
    pub top: u16,
    pub width: u16,
    pub height: u16,
    pub cursor_x: u16,
    pub cursor_y: u16,
    pub current_path: String,
    pub current_command: String,
    pub history_text: String,
    pub screen_text: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TmuxSessionSnapshot {
    pub session_name: String,
    pub active_pane_id: String,
    pub width: u16,
    pub height: u16,
    pub panes: Vec<TmuxPaneSnapshot>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TmuxStateEvent {
    pub session_id: String,
    pub snapshot: TmuxSessionSnapshot,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TmuxOutputEvent {
    pub session_id: String,
    pub pane_id: String,
    pub data: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TmuxErrorEvent {
    pub session_id: String,
    pub message: String,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
enum TmuxProxyEvent {
    State { snapshot: TmuxSessionSnapshot },
    Output {
        #[serde(rename = "paneId")]
        pane_id: String,
        data: String,
    },
    Error { message: String },
}

fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

fn tmux_quote_arg(value: &str) -> String {
    format!(
        "\"{}\"",
        value
            .replace('\\', "\\\\")
            .replace('"', "\\\"")
            .replace('$', "\\$")
    )
}

fn build_tmux_session_name(seed: &str) -> String {
    let mut normalized = seed
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' {
                ch
            } else {
                '-'
            }
        })
        .collect::<String>();
    normalized.truncate(48);
    while normalized.contains("--") {
        normalized = normalized.replace("--", "-");
    }
    normalized = normalized.trim_matches('-').to_string();
    if normalized.is_empty() {
        return format!("{TMUX_SESSION_PREFIX}-session");
    }

    if normalized.starts_with(&format!("{TMUX_SESSION_PREFIX}-")) {
        normalized
    } else {
        format!("{TMUX_SESSION_PREFIX}-{normalized}")
    }
}

fn host_path_to_wsl(path: &Path) -> Result<String, String> {
    let path_str = path.to_string_lossy().to_string();
    let bytes = path_str.as_bytes();
    if bytes.len() >= 3 && bytes[1] == b':' {
        let drive = (bytes[0] as char).to_ascii_lowercase();
        let rest = path_str[2..].replace('\\', "/");
        return Ok(format!("/mnt/{drive}{rest}"));
    }
    if path_str.starts_with('/') {
        return Ok(path_str.replace('\\', "/"));
    }
    Err(format!("Failed to convert host path '{}' to WSL path", path.display()))
}

fn ensure_tmux_proxy_script() -> Result<PathBuf, String> {
    let path = std::env::temp_dir().join("clcomx").join("tmux_proxy.py");
    ensure_parent_dir(&path)?;
    let should_write = match fs::read_to_string(&path) {
        Ok(existing) => existing != TMUX_PROXY_SCRIPT,
        Err(_) => true,
    };
    if should_write {
        fs::write(&path, TMUX_PROXY_SCRIPT)
            .map_err(|error| format!("Failed to write tmux proxy script: {error}"))?;
    }
    Ok(path)
}

fn run_wsl_shell(distro: &str, script: &str) -> Result<String, String> {
    let mut command = Command::new("wsl.exe");
    command
        .arg("-d")
        .arg(distro)
        .arg("-e")
        .arg("bash")
        .arg("-lc")
        .arg(script);

    #[cfg(windows)]
    command.creation_flags(0x08000000); // CREATE_NO_WINDOW

    let output = command
        .output()
        .map_err(|error| format!("Failed to run WSL command: {error}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
        let detail = if !stderr.is_empty() { stderr } else { stdout };
        return Err(if detail.is_empty() {
            format!("tmux command failed with status {}", output.status)
        } else {
            detail
        });
    }

    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

fn decode_field(value: &str) -> Result<String, String> {
    let bytes = BASE64
        .decode(value.trim())
        .map_err(|error| format!("Invalid tmux payload field: {error}"))?;
    String::from_utf8(bytes).map_err(|error| format!("Invalid UTF-8 in tmux payload field: {error}"))
}

fn parse_tmux_snapshot(output: &str) -> Result<Option<TmuxSessionSnapshot>, String> {
    let mut session_name = None;
    let mut active_pane_id = None;
    let mut width = 0u16;
    let mut height = 0u16;
    let mut panes = Vec::new();

    for line in output.lines() {
        if line.trim().is_empty() {
            continue;
        }

        let parts = line.split('\t').collect::<Vec<_>>();
        match parts.first().copied() {
            Some("__CLCOMX_TMUX_MISSING__") => return Ok(None),
            Some("__CLCOMX_TMUX_SESSION__") if parts.len() >= 5 => {
                session_name = Some(parts[1].to_string());
                width = parts[2].parse::<u16>().unwrap_or(0);
                height = parts[3].parse::<u16>().unwrap_or(0);
                active_pane_id = Some(parts[4].to_string());
            }
            Some("__CLCOMX_TMUX_PANE__") if parts.len() >= 14 => {
                panes.push(TmuxPaneSnapshot {
                    pane_id: parts[1].to_string(),
                    active: parts[2] == "1",
                    dead: parts[3] == "1",
                    left: parts[4].parse::<u16>().unwrap_or(0),
                    top: parts[5].parse::<u16>().unwrap_or(0),
                    width: parts[6].parse::<u16>().unwrap_or(0),
                    height: parts[7].parse::<u16>().unwrap_or(0),
                    cursor_x: parts[8].parse::<u16>().unwrap_or(0),
                    cursor_y: parts[9].parse::<u16>().unwrap_or(0),
                    current_path: decode_field(parts[10])?,
                    current_command: decode_field(parts[11])?,
                    history_text: decode_field(parts[12])?,
                    screen_text: decode_field(parts[13])?,
                });
            }
            _ => {}
        }
    }

    let Some(session_name) = session_name else {
        return Err("Tmux snapshot did not include session metadata".into());
    };

    let Some(active_pane_id) = active_pane_id else {
        return Err("Tmux snapshot did not include active pane metadata".into());
    };

    Ok(Some(TmuxSessionSnapshot {
        session_name,
        active_pane_id,
        width,
        height,
        panes,
    }))
}

fn capture_snapshot_script(session_name: &str, history_lines: u32) -> String {
    let session = shell_quote(session_name);
    let session_format = "#{session_name}\t#{window_width}\t#{window_height}";
    let pane_format = "#{pane_id}\t#{pane_active}\t#{pane_dead}\t#{pane_left}\t#{pane_top}\t#{pane_width}\t#{pane_height}\t#{cursor_x}\t#{cursor_y}\t#{pane_current_path}\t#{pane_current_command}";
    let capture_start = if history_lines == 0 {
        "-".to_string()
    } else {
        format!("-{history_lines}")
    };
    format!(
        "
session_name={session}
if ! tmux has-session -t \"$session_name\" 2>/dev/null; then
  echo \"__CLCOMX_TMUX_MISSING__\"
  exit 0
fi

session_line=$(tmux display-message -p -t \"$session_name\" '{session_format}')
active_pane_id=$(tmux list-panes -t \"$session_name\" -F '#{{?pane_active,#{{pane_id}},}}' | sed -n '/./{{p;q;}}')
if [ -z \"$active_pane_id\" ]; then
  active_pane_id=$(tmux list-panes -t \"$session_name\" -F '#{{pane_id}}' | sed -n '1p')
fi
printf '__CLCOMX_TMUX_SESSION__\t%s\t%s\n' \"$session_line\" \"$active_pane_id\"

while IFS=$'\t' read -r pane_id pane_active pane_dead pane_left pane_top pane_width pane_height cursor_x cursor_y pane_current_path pane_current_command; do
  path_b64=$(printf '%s' \"$pane_current_path\" | base64 -w0)
  command_b64=$(printf '%s' \"$pane_current_command\" | base64 -w0)
  if [ {history_lines} -gt 0 ]; then
    history_b64=$(tmux capture-pane -p -N -e -S {capture_start} -E -1 -t \"$pane_id\" | base64 -w0)
  else
    history_b64=$(printf '' | base64 -w0)
  fi
  screen_b64=$(tmux capture-pane -p -N -e -t \"$pane_id\" | base64 -w0)
  printf '__CLCOMX_TMUX_PANE__\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
    \"$pane_id\" \"$pane_active\" \"$pane_dead\" \"$pane_left\" \"$pane_top\" \"$pane_width\" \"$pane_height\" \
    \"$cursor_x\" \"$cursor_y\" \"$path_b64\" \"$command_b64\" \"$history_b64\" \"$screen_b64\"
done < <(tmux list-panes -t \"$session_name\" -F '{pane_format}')
        ",
        history_lines = history_lines,
    )
}

fn collect_tmux_snapshot(
    distro: &str,
    session_name: &str,
    history_lines: u32,
) -> Result<Option<TmuxSessionSnapshot>, String> {
    let output = run_wsl_shell(distro, &capture_snapshot_script(session_name, history_lines))?;
    parse_tmux_snapshot(&output)
}

fn collect_tmux_snapshot_with_size_wait(
    distro: &str,
    session_name: &str,
    history_lines: u32,
    cols: u16,
    rows: u16,
) -> Result<Option<TmuxSessionSnapshot>, String> {
    let target_cols = cols.max(60);
    let target_rows = rows.max(16);
    let mut latest = None;

    for attempt in 0..8 {
        latest = collect_tmux_snapshot(distro, session_name, history_lines)?;
        if let Some(snapshot) = latest.as_ref() {
            if snapshot.width == target_cols && snapshot.height == target_rows {
                return Ok(latest);
            }
        }

        if attempt < 7 {
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
    }

    Ok(latest)
}

fn emit_tmux_state(app: &AppHandle, session_id: &str, snapshot: &TmuxSessionSnapshot) -> Result<(), String> {
    app.emit(
        "clcomx:tmux/state",
        TmuxStateEvent {
            session_id: session_id.to_string(),
            snapshot: snapshot.clone(),
        },
    )
    .map_err(|error| error.to_string())
}

fn emit_tmux_output(app: &AppHandle, session_id: &str, pane_id: &str, data: &str) -> Result<(), String> {
    app.emit(
        "clcomx:tmux/output",
        TmuxOutputEvent {
            session_id: session_id.to_string(),
            pane_id: pane_id.to_string(),
            data: data.to_string(),
        },
    )
    .map_err(|error| error.to_string())
}

fn emit_tmux_error(app: &AppHandle, session_id: &str, message: impl Into<String>) -> Result<(), String> {
    app.emit(
        "clcomx:tmux/error",
        TmuxErrorEvent {
            session_id: session_id.to_string(),
            message: message.into(),
        },
    )
    .map_err(|error| error.to_string())
}

fn unescape_tmux_output(input: &str) -> String {
    let mut bytes = Vec::with_capacity(input.len());
    let raw = input.as_bytes();
    let mut index = 0usize;

    while index < raw.len() {
        if raw[index] != b'\\' {
            bytes.push(raw[index]);
            index += 1;
            continue;
        }

        index += 1;
        if index >= raw.len() {
            bytes.push(b'\\');
            break;
        }

        match raw[index] {
            b'\\' => {
                bytes.push(b'\\');
                index += 1;
            }
            b'n' => {
                bytes.push(b'\n');
                index += 1;
            }
            b'r' => {
                bytes.push(b'\r');
                index += 1;
            }
            b't' => {
                bytes.push(b'\t');
                index += 1;
            }
            b'0'..=b'7' => {
                let mut value = 0u16;
                let mut count = 0usize;
                while index < raw.len() && count < 3 && (b'0'..=b'7').contains(&raw[index]) {
                    value = (value * 8) + u16::from(raw[index] - b'0');
                    index += 1;
                    count += 1;
                }
                bytes.push((value & 0xff) as u8);
            }
            other => {
                bytes.push(other);
                index += 1;
            }
        }
    }

    String::from_utf8_lossy(&bytes).to_string()
}

fn is_structural_event(line: &str) -> bool {
    matches!(
        line.split_whitespace().next(),
        Some("%layout-change")
            | Some("%window-pane-changed")
            | Some("%window-add")
            | Some("%window-close")
            | Some("%sessions-changed")
            | Some("%session-changed")
            | Some("%session-window-changed")
            | Some("%unlinked-window-add")
            | Some("%unlinked-window-close")
            | Some("%pane-mode-changed")
    )
}

fn strip_tmux_control_wrappers(line: &str) -> &str {
    let mut stripped = line.trim_end_matches('\r');
    while let Some(next) = stripped.strip_prefix(TMUX_CONTROL_START) {
        stripped = next;
    }
    while let Some(next) = stripped.strip_suffix(TMUX_CONTROL_END) {
        stripped = next;
    }
    stripped
}

fn collect_tmux_control_messages(pending: &mut String) -> Vec<String> {
    let mut messages = Vec::new();

    loop {
        if let Some(start) = pending.find(TMUX_CONTROL_START) {
            if start > 0 {
                let prefix = pending[..start].to_string();
                pending.drain(..start);
                for line in prefix.split(['\n', '\r']) {
                    if !line.is_empty() {
                        messages.push(line.to_string());
                    }
                }
                continue;
            }

            pending.drain(..TMUX_CONTROL_START.len());
            continue;
        }

        if let Some(end) = pending.find(TMUX_CONTROL_END) {
            if end > 0 {
                let prefix = pending[..end].to_string();
                pending.drain(..end + TMUX_CONTROL_END.len());
                for line in prefix.split(['\n', '\r']) {
                    if !line.is_empty() {
                        messages.push(line.to_string());
                    }
                }
                continue;
            }
            pending.drain(..TMUX_CONTROL_END.len());
            continue;
        }

        let Some(line_end) = pending.find(['\n', '\r']) else {
            break;
        };
        let line = pending[..line_end].to_string();
        let mut consume = line_end;
        while consume < pending.len() {
            let byte = pending.as_bytes()[consume];
            if byte == b'\n' || byte == b'\r' {
                consume += 1;
            } else {
                break;
            }
        }
        pending.drain(..consume);
        if !line.is_empty() {
            messages.push(line);
        }
    }

    messages
}

fn handle_tmux_control_line(
    app: &AppHandle,
    session_id: &str,
    distro: &str,
    session_name: &str,
    history_lines: u32,
    line: &str,
) -> Result<(), String> {
    if line.starts_with("%begin ") || line.starts_with("%end ") {
        return Ok(());
    }

    if line.starts_with("%output ") {
        let mut parts = line.splitn(3, ' ');
        let _ = parts.next();
        let pane_id = parts
            .next()
            .ok_or_else(|| "tmux output line missing pane id".to_string())?;
        let payload = parts.next().unwrap_or_default();
        let decoded = unescape_tmux_output(payload);
        if !decoded.is_empty() {
            emit_tmux_output(app, session_id, pane_id, &decoded)?;
        }
        return Ok(());
    }

    if line.starts_with("%extended-output ") {
        let mut parts = line.splitn(5, ' ');
        let _ = parts.next();
        let pane_id = parts
            .next()
            .ok_or_else(|| "tmux extended-output line missing pane id".to_string())?;
        let _age = parts.next();
        let marker_or_payload = parts.next().unwrap_or_default();
        let payload = if marker_or_payload == ":" {
            parts.next().unwrap_or_default()
        } else {
            marker_or_payload
        };
        let decoded = unescape_tmux_output(payload);
        if !decoded.is_empty() {
            emit_tmux_output(app, session_id, pane_id, &decoded)?;
        }
        return Ok(());
    }

    if is_structural_event(line) {
        if let Some(snapshot) = collect_tmux_snapshot(distro, session_name, history_lines)? {
            emit_tmux_state(app, session_id, &snapshot)?;
        }
        return Ok(());
    }

    if line.starts_with('%') {
        return Ok(());
    }

    emit_tmux_error(app, session_id, format!("tmux control: {line}"))?;
    Ok(())
}

fn spawn_tmux_controller(
    app: AppHandle,
    session_id: String,
    distro: String,
    session_name: String,
    history_lines: u32,
    alive: Arc<AtomicBool>,
) -> Result<Arc<Mutex<ChildStdin>>, String> {
    let helper_host_path = ensure_tmux_proxy_script()?;
    let helper_wsl_path = host_path_to_wsl(&helper_host_path)?;

    let mut child = Command::new("wsl.exe");
    child
        .arg("-d")
        .arg(&distro)
        .arg("-e")
        .arg("python3")
        .arg("-u")
        .arg(&helper_wsl_path)
        .arg("--session-name")
        .arg(&session_name)
        .arg("--cols")
        .arg("160")
        .arg("--rows")
        .arg("40")
        .arg("--history-lines")
        .arg(history_lines.to_string())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    #[cfg(windows)]
    child.creation_flags(0x08000000); // CREATE_NO_WINDOW

    let mut child = child
        .spawn()
        .map_err(|error| format!("Failed to start tmux proxy helper: {error}"))?;

    let stdin = child
        .stdin
        .take()
        .ok_or_else(|| "tmux proxy helper did not expose stdin".to_string())?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "tmux proxy helper did not expose stdout".to_string())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "tmux proxy helper did not expose stderr".to_string())?;

    let writer = Arc::new(Mutex::new(stdin));
    let lines_seen = Arc::new(AtomicUsize::new(0));
    let lines_seen_for_wait = lines_seen.clone();
    let alive_for_wait = alive.clone();
    let app_for_wait = app.clone();
    let session_id_for_wait = session_id.clone();
    std::thread::spawn(move || {
        let status = child.wait();
        alive_for_wait.store(false, Ordering::SeqCst);
        let message = match status {
            Ok(status) => format!(
                "tmux proxy exited: status={status}, lines={}",
                lines_seen_for_wait.load(Ordering::SeqCst)
            ),
            Err(error) => format!(
                "tmux proxy wait failed: {error}, lines={}",
                lines_seen_for_wait.load(Ordering::SeqCst)
            ),
        };
        let _ = emit_tmux_error(&app_for_wait, &session_id_for_wait, message);
    });

    let app_for_stdout = app.clone();
    let session_id_for_stdout = session_id.clone();
    std::thread::spawn(move || {
        let mut reader = BufReader::new(stdout);
        let mut line = String::new();
        loop {
            line.clear();
            match reader.read_line(&mut line) {
                Ok(0) => break,
                Ok(_) => {
                    let trimmed = line.trim();
                    if trimmed.is_empty() {
                        continue;
                    }
                    lines_seen.fetch_add(1, Ordering::SeqCst);
                    match serde_json::from_str::<TmuxProxyEvent>(trimmed) {
                        Ok(TmuxProxyEvent::State { snapshot }) => {
                            let _ = emit_tmux_state(&app_for_stdout, &session_id_for_stdout, &snapshot);
                        }
                        Ok(TmuxProxyEvent::Output { pane_id, data }) => {
                            let _ = emit_tmux_output(&app_for_stdout, &session_id_for_stdout, &pane_id, &data);
                        }
                        Ok(TmuxProxyEvent::Error { message }) => {
                            let _ = emit_tmux_error(&app_for_stdout, &session_id_for_stdout, message);
                        }
                        Err(error) => {
                            let _ = emit_tmux_error(
                                &app_for_stdout,
                                &session_id_for_stdout,
                                format!("tmux proxy produced invalid JSON: {error}: {trimmed}"),
                            );
                        }
                    }
                }
                Err(error) => {
                    let _ = emit_tmux_error(
                        &app_for_stdout,
                        &session_id_for_stdout,
                        format!("Failed to read tmux proxy stdout: {error}"),
                    );
                    break;
                }
            }
        }
    });

    let app_for_stderr = app.clone();
    let session_id_for_stderr = session_id.clone();
    std::thread::spawn(move || {
        let mut reader = BufReader::new(stderr);
        let mut line = String::new();
        loop {
            line.clear();
            match reader.read_line(&mut line) {
                Ok(0) => break,
                Ok(_) => {
                    let trimmed = line.trim();
                    if !trimmed.is_empty() {
                        let _ = emit_tmux_error(
                            &app_for_stderr,
                            &session_id_for_stderr,
                            format!("tmux proxy stderr: {trimmed}"),
                        );
                    }
                }
                Err(error) => {
                    let _ = emit_tmux_error(
                        &app_for_stderr,
                        &session_id_for_stderr,
                        format!("Failed to read tmux proxy stderr: {error}"),
                    );
                    break;
                }
            }
        }
    });

    Ok(writer)
}

fn send_tmux_key(distro: &str, pane_id: &str, key: &str) -> Result<(), String> {
    let script = format!(
        "tmux send-keys -t {} {}",
        shell_quote(pane_id),
        shell_quote(key),
    );
    run_wsl_shell(distro, &script).map(|_| ())
}

fn send_tmux_literal(distro: &str, pane_id: &str, text: &str) -> Result<(), String> {
    let script = format!(
        "tmux send-keys -l -t {} -- {}",
        shell_quote(pane_id),
        shell_quote(text),
    );
    run_wsl_shell(distro, &script).map(|_| ())
}

fn send_tmux_control_command(
    writer: &Arc<Mutex<ChildStdin>>,
    command: &str,
) -> Result<(), String> {
    let mut writer = writer.lock().map_err(|error| error.to_string())?;
    writer
        .write_all(command.as_bytes())
        .map_err(|error| format!("Failed to write tmux control command: {error}"))?;
    writer
        .write_all(b"\n")
        .map_err(|error| format!("Failed to terminate tmux control command: {error}"))?;
    writer
        .flush()
        .map_err(|error| format!("Failed to flush tmux control command: {error}"))?;
    Ok(())
}

fn get_tmux_controller(
    state: &TmuxState,
    session_id: &str,
) -> Result<Option<(String, String, u32, Arc<AtomicBool>, Arc<Mutex<ChildStdin>>)>, String> {
    let sessions = state.sessions.lock().map_err(|error| error.to_string())?;
    let Some(registration) = sessions.get(session_id) else {
        return Ok(None);
    };
    let Some(writer) = registration.controller_writer.clone() else {
        return Ok(None);
    };
    Ok(Some((
        registration.distro.clone(),
        registration.session_name.clone(),
        registration.history_lines,
        registration.controller_alive.clone(),
        writer,
    )))
}

#[derive(Debug, Clone)]
enum InputAction {
    Literal(String),
    Key(&'static str),
}

fn translate_input(data: &str) -> Vec<InputAction> {
    let mut actions = Vec::new();
    let mut literal = String::new();
    let bytes = data.as_bytes();
    let mut index = 0usize;

    let flush_literal = |literal: &mut String, actions: &mut Vec<InputAction>| {
        if !literal.is_empty() {
            actions.push(InputAction::Literal(literal.clone()));
            literal.clear();
        }
    };

    while index < bytes.len() {
        if data[index..].starts_with("\u{1b}[A") {
            flush_literal(&mut literal, &mut actions);
            actions.push(InputAction::Key("Up"));
            index += 3;
            continue;
        }
        if data[index..].starts_with("\u{1b}[B") {
            flush_literal(&mut literal, &mut actions);
            actions.push(InputAction::Key("Down"));
            index += 3;
            continue;
        }
        if data[index..].starts_with("\u{1b}[C") {
            flush_literal(&mut literal, &mut actions);
            actions.push(InputAction::Key("Right"));
            index += 3;
            continue;
        }
        if data[index..].starts_with("\u{1b}[D") {
            flush_literal(&mut literal, &mut actions);
            actions.push(InputAction::Key("Left"));
            index += 3;
            continue;
        }
        if data[index..].starts_with("\u{1b}[3~") {
            flush_literal(&mut literal, &mut actions);
            actions.push(InputAction::Key("DC"));
            index += 4;
            continue;
        }
        if data[index..].starts_with("\u{1b}[H") || data[index..].starts_with("\u{1b}OH") {
            flush_literal(&mut literal, &mut actions);
            actions.push(InputAction::Key("Home"));
            index += 3;
            continue;
        }
        if data[index..].starts_with("\u{1b}[F") || data[index..].starts_with("\u{1b}OF") {
            flush_literal(&mut literal, &mut actions);
            actions.push(InputAction::Key("End"));
            index += 3;
            continue;
        }

        let remaining = &data[index..];
        let Some(ch) = remaining.chars().next() else {
            break;
        };
        let len = ch.len_utf8();

        match ch {
            '\r' => {
                flush_literal(&mut literal, &mut actions);
                actions.push(InputAction::Key("C-m"));
            }
            '\t' => {
                flush_literal(&mut literal, &mut actions);
                actions.push(InputAction::Key("Tab"));
            }
            '\u{7f}' => {
                flush_literal(&mut literal, &mut actions);
                actions.push(InputAction::Key("BSpace"));
            }
            '\u{3}' => {
                flush_literal(&mut literal, &mut actions);
                actions.push(InputAction::Key("C-c"));
            }
            '\u{4}' => {
                flush_literal(&mut literal, &mut actions);
                actions.push(InputAction::Key("C-d"));
            }
            '\u{c}' => {
                flush_literal(&mut literal, &mut actions);
                actions.push(InputAction::Key("C-l"));
            }
            '\u{1b}' => {
                flush_literal(&mut literal, &mut actions);
                actions.push(InputAction::Key("Escape"));
            }
            _ => literal.push(ch),
        }

        index += len;
    }

    if !literal.is_empty() {
        actions.push(InputAction::Literal(literal));
    }

    actions
}

#[tauri::command]
pub async fn tmux_create_session(
    distro: String,
    work_dir: String,
    start_command: String,
    session_seed: String,
    cols: u16,
    rows: u16,
    history_lines: u32,
) -> Result<TmuxSessionSnapshot, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let session_name = build_tmux_session_name(&session_seed);
        let script = format!(
            "if tmux has-session -t {session} 2>/dev/null; then exit 0; fi\n\
             session_line=$(tmux new-session -d -P -F '#{{session_name}}\t#{{pane_id}}' -s {session} -x {cols} -y {rows} -c {work_dir} {command})\n\
             pane_id=${{session_line#*$'\\t'}}\n\
             tmux send-keys -t \"$pane_id\" -l -- {start_command}\n\
             tmux send-keys -t \"$pane_id\" C-m\n\
             printf '%s\\n' \"$session_line\"",
            session = shell_quote(&session_name),
            cols = cols.max(60),
            rows = rows.max(16),
            work_dir = shell_quote(&work_dir),
            command = shell_quote("bash -li"),
            start_command = shell_quote(&start_command),
        );
        run_wsl_shell(&distro, &script)?;
        collect_tmux_snapshot_with_size_wait(&distro, &session_name, history_lines, cols, rows)?
            .ok_or_else(|| "Failed to create tmux session snapshot".into())
    })
    .await
    .map_err(|error| format!("Failed to join tmux create task: {error}"))?
}

#[tauri::command]
pub async fn tmux_subscribe_session(
    app: AppHandle,
    state: State<'_, TmuxState>,
    session_id: String,
    subscriber_id: String,
    distro: String,
    work_dir: String,
    start_command: String,
    session_name: Option<String>,
    cols: u16,
    rows: u16,
    history_lines: u32,
) -> Result<TmuxSessionSnapshot, String> {
    let desired_session_name = session_name.unwrap_or_else(|| build_tmux_session_name(&session_id));

    let snapshot = tauri::async_runtime::spawn_blocking({
        let distro = distro.clone();
        let work_dir = work_dir.clone();
        let start_command = start_command.clone();
        let desired_session_name = desired_session_name.clone();
        move || -> Result<TmuxSessionSnapshot, String> {
            if let Some(existing) =
                collect_tmux_snapshot(&distro, &desired_session_name, history_lines)?
            {
                return Ok(existing);
            }

            let script = format!(
                "if tmux has-session -t {session} 2>/dev/null; then exit 0; fi\n\
                 session_line=$(tmux new-session -d -P -F '#{{session_name}}\t#{{pane_id}}' -s {session} -x {cols} -y {rows} -c {work_dir} {command})\n\
                 pane_id=${{session_line#*$'\\t'}}\n\
                 tmux send-keys -t \"$pane_id\" -l -- {start_command}\n\
                 tmux send-keys -t \"$pane_id\" C-m\n\
                 printf '%s\\n' \"$session_line\"",
                session = shell_quote(&desired_session_name),
                cols = cols.max(60),
                rows = rows.max(16),
                work_dir = shell_quote(&work_dir),
                command = shell_quote("bash -li"),
                start_command = shell_quote(&start_command),
            );
            run_wsl_shell(&distro, &script)?;
            collect_tmux_snapshot_with_size_wait(
                &distro,
                &desired_session_name,
                history_lines,
                cols,
                rows,
            )?
                .ok_or_else(|| "Failed to create tmux session snapshot".to_string())
        }
    })
    .await
    .map_err(|error| format!("Failed to join tmux subscribe task: {error}"))??;

    {
        let mut sessions = state.sessions.lock().map_err(|error| error.to_string())?;
        let registration = sessions
            .entry(session_id.clone())
            .or_insert_with(|| TmuxSessionRegistration {
                distro: distro.clone(),
                session_name: snapshot.session_name.clone(),
                history_lines,
                subscribers: HashSet::new(),
                controller_started: false,
                controller_alive: Arc::new(AtomicBool::new(false)),
                controller_writer: None,
            });
        registration.distro = distro;
        registration.session_name = snapshot.session_name.clone();
        registration.history_lines = history_lines;
        registration.subscribers.insert(subscriber_id);

        if !registration.controller_started || !registration.controller_alive.load(Ordering::SeqCst) {
            registration.controller_started = true;
            registration.controller_alive.store(true, Ordering::SeqCst);
            let writer = spawn_tmux_controller(
                app.clone(),
                session_id.clone(),
                registration.distro.clone(),
                registration.session_name.clone(),
                registration.history_lines,
                registration.controller_alive.clone(),
            )?;
            registration.controller_writer = Some(writer);
        }
    }

    emit_tmux_state(&app, &session_id, &snapshot)?;
    Ok(snapshot)
}

#[tauri::command]
pub fn tmux_unsubscribe_session(
    state: State<'_, TmuxState>,
    session_id: String,
    subscriber_id: String,
) -> Result<(), String> {
    let mut sessions = state.sessions.lock().map_err(|error| error.to_string())?;
    if let Some(registration) = sessions.get_mut(&session_id) {
        registration.subscribers.remove(&subscriber_id);
    }
    Ok(())
}

#[tauri::command]
pub async fn tmux_get_session_snapshot(
    distro: String,
    session_name: String,
    history_lines: u32,
) -> Result<Option<TmuxSessionSnapshot>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        collect_tmux_snapshot(&distro, &session_name, history_lines)
    })
    .await
    .map_err(|error| format!("Failed to join tmux snapshot task: {error}"))?
}

#[tauri::command]
pub async fn tmux_send_input(
    state: State<'_, TmuxState>,
    session_id: String,
    distro: String,
    pane_id: String,
    data: String,
) -> Result<(), String> {
    let controller = get_tmux_controller(state.inner(), &session_id)?;
    tauri::async_runtime::spawn_blocking(move || {
        let actions = translate_input(&data);
        if let Some((_, _, _, alive, stdin)) = controller {
            if alive.load(Ordering::SeqCst) {
                for action in actions.clone() {
                    let command = match action {
                        InputAction::Literal(value) => format!(
                            "send-keys -t {} -l -- {}",
                            tmux_quote_arg(&pane_id),
                            tmux_quote_arg(&value),
                        ),
                        InputAction::Key(key) => format!(
                            "send-keys -t {} {}",
                            tmux_quote_arg(&pane_id),
                            key,
                        ),
                    };
                    send_tmux_control_command(&stdin, &command)?;
                }
                return Ok(());
            }
        }
        {
            for action in actions {
                match action {
                    InputAction::Literal(value) => send_tmux_literal(&distro, &pane_id, &value)?,
                    InputAction::Key(key) => send_tmux_key(&distro, &pane_id, key)?,
                }
            }
        }
        Ok(())
    })
    .await
    .map_err(|error| format!("Failed to join tmux input task: {error}"))?
}

#[tauri::command]
pub async fn tmux_split_pane(
    state: State<'_, TmuxState>,
    session_id: String,
    distro: String,
    target_pane_id: String,
    direction: String,
    work_dir: String,
) -> Result<(), String> {
    let controller = get_tmux_controller(state.inner(), &session_id)?;
    tauri::async_runtime::spawn_blocking(move || {
        let flag = if direction == "horizontal" { "-h" } else { "-v" };
        if let Some((_, _, _, alive, stdin)) = controller {
            if alive.load(Ordering::SeqCst) {
                let command = format!(
                    "split-window {flag} -t {target} -c {work_dir} {shell}",
                    flag = flag,
                    target = tmux_quote_arg(&target_pane_id),
                    work_dir = tmux_quote_arg(&work_dir),
                    shell = tmux_quote_arg("bash -li"),
                );
                return send_tmux_control_command(&stdin, &command);
            }
        }
        let script = format!(
            "tmux split-window {flag} -t {target} -c {work_dir} {command}",
            flag = flag,
            target = shell_quote(&target_pane_id),
            work_dir = shell_quote(&work_dir),
            command = shell_quote("bash -li"),
        );
        run_wsl_shell(&distro, &script).map(|_| ())
    })
    .await
    .map_err(|error| format!("Failed to join tmux split task: {error}"))?
}

#[tauri::command]
pub async fn tmux_select_pane(
    state: State<'_, TmuxState>,
    session_id: String,
    distro: String,
    pane_id: String,
) -> Result<(), String> {
    let controller = get_tmux_controller(state.inner(), &session_id)?;
    tauri::async_runtime::spawn_blocking(move || {
        if let Some((_, _, _, alive, stdin)) = controller {
            if alive.load(Ordering::SeqCst) {
                return send_tmux_control_command(
                    &stdin,
                    &format!("select-pane -t {}", tmux_quote_arg(&pane_id)),
                );
            }
        }
        let script = format!("tmux select-pane -t {}", shell_quote(&pane_id));
        run_wsl_shell(&distro, &script).map(|_| ())
    })
    .await
    .map_err(|error| format!("Failed to join tmux select task: {error}"))?
}

#[tauri::command]
pub async fn tmux_select_pane_direction(
    state: State<'_, TmuxState>,
    session_id: String,
    distro: String,
    pane_id: String,
    direction: String,
) -> Result<(), String> {
    let controller = get_tmux_controller(state.inner(), &session_id)?;
    tauri::async_runtime::spawn_blocking(move || {
        let flag = match direction.as_str() {
            "left" => "-L",
            "right" => "-R",
            "up" => "-U",
            "down" => "-D",
            _ => return Err("Unsupported tmux pane direction".into()),
        };
        if let Some((_, _, _, alive, stdin)) = controller {
            if alive.load(Ordering::SeqCst) {
                return send_tmux_control_command(
                    &stdin,
                    &format!("select-pane -t {} {}", tmux_quote_arg(&pane_id), flag),
                );
            }
        }
        let script = format!(
            "tmux select-pane -t {pane} {flag}",
            pane = shell_quote(&pane_id),
            flag = flag,
        );
        run_wsl_shell(&distro, &script).map(|_| ())
    })
    .await
    .map_err(|error| format!("Failed to join tmux directional select task: {error}"))?
}

#[tauri::command]
pub async fn tmux_kill_pane(
    state: State<'_, TmuxState>,
    session_id: String,
    distro: String,
    pane_id: String,
) -> Result<(), String> {
    let controller = get_tmux_controller(state.inner(), &session_id)?;
    tauri::async_runtime::spawn_blocking(move || {
        if let Some((_, _, _, alive, stdin)) = controller {
            if alive.load(Ordering::SeqCst) {
                return send_tmux_control_command(
                    &stdin,
                    &format!("kill-pane -t {}", tmux_quote_arg(&pane_id)),
                );
            }
        }
        let script = format!("tmux kill-pane -t {}", shell_quote(&pane_id));
        run_wsl_shell(&distro, &script).map(|_| ())
    })
    .await
    .map_err(|error| format!("Failed to join tmux kill-pane task: {error}"))?
}

#[tauri::command]
pub async fn tmux_kill_session(
    distro: String,
    session_name: String,
    state: State<'_, TmuxState>,
) -> Result<(), String> {
    {
        let mut sessions = state.sessions.lock().map_err(|error| error.to_string())?;
        sessions.retain(|_, registration| registration.session_name != session_name);
    }
    tauri::async_runtime::spawn_blocking(move || {
        let script = format!(
            "tmux has-session -t {session} 2>/dev/null && tmux kill-session -t {session} || true",
            session = shell_quote(&session_name),
        );
        run_wsl_shell(&distro, &script).map(|_| ())
    })
    .await
    .map_err(|error| format!("Failed to join tmux kill-session task: {error}"))?
}

#[tauri::command]
pub async fn tmux_resize_session(
    app: AppHandle,
    state: State<'_, TmuxState>,
    session_id: String,
    distro: String,
    session_name: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let controller = get_tmux_controller(state.inner(), &session_id)?;
    let app_handle = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mut history_lines = 10_000u32;
        let live_session_name = if let Some((_, live_session_name, stored_history_lines, alive, stdin)) = controller {
            history_lines = stored_history_lines;
            if alive.load(Ordering::SeqCst) {
                send_tmux_control_command(
                    &stdin,
                    &format!("refresh-client -C {}x{}", cols.max(60), rows.max(16)),
                )?;
            }
            live_session_name
        } else {
            let script = format!(
                "tmux resize-window -t {session} -x {cols} -y {rows}",
                session = shell_quote(&session_name),
                cols = cols.max(60),
                rows = rows.max(16),
            );
            run_wsl_shell(&distro, &script).map(|_| ())?;
            session_name.clone()
        };

        if let Some(snapshot) = collect_tmux_snapshot_with_size_wait(
            &distro,
            &live_session_name,
            history_lines,
            cols,
            rows,
        )? {
            let _ = emit_tmux_state(&app_handle, &session_id, &snapshot);
        }

        Ok(())
    })
    .await
    .map_err(|error| format!("Failed to join tmux resize task: {error}"))?
}

#[cfg(test)]
mod tests {
    use super::{parse_tmux_snapshot, translate_input, InputAction};

    #[test]
    fn parses_tmux_snapshot_payload() {
        let output = "__CLCOMX_TMUX_SESSION__\tclcomx-test\t120\t40\t%1\n\
__CLCOMX_TMUX_PANE__\t%1\t1\t0\t0\t0\t120\t40\t14\t5\tL2hvbWUvdGVzdGVy\tY2xhdWRl\taGlzdG9yeSBsaW5lCg==\tcHJvbXB0PiA=\n";
        let snapshot = parse_tmux_snapshot(output).expect("snapshot parse").expect("snapshot");
        assert_eq!(snapshot.session_name, "clcomx-test");
        assert_eq!(snapshot.active_pane_id, "%1");
        assert_eq!(snapshot.width, 120);
        assert_eq!(snapshot.height, 40);
        assert_eq!(snapshot.panes.len(), 1);
        assert_eq!(snapshot.panes[0].cursor_x, 14);
        assert_eq!(snapshot.panes[0].cursor_y, 5);
        assert_eq!(snapshot.panes[0].current_path, "/home/tester");
        assert_eq!(snapshot.panes[0].current_command, "claude");
        assert_eq!(snapshot.panes[0].history_text, "history line\n");
        assert_eq!(snapshot.panes[0].screen_text, "prompt> ");
    }

    #[test]
    fn translates_common_input_sequences() {
        let actions = translate_input("abc\r\u{1b}[A\u{7f}");
        assert!(matches!(actions[0], InputAction::Literal(ref value) if value == "abc"));
        assert!(matches!(actions[1], InputAction::Key("C-m")));
        assert!(matches!(actions[2], InputAction::Key("Up")));
        assert!(matches!(actions[3], InputAction::Key("BSpace")));
    }
}

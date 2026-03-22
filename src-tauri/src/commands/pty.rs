use crate::app_env::is_test_mode;
use portable_pty::{CommandBuilder, NativePtySystem, PtySize, PtySystem, MasterPty};
use serde::Serialize;
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::{Arc, Mutex, atomic::{AtomicBool, AtomicU64, Ordering}};
use tauri::{AppHandle, Emitter};

enum PtyRuntime {
    Native {
        master: Box<dyn MasterPty + Send>,
        writer: Box<dyn Write + Send>,
    },
    Mock,
}

struct PtySession {
    runtime: PtyRuntime,
    initial_output: Arc<Mutex<String>>,
    output_log: Arc<Mutex<String>>,
    output_seq: Arc<AtomicU64>,
    buffer_initial_output: Arc<AtomicBool>,
    exited: Arc<AtomicBool>,
}

#[derive(Default)]
pub struct PtyState {
    sessions: Mutex<HashMap<u32, PtySession>>,
    next_id: Mutex<u32>,
}

#[derive(Clone, Serialize)]
struct PtyOutput {
    id: u32,
    seq: u64,
    data: String,
}

#[derive(Clone, Serialize)]
pub struct PtyOutputSnapshot {
    pub data: String,
    pub seq: u64,
}

const MAX_OUTPUT_LOG_BYTES: usize = 4 * 1024 * 1024;
const RESUME_CAPTURE_TIMEOUT_MS: u64 = 2200;
const RESUME_CAPTURE_EXIT_COMMAND_GRACE_MS: u64 = 1200;

fn strip_ansi_sequences(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut result = String::with_capacity(input.len());
    let mut index = 0usize;

    while index < bytes.len() {
        if bytes[index] != 0x1b {
            if let Some(ch) = input[index..].chars().next() {
                result.push(ch);
                index += ch.len_utf8();
                continue;
            }
            break;
        }

        index += 1;
        if index >= bytes.len() {
            break;
        }

        match bytes[index] {
            b'[' => {
                index += 1;
                while index < bytes.len() {
                    let byte = bytes[index];
                    index += 1;
                    if (0x40..=0x7e).contains(&byte) {
                        break;
                    }
                }
            }
            b']' => {
                index += 1;
                while index < bytes.len() {
                    let byte = bytes[index];
                    index += 1;
                    if byte == 0x07 {
                        break;
                    }
                    if byte == 0x1b && index < bytes.len() && bytes[index] == b'\\' {
                        index += 1;
                        break;
                    }
                }
            }
            _ => {
                index += 1;
            }
        }
    }

    result
}

fn extract_resume_command_token(line: &str, command_prefix: &str) -> Option<String> {
    let Some(index) = line.find(command_prefix) else {
        return None;
    };

    let rest = line[index + command_prefix.len()..].trim_start();
    if rest.is_empty() {
        return None;
    }

    let candidate = if let Some(stripped) = rest.strip_prefix('"') {
        stripped.split('"').next().unwrap_or_default().trim()
    } else if let Some(stripped) = rest.strip_prefix('\'') {
        stripped.split('\'').next().unwrap_or_default().trim()
    } else {
        rest.split_whitespace().next().unwrap_or_default().trim()
    };

    if candidate.is_empty() {
        None
    } else {
        Some(candidate.to_string())
    }
}

fn extract_resume_token(output: &str, agent_id: &str) -> Option<String> {
    let command_prefix = match agent_id {
        "codex" => "codex resume",
        _ => "claude --resume",
    };

    let normalized = strip_ansi_sequences(output).replace('\r', "\n");

    for line in normalized.lines().rev() {
        if let Some(candidate) = extract_resume_command_token(line, command_prefix) {
            return Some(candidate);
        }
    }

    None
}

fn trim_output_log(output: &mut String) {
    if output.len() <= MAX_OUTPUT_LOG_BYTES {
        return;
    }

    let trim_target = output.len() - MAX_OUTPUT_LOG_BYTES;
    let trim_at = output
        .char_indices()
        .find(|(index, _)| *index >= trim_target)
        .map(|(index, _)| index)
        .unwrap_or(output.len());

    output.drain(..trim_at);
}

pub fn kill_pty_session(state: &PtyState, id: u32) -> Result<(), String> {
    let mut sessions = state.sessions.lock().map_err(|e| e.to_string())?;
    sessions.remove(&id);
    Ok(())
}

fn next_session_id(state: &PtyState) -> Result<u32, String> {
    let mut next = state.next_id.lock().map_err(|e| e.to_string())?;
    let id = *next;
    *next += 1;
    Ok(id)
}

fn append_output(
    app: &AppHandle,
    session_id: u32,
    session: &PtySession,
    data: String,
) -> Result<(), String> {
    if session.buffer_initial_output.load(Ordering::SeqCst) {
        session
            .initial_output
            .lock()
            .map_err(|e| e.to_string())?
            .push_str(&data);
    }

    let seq = session.output_seq.fetch_add(1, Ordering::SeqCst) + 1;
    {
        let mut output = session.output_log.lock().map_err(|e| e.to_string())?;
        output.push_str(&data);
        trim_output_log(&mut output);
    }

    app.emit(
        "pty-output",
        PtyOutput {
            id: session_id,
            seq,
            data,
        },
    )
    .map_err(|e| e.to_string())
}

fn append_mock_output(
    app: &AppHandle,
    session_id: u32,
    initial_output: &Arc<Mutex<String>>,
    output_log: &Arc<Mutex<String>>,
    output_seq: &Arc<AtomicU64>,
    buffer_initial_output: &Arc<AtomicBool>,
    data: String,
) -> Result<(), String> {
    if buffer_initial_output.load(Ordering::SeqCst) {
        initial_output
            .lock()
            .map_err(|e| e.to_string())?
            .push_str(&data);
    }

    let seq = output_seq.fetch_add(1, Ordering::SeqCst) + 1;
    {
        let mut output = output_log.lock().map_err(|e| e.to_string())?;
        output.push_str(&data);
        trim_output_log(&mut output);
    }

    app.emit(
        "pty-output",
        PtyOutput {
            id: session_id,
            seq,
            data,
        },
    )
    .map_err(|e| e.to_string())
}

fn create_mock_session(
    state: &PtyState,
    agent_id: Option<String>,
    distro: Option<String>,
    work_dir: Option<String>,
    resume_token: Option<String>,
) -> Result<(u32, PtySession), String> {
    let id = next_session_id(state)?;
    let agent_label = match agent_id.as_deref() {
        Some("shell") => "Shell",
        Some("codex") => "Codex",
        _ => "Claude Code",
    };
    let distro_label = distro.unwrap_or_else(|| "clcomx-test".into());
    let work_dir_label = work_dir.unwrap_or_else(|| "/home/tester/workspace/clcomx".into());
    let banner = if matches!(
        resume_token.as_deref(),
        Some("__clcomx_test_long_output__" | "__clcomx_test_long_output_stream__")
    ) {
        let mut output = format!(
            "CLCOMX test mode\r\nAgent: {}\r\nDistro: {}\r\nWorkspace: {}\r\nRestored mock session.\r\n",
            agent_label, distro_label, work_dir_label
        );
        for index in 0..360usize {
            output.push_str(&format!(
                "[{}] long restored transcript line {:03} {}\r\n",
                agent_label,
                index,
                "x".repeat(220)
            ));
        }
        output.push_str("> ");
        output
    } else {
        format!(
            "CLCOMX test mode\r\nAgent: {}\r\nDistro: {}\r\nWorkspace: {}\r\nMock session ready.\r\n> ",
            agent_label, distro_label, work_dir_label,
        )
    };
    let initial_output = Arc::new(Mutex::new(banner.clone()));
    let output_log = Arc::new(Mutex::new(banner));

    Ok((
        id,
        PtySession {
            runtime: PtyRuntime::Mock,
            initial_output,
            output_log,
            output_seq: Arc::new(AtomicU64::new(0)),
            buffer_initial_output: Arc::new(AtomicBool::new(true)),
            exited: Arc::new(AtomicBool::new(false)),
        },
    ))
}

#[tauri::command]
pub fn pty_spawn(
    app: AppHandle,
    state: tauri::State<'_, PtyState>,
    cols: u16,
    rows: u16,
    command: Option<String>,
    args: Option<Vec<String>>,
    cwd: Option<String>,
    mock_agent_id: Option<String>,
    mock_distro: Option<String>,
    mock_work_dir: Option<String>,
    mock_resume_token: Option<String>,
) -> Result<u32, String> {
    if is_test_mode() {
        let delayed_long_output = mock_resume_token.as_deref() == Some("__clcomx_test_long_output_stream__");
        let (id, session) =
            create_mock_session(state.inner(), mock_agent_id, mock_distro, mock_work_dir, mock_resume_token)?;
        let delayed_output_handles = if delayed_long_output {
            Some((
                session.initial_output.clone(),
                session.output_log.clone(),
                session.output_seq.clone(),
                session.buffer_initial_output.clone(),
                session.exited.clone(),
            ))
        } else {
            None
        };
        let mut sessions = state.sessions.lock().map_err(|e| e.to_string())?;
        sessions.insert(id, session);
        drop(sessions);

        if let Some((initial_output, output_log, output_seq, buffer_initial_output, exited)) =
            delayed_output_handles
        {
            let app_handle = app.clone();
            std::thread::spawn(move || {
                let delayed_chunks: Vec<(String, u64)> = vec![
                    ("\r\n[Claude Code] restored output stream continuing...\r\n".to_string(), 350u64),
                    (
                        "[Claude Code] wrapped transcript tail ".to_string() + &"y".repeat(260) + "\r\n",
                        850u64,
                    ),
                    ("[Claude Code] final restore flush\r\n> ".to_string(), 1450u64),
                ];

                for (chunk, delay_ms) in delayed_chunks {
                    std::thread::sleep(std::time::Duration::from_millis(delay_ms));
                    if exited.load(Ordering::SeqCst) {
                        break;
                    }
                    let _ = append_mock_output(
                        &app_handle,
                        id,
                        &initial_output,
                        &output_log,
                        &output_seq,
                        &buffer_initial_output,
                        chunk,
                    );
                }
            });
        }
        return Ok(id);
    }

    let pty_system = NativePtySystem::default();

    let size = PtySize {
        rows,
        cols,
        pixel_width: 0,
        pixel_height: 0,
    };

    let pair = pty_system.openpty(size).map_err(|e| e.to_string())?;

    let cmd_str = command.unwrap_or_else(|| "wsl.exe".to_string());
    let mut cmd = CommandBuilder::new(&cmd_str);
    if let Some(ref a) = args {
        for arg in a {
            cmd.arg(arg);
        }
    }
    if let Some(ref dir) = cwd {
        cmd.cwd(dir);
    }

    let mut child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
    drop(pair.slave);

    let id = next_session_id(state.inner())?;

    let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;
    let exited = Arc::new(AtomicBool::new(false));
    let initial_output = Arc::new(Mutex::new(String::new()));
    let output_log = Arc::new(Mutex::new(String::new()));
    let output_seq = Arc::new(AtomicU64::new(0));
    let buffer_initial_output = Arc::new(AtomicBool::new(true));

    // Thread 1: Watch child process exit
    let exited_clone = exited.clone();
    let app_for_child = app.clone();
    let session_id = id;
    std::thread::spawn(move || {
        // Wait for child process to exit
        let _ = child.wait();
        exited_clone.store(true, Ordering::SeqCst);
        // Small delay to let the reader thread flush remaining output
        std::thread::sleep(std::time::Duration::from_millis(200));
        let _ = app_for_child.emit("pty-exit", session_id);
    });

    // Thread 2: Read PTY output
    let app_handle = app.clone();
    let initial_output_for_reader = initial_output.clone();
    let output_log_for_reader = output_log.clone();
    let output_seq_for_reader = output_seq.clone();
    let buffer_initial_output_for_reader = buffer_initial_output.clone();
    std::thread::spawn(move || {
        let mut buf = [0u8; 4096];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    let data = String::from_utf8_lossy(&buf[..n]).to_string();
                    if buffer_initial_output_for_reader.load(Ordering::SeqCst) {
                        if let Ok(mut output) = initial_output_for_reader.lock() {
                            output.push_str(&data);
                        }
                    }
                    let seq = output_seq_for_reader.fetch_add(1, Ordering::SeqCst) + 1;
                    if let Ok(mut output) = output_log_for_reader.lock() {
                        output.push_str(&data);
                        trim_output_log(&mut output);
                    }
                let _ = app_handle.emit(
                        "pty-output",
                        PtyOutput {
                            id: session_id,
                            seq,
                            data,
                        },
                    );
                }
                Err(_) => break,
            }
        }
    });

    {
        let mut sessions = state.sessions.lock().map_err(|e| e.to_string())?;
        sessions.insert(
            id,
            PtySession {
            runtime: PtyRuntime::Native {
                master: pair.master,
                writer,
            },
            initial_output,
            output_log,
            output_seq,
            buffer_initial_output,
            exited,
        },
    );
}

    Ok(id)
}

#[tauri::command]
pub fn pty_take_initial_output(
    state: tauri::State<'_, PtyState>,
    id: u32,
) -> Result<String, String> {
    let sessions = state.sessions.lock().map_err(|e| e.to_string())?;
    let session = sessions.get(&id).ok_or("Session not found")?;
    session
        .buffer_initial_output
        .store(false, Ordering::SeqCst);

    let mut output = session.initial_output.lock().map_err(|e| e.to_string())?;
    Ok(std::mem::take(&mut *output))
}

#[tauri::command]
pub fn pty_get_output_snapshot(
    state: tauri::State<'_, PtyState>,
    id: u32,
) -> Result<PtyOutputSnapshot, String> {
    let sessions = state.sessions.lock().map_err(|e| e.to_string())?;
    let session = sessions.get(&id).ok_or("Session not found")?;
    let data = session.output_log.lock().map_err(|e| e.to_string())?.clone();
    let seq = session.output_seq.load(Ordering::SeqCst);
    Ok(PtyOutputSnapshot { data, seq })
}

#[tauri::command]
pub fn pty_write(
    app: AppHandle,
    state: tauri::State<'_, PtyState>,
    id: u32,
    data: String,
) -> Result<(), String> {
    let mut sessions = state.sessions.lock().map_err(|e| e.to_string())?;
    let session = sessions.get_mut(&id).ok_or("Session not found")?;

    match &mut session.runtime {
        PtyRuntime::Native { writer, .. } => {
            writer
                .write_all(data.as_bytes())
                .map_err(|e| e.to_string())?;
            writer.flush().map_err(|e| e.to_string())?;
        }
        PtyRuntime::Mock => {
            let mut output = data;
            if output.contains('\r') {
                output.push_str("\r\n[mock agent] request received\r\n> ");
            }
            append_output(&app, id, session, output)?;
        }
    }

    Ok(())
}

#[tauri::command]
pub fn pty_resize(
    state: tauri::State<'_, PtyState>,
    id: u32,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let sessions = state.sessions.lock().map_err(|e| e.to_string())?;
    let session = sessions.get(&id).ok_or("Session not found")?;
    if let PtyRuntime::Native { master, .. } = &session.runtime {
        master
            .resize(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub fn pty_kill(state: tauri::State<'_, PtyState>, id: u32) -> Result<(), String> {
    kill_pty_session(state.inner(), id)
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PtyResumeCaptureResult {
    pub resume_token: Option<String>,
}

#[tauri::command]
pub fn pty_close_and_capture_resume(
    state: tauri::State<'_, PtyState>,
    id: u32,
    agent_id: String,
) -> Result<PtyResumeCaptureResult, String> {
    let (output_log, output_seq, exited, is_mock) = {
        let mut sessions = state.sessions.lock().map_err(|e| e.to_string())?;
        let session = sessions.get_mut(&id).ok_or("Session not found")?;

        match &mut session.runtime {
            PtyRuntime::Native { writer, .. } => {
                if agent_id == "codex" {
                    writer.write_all(&[0x03]).map_err(|e| e.to_string())?;
                } else {
                    writer.write_all(b"exit\r").map_err(|e| e.to_string())?;
                }
                writer.flush().map_err(|e| e.to_string())?;
            }
            PtyRuntime::Mock => {
                let line = if agent_id == "codex" {
                    "\r\nTo continue this session, run codex resume 'mock-codex-session'\r\n"
                } else {
                    "\r\nResume this session with:\r\nclaude --resume \"mock-claude-session\"\r\n"
                };
                session.output_log.lock().map_err(|e| e.to_string())?.push_str(line);
                session.exited.store(true, Ordering::SeqCst);
            }
        }

        (
            session.output_log.clone(),
            session.output_seq.clone(),
            session.exited.clone(),
            matches!(session.runtime, PtyRuntime::Mock),
        )
    };

    if !is_mock {
        let started = std::time::Instant::now();
        let mut last_seq = output_seq.load(Ordering::SeqCst);
        let mut exited_at: Option<std::time::Instant> = None;
        let mut sent_eof_fallback = false;
        loop {
            let current = output_log.lock().map_err(|e| e.to_string())?.clone();
            if extract_resume_token(&current, &agent_id).is_some() {
                break;
            }

            let current_seq = output_seq.load(Ordering::SeqCst);
            if current_seq != last_seq {
                last_seq = current_seq;
                exited_at = None;
            }

            if exited.load(Ordering::SeqCst) {
                let exit_seen_at = exited_at.get_or_insert_with(std::time::Instant::now);
                if current_seq == last_seq && exit_seen_at.elapsed().as_millis() as u64 >= 300 {
                    break;
                }
            }

            if !sent_eof_fallback
                && started.elapsed().as_millis() as u64 >= RESUME_CAPTURE_EXIT_COMMAND_GRACE_MS
            {
                let mut sessions = state.sessions.lock().map_err(|e| e.to_string())?;
                if let Some(session) = sessions.get_mut(&id) {
                    if let PtyRuntime::Native { writer, .. } = &mut session.runtime {
                        if agent_id == "codex" {
                            writer.write_all(&[0x03]).map_err(|e| e.to_string())?;
                        } else {
                            writer.write_all(&[0x04]).map_err(|e| e.to_string())?;
                        }
                        writer.flush().map_err(|e| e.to_string())?;
                        sent_eof_fallback = true;
                    }
                } else {
                    break;
                }
            }

            if started.elapsed().as_millis() as u64 >= RESUME_CAPTURE_TIMEOUT_MS {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(60));
        }
    }

    let resume_token = {
        let output = output_log.lock().map_err(|e| e.to_string())?;
        extract_resume_token(&output, &agent_id)
    };

    kill_pty_session(state.inner(), id)?;
    Ok(PtyResumeCaptureResult { resume_token })
}

#[cfg(test)]
mod tests {
    use super::{extract_resume_token, strip_ansi_sequences};

    #[test]
    fn extract_resume_token_matches_claude_forms() {
        assert_eq!(
            extract_resume_token("Resume this session with:\nclaude --resume \"abc-123\"", "claude"),
            Some("abc-123".into())
        );
        assert_eq!(
            extract_resume_token("claude --resume 'abc-456'", "claude"),
            Some("abc-456".into())
        );
        assert_eq!(
            extract_resume_token("claude --resume 267c4d37-d196-4f64-a44d-a6dd884645d3", "claude"),
            Some("267c4d37-d196-4f64-a44d-a6dd884645d3".into())
        );
    }

    #[test]
    fn extract_resume_token_matches_codex_forms() {
        assert_eq!(
            extract_resume_token(
                "To continue this session, run codex resume '스킬연구'",
                "codex",
            ),
            Some("스킬연구".into())
        );
        assert_eq!(
            extract_resume_token(
                "To continue this session, run codex resume 019c9fe6-12fa-7272-a1b0-e541b71f608c",
                "codex",
            ),
            Some("019c9fe6-12fa-7272-a1b0-e541b71f608c".into())
        );
    }

    #[test]
    fn strip_ansi_sequences_removes_control_codes() {
        let raw = "\u{1b}[1mTo continue this session, run codex resume 'token-123'\u{1b}[0m";
        assert_eq!(
            strip_ansi_sequences(raw),
            "To continue this session, run codex resume 'token-123'"
        );
    }

    #[test]
    fn extract_resume_token_matches_codex_forms_with_ansi() {
        let raw = "\u{1b}[32mTo continue this session, run codex resume '스킬연구'\u{1b}[0m";
        assert_eq!(extract_resume_token(raw, "codex"), Some("스킬연구".into()));
    }
}

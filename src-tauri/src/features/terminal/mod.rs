mod parsing;
#[cfg(test)]
mod tests;

use crate::app_env::is_test_mode;
use portable_pty::{CommandBuilder, MasterPty, NativePtySystem, PtySize, PtySystem};
use serde::Serialize;
use std::collections::{HashMap, VecDeque};
use std::io::{Read, Write};
use std::sync::{
    atomic::{AtomicBool, AtomicU64, Ordering},
    Arc, Mutex,
};
use tauri::{AppHandle, Emitter};

use self::parsing::{consume_home_dir_osc, decode_utf8_stream_chunk, extract_resume_token};

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
    output_chunks: Arc<Mutex<VecDeque<PtyOutputChunkRecord>>>,
    home_dir: Arc<Mutex<Option<String>>>,
    home_dir_osc_remainder: Arc<Mutex<String>>,
    size: Arc<Mutex<PtyDimensions>>,
    output_seq: Arc<AtomicU64>,
    buffer_initial_output: Arc<AtomicBool>,
    exited: Arc<AtomicBool>,
}

#[derive(Default)]
pub struct PtyState {
    sessions: Mutex<HashMap<u32, PtySession>>,
    next_id: Mutex<u32>,
}

#[cfg(test)]
pub(crate) fn test_state_with_session(
    id: u32,
    chunks: &[(u64, &str)],
    current_seq: u64,
    cols: u16,
    rows: u16,
    home_dir: Option<&str>,
) -> PtyState {
    let output = chunks.iter().map(|(_, data)| *data).collect::<String>();
    let session = PtySession {
        runtime: PtyRuntime::Mock,
        initial_output: Arc::new(Mutex::new(String::new())),
        output_log: Arc::new(Mutex::new(output)),
        output_chunks: Arc::new(Mutex::new(
            chunks
                .iter()
                .map(|(seq, data)| PtyOutputChunkRecord {
                    seq: *seq,
                    data: (*data).to_string(),
                })
                .collect::<VecDeque<_>>(),
        )),
        home_dir: Arc::new(Mutex::new(home_dir.map(|value| value.to_string()))),
        home_dir_osc_remainder: Arc::new(Mutex::new(String::new())),
        size: Arc::new(Mutex::new(PtyDimensions { cols, rows })),
        output_seq: Arc::new(AtomicU64::new(current_seq)),
        buffer_initial_output: Arc::new(AtomicBool::new(false)),
        exited: Arc::new(AtomicBool::new(false)),
    };

    let mut sessions = HashMap::new();
    sessions.insert(id, session);

    PtyState {
        sessions: Mutex::new(sessions),
        next_id: Mutex::new(id + 1),
    }
}

#[derive(Clone, Serialize)]
struct PtyOutput {
    id: u32,
    seq: u64,
    data: String,
}

#[derive(Clone)]
struct PtyOutputChunkRecord {
    seq: u64,
    data: String,
}

#[derive(Clone, Copy)]
struct PtyDimensions {
    cols: u16,
    rows: u16,
}

#[derive(Clone, Serialize)]
pub struct PtyOutputSnapshot {
    pub data: String,
    pub seq: u64,
    pub home_dir: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PtyRuntimeSnapshot {
    pub data: String,
    pub seq: u64,
    pub cols: u16,
    pub rows: u16,
    pub home_dir: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PtyOutputDelta {
    pub data: String,
    pub seq: u64,
    pub complete: bool,
}

const MAX_OUTPUT_LOG_BYTES: usize = 4 * 1024 * 1024;
const MAX_OUTPUT_CHUNK_LOG_BYTES: usize = 4 * 1024 * 1024;
const RESUME_CAPTURE_TIMEOUT_MS: u64 = 2200;
const RESUME_CAPTURE_EXIT_COMMAND_GRACE_MS: u64 = 1200;

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

fn trim_output_chunks(chunks: &mut VecDeque<PtyOutputChunkRecord>) {
    let mut total_bytes = chunks.iter().map(|chunk| chunk.data.len()).sum::<usize>();
    while total_bytes > MAX_OUTPUT_CHUNK_LOG_BYTES {
        let Some(removed) = chunks.pop_front() else {
            break;
        };
        total_bytes = total_bytes.saturating_sub(removed.data.len());
    }
}

fn update_home_dir_cache(
    home_dir_cache: &Arc<Mutex<Option<String>>>,
    remainder: &Arc<Mutex<String>>,
    data: &str,
) -> Result<(), String> {
    let current_remainder = {
        let guard = remainder.lock().map_err(|e| e.to_string())?;
        guard.clone()
    };

    let (cached_home_dir, new_remainder) = consume_home_dir_osc(data, &current_remainder);

    {
        let mut guard = remainder.lock().map_err(|e| e.to_string())?;
        *guard = new_remainder;
    }

    if let Some(home_dir) = cached_home_dir {
        let mut guard = home_dir_cache.lock().map_err(|e| e.to_string())?;
        *guard = Some(home_dir);
    }

    Ok(())
}

fn record_output_chunk(
    app: &AppHandle,
    session_id: u32,
    initial_output: &Arc<Mutex<String>>,
    output_log: &Arc<Mutex<String>>,
    output_chunks: &Arc<Mutex<VecDeque<PtyOutputChunkRecord>>>,
    home_dir_cache: &Arc<Mutex<Option<String>>>,
    home_dir_osc_remainder: &Arc<Mutex<String>>,
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

    update_home_dir_cache(home_dir_cache, home_dir_osc_remainder, &data)?;

    let seq = output_seq.fetch_add(1, Ordering::SeqCst) + 1;
    {
        let mut output = output_log.lock().map_err(|e| e.to_string())?;
        output.push_str(&data);
        trim_output_log(&mut output);
    }
    {
        let mut chunks = output_chunks.lock().map_err(|e| e.to_string())?;
        chunks.push_back(PtyOutputChunkRecord {
            seq,
            data: data.clone(),
        });
        trim_output_chunks(&mut chunks);
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
    record_output_chunk(
        app,
        session_id,
        &session.initial_output,
        &session.output_log,
        &session.output_chunks,
        &session.home_dir,
        &session.home_dir_osc_remainder,
        &session.output_seq,
        &session.buffer_initial_output,
        data,
    )
}

fn append_mock_output(
    app: &AppHandle,
    session_id: u32,
    initial_output: &Arc<Mutex<String>>,
    output_log: &Arc<Mutex<String>>,
    output_chunks: &Arc<Mutex<VecDeque<PtyOutputChunkRecord>>>,
    home_dir_cache: &Arc<Mutex<Option<String>>>,
    home_dir_osc_remainder: &Arc<Mutex<String>>,
    output_seq: &Arc<AtomicU64>,
    buffer_initial_output: &Arc<AtomicBool>,
    data: String,
) -> Result<(), String> {
    record_output_chunk(
        app,
        session_id,
        initial_output,
        output_log,
        output_chunks,
        home_dir_cache,
        home_dir_osc_remainder,
        output_seq,
        buffer_initial_output,
        data,
    )
}

fn create_mock_session(
    state: &PtyState,
    cols: u16,
    rows: u16,
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
    let output_chunks = Arc::new(Mutex::new(VecDeque::new()));
    let home_dir = Arc::new(Mutex::new(None));
    let home_dir_osc_remainder = Arc::new(Mutex::new(String::new()));
    let size = Arc::new(Mutex::new(PtyDimensions { cols, rows }));

    Ok((
        id,
        PtySession {
            runtime: PtyRuntime::Mock,
            initial_output,
            output_log,
            output_chunks,
            home_dir,
            home_dir_osc_remainder,
            size,
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
        let delayed_long_output =
            mock_resume_token.as_deref() == Some("__clcomx_test_long_output_stream__");
        let (id, session) = create_mock_session(
            state.inner(),
            cols,
            rows,
            mock_agent_id,
            mock_distro,
            mock_work_dir,
            mock_resume_token,
        )?;
        let delayed_output_handles = if delayed_long_output {
            Some((
                session.initial_output.clone(),
                session.output_log.clone(),
                session.output_chunks.clone(),
                session.home_dir.clone(),
                session.home_dir_osc_remainder.clone(),
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

        if let Some((
            initial_output,
            output_log,
            output_chunks,
            home_dir,
            home_dir_osc_remainder,
            output_seq,
            buffer_initial_output,
            exited,
        )) = delayed_output_handles
        {
            let app_handle = app.clone();
            std::thread::spawn(move || {
                let delayed_chunks: Vec<(String, u64)> = vec![
                    (
                        "\r\n[Claude Code] restored output stream continuing...\r\n".to_string(),
                        350u64,
                    ),
                    (
                        "[Claude Code] wrapped transcript tail ".to_string()
                            + &"y".repeat(260)
                            + "\r\n",
                        850u64,
                    ),
                    (
                        "[Claude Code] final restore flush\r\n> ".to_string(),
                        1450u64,
                    ),
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
                        &output_chunks,
                        &home_dir,
                        &home_dir_osc_remainder,
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
    let output_chunks = Arc::new(Mutex::new(VecDeque::new()));
    let home_dir = Arc::new(Mutex::new(None));
    let home_dir_osc_remainder = Arc::new(Mutex::new(String::new()));
    let size_state = Arc::new(Mutex::new(PtyDimensions { cols, rows }));
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
    let output_chunks_for_reader = output_chunks.clone();
    let home_dir_for_reader = home_dir.clone();
    let home_dir_osc_remainder_for_reader = home_dir_osc_remainder.clone();
    let output_seq_for_reader = output_seq.clone();
    let buffer_initial_output_for_reader = buffer_initial_output.clone();
    std::thread::spawn(move || {
        let mut buf = [0u8; 4096];
        let mut pending_utf8 = Vec::new();
        let app_handle_for_output = app_handle.clone();
        let initial_output_for_output = initial_output_for_reader.clone();
        let output_log_for_output = output_log_for_reader.clone();
        let output_chunks_for_output = output_chunks_for_reader.clone();
        let home_dir_for_output = home_dir_for_reader.clone();
        let home_dir_osc_remainder_for_output = home_dir_osc_remainder_for_reader.clone();
        let output_seq_for_output = output_seq_for_reader.clone();
        let buffer_initial_output_for_output = buffer_initial_output_for_reader.clone();
        loop {
            match reader.read(&mut buf) {
                Ok(0) => {
                    let data = decode_utf8_stream_chunk(&mut pending_utf8, &[], true);
                    if !data.is_empty() {
                        let _ = record_output_chunk(
                            &app_handle_for_output,
                            session_id,
                            &initial_output_for_output,
                            &output_log_for_output,
                            &output_chunks_for_output,
                            &home_dir_for_output,
                            &home_dir_osc_remainder_for_output,
                            &output_seq_for_output,
                            &buffer_initial_output_for_output,
                            data,
                        );
                    }
                    break;
                }
                Ok(n) => {
                    let data = decode_utf8_stream_chunk(&mut pending_utf8, &buf[..n], false);
                    if data.is_empty() {
                        continue;
                    }
                    let _ = record_output_chunk(
                        &app_handle_for_output,
                        session_id,
                        &initial_output_for_output,
                        &output_log_for_output,
                        &output_chunks_for_output,
                        &home_dir_for_output,
                        &home_dir_osc_remainder_for_output,
                        &output_seq_for_output,
                        &buffer_initial_output_for_output,
                        data,
                    );
                }
                Err(_) => {
                    let data = decode_utf8_stream_chunk(&mut pending_utf8, &[], true);
                    if !data.is_empty() {
                        let _ = record_output_chunk(
                            &app_handle_for_output,
                            session_id,
                            &initial_output_for_output,
                            &output_log_for_output,
                            &output_chunks_for_output,
                            &home_dir_for_output,
                            &home_dir_osc_remainder_for_output,
                            &output_seq_for_output,
                            &buffer_initial_output_for_output,
                            data,
                        );
                    }
                    break;
                }
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
                output_chunks,
                home_dir,
                home_dir_osc_remainder,
                size: size_state,
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
    session.buffer_initial_output.store(false, Ordering::SeqCst);

    let mut output = session.initial_output.lock().map_err(|e| e.to_string())?;
    Ok(std::mem::take(&mut *output))
}

pub fn get_output_snapshot(state: &PtyState, id: u32) -> Result<PtyOutputSnapshot, String> {
    let sessions = state.sessions.lock().map_err(|e| e.to_string())?;
    let session = sessions.get(&id).ok_or("Session not found")?;
    let data = session
        .output_log
        .lock()
        .map_err(|e| e.to_string())?
        .clone();
    let seq = session.output_seq.load(Ordering::SeqCst);
    let home_dir = session.home_dir.lock().map_err(|e| e.to_string())?.clone();
    Ok(PtyOutputSnapshot {
        data,
        seq,
        home_dir,
    })
}

#[tauri::command]
pub fn pty_get_output_snapshot(
    state: tauri::State<'_, PtyState>,
    id: u32,
) -> Result<PtyOutputSnapshot, String> {
    get_output_snapshot(state.inner(), id)
}

pub fn get_runtime_snapshot(state: &PtyState, id: u32) -> Result<PtyRuntimeSnapshot, String> {
    let sessions = state.sessions.lock().map_err(|e| e.to_string())?;
    let session = sessions.get(&id).ok_or("Session not found")?;
    let data = session
        .output_log
        .lock()
        .map_err(|e| e.to_string())?
        .clone();
    let seq = session.output_seq.load(Ordering::SeqCst);
    let size = *session.size.lock().map_err(|e| e.to_string())?;
    let home_dir = session.home_dir.lock().map_err(|e| e.to_string())?.clone();
    Ok(PtyRuntimeSnapshot {
        data,
        seq,
        cols: size.cols,
        rows: size.rows,
        home_dir,
    })
}

#[tauri::command]
pub fn pty_get_runtime_snapshot(
    state: tauri::State<'_, PtyState>,
    id: u32,
) -> Result<PtyRuntimeSnapshot, String> {
    get_runtime_snapshot(state.inner(), id)
}

pub fn get_output_delta_since(
    state: &PtyState,
    id: u32,
    after_seq: u64,
) -> Result<PtyOutputDelta, String> {
    let sessions = state.sessions.lock().map_err(|e| e.to_string())?;
    let session = sessions.get(&id).ok_or("Session not found")?;
    let current_seq = session.output_seq.load(Ordering::SeqCst);
    let chunks = session.output_chunks.lock().map_err(|e| e.to_string())?;

    if after_seq >= current_seq {
        return Ok(PtyOutputDelta {
            data: String::new(),
            seq: current_seq,
            complete: true,
        });
    }

    let first_available_seq = chunks.front().map(|chunk| chunk.seq).unwrap_or(current_seq);
    let complete = after_seq + 1 >= first_available_seq;
    let data = if complete {
        chunks
            .iter()
            .filter(|chunk| chunk.seq > after_seq)
            .map(|chunk| chunk.data.as_str())
            .collect::<String>()
    } else {
        String::new()
    };

    Ok(PtyOutputDelta {
        data,
        seq: current_seq,
        complete,
    })
}

#[tauri::command]
pub fn pty_get_output_delta_since(
    state: tauri::State<'_, PtyState>,
    id: u32,
    after_seq: u64,
) -> Result<PtyOutputDelta, String> {
    get_output_delta_since(state.inner(), id, after_seq)
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
    {
        let mut size = session.size.lock().map_err(|e| e.to_string())?;
        size.cols = cols;
        size.rows = rows;
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
                session
                    .output_log
                    .lock()
                    .map_err(|e| e.to_string())?
                    .push_str(line);
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

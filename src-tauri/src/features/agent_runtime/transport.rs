//! Direct Agent Runtime — newline-delimited JSON-RPC framing + reader threads(07 §4·§5.3).
//!
//! 정본: `07-tauri-process-runtime.md` §4.1~§4.4(framing), §4.3(stderr), §5.3(child wait), §7(backpressure).
//! 이 모듈은 protocol 의미를 해석하지 않고 raw 라인을 JSON-RPC 메시지 경계로만 분리해 emit한다.
//! stdout reader는 PTY reader loop를 newline framer로 치환했고, UTF-8 경계는 `decode_utf8_stream_chunk` 재사용.

use super::process::ChildHandle;
use super::types::{
    AgentRuntimeEvent, RuntimeId, BACKPRESSURE_NOTIFY_INTERVAL, MAX_LINE_BYTES,
    MAX_MESSAGE_LOG_BYTES,
};
use crate::app_env::{ensure_parent_dir, is_agent_runtime_debug_log_enabled, state_path};
use crate::features::terminal::parsing::decode_utf8_stream_chunk;
use std::collections::VecDeque;
use std::fs::OpenOptions;
use std::io::{Read, Write};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter};

const PROTOCOL_DEBUG_LOG_FILE: &str = "agent-runtime-debug.log";
const MIN_LITERAL_REDACTION_VALUE_LEN: usize = 8;

/// diagnostic-only bounded replay log의 message 한 건(D-REPLAYLOG, §7.2).
pub struct RuntimeMessageRecord {
    /// 단조 증가 seq(1-based). v1은 진단용 기록만 — late-attach delta-since replay consumer는 후속(§4.5).
    #[allow(dead_code)]
    pub seq: u64,
    /// redacted JSON-RPC line(개행 제거 후 1메시지). realtime emit은 별도 raw value를 그대로 보낸다.
    pub line: String,
}

/// emit 시 사용하는 message payload(M-4: message는 serde_json::Value 무손실 통과).
#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct AgentRuntimeMessageEmit {
    #[serde(rename = "type")]
    type_: &'static str,
    runtime_id: RuntimeId,
    message: serde_json::Value,
}

/// stdout JSON-RPC message payload. 테스트와 production emitter가 같은 payload 타입을 공유한다.
pub(crate) type RuntimeMessagePayload = serde_json::Value;

/// stdout reader가 생성하는 runtime event sink. production은 Tauri emit, 테스트는 Vec 캡처를 쓴다.
pub(crate) trait RuntimeEventEmitter {
    /// raw JSON-RPC message event를 보낸다.
    fn emit_message(&self, runtime_id: RuntimeId, payload: RuntimeMessagePayload);
    /// framing/runtime error event를 보낸다.
    fn emit_error(
        &self,
        runtime_id: RuntimeId,
        message: String,
        recoverable: bool,
        code: Option<&'static str>,
    );
    /// bounded replay log backpressure event를 보낸다.
    fn emit_backpressure(&self, runtime_id: RuntimeId, dropped_messages: u64);
}

/// Tauri AppHandle 기반 production event emitter.
struct TauriRuntimeEventEmitter<'a> {
    app: &'a AppHandle,
}

impl RuntimeEventEmitter for TauriRuntimeEventEmitter<'_> {
    fn emit_message(&self, runtime_id: RuntimeId, payload: RuntimeMessagePayload) {
        let _ = self.app.emit(
            "agent-runtime-message",
            AgentRuntimeMessageEmit {
                type_: "message",
                runtime_id,
                message: payload,
            },
        );
    }

    fn emit_error(
        &self,
        runtime_id: RuntimeId,
        message: String,
        recoverable: bool,
        code: Option<&'static str>,
    ) {
        let _ = self.app.emit(
            "agent-runtime-error",
            AgentRuntimeEvent::Error {
                runtime_id,
                message,
                recoverable,
                code: code.map(str::to_string),
            },
        );
    }

    fn emit_backpressure(&self, runtime_id: RuntimeId, dropped_messages: u64) {
        let _ = self.app.emit(
            "agent-runtime-backpressure",
            AgentRuntimeEvent::Backpressure {
                runtime_id,
                dropped_messages,
            },
        );
    }
}

/// 한 stdout reader의 framing 상태. `recoverable:false` 이후 latch되어 후속 stdout을 suppress한다.
#[derive(Default)]
pub(crate) struct FramingState {
    invalid_streak: u32,
    framing_failed: bool,
}

/// framing 분류 결과(테스트 가능한 순수 판정). emit 없이 한 라인의 처리 방식만 정한다.
#[derive(Debug, PartialEq)]
pub enum LineClass {
    /// 빈/공백 라인 — 무시.
    Empty,
    /// valid JSON-RPC — emit 대상.
    Valid,
    /// invalid JSON 또는 cap 초과 — framing 에러.
    Invalid,
    /// 개행으로 JSON 메시지가 쪼개진 EOF 계열 오류 — 즉시 fatal framing 붕괴.
    Fatal,
}

/// 한 라인을 순수 분류한다(emit/latch 없음). reader와 테스트가 공유한다.
pub fn classify_line(line: &str) -> LineClass {
    let trimmed = line.trim_end_matches(['\n', '\r']);
    if trimmed.trim().is_empty() {
        return LineClass::Empty;
    }
    if trimmed.len() > MAX_LINE_BYTES {
        return LineClass::Invalid;
    }
    match serde_json::from_str::<serde_json::Value>(trimmed) {
        Ok(_) => LineClass::Valid,
        Err(e) if e.is_eof() => LineClass::Fatal,
        Err(_) => LineClass::Invalid,
    }
}

/// 누적 버퍼에서 '\n'으로 끝나는 완성 라인을 모두 뽑아 돌려준다(개행 제거). 미완성 조각은 line_buf에 남긴다.
/// reader의 framing 경계 로직과 동일 규칙이며, UTF-8/newline 경계 복원을 테스트로 검증하기 위한 순수 함수다.
pub fn extract_complete_lines(line_buf: &mut String) -> Vec<String> {
    let mut out = Vec::new();
    loop {
        let Some(idx) = line_buf.find('\n') else {
            break;
        };
        let raw: String = line_buf.drain(..=idx).collect();
        let line = raw.trim_end_matches(['\n', '\r']).to_string();
        // 빈 라인·공백 전용 라인은 메시지가 아니므로 무시한다(§4.2).
        if !line.trim().is_empty() {
            out.push(line);
        }
    }
    out
}

/// stderr stream에서 완성된 line을 추출한다. stdout JSON-RPC framer와 별도이며 JSON parse를 하지 않는다.
pub fn extract_stderr_lines(line_buf: &mut String, is_final: bool) -> Vec<String> {
    let mut out = extract_complete_lines(line_buf);
    if is_final && !line_buf.trim().is_empty() {
        out.push(line_buf.trim_end_matches(['\n', '\r']).to_string());
        line_buf.clear();
    }
    out
}

/// 한 reader/handler가 공유하는 framing 상태 묶음. spawn_stdout_reader가 Arc로 캡처해 thread로 넘긴다.
#[derive(Clone)]
pub struct ReaderShared {
    pub message_log: Arc<Mutex<VecDeque<RuntimeMessageRecord>>>,
    pub message_seq: Arc<AtomicU64>,
    pub dropped_messages: Arc<AtomicU64>,
    pub exited: Arc<AtomicBool>,
    pub redaction_values: Arc<Vec<String>>,
}

/// stdout reader thread. 4096-byte buffer + UTF-8 carry over + line accumulator로 newline framing.
pub fn spawn_stdout_reader(
    app: AppHandle,
    runtime_id: RuntimeId,
    mut reader: Box<dyn Read + Send>,
    shared: ReaderShared,
) {
    std::thread::spawn(move || {
        let mut pending_bytes: Vec<u8> = Vec::new(); // UTF-8 carry over
        let mut line_buf = String::new(); // 미완성 라인 carry over
        let mut buf = [0u8; 4096];
        let mut framing = FramingState::default(); // §4.4 latch 상태

        loop {
            match reader.read(&mut buf) {
                Ok(0) => {
                    // EOF: 마지막 flush(incomplete UTF-8 강제 디코드).
                    let tail = decode_utf8_stream_chunk(&mut pending_bytes, &[], true);
                    line_buf.push_str(&tail);
                    let emitter = TauriRuntimeEventEmitter { app: &app };
                    flush_complete_lines(
                        &mut line_buf,
                        true,
                        &emitter,
                        runtime_id,
                        &shared,
                        &mut framing,
                    );
                    break;
                }
                Ok(n) => {
                    let decoded = decode_utf8_stream_chunk(&mut pending_bytes, &buf[..n], false);
                    line_buf.push_str(&decoded);
                    let emitter = TauriRuntimeEventEmitter { app: &app };
                    flush_complete_lines(
                        &mut line_buf,
                        false,
                        &emitter,
                        runtime_id,
                        &shared,
                        &mut framing,
                    );
                }
                Err(_) => break,
            }
            if shared.exited.load(Ordering::SeqCst) {
                break;
            }
        }
    });
}

/// line_buf에서 '\n'으로 끝나는 완성 라인을 모두 뽑아 처리. 마지막 미완성 조각은 남긴다.
pub(crate) fn flush_complete_lines(
    line_buf: &mut String,
    is_final: bool,
    emitter: &dyn RuntimeEventEmitter,
    runtime_id: RuntimeId,
    shared: &ReaderShared,
    framing: &mut FramingState,
) {
    // 완성 라인을 순수 추출(개행 제거·빈 라인 무시). framing 경계 로직은 extract_complete_lines가 정본.
    for line in extract_complete_lines(line_buf) {
        // §4.4 latch: framing 붕괴 후에는 라인을 drop(파싱·emit 안 함).
        if framing.framing_failed {
            continue;
        }
        handle_line(line, emitter, runtime_id, shared, framing);
    }
    if is_final && !framing.framing_failed && !line_buf.trim().is_empty() {
        // EOF 후 남은 개행 없는 마지막 조각도 한 메시지로 시도.
        let line = std::mem::take(line_buf).trim().to_string();
        handle_line(line, emitter, runtime_id, shared, framing);
    }
}

/// 한 라인을 JSON으로 1차 검증(Value)하고 emit하거나 framing 에러로 분류한다.
fn handle_line(
    line: String,
    emitter: &dyn RuntimeEventEmitter,
    runtime_id: RuntimeId,
    shared: &ReaderShared,
    framing: &mut FramingState,
) {
    if framing.framing_failed {
        return;
    }
    match classify_line(&line) {
        LineClass::Empty => {}
        LineClass::Valid => {
            framing.invalid_streak = 0; // latch 진입 전에만 유효.
                                        // classify_line이 valid를 보장하므로 unwrap_or로 안전 디코드.
            let value =
                serde_json::from_str::<serde_json::Value>(&line).unwrap_or(serde_json::Value::Null);
            let seq = shared.message_seq.fetch_add(1, Ordering::SeqCst) + 1; // 1-based
            record_and_emit_message(emitter, runtime_id, seq, line, value, shared);
        }
        LineClass::Invalid => {
            framing.invalid_streak += 1;
            // cap 초과인지 JSON 오류인지 메시지 구분.
            let (msg, code) = if line.len() > MAX_LINE_BYTES {
                (
                    format!("json-rpc line exceeds {MAX_LINE_BYTES} bytes"),
                    "framing_line_too_large",
                )
            } else {
                ("invalid json-rpc line".to_string(), "framing_invalid_json")
            };
            emit_framing_error(emitter, runtime_id, msg, Some(code), framing);
        }
        LineClass::Fatal => {
            // Raw newline/pretty-print처럼 한 JSON 메시지가 여러 줄로 깨진 경우는 즉시 latch한다.
            framing.invalid_streak = 5;
            emit_framing_error(
                emitter,
                runtime_id,
                "invalid json-rpc framing".to_string(),
                Some("framing_broken"),
                framing,
            );
        }
    }
}

/// framing 에러 emit + latch 처리. 5회 연속 invalid면 recoverable:false로 격상하고 latch를 set한다.
fn emit_framing_error(
    emitter: &dyn RuntimeEventEmitter,
    runtime_id: RuntimeId,
    message: String,
    code: Option<&'static str>,
    framing: &mut FramingState,
) {
    let recoverable = framing.invalid_streak < 5;
    let emitted_code = if recoverable {
        code
    } else {
        // 5회 연속 invalid로 latch에 들어가는 순간은 개별 원인이 아니라 framing 붕괴로 노출한다.
        Some("framing_broken")
    };
    emitter.emit_error(runtime_id, message, recoverable, emitted_code);
    // §4.4 latch 진입: recoverable:false를 올린 직후 latch를 set한다.
    if !recoverable {
        framing.framing_failed = true;
    }
}

/// bounded replay log에 `seq`/`line`을 기록하고 `max_bytes` 초과분을 oldest부터 trim한다.
///
/// 반환값은 `notify_interval` 배수에 도달해 backpressure emit이 필요한 누적 dropped count 목록이다.
pub(crate) fn record_bounded_replay_log(
    message_log: &mut VecDeque<RuntimeMessageRecord>,
    dropped_messages: &AtomicU64,
    seq: u64,
    line: String,
    max_bytes: usize,
    notify_interval: u64,
) -> Vec<u64> {
    message_log.push_back(RuntimeMessageRecord { seq, line });
    let mut total: usize = message_log.iter().map(|r| r.line.len()).sum();
    let mut notifications = Vec::new();
    // 1메시지가 cap을 통째 넘겨도 최소 1건은 남긴다.
    while total > max_bytes && message_log.len() > 1 {
        if let Some(old) = message_log.pop_front() {
            total -= old.line.len();
            let n = dropped_messages.fetch_add(1, Ordering::SeqCst) + 1;
            if notify_interval > 0 && n % notify_interval == 0 {
                notifications.push(n);
            }
        }
    }
    notifications
}

/// late-attach용 bounded replay log 기록 + 실시간 emit(§7.2). trim은 메모리 보호용이며 실시간 emit엔 무관.
fn record_and_emit_message(
    emitter: &dyn RuntimeEventEmitter,
    runtime_id: RuntimeId,
    seq: u64,
    line: String,
    value: RuntimeMessagePayload,
    shared: &ReaderShared,
) {
    let _ = write_protocol_debug_log_with_values(
        runtime_id,
        "in",
        &line,
        &shared.redaction_values,
        Some(seq),
    );
    let replay_line = redact_with_values(&line, &shared.redaction_values);
    let notifications = {
        if let Ok(mut log) = shared.message_log.lock() {
            record_bounded_replay_log(
                &mut log,
                &shared.dropped_messages,
                seq,
                replay_line,
                MAX_MESSAGE_LOG_BYTES,
                BACKPRESSURE_NOTIFY_INTERVAL,
            )
        } else {
            Vec::new()
        }
    };
    for dropped_messages in notifications {
        emitter.emit_backpressure(runtime_id, dropped_messages);
    }
    // 실시간 emit(raw value 그대로 — M-4 무손실 통과).
    emitter.emit_message(runtime_id, value);
}

/// opt-in protocol debug log에 runtime별 추가 redaction 값까지 적용해 append한다.
pub(crate) fn write_protocol_debug_log_with_values(
    runtime_id: RuntimeId,
    direction: &str,
    line: &str,
    redaction_values: &[String],
    seq: Option<u64>,
) -> Result<(), String> {
    if !is_agent_runtime_debug_log_enabled() {
        return Ok(());
    }
    let path = state_path(PROTOCOL_DEBUG_LOG_FILE)?;
    ensure_parent_dir(&path)?;
    let redacted = redact_with_values(line, redaction_values);
    let mut entry = serde_json::json!({
        "runtimeId": runtime_id,
        "direction": direction,
        "line": redacted,
    });
    // inbound raw log는 replay seq를 함께 남겨 same-turn late event 순서를 재현 가능하게 한다.
    if let Some(seq) = seq {
        entry["seq"] = serde_json::json!(seq);
    }
    let encoded = serde_json::to_string(&entry).map_err(|e| e.to_string())?;
    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|e| e.to_string())?;
    writeln!(file, "{encoded}").map_err(|e| e.to_string())
}

/// stderr reader thread. runtime별 redaction values를 함께 적용한다.
pub fn spawn_stderr_reader_with_values(
    app: AppHandle,
    runtime_id: RuntimeId,
    stderr: Box<dyn Read + Send>,
    redaction_values: Arc<Vec<String>>,
) {
    std::thread::spawn(move || {
        let mut reader = stderr;
        let mut pending_bytes = Vec::<u8>::new();
        let mut line_buf = String::new();
        let mut buf = [0u8; 4096];
        let mut redaction_state = PlainTextRedactionState::default();
        loop {
            match reader.read(&mut buf) {
                Ok(0) => {
                    let tail = decode_utf8_stream_chunk(&mut pending_bytes, &[], true);
                    line_buf.push_str(&tail);
                    for line in extract_stderr_lines(&mut line_buf, true) {
                        emit_stderr_line(
                            &app,
                            runtime_id,
                            line,
                            &redaction_values,
                            &mut redaction_state,
                        );
                    }
                    break;
                }
                Ok(n) => {
                    let decoded = decode_utf8_stream_chunk(&mut pending_bytes, &buf[..n], false);
                    line_buf.push_str(&decoded);
                    for line in extract_stderr_lines(&mut line_buf, false) {
                        emit_stderr_line(
                            &app,
                            runtime_id,
                            line,
                            &redaction_values,
                            &mut redaction_state,
                        );
                    }
                }
                Err(_) => break,
            }
        }
    });
}

/// stderr line을 redaction 후 별도 event 채널로 보낸다.
fn emit_stderr_line(
    app: &AppHandle,
    runtime_id: RuntimeId,
    line: String,
    redaction_values: &[String],
    redaction_state: &mut PlainTextRedactionState,
) {
    let _ = app.emit(
        "agent-runtime-stderr",
        AgentRuntimeEvent::Stderr {
            runtime_id,
            line: redact_stderr_line_with_values(&line, redaction_values, redaction_state),
        },
    );
}

/// child wait thread(§5.3). child reap의 단일 책임자다. `child.wait()` 반환 시 exit를 정확히 한 번 emit한다.
pub fn spawn_child_wait(
    app: AppHandle,
    runtime_id: RuntimeId,
    mut child: ChildHandle, // wait 전용 thread로 move(소유) — wait 중 Mutex 미보유
    exited: Arc<AtomicBool>,
    exited_at: Arc<Mutex<Option<i64>>>,
    status: Arc<Mutex<String>>,
) {
    std::thread::spawn(move || {
        let exit_status = child.child.wait(); // reap: 이 thread가 child를 거둔다(zombie 방지).
                                              // S3: exit event는 정확히 한 번. compare_exchange로 최초 1회만 통과시켜 이중 emit을 막는다.
        let first = exited
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .is_ok();
        if !first {
            return; // 이미 종료 반영됨 — 멱등 무시.
        }
        if let Ok(mut guard) = exited_at.lock() {
            *guard = Some(super::process::now_millis());
        }
        if let Ok(mut guard) = status.lock() {
            *guard = "exited".to_string();
        }
        let (code, signal) = match exit_status {
            Ok(st) => (st.code(), unix_signal(&st)),
            Err(_) => (None, None),
        };
        let _ = app.emit(
            "agent-runtime-exit",
            AgentRuntimeEvent::Exit {
                runtime_id,
                code,
                signal,
            },
        );
    });
}

/// Unix signal 추출(Windows는 항상 None).
#[cfg(unix)]
fn unix_signal(status: &std::process::ExitStatus) -> Option<String> {
    use std::os::unix::process::ExitStatusExt;
    status.signal().map(|s| s.to_string())
}

#[cfg(not(unix))]
fn unix_signal(_status: &std::process::ExitStatus) -> Option<String> {
    None
}

/// stdin write(§6.2). compact JSON + newline. embedded newline 방어(compact라 raw 개행 없음).
/// stdin write(§6.2). outbound protocol debug log에는 runtime redaction values를 적용한다.
pub fn write_message_with_values(
    runtime_id: RuntimeId,
    stdin: &Arc<Mutex<Option<Box<dyn Write + Send>>>>,
    message: &super::types::JsonRpcMessage,
    redaction_values: &[String],
) -> Result<(), String> {
    let line = serde_json::to_string(message).map_err(|e| e.to_string())?;
    debug_assert!(
        !line.contains('\n'),
        "compact json must not contain raw newline"
    );
    let mut guard = stdin.lock().map_err(|e| e.to_string())?;
    let writer = guard.as_mut().ok_or("stdin closed")?;
    writer
        .write_all(line.as_bytes())
        .map_err(|e| e.to_string())?;
    // test-mode mock writer는 newline 수신 즉시 inbound를 emit하므로, outbound 진단 로그를 먼저 남긴다.
    let _ = write_protocol_debug_log_with_values(runtime_id, "out", &line, redaction_values, None);
    writer.write_all(b"\n").map_err(|e| e.to_string())?;
    writer.flush().map_err(|e| e.to_string())?;
    Ok(())
}

/// 민감 정보 redaction(§11). emit/log 직전 적용. 정책 정본은 09. v1은 토큰 패턴 마스킹 + 길이 제한.
pub fn redact(s: &str) -> String {
    redact_with_values(s, &[])
}

/// 기본 secret 패턴과 runtime별 추가 redaction 값 목록을 함께 적용한다.
pub(crate) fn redact_with_values(s: &str, values: &[String]) -> String {
    if let Ok(mut value) = serde_json::from_str::<serde_json::Value>(s) {
        redact_json_value(&mut value);
        let encoded = serde_json::to_string(&value).unwrap_or_else(|_| "[REDACTED]".to_string());
        return redact_literal_values(encoded, values);
    }

    redact_literal_values(redact_plain_text(s), values)
}

/// stderr line 경계를 넘어 이어지는 auth marker redaction 상태.
#[derive(Default)]
struct PlainTextRedactionState {
    /// 다음 line/token에서 본문을 마스킹해야 하는 토큰 수.
    redact_next_tokens: usize,
}

/// stderr line별 redaction에서 이전 line의 auth marker 예약을 이어간다.
fn redact_stderr_line_with_values(
    line: &str,
    values: &[String],
    state: &mut PlainTextRedactionState,
) -> String {
    if state.redact_next_tokens == 0 {
        if let Ok(mut value) = serde_json::from_str::<serde_json::Value>(line) {
            redact_json_value(&mut value);
            let encoded =
                serde_json::to_string(&value).unwrap_or_else(|_| "[REDACTED]".to_string());
            return redact_literal_values(encoded, values);
        }
    }

    redact_literal_values(redact_plain_text_with_state(line, state), values)
}

/// plain text 로그의 민감 토큰을 마스킹한다.
fn redact_plain_text(s: &str) -> String {
    let mut state = PlainTextRedactionState::default();
    redact_plain_text_with_state(s, &mut state)
}

/// plain text 로그의 민감 토큰을 stateful하게 마스킹한다.
fn redact_plain_text_with_state(s: &str, state: &mut PlainTextRedactionState) -> String {
    const MAX_LEN: usize = 8 * 1024;
    let mut out = String::with_capacity(s.len().min(MAX_LEN));
    for token in s.split_inclusive(|c: char| c.is_whitespace()) {
        let trimmed = token.trim_end();
        let should_redact = state.redact_next_tokens > 0 || is_secret_token(trimmed);
        // `Authorization: Bearer <token>`처럼 marker와 값이 분리된 stderr를 처리한다.
        let following_redact_count = following_redact_count(trimmed);
        if should_redact {
            // 공백은 보존하되 토큰 본문만 마스킹.
            let ws = &token[trimmed.len()..];
            out.push_str("[REDACTED]");
            out.push_str(ws);
        } else {
            out.push_str(token);
        }
        state.redact_next_tokens = state
            .redact_next_tokens
            .saturating_sub(1)
            .max(following_redact_count);
        if out.len() >= MAX_LEN {
            out.truncate(MAX_LEN);
            break;
        }
    }
    truncate_redacted(out)
}

/// JSON object/array 내부의 민감 key/value를 재귀적으로 마스킹한다.
fn redact_json_value(value: &mut serde_json::Value) {
    match value {
        serde_json::Value::Object(map) => {
            for (key, child) in map.iter_mut() {
                if is_secret_env_key(key) {
                    *child = serde_json::Value::String("[REDACTED]".to_string());
                } else if key == "env" && child.is_object() {
                    redact_env_object_values(child);
                } else {
                    redact_json_value(child);
                }
            }
        }
        serde_json::Value::Array(items) => {
            for child in items {
                redact_json_value(child);
            }
        }
        serde_json::Value::String(text) => {
            if contains_secret_text(text) {
                *text = "[REDACTED]".to_string();
            }
        }
        _ => {}
    }
}

/// JSON raw에 포함된 env map은 key만 남기고 값은 숨긴다(MCP/command env 로그 경계).
fn redact_env_object_values(value: &mut serde_json::Value) {
    if let serde_json::Value::Object(map) = value {
        for child in map.values_mut() {
            *child = serde_json::Value::String("[REDACTED]".to_string());
        }
    }
}

/// redaction 결과 길이를 제한한다.
fn truncate_redacted(mut value: String) -> String {
    const MAX_LEN: usize = 8 * 1024;
    if value.len() > MAX_LEN {
        value.truncate(MAX_LEN);
    }
    value
}

/// runtime launch env value처럼 패턴으로는 secret이 아니어도 보호해야 하는 literal 값을 마스킹한다.
fn redact_literal_values(mut text: String, values: &[String]) -> String {
    for value in values {
        if is_specific_literal_redaction_value(value) {
            text = text.replace(value, "[REDACTED]");
        }
    }
    truncate_redacted(text)
}

/// 너무 짧은 env 값은 JSON-RPC id/count 같은 일반 payload를 과도하게 훼손하므로 literal redaction에서 제외한다.
fn is_specific_literal_redaction_value(value: &str) -> bool {
    value.len() >= MIN_LITERAL_REDACTION_VALUE_LEN
}

/// 흔한 비밀 토큰 패턴 감지(sk-/ghp_/Bearer/긴 base64류).
fn is_secret_token(t: &str) -> bool {
    let lower = t.to_ascii_lowercase();
    if let Some((key, value)) = lower.split_once('=') {
        return !value.is_empty() && (is_secret_env_key(key) || is_secret_value(value));
    }
    is_secret_value(&lower)
}

/// env assignment의 key가 secret 계열인지 판정한다(09 §5.1 최소 redaction 집합).
fn is_secret_env_key(key: &str) -> bool {
    let lower = key.to_ascii_lowercase();
    let compact: String = lower
        .chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .collect();
    lower.contains("api_key")
        || lower.contains("auth_token")
        || lower.contains("bearer_token")
        || lower.ends_with("_token")
        || lower.ends_with("_secret")
        || compact.contains("apikey")
        || compact.contains("authtoken")
        || compact.contains("bearertoken")
        || compact.contains("resumetoken")
        || compact.contains("providersessiontoken")
        || compact.contains("providerthreadtoken")
        || compact.contains("authorization")
        || compact.contains("cookie")
        || compact.contains("password")
}

/// 토큰 값 자체가 알려진 secret prefix를 갖는지 판정한다.
fn is_secret_value(v: &str) -> bool {
    v.starts_with("sk-")
        || v.starts_with("ghp_")
        || v.starts_with("akia")
        || v.starts_with("bearer")
        || v.starts_with("anthropic_api_key")
        || v.starts_with("anthropic_auth_token")
        || v.starts_with("aws_bearer_token_bedrock")
        || v.starts_with("openai_api_key")
}

/// JSON string value처럼 token split이 어려운 문자열의 secret 포함 여부를 판정한다.
fn contains_secret_text(value: &str) -> bool {
    let lower = value.to_ascii_lowercase();
    lower.contains("bearer ")
        || lower.starts_with("sk-")
        || lower.starts_with("ghp_")
        || lower.starts_with("akia")
        || lower.contains("anthropic_auth_token")
        || lower.contains("aws_bearer_token_bedrock")
        || lower.contains("openai_api_key")
        || lower.contains("api_key=")
        || lower.contains("auth_token=")
        || lower.contains("password=")
        || lower.contains("cookie:")
        || lower.contains("authorization:")
}

/// header/auth marker와 실제 값이 whitespace로 분리되는 stderr를 위해 후속 토큰 redaction을 예약한다.
fn following_redact_count(t: &str) -> usize {
    let normalized = t
        .trim_matches(|c: char| matches!(c, '"' | '\'' | ',' | ';' | ':' | '='))
        .to_ascii_lowercase();
    match normalized.as_str() {
        // Authorization은 "Authorization: Token <value>"처럼 scheme + value가 분리될 수 있다.
        "authorization" => 2,
        // 일부 stderr logger는 header와 scheme 사이 공백을 제거해 남은 값을 별도 토큰으로 찍는다.
        "authorization:bearer"
        | "authorization:token"
        | "authorization:basic"
        | "authorization=bearer"
        | "authorization=token"
        | "authorization=basic" => 1,
        "bearer" | "cookie" | "set-cookie" | "x-api-key" | "api-key" | "password" => 1,
        _ => 0,
    }
}

#[cfg(test)]
mod redact_tests {
    use super::{
        redact, redact_stderr_line_with_values, redact_with_values, PlainTextRedactionState,
    };

    #[test]
    fn masks_known_secret_token_patterns() {
        let out = redact("using sk-abc123 and ghp_def456 done");
        assert!(!out.contains("sk-abc123"));
        assert!(!out.contains("ghp_def456"));
        assert!(out.contains("[REDACTED]"));
        assert!(out.contains("using"));
        assert!(out.contains("done"));
    }

    #[test]
    fn masks_minimum_policy_auth_patterns() {
        let out = redact(
            "aws AKIAIOSFODNN7EXAMPLE ANTHROPIC_AUTH_TOKEN=anth-secret AWS_BEARER_TOKEN_BEDROCK=aws-secret",
        );
        assert!(!out.contains("AKIAIOSFODNN7EXAMPLE"));
        assert!(!out.contains("anth-secret"));
        assert!(!out.contains("aws-secret"));
    }

    #[test]
    fn masks_bearer_token_value() {
        let out = redact("Authorization: Bearer account-token-123 done");
        assert!(!out.contains("account-token-123"));
        assert!(out.contains("Authorization:"));
        assert!(out.contains("done"));
    }

    /// 공백 없는 Authorization scheme 뒤의 값 토큰도 마스킹한다.
    #[test]
    fn masks_compact_bearer_header_value() {
        let out = redact("Authorization:Bearer compact-token-123 done");
        assert!(!out.contains("compact-token-123"));
        assert!(out.contains("Authorization:Bearer"));
        assert!(out.contains("done"));

        let equals_out = redact("Authorization=Bearer equals-token-123 done");
        assert!(!equals_out.contains("equals-token-123"));
        assert!(equals_out.contains("done"));
    }

    /// stderr reader처럼 line별 redaction을 해도 compact header 예약을 이어간다.
    #[test]
    fn masks_compact_bearer_header_value_across_stderr_lines() {
        let mut state = PlainTextRedactionState::default();
        let marker = redact_stderr_line_with_values("Authorization:Bearer", &[], &mut state);
        let value = redact_stderr_line_with_values("split-token-123 done", &[], &mut state);

        assert!(marker.contains("Authorization:Bearer"));
        assert!(!value.contains("split-token-123"));
        assert!(value.contains("done"));

        let mut equals_state = PlainTextRedactionState::default();
        let _marker =
            redact_stderr_line_with_values("Authorization=Bearer", &[], &mut equals_state);
        let equals_value =
            redact_stderr_line_with_values("equals-split-token-123 done", &[], &mut equals_state);
        assert!(!equals_value.contains("equals-split-token-123"));
        assert!(equals_value.contains("done"));
    }

    #[test]
    fn masks_header_like_auth_and_cookie_values() {
        let out = redact("Authorization: Token account-secret Cookie: sid=session-secret done");
        assert!(!out.contains("account-secret"));
        assert!(!out.contains("session-secret"));
        assert!(out.contains("Authorization:"));
        assert!(out.contains("Cookie:"));
        assert!(out.contains("done"));
    }

    #[test]
    fn masks_equals_style_header_values() {
        let out = redact("X-API-Key= x-api-secret Password= password-secret done");
        assert!(!out.contains("x-api-secret"));
        assert!(!out.contains("password-secret"));
        assert!(out.contains("X-API-Key="));
        assert!(out.contains("Password="));
        assert!(out.contains("done"));
    }

    #[test]
    fn masks_runtime_env_values_even_when_not_secret_shaped() {
        let out = redact_with_values(
            "provider echoed SAFE_VALUE_123 in stderr",
            &["SAFE_VALUE_123".to_string()],
        );

        assert!(!out.contains("SAFE_VALUE_123"));
        assert!(out.contains("[REDACTED]"));
        assert!(out.contains("provider echoed"));
    }

    #[test]
    fn short_runtime_env_values_do_not_corrupt_unrelated_json_fields() {
        let out = redact_with_values(
            r#"{"id":1,"result":{"count":10,"note":"done"}}"#,
            &["1".to_string()],
        );

        assert!(out.contains(r#""id":1"#));
        assert!(out.contains(r#""count":10"#));
        assert!(!out.contains("[REDACTED]"));
    }

    #[test]
    fn masks_env_object_values_in_json() {
        let out = redact(
            r#"{"mcpServers":{"docs":{"command":"node","env":{"SAFE_ROUTING_HINT":"workspace-alpha","FEATURE_FLAG":"enabled"}}}}"#,
        );

        assert!(out.contains("SAFE_ROUTING_HINT"));
        assert!(out.contains("FEATURE_FLAG"));
        assert!(out.contains("[REDACTED]"));
        assert!(!out.contains("workspace-alpha"));
        assert!(!out.contains("enabled"));
    }
}

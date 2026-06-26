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
use crate::features::terminal::parsing::decode_utf8_stream_chunk;
use std::collections::VecDeque;
use std::io::{BufRead, Read, Write};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter};

/// diagnostic-only bounded replay log의 message 한 건(D-REPLAYLOG, §7.2).
pub struct RuntimeMessageRecord {
    /// 단조 증가 seq(1-based). v1은 진단용 기록만 — late-attach delta-since replay consumer는 후속(§4.5).
    #[allow(dead_code)]
    pub seq: u64,
    /// raw JSON-RPC line(개행 제거 후 1메시지).
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

/// framing 분류 결과(테스트 가능한 순수 판정). emit 없이 한 라인의 처리 방식만 정한다.
#[derive(Debug, PartialEq)]
pub enum LineClass {
    /// 빈/공백 라인 — 무시.
    Empty,
    /// valid JSON-RPC — emit 대상.
    Valid,
    /// invalid JSON 또는 cap 초과 — framing 에러.
    Invalid,
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

/// 한 reader/handler가 공유하는 framing 상태 묶음. spawn_stdout_reader가 Arc로 캡처해 thread로 넘긴다.
#[derive(Clone)]
pub struct ReaderShared {
    pub message_log: Arc<Mutex<VecDeque<RuntimeMessageRecord>>>,
    pub message_seq: Arc<AtomicU64>,
    pub dropped_messages: Arc<AtomicU64>,
    pub exited: Arc<AtomicBool>,
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
        let mut invalid_streak = 0u32;
        let mut framing_failed = false; // §4.4 latch: recoverable:false emit 후 true(이후 라인 drop)

        loop {
            match reader.read(&mut buf) {
                Ok(0) => {
                    // EOF: 마지막 flush(incomplete UTF-8 강제 디코드).
                    let tail = decode_utf8_stream_chunk(&mut pending_bytes, &[], true);
                    line_buf.push_str(&tail);
                    flush_complete_lines(
                        &mut line_buf,
                        true,
                        &app,
                        runtime_id,
                        &shared,
                        &mut invalid_streak,
                        &mut framing_failed,
                    );
                    break;
                }
                Ok(n) => {
                    let decoded = decode_utf8_stream_chunk(&mut pending_bytes, &buf[..n], false);
                    line_buf.push_str(&decoded);
                    flush_complete_lines(
                        &mut line_buf,
                        false,
                        &app,
                        runtime_id,
                        &shared,
                        &mut invalid_streak,
                        &mut framing_failed,
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
fn flush_complete_lines(
    line_buf: &mut String,
    is_final: bool,
    app: &AppHandle,
    runtime_id: RuntimeId,
    shared: &ReaderShared,
    invalid_streak: &mut u32,
    framing_failed: &mut bool,
) {
    // 완성 라인을 순수 추출(개행 제거·빈 라인 무시). framing 경계 로직은 extract_complete_lines가 정본.
    for line in extract_complete_lines(line_buf) {
        // §4.4 latch: framing 붕괴 후에는 라인을 drop(파싱·emit 안 함).
        if *framing_failed {
            continue;
        }
        handle_line(line, app, runtime_id, shared, invalid_streak, framing_failed);
    }
    if is_final && !*framing_failed && !line_buf.trim().is_empty() {
        // EOF 후 남은 개행 없는 마지막 조각도 한 메시지로 시도.
        let line = std::mem::take(line_buf).trim().to_string();
        handle_line(line, app, runtime_id, shared, invalid_streak, framing_failed);
    }
}

/// 한 라인을 JSON으로 1차 검증(Value)하고 emit하거나 framing 에러로 분류한다.
fn handle_line(
    line: String,
    app: &AppHandle,
    runtime_id: RuntimeId,
    shared: &ReaderShared,
    invalid_streak: &mut u32,
    framing_failed: &mut bool,
) {
    if *framing_failed {
        return;
    }
    match classify_line(&line) {
        LineClass::Empty => {}
        LineClass::Valid => {
            *invalid_streak = 0; // latch 진입 전에만 유효.
            // classify_line이 valid를 보장하므로 unwrap_or로 안전 디코드.
            let value = serde_json::from_str::<serde_json::Value>(&line)
                .unwrap_or(serde_json::Value::Null);
            let seq = shared.message_seq.fetch_add(1, Ordering::SeqCst) + 1; // 1-based
            record_and_emit_message(app, runtime_id, seq, line, value, shared);
        }
        LineClass::Invalid => {
            *invalid_streak += 1;
            // cap 초과인지 JSON 오류인지 메시지 구분.
            let msg = if line.len() > MAX_LINE_BYTES {
                format!("json-rpc line exceeds {MAX_LINE_BYTES} bytes")
            } else {
                "invalid json-rpc line".to_string()
            };
            emit_framing_error(app, runtime_id, msg, invalid_streak, framing_failed);
        }
    }
}

/// framing 에러 emit + latch 처리. 5회 연속 invalid면 recoverable:false로 격상하고 latch를 set한다.
fn emit_framing_error(
    app: &AppHandle,
    runtime_id: RuntimeId,
    message: String,
    invalid_streak: &mut u32,
    framing_failed: &mut bool,
) {
    let recoverable = *invalid_streak < 5;
    let _ = app.emit(
        "agent-runtime-error",
        AgentRuntimeEvent::Error {
            runtime_id,
            message,
            recoverable,
        },
    );
    // §4.4 latch 진입: recoverable:false를 올린 직후 latch를 set한다.
    if !recoverable {
        *framing_failed = true;
    }
}

/// late-attach용 bounded replay log 기록 + 실시간 emit(§7.2). trim은 메모리 보호용이며 실시간 emit엔 무관.
fn record_and_emit_message(
    app: &AppHandle,
    runtime_id: RuntimeId,
    seq: u64,
    line: String,
    value: serde_json::Value,
    shared: &ReaderShared,
) {
    {
        if let Ok(mut log) = shared.message_log.lock() {
            let added = line.len();
            log.push_back(RuntimeMessageRecord { seq, line });
            let mut total: usize = log.iter().map(|r| r.line.len()).sum();
            // 1메시지가 cap을 통째 넘겨도 최소 1건은 남긴다.
            let _ = added;
            while total > MAX_MESSAGE_LOG_BYTES && log.len() > 1 {
                if let Some(old) = log.pop_front() {
                    total -= old.line.len();
                    let n = shared.dropped_messages.fetch_add(1, Ordering::SeqCst) + 1;
                    if n % BACKPRESSURE_NOTIFY_INTERVAL == 0 {
                        let _ = app.emit(
                            "agent-runtime-backpressure",
                            AgentRuntimeEvent::Backpressure {
                                runtime_id,
                                dropped_messages: n,
                            },
                        );
                    }
                }
            }
        }
    }
    // 실시간 emit(raw value 그대로 — M-4 무손실 통과).
    let _ = app.emit(
        "agent-runtime-message",
        AgentRuntimeMessageEmit {
            type_: "message",
            runtime_id,
            message: value,
        },
    );
}

/// stderr reader thread. 라인 단위 캡처 후 `agent-runtime-stderr` emit(§4.3).
pub fn spawn_stderr_reader(
    app: AppHandle,
    runtime_id: RuntimeId,
    stderr: Box<dyn Read + Send>,
) {
    std::thread::spawn(move || {
        let mut reader = std::io::BufReader::new(stderr);
        let mut line = String::new();
        loop {
            line.clear();
            match reader.read_line(&mut line) {
                Ok(0) => break,
                Ok(_) => {
                    let trimmed = line.trim_end_matches(['\n', '\r']).to_string();
                    if trimmed.is_empty() {
                        continue;
                    }
                    let _ = app.emit(
                        "agent-runtime-stderr",
                        AgentRuntimeEvent::Stderr {
                            runtime_id,
                            line: redact(&trimmed),
                        },
                    );
                }
                Err(_) => break,
            }
        }
    });
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
pub fn write_message(
    stdin: &Arc<Mutex<Option<Box<dyn Write + Send>>>>,
    message: &super::types::JsonRpcMessage,
) -> Result<(), String> {
    let line = serde_json::to_string(message).map_err(|e| e.to_string())?;
    debug_assert!(
        !line.contains('\n'),
        "compact json must not contain raw newline"
    );
    let mut guard = stdin.lock().map_err(|e| e.to_string())?;
    let writer = guard.as_mut().ok_or("stdin closed")?;
    writer.write_all(line.as_bytes()).map_err(|e| e.to_string())?;
    writer.write_all(b"\n").map_err(|e| e.to_string())?;
    writer.flush().map_err(|e| e.to_string())?;
    Ok(())
}

/// 민감 정보 redaction(§11). emit/log 직전 적용. 정책 정본은 09. v1은 토큰 패턴 마스킹 + 길이 제한.
pub fn redact(s: &str) -> String {
    const MAX_LEN: usize = 8 * 1024;
    let mut out = String::with_capacity(s.len().min(MAX_LEN));
    for token in s.split_inclusive(|c: char| c.is_whitespace()) {
        let trimmed = token.trim_end();
        if is_secret_token(trimmed) {
            // 공백은 보존하되 토큰 본문만 마스킹.
            let ws = &token[trimmed.len()..];
            out.push_str("[REDACTED]");
            out.push_str(ws);
        } else {
            out.push_str(token);
        }
        if out.len() >= MAX_LEN {
            out.truncate(MAX_LEN);
            break;
        }
    }
    out
}

/// 흔한 비밀 토큰 패턴 감지(sk-/ghp_/Bearer/긴 base64류).
fn is_secret_token(t: &str) -> bool {
    let lower = t.to_ascii_lowercase();
    lower.starts_with("sk-")
        || lower.starts_with("ghp_")
        || lower.starts_with("bearer")
        || lower.starts_with("anthropic_api_key")
        || lower.starts_with("openai_api_key")
}

#[cfg(test)]
mod redact_tests {
    use super::redact;

    #[test]
    fn masks_known_secret_token_patterns() {
        let out = redact("using sk-abc123 and ghp_def456 done");
        assert!(!out.contains("sk-abc123"));
        assert!(!out.contains("ghp_def456"));
        assert!(out.contains("[REDACTED]"));
        assert!(out.contains("using"));
        assert!(out.contains("done"));
    }
}

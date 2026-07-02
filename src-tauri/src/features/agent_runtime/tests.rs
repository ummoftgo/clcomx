//! Direct Agent Runtime — framing·serde round-trip·allowlist·snapshot 단위 테스트(BE §8.1, 11 §5).
//!
//! 정본: `11-testing-acceptance.md` §5 RS-* 케이스. framing(RS-1..7, AC-4b),
//! allowlist(RS-8..12c), serde round-trip(RS-21..25), snapshot(RS-20)을 다룬다.
//! exit emit처럼 실제 AppHandle lifecycle가 필요한 범위는 E2E/통합으로 분리한다.

use super::allowlist::{is_valid_env_key, validate_and_extract};
use super::process::{build_wsl_command, canonicalize_wsl_path, now_millis, KillHandle};
use super::transport::{
    classify_line, extract_complete_lines, extract_stderr_lines, flush_complete_lines,
    record_bounded_replay_log, write_message_with_values, FramingState, LineClass,
    RuntimeEventEmitter, RuntimeMessagePayload, RuntimeMessageRecord,
};
use super::types::{
    AgentRuntimeCancelTarget, AgentRuntimeEvent, AgentRuntimeSnapshot, AgentRuntimeStartParams,
    JsonRpcMessage, MAX_LINE_BYTES,
};
use crate::features::terminal::parsing::decode_utf8_stream_chunk;
use std::collections::{HashMap, VecDeque};
use std::ffi::OsString;
use std::io::Write;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

const RAW_DEBUG_LOG_ENV: &str = "CLCOMX_AGENT_DEBUG_LOG";

struct EnvVarGuard {
    _lock: MutexGuard<'static, ()>,
    name: &'static str,
    previous: Option<OsString>,
}

impl Drop for EnvVarGuard {
    fn drop(&mut self) {
        if let Some(value) = &self.previous {
            std::env::set_var(self.name, value);
        } else {
            std::env::remove_var(self.name);
        }
    }
}

fn raw_debug_log_env_lock() -> &'static Mutex<()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}

fn set_raw_debug_log_env(value: Option<&str>) -> EnvVarGuard {
    let lock = raw_debug_log_env_lock().lock().unwrap();
    let previous = std::env::var_os(RAW_DEBUG_LOG_ENV);
    if let Some(value) = value {
        std::env::set_var(RAW_DEBUG_LOG_ENV, value);
    } else {
        std::env::remove_var(RAW_DEBUG_LOG_ENV);
    }
    EnvVarGuard {
        _lock: lock,
        name: RAW_DEBUG_LOG_ENV,
        previous,
    }
}

fn unique_state_dir(label: &str) -> PathBuf {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("time")
        .as_nanos();
    std::env::temp_dir().join(format!(
        "clcomx-agent-runtime-{label}-{}-{nonce}",
        std::process::id()
    ))
}

#[derive(Debug, PartialEq)]
enum CapturedRuntimeEvent {
    Message {
        runtime_id: u32,
    },
    Error {
        runtime_id: u32,
        recoverable: bool,
        code: Option<String>,
    },
    Backpressure {
        runtime_id: u32,
        dropped_messages: u64,
    },
}

#[derive(Default)]
struct CapturingRuntimeEmitter {
    events: Mutex<Vec<CapturedRuntimeEvent>>,
    messages: Mutex<Vec<RuntimeMessagePayload>>,
}

impl RuntimeEventEmitter for CapturingRuntimeEmitter {
    fn emit_message(&self, runtime_id: u32, payload: RuntimeMessagePayload) {
        self.messages.lock().expect("messages").push(payload);
        self.events
            .lock()
            .expect("events")
            .push(CapturedRuntimeEvent::Message { runtime_id });
    }

    fn emit_error(
        &self,
        runtime_id: u32,
        _message: String,
        recoverable: bool,
        code: Option<&'static str>,
    ) {
        self.events
            .lock()
            .expect("events")
            .push(CapturedRuntimeEvent::Error {
                runtime_id,
                recoverable,
                code: code.map(str::to_string),
            });
    }

    fn emit_backpressure(&self, runtime_id: u32, dropped_messages: u64) {
        self.events
            .lock()
            .expect("events")
            .push(CapturedRuntimeEvent::Backpressure {
                runtime_id,
                dropped_messages,
            });
    }
}

// ───────────────────────── mock resolvers ─────────────────────────

fn ok_exe(provider: &str, _distro: &str) -> Result<String, String> {
    match provider {
        "codex" => Ok("/usr/bin/codex".to_string()),
        "claude" => Ok("/usr/bin/node".to_string()),
        other => Err(format!("unknown provider: {other}")),
    }
}

fn ok_entry(_provider: &str, _distro: &str) -> Result<String, String> {
    Ok("/opt/node_modules/@agentclientprotocol/claude-agent-acp/dist/index.js".to_string())
}

fn fail_exe(_provider: &str, _distro: &str) -> Result<String, String> {
    Err("codex/node not found in WSL distro".to_string())
}

fn stdio(
    provider: &str,
    args: &[&str],
    env: Option<HashMap<String, String>>,
) -> AgentRuntimeStartParams {
    AgentRuntimeStartParams::JsonrpcStdio {
        provider: provider.to_string(),
        distro: "Ubuntu-24.04".to_string(),
        work_dir: "/home/tester/work".to_string(),
        args: args.iter().map(|s| s.to_string()).collect(),
        env,
    }
}

// ───────────────────────── RS-1..RS-5: framing ─────────────────────────

#[test]
fn rs1_splits_two_messages_in_one_read() {
    let mut buf = String::from(r#"{"id":1}"#.to_string() + "\n" + r#"{"id":2}"# + "\n");
    let lines = extract_complete_lines(&mut buf);
    assert_eq!(lines, vec![r#"{"id":1}"#, r#"{"id":2}"#]);
    assert!(buf.is_empty());
}

#[test]
fn rs2_buffers_partial_line_until_newline() {
    let mut buf = String::from(r#"{"id":1}"#); // 개행 없음
    assert!(extract_complete_lines(&mut buf).is_empty());
    buf.push_str("}\n"); // 나머지 도착(여기서는 단순 완성 시뮬레이션)
    let lines = extract_complete_lines(&mut buf);
    assert_eq!(lines.len(), 1);
}

#[test]
fn rs3_recovers_utf8_split_at_read_boundary() {
    // "안" (3 bytes) + "녕" — read 경계에서 멀티바이트가 잘려도 복원.
    let full = "{\"t\":\"안녕\"}\n";
    let bytes = full.as_bytes();
    let mid = 9; // 멀티바이트 중간으로 자른다
    let mut pending = Vec::new();
    let mut line_buf = String::new();
    line_buf.push_str(&decode_utf8_stream_chunk(
        &mut pending,
        &bytes[..mid],
        false,
    ));
    let early = extract_complete_lines(&mut line_buf); // 아직 개행 전 → 없음 가능
    line_buf.push_str(&decode_utf8_stream_chunk(
        &mut pending,
        &bytes[mid..],
        false,
    ));
    let mut all = early;
    all.extend(extract_complete_lines(&mut line_buf));
    assert_eq!(all, vec!["{\"t\":\"안녕\"}".to_string()]);
}

#[test]
fn rs4_ignores_empty_and_blank_lines() {
    let mut buf = String::from("\n   \n{\"id\":1}\n");
    let lines = extract_complete_lines(&mut buf);
    assert_eq!(lines, vec![r#"{"id":1}"#]);
    assert_eq!(classify_line("   "), LineClass::Empty);
}

#[test]
fn rs5_classifies_valid_and_invalid_json() {
    assert_eq!(classify_line(r#"{"id":1}"#), LineClass::Valid);
    assert_eq!(classify_line("not json"), LineClass::Invalid);
    assert_eq!(classify_line(""), LineClass::Empty);
}

#[test]
fn rs5b_incomplete_json_line_is_fatal_framing_break() {
    // Raw newline inside a JSON message splits the object into an EOF-like line and must latch.
    assert_eq!(classify_line(r#"{"id":1"#), LineClass::Fatal);
}

#[test]
fn rs6_stdout_json_and_stderr_lines_are_separate() {
    let mut stdout_buf = String::from(r#"{"id":1}"#.to_string() + "\n");
    let stdout_lines = extract_complete_lines(&mut stdout_buf);
    assert_eq!(stdout_lines, vec![r#"{"id":1}"#]);
    assert_eq!(classify_line(&stdout_lines[0]), LineClass::Valid);

    let mut stderr_buf = String::from("diagnostic log\n");
    let stderr_lines = extract_stderr_lines(&mut stderr_buf, false);
    assert_eq!(stderr_lines, vec!["diagnostic log"]);
    assert!(stderr_buf.is_empty());
}

#[test]
fn rs7_stderr_non_utf8_and_tail_lines_do_not_pollute_stdout_framer() {
    let mut pending = Vec::new();
    let mut stderr_buf = String::new();
    stderr_buf.push_str(&decode_utf8_stream_chunk(
        &mut pending,
        b"warn:\xff\npartial-tail",
        false,
    ));

    let first = extract_stderr_lines(&mut stderr_buf, false);
    assert_eq!(first, vec!["warn:\u{fffd}"]);
    assert_eq!(classify_line(&first[0]), LineClass::Invalid);

    stderr_buf.push_str(&decode_utf8_stream_chunk(&mut pending, &[], true));
    let tail = extract_stderr_lines(&mut stderr_buf, true);
    assert_eq!(tail, vec!["partial-tail"]);
}

#[test]
fn ac4b_fatal_framing_latches_and_suppresses_followup_stdout() {
    let emitter = CapturingRuntimeEmitter::default();
    let shared = super::transport::ReaderShared {
        message_log: Arc::new(Mutex::new(VecDeque::new())),
        message_seq: Arc::new(AtomicU64::new(0)),
        dropped_messages: Arc::new(AtomicU64::new(0)),
        exited: Arc::new(std::sync::atomic::AtomicBool::new(false)),
        redaction_values: Arc::new(Vec::new()),
    };
    let mut framing = FramingState::default();
    let mut line_buf = String::from("{\"id\":1\n{\"id\":2}\nnot-json\n");

    flush_complete_lines(&mut line_buf, true, &emitter, 42, &shared, &mut framing);

    assert_eq!(
        *emitter.events.lock().expect("events"),
        vec![CapturedRuntimeEvent::Error {
            runtime_id: 42,
            recoverable: false,
            code: Some("framing_broken".to_string()),
        }]
    );
    assert_eq!(shared.message_seq.load(Ordering::SeqCst), 0);
    assert!(shared.message_log.lock().expect("message log").is_empty());
}

#[test]
fn oq60_recoverable_framing_errors_emit_stable_codes() {
    let emitter = CapturingRuntimeEmitter::default();
    let shared = super::transport::ReaderShared {
        message_log: Arc::new(Mutex::new(VecDeque::new())),
        message_seq: Arc::new(AtomicU64::new(0)),
        dropped_messages: Arc::new(AtomicU64::new(0)),
        exited: Arc::new(std::sync::atomic::AtomicBool::new(false)),
        redaction_values: Arc::new(Vec::new()),
    };
    let mut framing = FramingState::default();
    let mut line_buf = String::from("not-json\n");

    flush_complete_lines(&mut line_buf, false, &emitter, 42, &shared, &mut framing);

    let events = emitter.events.lock().expect("events");
    assert_eq!(
        events.as_slice(),
        &[CapturedRuntimeEvent::Error {
            runtime_id: 42,
            recoverable: true,
            code: Some("framing_invalid_json".to_string()),
        }]
    );
}

#[test]
fn oq60_line_too_large_framing_error_emits_stable_code() {
    let emitter = CapturingRuntimeEmitter::default();
    let shared = super::transport::ReaderShared {
        message_log: Arc::new(Mutex::new(VecDeque::new())),
        message_seq: Arc::new(AtomicU64::new(0)),
        dropped_messages: Arc::new(AtomicU64::new(0)),
        exited: Arc::new(std::sync::atomic::AtomicBool::new(false)),
        redaction_values: Arc::new(Vec::new()),
    };
    let mut framing = FramingState::default();
    let mut line_buf = "x".repeat(MAX_LINE_BYTES + 1);
    line_buf.push('\n');

    flush_complete_lines(&mut line_buf, false, &emitter, 42, &shared, &mut framing);

    let events = emitter.events.lock().expect("events");
    assert_eq!(
        events.as_slice(),
        &[CapturedRuntimeEvent::Error {
            runtime_id: 42,
            recoverable: true,
            code: Some("framing_line_too_large".to_string()),
        }]
    );
}

#[test]
fn oq60_repeated_invalid_lines_escalate_to_framing_broken_code_and_latch() {
    let emitter = CapturingRuntimeEmitter::default();
    let shared = super::transport::ReaderShared {
        message_log: Arc::new(Mutex::new(VecDeque::new())),
        message_seq: Arc::new(AtomicU64::new(0)),
        dropped_messages: Arc::new(AtomicU64::new(0)),
        exited: Arc::new(std::sync::atomic::AtomicBool::new(false)),
        redaction_values: Arc::new(Vec::new()),
    };
    let mut framing = FramingState::default();
    let mut line_buf = String::from(
        "not-json-1\nnot-json-2\nnot-json-3\nnot-json-4\nnot-json-5\n{\"id\":1,\"result\":{}}\n",
    );

    flush_complete_lines(&mut line_buf, false, &emitter, 42, &shared, &mut framing);

    assert_eq!(
        *emitter.events.lock().expect("events"),
        vec![
            CapturedRuntimeEvent::Error {
                runtime_id: 42,
                recoverable: true,
                code: Some("framing_invalid_json".to_string()),
            },
            CapturedRuntimeEvent::Error {
                runtime_id: 42,
                recoverable: true,
                code: Some("framing_invalid_json".to_string()),
            },
            CapturedRuntimeEvent::Error {
                runtime_id: 42,
                recoverable: true,
                code: Some("framing_invalid_json".to_string()),
            },
            CapturedRuntimeEvent::Error {
                runtime_id: 42,
                recoverable: true,
                code: Some("framing_invalid_json".to_string()),
            },
            CapturedRuntimeEvent::Error {
                runtime_id: 42,
                recoverable: false,
                code: Some("framing_broken".to_string()),
            },
        ]
    );
    assert_eq!(shared.message_seq.load(Ordering::SeqCst), 0);
    assert!(shared.message_log.lock().expect("message log").is_empty());
}

#[test]
fn e2e10_raw_protocol_debug_log_is_off_by_default() {
    let _debug_guard = set_raw_debug_log_env(None);
    let dir = unique_state_dir("raw-log-off");
    let _state_guard = crate::app_env::test_support::set_state_dir_env(&dir);
    let emitter = CapturingRuntimeEmitter::default();
    let shared = super::transport::ReaderShared {
        message_log: Arc::new(Mutex::new(VecDeque::new())),
        message_seq: Arc::new(AtomicU64::new(0)),
        dropped_messages: Arc::new(AtomicU64::new(0)),
        exited: Arc::new(std::sync::atomic::AtomicBool::new(false)),
        redaction_values: Arc::new(Vec::new()),
    };
    let mut framing = FramingState::default();
    let mut line_buf = String::from("{\"id\":1,\"params\":{\"authToken\":\"secret-token\"}}\n");

    flush_complete_lines(&mut line_buf, false, &emitter, 7, &shared, &mut framing);

    assert!(!dir.join("agent-runtime-debug.log").exists());
}

#[test]
fn e2e10_raw_protocol_debug_log_is_opt_in_and_redacted() {
    let _debug_guard = set_raw_debug_log_env(Some("1"));
    let dir = unique_state_dir("raw-log-on");
    let _state_guard = crate::app_env::test_support::set_state_dir_env(&dir);
    let emitter = CapturingRuntimeEmitter::default();
    let shared = super::transport::ReaderShared {
        message_log: Arc::new(Mutex::new(VecDeque::new())),
        message_seq: Arc::new(AtomicU64::new(0)),
        dropped_messages: Arc::new(AtomicU64::new(0)),
        exited: Arc::new(std::sync::atomic::AtomicBool::new(false)),
        redaction_values: Arc::new(Vec::new()),
    };
    let mut framing = FramingState::default();
    let mut line_buf = String::from(
        "{\"id\":1,\"params\":{\"Authorization\":\"Bearer inbound-secret\"}}\n{\"id\":2,\"result\":{\"ok\":true}}\n",
    );

    flush_complete_lines(&mut line_buf, false, &emitter, 7, &shared, &mut framing);

    let log = std::fs::read_to_string(dir.join("agent-runtime-debug.log")).expect("debug log");
    let entries: Vec<serde_json::Value> = log
        .lines()
        .map(|line| serde_json::from_str(line).expect("debug log entry"))
        .collect();
    assert_eq!(entries.len(), 2);
    assert_eq!(entries[0]["seq"], 1);
    assert_eq!(entries[1]["seq"], 2);
    assert!(log.contains("\"direction\":\"in\""));
    assert!(log.contains("[REDACTED]"));
    assert!(!log.contains("inbound-secret"));
}

#[test]
fn e2e10_raw_protocol_debug_log_redacts_runtime_env_values() {
    let _debug_guard = set_raw_debug_log_env(Some("1"));
    let dir = unique_state_dir("raw-log-env-value");
    let _state_guard = crate::app_env::test_support::set_state_dir_env(&dir);
    let emitter = CapturingRuntimeEmitter::default();
    let shared = super::transport::ReaderShared {
        message_log: Arc::new(Mutex::new(VecDeque::new())),
        message_seq: Arc::new(AtomicU64::new(0)),
        dropped_messages: Arc::new(AtomicU64::new(0)),
        exited: Arc::new(std::sync::atomic::AtomicBool::new(false)),
        redaction_values: Arc::new(vec!["SAFE_VALUE_123".to_string()]),
    };
    let mut framing = FramingState::default();
    let mut line_buf = String::from("{\"id\":1,\"result\":{\"note\":\"SAFE_VALUE_123\"}}\n");

    flush_complete_lines(&mut line_buf, false, &emitter, 7, &shared, &mut framing);

    let log = std::fs::read_to_string(dir.join("agent-runtime-debug.log")).expect("debug log");
    assert!(log.contains("[REDACTED]"));
    assert!(!log.contains("SAFE_VALUE_123"));
}

#[test]
fn d_replaylog_redacts_runtime_env_values_without_redacting_realtime_event() {
    let _debug_guard = set_raw_debug_log_env(None);
    let emitter = CapturingRuntimeEmitter::default();
    let shared = super::transport::ReaderShared {
        message_log: Arc::new(Mutex::new(VecDeque::new())),
        message_seq: Arc::new(AtomicU64::new(0)),
        dropped_messages: Arc::new(AtomicU64::new(0)),
        exited: Arc::new(std::sync::atomic::AtomicBool::new(false)),
        redaction_values: Arc::new(vec!["SAFE_VALUE_123".to_string()]),
    };
    let mut framing = FramingState::default();
    let mut line_buf = String::from("{\"id\":1,\"result\":{\"note\":\"SAFE_VALUE_123\"}}\n");

    flush_complete_lines(&mut line_buf, false, &emitter, 7, &shared, &mut framing);

    let log = shared.message_log.lock().expect("message log");
    let stored = log.front().expect("stored replay log").line.as_str();
    assert!(stored.contains("[REDACTED]"));
    assert!(!stored.contains("SAFE_VALUE_123"));
    drop(log);

    let messages = emitter.messages.lock().expect("messages");
    assert_eq!(messages[0]["result"]["note"], "SAFE_VALUE_123");
}

#[test]
fn e2e10_raw_protocol_debug_log_redacts_mcp_env_values() {
    let _debug_guard = set_raw_debug_log_env(Some("1"));
    let dir = unique_state_dir("raw-log-mcp-env-value");
    let _state_guard = crate::app_env::test_support::set_state_dir_env(&dir);
    let emitter = CapturingRuntimeEmitter::default();
    let shared = super::transport::ReaderShared {
        message_log: Arc::new(Mutex::new(VecDeque::new())),
        message_seq: Arc::new(AtomicU64::new(0)),
        dropped_messages: Arc::new(AtomicU64::new(0)),
        exited: Arc::new(std::sync::atomic::AtomicBool::new(false)),
        redaction_values: Arc::new(Vec::new()),
    };
    let mut framing = FramingState::default();
    let mut line_buf = String::from(
        "{\"id\":1,\"result\":{\"mcpServers\":{\"docs\":{\"env\":{\"SAFE_ROUTING_HINT\":\"workspace-alpha\",\"FEATURE_FLAG\":\"enabled\"}}}}}\n",
    );

    flush_complete_lines(&mut line_buf, false, &emitter, 7, &shared, &mut framing);

    let log = std::fs::read_to_string(dir.join("agent-runtime-debug.log")).expect("debug log");
    assert!(log.contains("SAFE_ROUTING_HINT"));
    assert!(log.contains("[REDACTED]"));
    assert!(!log.contains("workspace-alpha"));
    assert!(!log.contains("enabled"));
}

#[test]
fn e2e10_outbound_protocol_debug_log_is_opt_in_and_redacted() {
    let _debug_guard = set_raw_debug_log_env(Some("1"));
    let dir = unique_state_dir("raw-log-outbound");
    let _state_guard = crate::app_env::test_support::set_state_dir_env(&dir);
    let stdin = Arc::new(Mutex::new(Some(
        Box::new(std::io::sink()) as Box<dyn Write + Send>
    )));

    write_message_with_values(
        9,
        &stdin,
        &JsonRpcMessage::Request {
            jsonrpc: Some("2.0".into()),
            id: serde_json::json!(2),
            method: "session/prompt".into(),
            params: Some(serde_json::json!({ "apiKey": "outbound-secret" })),
        },
        &[],
    )
    .expect("write message");

    let log = std::fs::read_to_string(dir.join("agent-runtime-debug.log")).expect("debug log");
    assert!(log.contains("\"runtimeId\":9"));
    assert!(log.contains("\"direction\":\"out\""));
    assert!(log.contains("[REDACTED]"));
    assert!(!log.contains("outbound-secret"));
}

// ───────────────────────── RS-8..RS-12c: allowlist ─────────────────────────

#[test]
fn rs8_codex_exact_args_allowed_and_resolves_executable() {
    let params = stdio("codex", &["app-server", "--stdio"], None);
    let launch = validate_and_extract(&params, ok_exe, ok_entry).expect("codex allowed");
    assert_eq!(launch.executable, "/usr/bin/codex");
    assert_eq!(launch.argv, vec!["app-server", "--stdio"]);
}

#[test]
fn rs8b_codex_wrong_args_rejected() {
    assert!(
        validate_and_extract(&stdio("codex", &["app-server"], None), ok_exe, ok_entry).is_err()
    );
    assert!(validate_and_extract(
        &stdio("codex", &["app-server", "--stdio", "--extra"], None),
        ok_exe,
        ok_entry
    )
    .is_err());
}

#[test]
fn rs8c_empty_distro_rejected_but_distro_list_is_not_probed() {
    let params = AgentRuntimeStartParams::JsonrpcStdio {
        provider: "codex".to_string(),
        distro: "  ".to_string(),
        work_dir: "/home/tester/work".to_string(),
        args: vec!["app-server".to_string(), "--stdio".to_string()],
        env: None,
    };

    assert!(validate_and_extract(&params, ok_exe, ok_entry).is_err());
}

#[test]
fn rs9_claude_trusted_entry_allowed_and_resolves_node() {
    let entry = "/opt/node_modules/@agentclientprotocol/claude-agent-acp/dist/index.js";
    let launch = validate_and_extract(
        &stdio("claude", &[entry, "--hide-claude-auth"], None),
        ok_exe,
        ok_entry,
    )
    .expect("claude ok");
    assert_eq!(launch.executable, "/usr/bin/node");
    assert_eq!(launch.argv, vec![entry, "--hide-claude-auth"]);
}

#[test]
fn rs9b_claude_untrusted_or_multi_args_rejected() {
    // 임의 .js
    assert!(
        validate_and_extract(&stdio("claude", &["/tmp/x.js"], None), ok_exe, ok_entry).is_err()
    );
    // 허용된 고정 auth 숨김 플래그 외의 추가 argv
    let entry = "/opt/node_modules/@agentclientprotocol/claude-agent-acp/dist/index.js";
    assert!(
        validate_and_extract(&stdio("claude", &[entry, "--x"], None), ok_exe, ok_entry).is_err()
    );
    // hide flag 누락
    assert!(validate_and_extract(&stdio("claude", &[entry], None), ok_exe, ok_entry).is_err());
}

#[test]
fn rs10c_resolve_failure_rejects_start() {
    let params = stdio("codex", &["app-server", "--stdio"], None);
    assert!(validate_and_extract(&params, fail_exe, ok_entry).is_err());
}

#[test]
fn rs11_shell_metachar_args_rejected() {
    // claude entry처럼 보이지만 메타문자 포함 → entry 미일치로 먼저 거부되므로 codex 경로로 검증.
    let params = AgentRuntimeStartParams::JsonrpcStdio {
        provider: "codex".to_string(),
        distro: "Ubuntu".to_string(),
        work_dir: "/x".to_string(),
        args: vec!["app-server".to_string(), "--stdio; rm -rf".to_string()],
        env: None,
    };
    assert!(validate_and_extract(&params, ok_exe, ok_entry).is_err());
}

#[test]
fn rs12_invalid_env_key_regex_rejected() {
    assert!(!is_valid_env_key("1BAD"));
    assert!(!is_valid_env_key("A-B"));
    assert!(!is_valid_env_key("A B"));
    assert!(is_valid_env_key("RUST_LOG"));
    let mut env = HashMap::new();
    env.insert("1BAD".to_string(), "x".to_string());
    assert!(validate_and_extract(
        &stdio("codex", &["app-server", "--stdio"], Some(env)),
        ok_exe,
        ok_entry
    )
    .is_err());
}

#[test]
fn rs12b_env_key_outside_allowlist_rejected() {
    let mut env = HashMap::new();
    env.insert("SOME_RANDOM_KEY".to_string(), "x".to_string());
    assert!(validate_and_extract(
        &stdio("codex", &["app-server", "--stdio"], Some(env)),
        ok_exe,
        ok_entry
    )
    .is_err());
    // 허용 key는 통과.
    let mut ok = HashMap::new();
    ok.insert("RUST_LOG".to_string(), "info".to_string());
    ok.insert("CODEX_DISABLE_UPDATE_CHECK".to_string(), "1".to_string());
    assert!(validate_and_extract(
        &stdio("codex", &["app-server", "--stdio"], Some(ok)),
        ok_exe,
        ok_entry
    )
    .is_ok());
}

#[test]
fn rs12b_claude_specific_env_keys() {
    let mut env = HashMap::new();
    env.insert(
        "CLAUDE_CONFIG_DIR".to_string(),
        "/home/tester/.claude".to_string(),
    );
    let entry = "/opt/node_modules/@agentclientprotocol/claude-agent-acp/dist/index.js";
    assert!(validate_and_extract(
        &stdio("claude", &[entry, "--hide-claude-auth"], Some(env)),
        ok_exe,
        ok_entry
    )
    .is_ok());
    // codex에는 claude 전용 key가 허용되지 않는다.
    let mut env2 = HashMap::new();
    env2.insert("CLAUDE_CONFIG_DIR".to_string(), "/x".to_string());
    assert!(validate_and_extract(
        &stdio("codex", &["app-server", "--stdio"], Some(env2)),
        ok_exe,
        ok_entry
    )
    .is_err());
}

#[test]
fn rs12c_websocket_rejected_without_logging_token() {
    let dir = unique_state_dir("websocket-reject-audit");
    let _state_guard = crate::app_env::test_support::set_state_dir_env(&dir);

    let params = AgentRuntimeStartParams::Websocket {
        provider: "codex".to_string(),
        distro: "Ubuntu".to_string(),
        work_dir: "/x".to_string(),
        url: "ws://localhost:1234".to_string(),
        auth_token: Some("secret-xyz".to_string()),
    };
    let err = super::validate_launch_for_start(&params, ok_exe, ok_entry).unwrap_err();
    // 에러 문자열에 authToken 값이 평문으로 실리지 않음(reject-before-log, D-WSAUTH).
    assert!(!err.contains("secret-xyz"));
    assert_eq!(err, "only jsonrpc-stdio transport is supported in v1");

    let audit = std::fs::read_to_string(dir.join("agent-runtime-audit.log")).expect("audit log");
    assert!(audit.contains(r#""transportKind":"websocket""#));
    assert!(audit.contains(r#""reason":"only jsonrpc-stdio transport is supported in v1""#));
    assert!(!audit.contains("authToken"));
    assert!(!audit.contains("secret-xyz"));
    assert!(!audit.contains("ws://localhost:1234"));
}

#[test]
fn rs12d_allowlist_failure_writes_redacted_launch_audit() {
    let dir = unique_state_dir("launch-reject-audit");
    let _state_guard = crate::app_env::test_support::set_state_dir_env(&dir);

    let params = AgentRuntimeStartParams::JsonrpcStdio {
        provider: "sk-super-secret".to_string(),
        distro: "Ubuntu".to_string(),
        work_dir: "/home/tester/work".to_string(),
        args: vec!["app-server".to_string(), "--stdio".to_string()],
        env: None,
    };
    let err = super::validate_launch_for_start(&params, ok_exe, ok_entry).unwrap_err();

    assert_eq!(err, "unknown provider");
    let audit = std::fs::read_to_string(dir.join("agent-runtime-audit.log")).expect("audit log");
    assert!(audit.contains(r#""event":"launchRejected""#));
    assert!(audit.contains(r#""provider":"[REDACTED]""#));
    assert!(audit.contains(r#""reason":"unknown provider""#));
    assert!(audit.contains("[REDACTED]"));
    assert!(!audit.contains("sk-super-secret"));
}

#[test]
fn rs8_path_windows_and_relative_rejected() {
    assert!(canonicalize_wsl_path("C:\\Users").is_err());
    assert!(canonicalize_wsl_path("relative").is_err());
    assert!(canonicalize_wsl_path("~/work").is_err());
    assert_eq!(canonicalize_wsl_path("/home/x//y/").unwrap(), "/home/x/y");
}

// ───────────────────────── RS-16/17: bounded replay log / backpressure ─────────────────────────

#[test]
fn rs16_bounded_replay_log_trims_and_reports_notify_counts() {
    let mut log: VecDeque<RuntimeMessageRecord> = VecDeque::new();
    let dropped = AtomicU64::new(0);
    let mut notifications = Vec::new();

    for seq in 1..=5 {
        notifications.extend(record_bounded_replay_log(
            &mut log,
            &dropped,
            seq,
            "x".repeat(60),
            100,
            2,
        ));
    }

    assert_eq!(dropped.load(Ordering::SeqCst), 4);
    assert_eq!(notifications, vec![2, 4]);
    assert_eq!(log.len(), 1);
    assert_eq!(log.back().map(|r| r.seq), Some(5));
}

#[test]
fn rs17_bounded_replay_log_retains_followup_after_overflow() {
    let mut log: VecDeque<RuntimeMessageRecord> = VecDeque::new();
    let dropped = AtomicU64::new(0);

    assert!(record_bounded_replay_log(&mut log, &dropped, 1, "a".repeat(80), 150, 256).is_empty());
    assert!(record_bounded_replay_log(&mut log, &dropped, 2, "b".repeat(80), 150, 256).is_empty());
    assert!(
        record_bounded_replay_log(&mut log, &dropped, 3, "tail".to_string(), 150, 256).is_empty()
    );

    assert_eq!(dropped.load(Ordering::SeqCst), 1);
    assert_eq!(log.len(), 2);
    assert_eq!(log.front().map(|r| r.seq), Some(2));
    assert_eq!(log.back().map(|r| r.line.as_str()), Some("tail"));
}

// ───────────────────────── RS-13..15c: shutdown reap boundary ─────────────────────────

struct TestSink;
impl Write for TestSink {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        Ok(buf.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

fn lifecycle_test_state(
    provider: &str,
    kill_handle: Option<KillHandle>,
    exited: Arc<std::sync::atomic::AtomicBool>,
) -> (super::AgentRuntimeState, super::RuntimeId) {
    let state = super::AgentRuntimeState::default();
    let id = super::next_runtime_id(&state).expect("next id");
    let runtime = super::AgentRuntime {
        provider: provider.to_string(),
        kill_handle,
        stdin: Arc::new(Mutex::new(
            Some(Box::new(TestSink) as Box<dyn Write + Send>),
        )),
        message_log: Arc::new(Mutex::new(VecDeque::new())),
        message_seq: Arc::new(AtomicU64::new(0)),
        pending_request_ids: Arc::new(Mutex::new(Vec::new())),
        status: Arc::new(Mutex::new(if exited.load(Ordering::SeqCst) {
            "exited".to_string()
        } else {
            "running".to_string()
        })),
        started_at: now_millis(),
        exited_at: Arc::new(Mutex::new(if exited.load(Ordering::SeqCst) {
            Some(now_millis())
        } else {
            None
        })),
        exited,
        dropped_messages: Arc::new(AtomicU64::new(0)),
        redaction_values: Arc::new(Vec::new()),
    };
    super::insert_runtime(&state, id, runtime).expect("insert");
    (state, id)
}

#[test]
fn rs13_shutdown_graceful_exit_removes_without_kill() {
    let exited = Arc::new(std::sync::atomic::AtomicBool::new(true));
    let (state, id) = lifecycle_test_state("codex", Some(KillHandle { pid: 123 }), exited);
    let killed = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let killed_for_closure = killed.clone();

    super::shutdown_with_policy(
        &state,
        id,
        super::ShutdownPolicy {
            grace_ms: 0,
            reap_grace_ms: 0,
            poll_ms: 1,
        },
        move |_| {
            killed_for_closure.store(true, Ordering::SeqCst);
        },
    )
    .expect("shutdown");

    assert!(!killed.load(Ordering::SeqCst));
    assert!(super::get_snapshot(&state, id).is_err());
}

#[test]
fn rs14_shutdown_timeout_kills_then_reaps_before_removal() {
    let exited = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let (state, id) = lifecycle_test_state("codex", Some(KillHandle { pid: 456 }), exited.clone());
    let killed = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let killed_for_closure = killed.clone();

    super::shutdown_with_policy(
        &state,
        id,
        super::ShutdownPolicy {
            grace_ms: 0,
            reap_grace_ms: 10,
            poll_ms: 1,
        },
        move |handle| {
            assert_eq!(handle.pid, 456);
            killed_for_closure.store(true, Ordering::SeqCst);
            exited.store(true, Ordering::SeqCst);
        },
    )
    .expect("shutdown");

    assert!(killed.load(Ordering::SeqCst));
    assert!(super::get_snapshot(&state, id).is_err());
}

#[test]
fn rs15c_shutdown_reap_timeout_keeps_runtime() {
    let exited = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let (state, id) = lifecycle_test_state("codex", Some(KillHandle { pid: 789 }), exited);
    let killed = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let killed_for_closure = killed.clone();

    let err = super::shutdown_with_policy(
        &state,
        id,
        super::ShutdownPolicy {
            grace_ms: 0,
            reap_grace_ms: 0,
            poll_ms: 1,
        },
        move |_| {
            killed_for_closure.store(true, Ordering::SeqCst);
        },
    )
    .unwrap_err();

    assert!(err.contains("child not reaped"));
    assert!(killed.load(Ordering::SeqCst));
    assert_eq!(super::get_snapshot(&state, id).unwrap().status, "running");
}

// ───────────────────────── AC-10b: spawn argv 조립(secret 비경유) ─────────────────────────

#[test]
fn ac10b_secret_env_not_in_argv_but_in_wslenv() {
    let mut non_secret = HashMap::new();
    non_secret.insert("RUST_LOG".to_string(), "info".to_string());
    let mut secret = HashMap::new();
    secret.insert(
        "ANTHROPIC_API_KEY".to_string(),
        "sk-super-secret".to_string(),
    );

    let cmd = build_wsl_command(
        "Ubuntu",
        "/usr/bin/codex",
        &["app-server".to_string(), "--stdio".to_string()],
        "/home/tester/work",
        &non_secret,
        &secret,
    );
    let argv: Vec<String> = cmd
        .get_args()
        .map(|a| a.to_string_lossy().to_string())
        .collect();
    // non-secret은 argv(`-e env KEY=VAL`)에 등재.
    assert!(argv.iter().any(|a| a == "RUST_LOG=info"));
    // secret 값/키는 argv 어디에도 평문으로 없다.
    assert!(!argv.iter().any(|a| a.contains("sk-super-secret")));
    assert!(!argv.iter().any(|a| a.starts_with("ANTHROPIC_API_KEY=")));
    // WSLENV passthrough + Command::env로 secret 전달.
    let envs: HashMap<String, Option<String>> = cmd
        .get_envs()
        .map(|(k, v)| {
            (
                k.to_string_lossy().to_string(),
                v.map(|v| v.to_string_lossy().to_string()),
            )
        })
        .collect();
    assert_eq!(
        envs.get("ANTHROPIC_API_KEY"),
        Some(&Some("sk-super-secret".to_string()))
    );
    assert_eq!(
        envs.get("WSLENV"),
        Some(&Some("ANTHROPIC_API_KEY/u".to_string()))
    );
    // launch 형태: --cd <workDir> 포함.
    assert!(argv.iter().any(|a| a == "--cd"));
    assert!(argv.iter().any(|a| a == "/home/tester/work"));
}

// ───────────────────────── RS-10d/10e: resolver 캐시 ─────────────────────────

#[test]
fn rs10d_caching_resolver_returns_executable_absolute_and_reresolves_after_clear() {
    use super::resolver::{CachingResolver, TrustedPathResolver};
    use std::sync::atomic::{AtomicU32, Ordering};
    use std::sync::Arc;

    struct CountingResolver {
        calls: Arc<AtomicU32>,
    }
    impl TrustedPathResolver for CountingResolver {
        fn resolve_executable(&self, _p: &str, _d: &str) -> Result<String, String> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            Ok("/usr/bin/node".to_string())
        }
        fn resolve_adapter_entry(&self, _p: &str, _d: &str) -> Result<String, String> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            Ok("/opt/node_modules/@agentclientprotocol/claude-agent-acp/dist/index.js".to_string())
        }
    }

    let calls = Arc::new(AtomicU32::new(0));
    let resolver = CachingResolver::new(Box::new(CountingResolver {
        calls: calls.clone(),
    }));

    // 1차 executable resolve → 절대경로 + inner 호출 1회.
    let p1 = resolver.resolve_executable("claude", "Ubuntu").unwrap();
    assert!(p1.starts_with('/'));
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    // 캐시 hit → inner 미호출.
    let _ = resolver.resolve_executable("claude", "Ubuntu").unwrap();
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    // 무효화 후 재탐색(stale 미반환).
    resolver.clear();
    let _ = resolver.resolve_executable("claude", "Ubuntu").unwrap();
    assert_eq!(calls.load(Ordering::SeqCst), 2);
}

#[test]
fn rs10e_caching_resolver_requires_pinned_adapter_entry_layout() {
    use super::resolver::{CachingResolver, TrustedPathResolver};
    use std::sync::atomic::{AtomicU32, Ordering};
    use std::sync::Arc;

    struct CountingResolver {
        calls: Arc<AtomicU32>,
        entry: String,
    }
    impl TrustedPathResolver for CountingResolver {
        fn resolve_executable(&self, _p: &str, _d: &str) -> Result<String, String> {
            Ok("/usr/bin/node".to_string())
        }
        fn resolve_adapter_entry(&self, _p: &str, _d: &str) -> Result<String, String> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            Ok(self.entry.clone())
        }
    }

    let calls = Arc::new(AtomicU32::new(0));
    let resolver = CachingResolver::new(Box::new(CountingResolver {
        calls: calls.clone(),
        entry: "/opt/acp/dist/index.js".to_string(),
    }));

    let err = resolver
        .resolve_adapter_entry("claude", "Ubuntu")
        .unwrap_err();
    assert!(err.contains("pinned package layout"));
    assert_eq!(calls.load(Ordering::SeqCst), 1);

    let resolver = CachingResolver::new(Box::new(CountingResolver {
        calls: calls.clone(),
        entry: "/opt/node_modules/@agentclientprotocol/claude-agent-acp/dist/index.js".to_string(),
    }));
    let p1 = resolver.resolve_adapter_entry("claude", "Ubuntu").unwrap();
    assert!(p1.ends_with("node_modules/@agentclientprotocol/claude-agent-acp/dist/index.js"));
    let _ = resolver.resolve_adapter_entry("claude", "Ubuntu").unwrap();
    assert_eq!(calls.load(Ordering::SeqCst), 2);
    resolver.clear();
    let _ = resolver.resolve_adapter_entry("claude", "Ubuntu").unwrap();
    assert_eq!(calls.load(Ordering::SeqCst), 3);
}

#[test]
fn rs10f_preflight_executable_version_runs_outside_path_cache() {
    use super::resolver::{CachingResolver, TrustedPathResolver};
    use std::sync::atomic::{AtomicU32, Ordering};
    use std::sync::Arc;

    struct CountingResolver {
        version_calls: Arc<AtomicU32>,
    }
    impl TrustedPathResolver for CountingResolver {
        fn resolve_executable(&self, _p: &str, _d: &str) -> Result<String, String> {
            Ok("/usr/bin/codex".to_string())
        }
        fn resolve_adapter_entry(&self, _p: &str, _d: &str) -> Result<String, String> {
            Ok("/opt/node_modules/@agentclientprotocol/claude-agent-acp/dist/index.js".to_string())
        }
        fn preflight_executable_version(
            &self,
            provider: &str,
            _distro: &str,
            executable: &str,
        ) -> Result<String, String> {
            self.version_calls.fetch_add(1, Ordering::SeqCst);
            Ok(format!("{provider}:{executable}:0.142.2"))
        }
    }

    let version_calls = Arc::new(AtomicU32::new(0));
    let resolver = CachingResolver::new(Box::new(CountingResolver {
        version_calls: version_calls.clone(),
    }));

    let executable = resolver.resolve_executable("codex", "Ubuntu").unwrap();
    let v1 = resolver
        .preflight_executable_version("codex", "Ubuntu", &executable)
        .unwrap();
    let v2 = resolver
        .preflight_executable_version("codex", "Ubuntu", &executable)
        .unwrap();

    assert_eq!(v1, "codex:/usr/bin/codex:0.142.2");
    assert_eq!(v2, "codex:/usr/bin/codex:0.142.2");
    assert_eq!(version_calls.load(Ordering::SeqCst), 2);
}

#[test]
fn rs10g_preflight_executable_version_rejects_non_absolute_path() {
    use super::resolver::{CachingResolver, TrustedPathResolver};

    struct Resolver;
    impl TrustedPathResolver for Resolver {
        fn resolve_executable(&self, _p: &str, _d: &str) -> Result<String, String> {
            Ok("codex".to_string())
        }
        fn resolve_adapter_entry(&self, _p: &str, _d: &str) -> Result<String, String> {
            Ok("/opt/node_modules/@agentclientprotocol/claude-agent-acp/dist/index.js".to_string())
        }
        fn preflight_executable_version(
            &self,
            _provider: &str,
            _distro: &str,
            _executable: &str,
        ) -> Result<String, String> {
            Ok("codex-cli 0.142.2".to_string())
        }
    }

    let resolver = CachingResolver::new(Box::new(Resolver));
    let err = resolver
        .preflight_executable_version("codex", "Ubuntu", "codex")
        .unwrap_err();

    assert!(err.contains("preflight executable is not absolute"));
}

#[test]
fn rs10h_start_preflight_rejects_failure_with_resolved_executable() {
    use std::sync::atomic::{AtomicU32, Ordering};
    use std::sync::Arc;

    let params = stdio("codex", &["app-server", "--stdio"], None);
    let launch = super::validate_launch_for_start(&params, ok_exe, ok_entry).unwrap();
    let calls = Arc::new(AtomicU32::new(0));
    let seen_calls = calls.clone();

    let err = super::preflight_launch_for_start(
        &params,
        &launch,
        |provider, distro, executable| {
            seen_calls.fetch_add(1, Ordering::SeqCst);
            assert_eq!(provider, "codex");
            assert_eq!(distro, "Ubuntu-24.04");
            assert_eq!(executable, "/usr/bin/codex");
            Err("version probe failed".to_string())
        },
        |_distro, _executable, _adapter_entry, _env| {
            panic!("codex preflight must not run claude native probe");
        },
    )
    .unwrap_err();

    assert!(err.contains("version probe failed"));
    assert_eq!(calls.load(Ordering::SeqCst), 1);
}

#[test]
fn rs10i_start_preflight_rejects_empty_version_output() {
    let params = stdio(
        "claude",
        &[
            "/opt/node_modules/@agentclientprotocol/claude-agent-acp/dist/index.js",
            "--hide-claude-auth",
        ],
        None,
    );
    let launch = super::validate_launch_for_start(&params, ok_exe, ok_entry).unwrap();

    let err = super::preflight_launch_for_start(
        &params,
        &launch,
        |_provider, _distro, _executable| Ok("  \n".to_string()),
        |_distro, _executable, _adapter_entry, _env| {
            panic!("empty node version must stop before claude native probe");
        },
    )
    .unwrap_err();

    assert!(err.contains("claude version preflight returned empty output"));
}

#[test]
fn rs10k_claude_start_preflight_runs_native_binary_probe() {
    use std::sync::atomic::{AtomicU32, Ordering};
    use std::sync::Arc;

    let entry = "/opt/node_modules/@agentclientprotocol/claude-agent-acp/dist/index.js";
    let params = stdio("claude", &[entry, "--hide-claude-auth"], None);
    let launch = super::validate_launch_for_start(&params, ok_exe, ok_entry).unwrap();
    let node_calls = Arc::new(AtomicU32::new(0));
    let native_calls = Arc::new(AtomicU32::new(0));
    let seen_node_calls = node_calls.clone();
    let seen_native_calls = native_calls.clone();

    let version = super::preflight_launch_for_start(
        &params,
        &launch,
        |provider, distro, executable| {
            seen_node_calls.fetch_add(1, Ordering::SeqCst);
            assert_eq!(provider, "claude");
            assert_eq!(distro, "Ubuntu-24.04");
            assert_eq!(executable, "/usr/bin/node");
            Ok("node v24.11.1".to_string())
        },
        |distro, executable, adapter_entry, env| {
            seen_native_calls.fetch_add(1, Ordering::SeqCst);
            assert_eq!(distro, "Ubuntu-24.04");
            assert_eq!(executable, "/usr/bin/node");
            assert_eq!(adapter_entry, entry);
            assert!(env.is_empty());
            Ok("2.1.187 (Claude Code)".to_string())
        },
    )
    .unwrap();

    assert_eq!(version, "node v24.11.1");
    assert_eq!(node_calls.load(Ordering::SeqCst), 1);
    assert_eq!(native_calls.load(Ordering::SeqCst), 1);
}

#[test]
fn rs10l_claude_start_preflight_rejects_native_binary_failure() {
    use std::sync::atomic::{AtomicU32, Ordering};
    use std::sync::Arc;

    let entry = "/opt/node_modules/@agentclientprotocol/claude-agent-acp/dist/index.js";
    let params = stdio("claude", &[entry, "--hide-claude-auth"], None);
    let launch = super::validate_launch_for_start(&params, ok_exe, ok_entry).unwrap();
    let native_calls = Arc::new(AtomicU32::new(0));
    let seen_native_calls = native_calls.clone();

    let err = super::preflight_launch_for_start(
        &params,
        &launch,
        |_provider, _distro, _executable| Ok("node v24.11.1".to_string()),
        |_distro, _executable, _adapter_entry, _env| {
            seen_native_calls.fetch_add(1, Ordering::SeqCst);
            Err("Claude native binary not found".to_string())
        },
    )
    .unwrap_err();

    assert!(err.contains("Claude native binary not found"));
    assert_eq!(native_calls.load(Ordering::SeqCst), 1);
}

#[test]
fn rs10m_claude_native_preflight_receives_launch_env() {
    let entry = "/opt/node_modules/@agentclientprotocol/claude-agent-acp/dist/index.js";
    let mut env = HashMap::new();
    env.insert(
        "CLAUDE_CODE_EXECUTABLE".to_string(),
        "/opt/claude/claude".to_string(),
    );
    let params = stdio("claude", &[entry, "--hide-claude-auth"], Some(env));
    let launch = super::validate_launch_for_start(&params, ok_exe, ok_entry).unwrap();

    super::preflight_launch_for_start(
        &params,
        &launch,
        |_provider, _distro, _executable| Ok("node v24.11.1".to_string()),
        |_distro, _executable, _adapter_entry, env| {
            assert_eq!(
                env.get("CLAUDE_CODE_EXECUTABLE").map(String::as_str),
                Some("/opt/claude/claude"),
            );
            Ok("2.1.187 (Claude Code)".to_string())
        },
    )
    .unwrap();
}

#[test]
fn rs10j_default_resolver_preflight_reports_unavailable() {
    use super::resolver::{CachingResolver, TrustedPathResolver};

    struct Resolver;
    impl TrustedPathResolver for Resolver {
        fn resolve_executable(&self, _p: &str, _d: &str) -> Result<String, String> {
            Ok("/usr/bin/codex".to_string())
        }
        fn resolve_adapter_entry(&self, _p: &str, _d: &str) -> Result<String, String> {
            Ok("/opt/node_modules/@agentclientprotocol/claude-agent-acp/dist/index.js".to_string())
        }
    }

    let resolver = CachingResolver::new(Box::new(Resolver));
    let err = resolver
        .preflight_executable_version("codex", "Ubuntu", "/usr/bin/codex")
        .unwrap_err();

    assert!(err.contains("preflight unavailable"));
    assert!(!err.contains("not implemented"));
}

// ───────────────────────── RS-18..20: test-mode mock / snapshot ─────────────────────────

#[test]
fn rs18_test_mode_mock_provider_accepts_stdio_and_rejects_websocket_without_token() {
    let params = stdio("codex", &["app-server", "--stdio"], None);
    assert_eq!(super::mock_provider(&params).unwrap(), "codex");

    let ws = AgentRuntimeStartParams::Websocket {
        provider: "codex".to_string(),
        distro: "Ubuntu".to_string(),
        work_dir: "/home/x".to_string(),
        url: "ws://localhost:1234".to_string(),
        auth_token: Some("secret-xyz".to_string()),
    };
    let err = super::mock_provider(&ws).unwrap_err();
    assert!(err.contains("only jsonrpc-stdio"));
    assert!(!err.contains("secret-xyz"));
}

#[test]
fn rs19_mock_jsonrpc_responses_are_valid_and_provider_specific() {
    let mut codex_turn_seq = 0;
    let codex_init = super::mock_jsonrpc_response_script(
        "codex",
        "/home/tester/work",
        r#"{"id":1,"method":"initialize","params":{}}"#,
        &mut codex_turn_seq,
    );
    assert!(codex_init.immediate[0].contains("\"userAgent\":\"codex\""));
    assert!(!codex_init.immediate[0].contains("codex-test-mode"));

    let codex_start = super::mock_jsonrpc_response_script(
        "codex",
        "/home/tester/work",
        r#"{"id":2,"method":"thread/start","params":{"cwd":"/home/tester/work"}}"#,
        &mut codex_turn_seq,
    );
    assert!(codex_start.immediate[0].contains("\"t-mock\""));

    let codex_turn = super::mock_jsonrpc_response_script(
        "codex",
        "/home/tester/work",
        r#"{"id":3,"method":"turn/start","params":{"input":[{"type":"text","text":"hello","text_elements":[]}]}}"#,
        &mut codex_turn_seq,
    );
    assert!(codex_turn.immediate[0].contains("turn-mock-1"));
    assert!(codex_turn
        .delayed
        .iter()
        .any(|(line, _)| line.contains("Mock Codex response: hello")));
    assert!(super::mock_should_emit_post_start_fatal_error(
        "codex",
        r#"{"id":30,"method":"turn/start","params":{"input":[{"type":"text","text":"fatal runtime error please","text_elements":[]}]}}"#
    ));
    assert!(!super::mock_should_emit_post_start_fatal_error(
        "claude",
        r#"{"id":30,"method":"turn/start","params":{"input":[{"type":"text","text":"fatal runtime error please","text_elements":[]}]}}"#
    ));
    assert!(!super::mock_should_emit_post_start_fatal_error(
        "codex",
        r#"{"id":30,"method":"thread/start","params":{"cwd":"/home/tester/work"}}"#
    ));
    let codex_location_turn = super::mock_jsonrpc_response_script(
        "codex",
        "/home/tester/work",
        r#"{"id":31,"method":"turn/start","params":{"input":[{"type":"text","text":"location please","text_elements":[]}]}}"#,
        &mut codex_turn_seq,
    );
    assert!(codex_location_turn
        .delayed
        .iter()
        .any(|(line, _)| line.contains("\"locations\"")));
    assert!(codex_location_turn
        .delayed
        .iter()
        .any(|(line, _)| line.contains("src/lib/example.ts")));
    assert!(codex_location_turn
        .delayed
        .iter()
        .any(|(line, _)| line.contains("\"line\":12")));
    assert!(codex_location_turn
        .delayed
        .iter()
        .any(|(line, _)| line.contains("\"column\":4")));
    let codex_approval_turn = super::mock_jsonrpc_response_script(
        "codex",
        "/home/tester/work",
        r#"{"id":4,"method":"turn/start","params":{"input":[{"type":"text","text":"approval allow","text_elements":[]}]}}"#,
        &mut codex_turn_seq,
    );
    assert!(codex_approval_turn
        .delayed
        .iter()
        .any(|(line, _)| line.contains("item/commandExecution/requestApproval")));
    let codex_approval_accept = super::mock_jsonrpc_response_script(
        "codex",
        "/home/tester/work",
        r#"{"id":7002,"result":{"decision":"accept"}}"#,
        &mut codex_turn_seq,
    );
    assert!(codex_approval_accept
        .delayed
        .iter()
        .any(|(line, _)| line.contains("approval accepted")));
    let codex_interrupt = super::mock_jsonrpc_response_script(
        "codex",
        "/home/tester/work",
        r#"{"id":5,"method":"turn/interrupt","params":{"threadId":"t-mock","turnId":"turn-mock-2"}}"#,
        &mut codex_turn_seq,
    );
    assert!(codex_interrupt.immediate[0].contains("\"id\":5"));
    for line in codex_init
        .immediate
        .iter()
        .chain(codex_start.immediate.iter())
        .chain(codex_turn.immediate.iter())
        .chain(codex_turn.delayed.iter().map(|(line, _)| line))
        .chain(codex_location_turn.immediate.iter())
        .chain(codex_location_turn.delayed.iter().map(|(line, _)| line))
        .chain(codex_approval_turn.immediate.iter())
        .chain(codex_approval_turn.delayed.iter().map(|(line, _)| line))
        .chain(codex_approval_accept.immediate.iter())
        .chain(codex_approval_accept.delayed.iter().map(|(line, _)| line))
        .chain(codex_interrupt.immediate.iter())
        .chain(codex_interrupt.delayed.iter().map(|(line, _)| line))
    {
        serde_json::from_str::<serde_json::Value>(line).expect("codex mock line is json");
    }

    let mut claude_turn_seq = 0;
    let claude_init = super::mock_jsonrpc_response_script(
        "claude",
        "/home/tester/work",
        r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}"#,
        &mut claude_turn_seq,
    );
    assert!(claude_init.immediate[0].contains("\"protocolVersion\":1"));
    assert!(!claude_init.immediate[0].contains("claude-test-mode"));

    let claude_new = super::mock_jsonrpc_response_script(
        "claude",
        "/home/tester/work",
        r#"{"jsonrpc":"2.0","id":2,"method":"session/new","params":{"cwd":"/home/tester/work"}}"#,
        &mut claude_turn_seq,
    );
    assert!(claude_new.immediate[0].contains("\"sessionId\":\"sess-1\""));
    assert!(!claude_new.immediate[0].contains("\"sessionId\":\"s-mock\""));

    let claude_load = super::mock_jsonrpc_response_script(
        "claude",
        "/home/tester/work",
        r#"{"jsonrpc":"2.0","id":22,"method":"session/load","params":{"sessionId":"sess-1","cwd":"/home/tester/work"}}"#,
        &mut claude_turn_seq,
    );
    assert!(claude_load.immediate[0].contains("user_message_chunk"));
    assert!(claude_load.immediate[2].contains("\"id\":22"));

    let claude_prompt = super::mock_jsonrpc_response_script(
        "claude",
        "/home/tester/work",
        r#"{"jsonrpc":"2.0","id":3,"method":"session/prompt","params":{"sessionId":"s-mock","prompt":[]}}"#,
        &mut claude_turn_seq,
    );
    assert!(claude_prompt.immediate[0].contains("Mock Claude response"));
    assert!(claude_prompt.immediate[1].contains("\"stopReason\":\"end_turn\""));
    let claude_late_prompt = super::mock_jsonrpc_response_script(
        "claude",
        "/home/tester/work",
        r#"{"jsonrpc":"2.0","id":33,"method":"session/prompt","params":{"sessionId":"sess-custom","prompt":[{"type":"text","text":"late update please"}]}}"#,
        &mut claude_turn_seq,
    );
    assert!(claude_late_prompt
        .immediate
        .iter()
        .any(|line| line.contains("\"stopReason\":\"end_turn\"")));
    assert!(claude_late_prompt
        .immediate
        .iter()
        .any(|line| line.contains("\"sessionId\":\"sess-custom\"")));
    assert!(claude_late_prompt
        .delayed
        .iter()
        .any(|(line, _)| line.contains("\"sessionId\":\"sess-custom\"")
            && line.contains("\"sessionUpdate\":\"plan_update\"")));
    let claude_permission_prompt = super::mock_jsonrpc_response_script(
        "claude",
        "/home/tester/work",
        r#"{"jsonrpc":"2.0","id":4,"method":"session/prompt","params":{"sessionId":"s-mock","prompt":[{"type":"text","text":"approval please"}]}}"#,
        &mut claude_turn_seq,
    );
    assert!(claude_permission_prompt
        .immediate
        .iter()
        .any(|line| line.contains("session/request_permission")));
    assert!(!claude_permission_prompt
        .immediate
        .iter()
        .any(|line| line.contains("\"stopReason\"")));
    let claude_permission_accept = super::mock_jsonrpc_response_script(
        "claude",
        "/home/tester/work",
        &format!(
            r#"{{"jsonrpc":"2.0","id":{},"result":{{"outcome":{{"outcome":"selected","optionId":"allow"}}}}}}"#,
            super::CLAUDE_PERMISSION_REQUEST_ID_OFFSET + 4
        ),
        &mut claude_turn_seq,
    );
    assert!(claude_permission_accept
        .immediate
        .iter()
        .any(|line| line.contains("\"toolCallId\":\"tc-permission-4\"")));
    assert!(claude_permission_accept
        .immediate
        .iter()
        .any(|line| line.contains("\"id\":4")));
    for line in claude_init
        .immediate
        .iter()
        .chain(claude_new.immediate.iter())
        .chain(claude_prompt.immediate.iter())
        .chain(claude_late_prompt.immediate.iter())
        .chain(claude_late_prompt.delayed.iter().map(|(line, _)| line))
        .chain(claude_permission_prompt.immediate.iter())
        .chain(claude_permission_accept.immediate.iter())
    {
        serde_json::from_str::<serde_json::Value>(line).expect("claude mock line is json");
    }
}

#[test]
fn rs19b_fixture_replay_does_not_match_different_prompt_params() {
    let fixture = include_str!(
        "../../../../src/lib/features/agent-runtime/adapters/__fixtures__/claude-acp/claude-prompt-update-stream.jsonl"
    );
    let script = super::mock_fixture_response_script(
        fixture,
        r#"{"jsonrpc":"2.0","id":99,"method":"session/prompt","params":{"sessionId":"s-mock","prompt":[{"type":"text","text":"different"}]}}"#,
        true,
    );

    assert!(script.is_none());
}

#[test]
fn rs19c_fixture_replay_remaps_claude_session_load_session_id() {
    let mut claude_turn_seq = 0;
    let script = super::mock_jsonrpc_response_script(
        "claude",
        "/home/tester/work",
        r#"{"jsonrpc":"2.0","id":77,"method":"session/load","params":{"sessionId":"sess-custom","cwd":"/home/tester/work","mcpServers":[],"additionalDirectories":[]}}"#,
        &mut claude_turn_seq,
    );

    assert!(
        script
            .immediate
            .iter()
            .all(|line| !line.contains("\"sessionId\":\"sess-1\"")),
        "fixture-local session id must not leak into replay output: {:?}",
        script.immediate
    );
    assert!(
        script
            .immediate
            .iter()
            .any(|line| line.contains("\"sessionId\":\"sess-custom\"")),
        "replay output should target the requested session id: {:?}",
        script.immediate
    );
    assert!(script.immediate[2].contains("\"id\":77"));
}

#[test]
fn rs20_snapshot_from_test_state() {
    let (state, id) = super::test_state_with_runtime("codex");
    let snap = super::get_snapshot(&state, id).expect("snapshot");
    assert_eq!(snap.runtime_id, id);
    assert_eq!(snap.provider, "codex");
    assert_eq!(snap.status, "running");
    assert_eq!(snap.pending_request_ids, vec!["7".to_string()]);
    assert!(snap.exited_at.is_none());
}

// ───────────────────────── RS-21..RS-25: serde round-trip ─────────────────────────

#[test]
fn rs21_start_params_camelcase_field_roundtrip() {
    let json = r#"{"transportKind":"jsonrpc-stdio","provider":"codex","distro":"Ubuntu","workDir":"/home/x","args":["app-server","--stdio"],"env":{"RUST_LOG":"info"}}"#;
    let parsed: AgentRuntimeStartParams = serde_json::from_str(json).expect("parse");
    let reser = serde_json::to_value(&parsed).expect("ser");
    assert_eq!(reser["workDir"], "/home/x");
    assert_eq!(reser["transportKind"], "jsonrpc-stdio");
    assert!(reser.get("work_dir").is_none());
}

#[test]
fn rs22_cancel_target_camelcase_roundtrip() {
    let req: AgentRuntimeCancelTarget =
        serde_json::from_str(r#"{"type":"request","requestId":"7"}"#).unwrap();
    assert_eq!(serde_json::to_value(&req).unwrap()["requestId"], "7");

    let turn: AgentRuntimeCancelTarget =
        serde_json::from_str(r#"{"type":"turn","turnId":"t1"}"#).unwrap();
    assert_eq!(serde_json::to_value(&turn).unwrap()["turnId"], "t1");

    let proc: AgentRuntimeCancelTarget = serde_json::from_str(r#"{"type":"process"}"#).unwrap();
    assert_eq!(serde_json::to_value(&proc).unwrap()["type"], "process");
}

#[test]
fn rs23_event_camelcase_roundtrip() {
    let ev = AgentRuntimeEvent::Backpressure {
        runtime_id: 3,
        dropped_messages: 512,
    };
    let v = serde_json::to_value(&ev).unwrap();
    assert_eq!(v["runtimeId"], 3);
    assert_eq!(v["droppedMessages"], 512);
    assert_eq!(v["type"], "backpressure");

    let exit = AgentRuntimeEvent::Exit {
        runtime_id: 1,
        code: Some(0),
        signal: None,
    };
    let v = serde_json::to_value(&exit).unwrap();
    assert_eq!(v["runtimeId"], 1);
    assert_eq!(v["code"], 0);
    assert!(v.get("signal").is_none());
}

#[test]
fn rs24_jsonrpc_message_untagged_roundtrip() {
    // (a) Codex: jsonrpc 생략, request.
    let req: JsonRpcMessage =
        serde_json::from_str(r#"{"id":1,"method":"initialize","params":{}}"#).unwrap();
    let v = serde_json::to_value(&req).unwrap();
    assert_eq!(v["method"], "initialize");
    assert!(v.get("jsonrpc").is_none());

    // (b) ACP: jsonrpc:"2.0", notification.
    let notif: JsonRpcMessage =
        serde_json::from_str(r#"{"jsonrpc":"2.0","method":"initialized"}"#).unwrap();
    let v = serde_json::to_value(&notif).unwrap();
    assert_eq!(v["jsonrpc"], "2.0");
    assert_eq!(v["method"], "initialized");

    // response.
    let resp: JsonRpcMessage = serde_json::from_str(r#"{"id":1,"result":{"ok":true}}"#).unwrap();
    assert_eq!(serde_json::to_value(&resp).unwrap()["result"]["ok"], true);

    // error.
    let err: JsonRpcMessage =
        serde_json::from_str(r#"{"id":2,"error":{"code":-32601,"message":"nope"}}"#).unwrap();
    let v = serde_json::to_value(&err).unwrap();
    assert_eq!(v["error"]["code"], -32601);
    assert_eq!(v["error"]["message"], "nope");
}

#[test]
fn rs25_snapshot_struct_roundtrip() {
    let snap = AgentRuntimeSnapshot {
        runtime_id: 4,
        provider: "claude".to_string(),
        status: "running".to_string(),
        started_at: 1234,
        exited_at: None,
        pending_request_ids: vec!["a".to_string()],
    };
    let v = serde_json::to_value(&snap).unwrap();
    assert_eq!(v["runtimeId"], 4);
    assert_eq!(v["startedAt"], 1234);
    assert_eq!(v["pendingRequestIds"][0], "a");
    assert!(v.get("exitedAt").is_none());
    let back: AgentRuntimeSnapshot = serde_json::from_value(v).unwrap();
    assert_eq!(back.runtime_id, 4);
}

//! Direct Agent Runtime — framing·serde round-trip·allowlist·snapshot 단위 테스트(BE §8.1, 11 §5).
//!
//! 정본: `11-testing-acceptance.md` §5 RS-* 케이스. framing(RS-1..5), allowlist(RS-8..12c),
//! serde round-trip(RS-21..25), snapshot(RS-20)을 다룬다. emit이 필요한 케이스(backpressure/exit emit)는
//! AppHandle이 필요하므로 E2E/통합으로 미루고, 여기서는 순수 로직을 검증한다.

use super::allowlist::{is_valid_env_key, validate_and_extract};
use super::process::{build_wsl_command, canonicalize_wsl_path};
use super::transport::{classify_line, extract_complete_lines, LineClass};
use super::types::{
    AgentRuntimeCancelTarget, AgentRuntimeEvent, AgentRuntimeSnapshot, AgentRuntimeStartParams,
    JsonRpcMessage,
};
use crate::features::terminal::parsing::decode_utf8_stream_chunk;
use std::collections::HashMap;

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

fn stdio(provider: &str, args: &[&str], env: Option<HashMap<String, String>>) -> AgentRuntimeStartParams {
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
    line_buf.push_str(&decode_utf8_stream_chunk(&mut pending, &bytes[..mid], false));
    let early = extract_complete_lines(&mut line_buf); // 아직 개행 전 → 없음 가능
    line_buf.push_str(&decode_utf8_stream_chunk(&mut pending, &bytes[mid..], false));
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
    assert!(validate_and_extract(&stdio("codex", &["app-server"], None), ok_exe, ok_entry).is_err());
    assert!(validate_and_extract(
        &stdio("codex", &["app-server", "--stdio", "--extra"], None),
        ok_exe,
        ok_entry
    )
    .is_err());
}

#[test]
fn rs9_claude_trusted_entry_allowed_and_resolves_node() {
    let entry = "/opt/node_modules/@agentclientprotocol/claude-agent-acp/dist/index.js";
    let launch =
        validate_and_extract(&stdio("claude", &[entry], None), ok_exe, ok_entry).expect("claude ok");
    assert_eq!(launch.executable, "/usr/bin/node");
    assert_eq!(launch.argv, vec![entry]);
}

#[test]
fn rs9b_claude_untrusted_or_multi_args_rejected() {
    // 임의 .js
    assert!(validate_and_extract(&stdio("claude", &["/tmp/x.js"], None), ok_exe, ok_entry).is_err());
    // args.length != 1
    let entry = "/opt/node_modules/@agentclientprotocol/claude-agent-acp/dist/index.js";
    assert!(validate_and_extract(&stdio("claude", &[entry, "--x"], None), ok_exe, ok_entry).is_err());
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
    env.insert("CLAUDE_CONFIG_DIR".to_string(), "/home/tester/.claude".to_string());
    let entry = "/opt/node_modules/@agentclientprotocol/claude-agent-acp/dist/index.js";
    assert!(validate_and_extract(&stdio("claude", &[entry], Some(env)), ok_exe, ok_entry).is_ok());
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
    let params = AgentRuntimeStartParams::Websocket {
        provider: "codex".to_string(),
        distro: "Ubuntu".to_string(),
        work_dir: "/x".to_string(),
        url: "ws://localhost:1234".to_string(),
        auth_token: Some("secret-xyz".to_string()),
    };
    let err = validate_and_extract(&params, ok_exe, ok_entry).unwrap_err();
    // 에러 문자열에 authToken 값이 평문으로 실리지 않음(reject-before-log, D-WSAUTH).
    assert!(!err.contains("secret-xyz"));
    assert_eq!(err, "only jsonrpc-stdio transport is supported in v1");
}

#[test]
fn rs8_path_windows_and_relative_rejected() {
    assert!(canonicalize_wsl_path("C:\\Users").is_err());
    assert!(canonicalize_wsl_path("relative").is_err());
    assert_eq!(canonicalize_wsl_path("/home/x//y/").unwrap(), "/home/x/y");
}

// ───────────────────────── AC-10b: spawn argv 조립(secret 비경유) ─────────────────────────

#[test]
fn ac10b_secret_env_not_in_argv_but_in_wslenv() {
    let mut non_secret = HashMap::new();
    non_secret.insert("RUST_LOG".to_string(), "info".to_string());
    let mut secret = HashMap::new();
    secret.insert("ANTHROPIC_API_KEY".to_string(), "sk-super-secret".to_string());

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
fn rs10e_caching_resolver_returns_absolute_and_reresolves_after_clear() {
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
            Ok("/opt/acp/dist/index.js".to_string())
        }
    }

    let calls = Arc::new(AtomicU32::new(0));
    let resolver = CachingResolver::new(Box::new(CountingResolver {
        calls: calls.clone(),
    }));

    // 1차 resolve → 절대경로 + inner 호출 1회.
    let p1 = resolver.resolve_adapter_entry("claude", "Ubuntu").unwrap();
    assert!(p1.starts_with('/'));
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    // 캐시 hit → inner 미호출.
    let _ = resolver.resolve_adapter_entry("claude", "Ubuntu").unwrap();
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    // 무효화 후 재탐색(stale 미반환).
    resolver.clear();
    let _ = resolver.resolve_adapter_entry("claude", "Ubuntu").unwrap();
    assert_eq!(calls.load(Ordering::SeqCst), 2);
}

// ───────────────────────── RS-20: snapshot ─────────────────────────

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

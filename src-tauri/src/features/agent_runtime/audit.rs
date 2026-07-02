//! Direct Agent Runtime — backend audit helpers.
//!
//! process spawn 전 거부되는 실패도 보안 추적 대상이다. 이 모듈은 renderer 입력 전체를 저장하지 않고,
//! provider/transport/reason 같은 최소 메타만 redaction 후 JSONL로 남긴다.

use super::process::now_millis;
use super::transport::redact;
use super::types::AgentRuntimeStartParams;
use crate::app_env::{ensure_parent_dir, state_path};
use std::fs::OpenOptions;
use std::io::Write;

const AGENT_RUNTIME_AUDIT_LOG_FILE: &str = "agent-runtime-audit.log";

/// launch 거부 audit entry를 redacted JSONL로 기록한다.
pub(crate) fn write_launch_rejection_audit(
    params: &AgentRuntimeStartParams,
    reason: &str,
) -> Result<(), String> {
    let path = state_path(AGENT_RUNTIME_AUDIT_LOG_FILE)?;
    ensure_parent_dir(&path)?;
    let entry = serde_json::json!({
        "event": "launchRejected",
        "atMs": now_millis(),
        "transportKind": transport_kind(params),
        "provider": redact(provider_hint(params)),
        "reason": redact(reason),
    });
    let encoded = serde_json::to_string(&entry).map_err(|e| e.to_string())?;
    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|e| e.to_string())?;
    writeln!(file, "{encoded}").map_err(|e| e.to_string())
}

/// params 전체를 직렬화하지 않고 provider 필드만 추출한다.
fn provider_hint(params: &AgentRuntimeStartParams) -> &str {
    match params {
        AgentRuntimeStartParams::JsonrpcStdio { provider, .. }
        | AgentRuntimeStartParams::Websocket { provider, .. } => provider,
    }
}

/// audit용 transport kind. secret-bearing variant도 정적 문자열만 남긴다.
fn transport_kind(params: &AgentRuntimeStartParams) -> &'static str {
    match params {
        AgentRuntimeStartParams::JsonrpcStdio { .. } => "jsonrpc-stdio",
        AgentRuntimeStartParams::Websocket { .. } => "websocket",
    }
}

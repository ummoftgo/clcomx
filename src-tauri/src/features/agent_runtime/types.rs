//! Direct Agent Runtime — 15 §8 Rust 미러 타입(serde camelCase).
//!
//! 정본: `docs/plans/agent-direct-runtime/15-data-contracts.md` §8.1/§8.2/§8.3.
//! 이 모듈은 Tauri command/event 경계를 넘는 wire 타입을 정의한다. TS 측(`service/transport.ts`)과
//! 1:1 미러링하며, enum variant 필드는 `#[serde(rename_all_fields = "camelCase")]`로 camelCase 직렬화한다
//! (serde 1.0.228 ≥ 1.0.181, OQ-37 해소). struct 미러는 struct 레벨 `rename_all`로 필드까지 적용된다.

use serde::{Deserialize, Serialize};

/// runtime 식별자. 15 §8.1 `RuntimeId = number`와 동일하며 PTY 세션 id 공간과 분리한다.
pub type RuntimeId = u32;

/// JSON-RPC error 객체(15 §8.1). struct이므로 struct 레벨 rename_all로 충분하다.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JsonRpcError {
    /// JSON-RPC error code.
    pub code: i64,
    /// 사람이 읽는 에러 메시지.
    pub message: String,
    /// provider-specific 부가 데이터(선택).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub data: Option<serde_json::Value>,
}

/// JSON-RPC 메시지 4종(15 §8.1). serde untagged로 표현하며 `jsonrpc`는 Codex가 생략하므로 Option.
///
/// S2: variant 내부 필드를 camelCase로 직렬화하기 위해 `rename_all_fields`를 명시한다. 본 enum의 필드명
/// (jsonrpc/id/method/params/result/error)은 단일어라 동작 변화는 없으나 다른 미러와 일관성을 유지한다.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(untagged, rename_all_fields = "camelCase")]
pub enum JsonRpcMessage {
    /// request: id + method 동시 존재.
    Request {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        jsonrpc: Option<String>,
        id: serde_json::Value, // string | number | null
        method: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        params: Option<serde_json::Value>,
    },
    /// notification: id 없음.
    Notification {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        jsonrpc: Option<String>,
        method: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        params: Option<serde_json::Value>,
    },
    /// response: id + result.
    Response {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        jsonrpc: Option<String>,
        id: serde_json::Value,
        result: serde_json::Value,
    },
    /// error: id + error.
    Error {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        jsonrpc: Option<String>,
        id: serde_json::Value,
        error: JsonRpcError,
    },
}

/// process/transport 기동 파라미터(15 §8.1). S1 정본: renderer는 executable command를 넘기지 않고,
/// backend가 provider로 신뢰 절대경로를 resolve한다. 따라서 본 타입에 `command` 필드는 없다.
///
/// S2: variant 필드 `work_dir`/`auth_token`을 `workDir`/`authToken`으로 직렬화하려면 enum 레벨
/// `rename_all = "kebab-case"`(variant 이름만)만으로는 부족하므로 `rename_all_fields = "camelCase"`를 추가한다.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(
    tag = "transportKind",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase"
)]
pub enum AgentRuntimeStartParams {
    /// v1 유일 구현. stdio piped child로 provider process를 띄운다.
    #[serde(rename = "jsonrpc-stdio")]
    JsonrpcStdio {
        /// "codex" | "claude". backend가 enum 검증.
        provider: String,
        /// WSL distro 이름.
        distro: String,
        /// WSL absolute path(spawn 직전 canonicalize). → "workDir".
        work_dir: String,
        /// provider별 정확 검증 대상(codex=["app-server","--stdio"], claude=[adapterEntryPath]).
        args: Vec<String>,
        /// non-secret 전용 env. key allowlist로 재검증된다.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        env: Option<std::collections::HashMap<String, String>>,
    },
    /// future-sketch — v1 미사용. handler가 로깅/스냅샷 노출 전에 reject(D-WSAUTH). 타입만 유지한다.
    #[serde(rename = "websocket")]
    Websocket {
        provider: String,
        distro: String,
        /// → "workDir".
        work_dir: String,
        url: String,
        /// → "authToken". v1 미사용 — redaction 집합(09 §5.1), reject-before-log(07 §8.1).
        #[serde(default, skip_serializing_if = "Option::is_none")]
        auth_token: Option<String>,
    },
}

/// cancel 대상(15 §8.1). request=approval 요청, turn=진행 turn, process=전체.
///
/// S2: variant 필드 `request_id`/`turn_id`를 `requestId`/`turnId`로 직렬화하려면 `rename_all_fields` 필요.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum AgentRuntimeCancelTarget {
    /// approval 요청 취소. → "requestId".
    Request { request_id: String },
    /// 진행 turn 취소. → "turnId".
    Turn { turn_id: String },
    /// 전체 process 종료.
    Process,
}

/// runtime 상태 스냅샷(15 §8.1, late-attach/진단용). struct 레벨 rename_all로 필드까지 camelCase.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentRuntimeSnapshot {
    pub runtime_id: RuntimeId,
    /// "codex" | "claude".
    pub provider: String,
    /// "starting" | "running" | "exited" | "failed"(transport-level 상태).
    pub status: String,
    pub started_at: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub exited_at: Option<i64>,
    pub pending_request_ids: Vec<String>,
}

/// Rust emit payload 미러(15 §8.3). frontend `listen`이 받는다.
///
/// S2: variant 필드 `runtime_id`/`dropped_messages`를 `runtimeId`/`droppedMessages`로 직렬화하려면
/// `rename_all_fields` 필요(tag/variant rename_all만으로는 필드명이 snake_case로 남아 역직렬화가 깨진다).
/// M-4: `Message.message`는 Rust `serde_json::Value`로 무손실 통과시키고, TS는 `JsonRpcMessage`로 받는다
/// (`JsonRpcMessage`가 untagged라 동일 JSON이므로 비대칭이어도 wire-compat).
#[derive(Clone, Debug, Serialize)]
#[serde(tag = "type", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum AgentRuntimeEvent {
    /// raw JSON-RPC response/notification/request. → "runtimeId"; TS는 JsonRpcMessage로 수신(M-4 비대칭).
    Message {
        runtime_id: RuntimeId,
        message: serde_json::Value,
    },
    /// stderr 로그 라인.
    Stderr { runtime_id: RuntimeId, line: String },
    /// process 종료.
    Exit {
        runtime_id: RuntimeId,
        #[serde(skip_serializing_if = "Option::is_none")]
        code: Option<i32>,
        #[serde(skip_serializing_if = "Option::is_none")]
        signal: Option<String>,
    },
    /// framing/runtime 에러.
    Error {
        runtime_id: RuntimeId,
        message: String,
        recoverable: bool,
    },
    /// bounded replay log saturation. → "droppedMessages".
    Backpressure {
        runtime_id: RuntimeId,
        dropped_messages: u64,
    },
}

/// bounded replay log 경계 상수(OQ-39 확정값). diagnostic-only bounded log 경계 유지에만 쓰이며
/// 실시간 emit은 throttle/block하지 않는다.
pub const MAX_MESSAGE_LOG_BYTES: usize = 8 * 1024 * 1024;
/// 한 라인(=한 JSON-RPC 메시지) 최대 바이트. 초과 시 recoverable framing error로 분류한다.
pub const MAX_LINE_BYTES: usize = 4 * 1024 * 1024;
/// N건 drop마다 backpressure event를 1회 emit한다.
pub const BACKPRESSURE_NOTIFY_INTERVAL: u64 = 256;

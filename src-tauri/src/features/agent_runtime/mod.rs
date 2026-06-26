//! Direct Agent Runtime — backend process/transport 런타임 모듈.
//!
//! 정본: `docs/plans/agent-direct-runtime/07-tauri-process-runtime.md`,
//! 타입은 15 §8, 등록은 BE §3.2. 이 모듈은 protocol 의미를 해석하지 않고
//! raw JSON-RPC framing/transport/lifecycle만 책임진다.
//!
//! `AgentRuntimeState`는 PTY `PtyState`와 별도(`Mutex<HashMap<RuntimeId, AgentRuntime>>` + next_id)다.
//! 동시성은 `std::thread` + `Arc<Mutex>`(tokio 미도입, OQ-25).

mod allowlist;
mod process;
pub(crate) mod resolver;
mod transport;
pub mod types;

#[cfg(test)]
mod tests;

pub use types::{
    AgentRuntimeCancelTarget, AgentRuntimeSnapshot, AgentRuntimeStartParams, JsonRpcMessage,
    RuntimeId,
};

use crate::app_env::is_test_mode;
use process::{
    canonicalize_wsl_path, kill_by_stored_pid, now_millis, spawn_wsl_process, ChildStdio, KillHandle,
};
use std::collections::{HashMap, VecDeque};
use std::io::Write;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter};
use transport::{
    spawn_child_wait, spawn_stderr_reader, spawn_stdout_reader, write_message, ReaderShared,
    RuntimeMessageRecord,
};

const SHUTDOWN_GRACE_MS: u64 = 2000;
const POLL_MS: u64 = 50;
const REAP_GRACE_MS: u64 = 1000;

/// 한 direct agent process의 backend 핸들. PtySession과 동형.
struct AgentRuntime {
    /// "codex" | "claude"(allowlist·로깅용).
    provider: String,
    /// kill 전용 식별자. ChildHandle 자체는 wait 전용 thread가 소유한다(§5.3 정본).
    /// mock runtime은 child가 없으므로 None.
    kill_handle: Option<KillHandle>,
    /// stdin writer. agent_runtime_send가 잠가 write(§6.2).
    stdin: Arc<Mutex<Option<Box<dyn Write + Send>>>>,
    /// diagnostic-only bounded replay log(D-REPLAYLOG, §7.2).
    #[allow(dead_code)]
    message_log: Arc<Mutex<VecDeque<RuntimeMessageRecord>>>,
    /// 단조 증가 message seq(1-based).
    #[allow(dead_code)]
    message_seq: Arc<AtomicU64>,
    /// 진단용 pending request id 집합(의미 해석 없음, §6.4). v1은 비어 있을 수 있다.
    pending_request_ids: Arc<Mutex<Vec<String>>>,
    /// status: "starting" | "running" | "exited" | "failed".
    status: Arc<Mutex<String>>,
    started_at: i64,
    exited_at: Arc<Mutex<Option<i64>>>,
    exited: Arc<AtomicBool>,
    /// bounded replay log 누적 drop 카운트.
    #[allow(dead_code)]
    dropped_messages: Arc<AtomicU64>,
}

/// direct runtime 전역 상태. PTY와 별도 RuntimeId 공간.
#[derive(Default)]
pub struct AgentRuntimeState {
    runtimes: Mutex<HashMap<RuntimeId, AgentRuntime>>,
    next_id: Mutex<RuntimeId>,
}

/// RuntimeId 발급(lock 후 += 1, PTY next_session_id 동형).
fn next_runtime_id(state: &AgentRuntimeState) -> Result<RuntimeId, String> {
    let mut id = state.next_id.lock().map_err(|e| e.to_string())?;
    *id += 1;
    Ok(*id)
}

fn insert_runtime(
    state: &AgentRuntimeState,
    id: RuntimeId,
    runtime: AgentRuntime,
) -> Result<(), String> {
    state
        .runtimes
        .lock()
        .map_err(|e| e.to_string())?
        .insert(id, runtime);
    Ok(())
}

/// 새 direct agent process를 띄운다(§5.1). test-mode면 mock 경로로 분기한다.
pub fn start(
    state: &AgentRuntimeState,
    app: &AppHandle,
    params: AgentRuntimeStartParams,
) -> Result<RuntimeId, String> {
    // 1) test-mode 분기(§10).
    if is_test_mode() {
        return start_mock(state, app, params);
    }
    // 2) allowlist 검증(§8). websocket 등 비-stdio는 params 로깅 없이 reject(D-WSAUTH).
    //    executable은 backend가 provider로 resolve한 신뢰 절대경로(S1).
    let launch = allowlist::validate_and_extract(
        &params,
        resolver::resolve_trusted_executable,
        resolver::resolve_trusted_adapter_entry,
    )?;
    // 3) path canonicalize(§9).
    let work_dir = canonicalize_wsl_path(&launch.work_dir)?;
    // 4) spawn — non-secret은 argv(`-e env`), secret은 Command::env()+WSLENV(C1).
    let (child, stdio) = spawn_wsl_process(
        &launch.distro,
        &launch.executable,
        &launch.argv,
        &work_dir,
        &launch.non_secret_env,
        &launch.secret_env,
    )?;
    // 5) RuntimeId 발급 + AgentRuntime 구성.
    let id = next_runtime_id(state)?;
    let kill_handle = KillHandle { pid: child.pid };
    let ChildStdio {
        stdin,
        stdout,
        stderr,
    } = stdio;

    let message_log = Arc::new(Mutex::new(VecDeque::new()));
    let message_seq = Arc::new(AtomicU64::new(0));
    let dropped_messages = Arc::new(AtomicU64::new(0));
    let exited = Arc::new(AtomicBool::new(false));
    let exited_at = Arc::new(Mutex::new(None));
    let status = Arc::new(Mutex::new("running".to_string()));

    let runtime = AgentRuntime {
        provider: launch.provider.clone(),
        kill_handle: Some(kill_handle),
        stdin: Arc::new(Mutex::new(Some(Box::new(stdin) as Box<dyn Write + Send>))),
        message_log: message_log.clone(),
        message_seq: message_seq.clone(),
        pending_request_ids: Arc::new(Mutex::new(Vec::new())),
        status: status.clone(),
        started_at: now_millis(),
        exited_at: exited_at.clone(),
        exited: exited.clone(),
        dropped_messages: dropped_messages.clone(),
    };

    // 6) reader/stderr/child-wait thread 3개 spawn(§4.2·§4.3·§5.3).
    let shared = ReaderShared {
        message_log,
        message_seq,
        dropped_messages,
        exited: exited.clone(),
    };
    spawn_stdout_reader(app.clone(), id, Box::new(stdout), shared);
    spawn_stderr_reader(app.clone(), id, Box::new(stderr));
    spawn_child_wait(app.clone(), id, child, exited, exited_at, status);

    // 7) 상태 등록(process는 떴음; protocol initialize는 frontend adapter가 별도로 수행).
    insert_runtime(state, id, runtime)?;
    Ok(id)
}

/// stdin write(§6.2). backend는 message가 request/notification/response인지 검사하지 않는다.
pub fn send(
    state: &AgentRuntimeState,
    runtime_id: RuntimeId,
    message: JsonRpcMessage,
) -> Result<(), String> {
    let stdin = {
        let runtimes = state.runtimes.lock().map_err(|e| e.to_string())?;
        let rt = runtimes.get(&runtime_id).ok_or("runtime not found")?;
        rt.stdin.clone()
    };
    write_message(&stdin, &message)
}

/// cancel(§6.3). backend는 process만 직접 처리하고 request/turn은 no-op(frontend adapter가 wire 전송).
pub fn cancel(
    state: &AgentRuntimeState,
    _app: &AppHandle,
    runtime_id: RuntimeId,
    target: AgentRuntimeCancelTarget,
) -> Result<(), String> {
    match target {
        AgentRuntimeCancelTarget::Process => shutdown(state, runtime_id),
        AgentRuntimeCancelTarget::Request { request_id } => {
            // 진단용: pending 집합에서 제거(선택). 실제 cancel wire는 frontend가 send.
            remove_pending(state, runtime_id, &request_id);
            Ok(())
        }
        AgentRuntimeCancelTarget::Turn { .. } => Ok(()), // frontend adapter가 cancel 전송.
    }
}

/// 진단용 pending id 제거(없어도 무방).
fn remove_pending(state: &AgentRuntimeState, runtime_id: RuntimeId, request_id: &str) {
    if let Ok(runtimes) = state.runtimes.lock() {
        if let Some(rt) = runtimes.get(&runtime_id) {
            if let Ok(mut pending) = rt.pending_request_ids.lock() {
                pending.retain(|id| id != request_id);
            }
        }
    }
}

/// graceful shutdown(§5.2, authoritative cleanup 경계). stdin EOF → grace → kill → child reap → teardown.
pub fn shutdown(state: &AgentRuntimeState, runtime_id: RuntimeId) -> Result<(), String> {
    // kill_handle은 kill 전용 식별자. ChildHandle은 wait thread가 소유하므로 여기서 다시 잠그지 않는다.
    let (stdin, kill_handle, exited) = {
        let runtimes = state.runtimes.lock().map_err(|e| e.to_string())?;
        let rt = runtimes.get(&runtime_id).ok_or("runtime not found")?;
        (rt.stdin.clone(), rt.kill_handle.clone(), rt.exited.clone())
    };

    // 1) stdin drop → EOF(provider가 정상 종료하도록).
    if let Ok(mut guard) = stdin.lock() {
        guard.take(); // Box<dyn Write> drop → pipe close.
    }

    // 2~3) grace polling.
    let mut waited = 0u64;
    while waited < SHUTDOWN_GRACE_MS {
        if exited.load(Ordering::SeqCst) {
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(POLL_MS));
        waited += POLL_MS;
    }

    // 4) 여전히 살아있으면 저장된 pid/handle로 강제 종료(wait thread와 lock 경쟁 없음).
    if !exited.load(Ordering::SeqCst) {
        if let Some(handle) = &kill_handle {
            kill_by_stored_pid(handle);
        }
    }

    // 5) S3: child reap 보장 — kill 후 wait thread가 reap + exit emit을 끝내(exited=true)도록 대기.
    let mut reap_waited = 0u64;
    while !exited.load(Ordering::SeqCst) && reap_waited < REAP_GRACE_MS {
        std::thread::sleep(std::time::Duration::from_millis(POLL_MS));
        reap_waited += POLL_MS;
    }

    // 6) teardown — reap 확인 후에만 제거·Ok 반환. reap 실패(exited=false) 시 runtime을 제거하지 않고 Err.
    if !exited.load(Ordering::SeqCst) {
        return Err("shutdown: child not reaped within REAP_GRACE_MS".into());
    }
    state
        .runtimes
        .lock()
        .map_err(|e| e.to_string())?
        .remove(&runtime_id);
    Ok(())
}

/// runtime 상태 스냅샷(§6.5). late-attach 진단용.
pub fn get_snapshot(
    state: &AgentRuntimeState,
    runtime_id: RuntimeId,
) -> Result<AgentRuntimeSnapshot, String> {
    let runtimes = state.runtimes.lock().map_err(|e| e.to_string())?;
    let rt = runtimes.get(&runtime_id).ok_or("runtime not found")?;
    let status = rt.status.lock().map_err(|e| e.to_string())?.clone();
    let exited_at = *rt.exited_at.lock().map_err(|e| e.to_string())?;
    let pending_request_ids = rt
        .pending_request_ids
        .lock()
        .map_err(|e| e.to_string())?
        .clone();
    Ok(AgentRuntimeSnapshot {
        runtime_id,
        provider: rt.provider.clone(),
        status,
        started_at: rt.started_at,
        exited_at,
        pending_request_ids,
    })
}

// ───────────────────────── test-mode mock(§10) ─────────────────────────

/// in-memory sink writer. mock runtime의 stdin 대용.
struct NullSink;
impl Write for NullSink {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        Ok(buf.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

/// test-mode start. 실제 process 없이 mock JSON-RPC 스트림을 시간차 emit한다(§10.1).
fn start_mock(
    state: &AgentRuntimeState,
    app: &AppHandle,
    params: AgentRuntimeStartParams,
) -> Result<RuntimeId, String> {
    let provider = mock_provider(&params)?;
    let id = next_runtime_id(state)?;
    let runtime = AgentRuntime {
        provider: provider.clone(),
        kill_handle: None,
        stdin: Arc::new(Mutex::new(Some(Box::new(NullSink) as Box<dyn Write + Send>))),
        message_log: Arc::new(Mutex::new(VecDeque::new())),
        message_seq: Arc::new(AtomicU64::new(0)),
        pending_request_ids: Arc::new(Mutex::new(Vec::new())),
        status: Arc::new(Mutex::new("running".to_string())),
        started_at: now_millis(),
        exited_at: Arc::new(Mutex::new(None)),
        exited: Arc::new(AtomicBool::new(false)),
        dropped_messages: Arc::new(AtomicU64::new(0)),
    };
    insert_runtime(state, id, runtime)?;

    let app2 = app.clone();
    let provider2 = provider.clone();
    std::thread::spawn(move || {
        for (line, delay_ms) in mock_jsonrpc_script(&provider2) {
            std::thread::sleep(std::time::Duration::from_millis(delay_ms));
            if let Ok(value) = serde_json::from_str::<serde_json::Value>(&line) {
                let _ = app2.emit(
                    "agent-runtime-message",
                    types::AgentRuntimeEvent::Message {
                        runtime_id: id,
                        message: value,
                    },
                );
            }
        }
        let _ = app2.emit(
            "agent-runtime-exit",
            types::AgentRuntimeEvent::Exit {
                runtime_id: id,
                code: Some(0),
                signal: None,
            },
        );
    });
    Ok(id)
}

/// mock provider 추출. websocket variant는 여기서도 reject(token 비로깅).
fn mock_provider(params: &AgentRuntimeStartParams) -> Result<String, String> {
    match params {
        AgentRuntimeStartParams::JsonrpcStdio { provider, .. } => Ok(provider.clone()),
        AgentRuntimeStartParams::Websocket { .. } => {
            Err("only jsonrpc-stdio transport is supported in v1".into())
        }
    }
}

/// provider별 최소 가짜 JSON-RPC 라인 시퀀스(line, delay_ms). T0.5 fixture 최소 시나리오 대응.
fn mock_jsonrpc_script(provider: &str) -> Vec<(String, u64)> {
    match provider {
        "codex" => vec![
            (
                r#"{"id":1,"result":{"userAgent":"codex","capabilities":{}}}"#.to_string(),
                5,
            ),
            (
                r#"{"method":"thread/started","params":{"thread":{"id":"t-mock","sessionId":"s-mock","cwd":"/home/tester"}}}"#
                    .to_string(),
                5,
            ),
        ],
        _ => vec![
            (
                r#"{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":1,"agentCapabilities":{}}}"#
                    .to_string(),
                5,
            ),
            (
                r#"{"jsonrpc":"2.0","id":2,"result":{"sessionId":"s-mock"}}"#.to_string(),
                5,
            ),
        ],
    }
}

#[cfg(test)]
pub(crate) fn test_state_with_runtime(provider: &str) -> (AgentRuntimeState, RuntimeId) {
    let state = AgentRuntimeState::default();
    let id = next_runtime_id(&state).expect("next id");
    let runtime = AgentRuntime {
        provider: provider.to_string(),
        kill_handle: None,
        stdin: Arc::new(Mutex::new(Some(Box::new(NullSink) as Box<dyn Write + Send>))),
        message_log: Arc::new(Mutex::new(VecDeque::new())),
        message_seq: Arc::new(AtomicU64::new(0)),
        pending_request_ids: Arc::new(Mutex::new(vec!["7".to_string()])),
        status: Arc::new(Mutex::new("running".to_string())),
        started_at: now_millis(),
        exited_at: Arc::new(Mutex::new(None)),
        exited: Arc::new(AtomicBool::new(false)),
        dropped_messages: Arc::new(AtomicU64::new(0)),
    };
    insert_runtime(&state, id, runtime).expect("insert");
    (state, id)
}

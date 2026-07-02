//! Direct Agent Runtime — backend process/transport 런타임 모듈.
//!
//! 정본: `docs/plans/agent-direct-runtime/07-tauri-process-runtime.md`,
//! 타입은 15 §8, 등록은 BE §3.2. 이 모듈은 protocol 의미를 해석하지 않고
//! raw JSON-RPC framing/transport/lifecycle만 책임진다.
//!
//! `AgentRuntimeState`는 PTY `PtyState`와 별도(`Mutex<HashMap<RuntimeId, AgentRuntime>>` + next_id)다.
//! 동시성은 `std::thread` + `Arc<Mutex>`(tokio 미도입, OQ-25).

mod allowlist;
mod audit;
mod process;
pub(crate) mod resolver;
pub(crate) mod secret_store;
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
    canonicalize_wsl_path, kill_by_stored_pid, now_millis, spawn_wsl_process, ChildStdio,
    KillHandle,
};
use std::collections::{HashMap, VecDeque};
use std::io::Write;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter};
use transport::{
    spawn_child_wait, spawn_stderr_reader_with_values, spawn_stdout_reader,
    write_message_with_values, write_protocol_debug_log_with_values, ReaderShared,
    RuntimeMessageRecord,
};

const SHUTDOWN_GRACE_MS: u64 = 2000;
const POLL_MS: u64 = 50;
const REAP_GRACE_MS: u64 = 1000;

/// shutdown 대기 정책. 운영 경로는 문서 상수값을 쓰고 테스트는 짧은 값으로 S3 경계를 검증한다.
#[derive(Clone, Copy)]
pub(crate) struct ShutdownPolicy {
    /// stdin EOF 후 graceful exit를 기다리는 시간(ms).
    pub(crate) grace_ms: u64,
    /// kill 후 child wait thread의 reap 반영을 기다리는 시간(ms).
    pub(crate) reap_grace_ms: u64,
    /// polling 간격(ms). 0은 1ms로 보정한다.
    pub(crate) poll_ms: u64,
}

const DEFAULT_SHUTDOWN_POLICY: ShutdownPolicy = ShutdownPolicy {
    grace_ms: SHUTDOWN_GRACE_MS,
    reap_grace_ms: REAP_GRACE_MS,
    poll_ms: POLL_MS,
};

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
    /// stderr/debug log redaction에 추가 적용할 runtime launch env value 목록.
    redaction_values: Arc<Vec<String>>,
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
    let launch = validate_launch_for_start(
        &params,
        resolver::resolve_trusted_executable,
        resolver::resolve_trusted_adapter_entry,
    )?;
    // 3) path canonicalize(§9).
    let work_dir = canonicalize_wsl_path(&launch.work_dir).map_err(|err| {
        let _ = audit::write_launch_rejection_audit(&params, &err);
        err
    })?;
    // 4) startup preflight — cached path와 별개로 실제 executable version probe가 성공해야 spawn한다(OQ-24).
    let _provider_version = preflight_launch_for_start(
        &params,
        &launch,
        resolver::preflight_trusted_executable_version,
        resolver::preflight_trusted_claude_native_version,
    )?;
    // 5) spawn — non-secret은 argv(`-e env`), secret은 Command::env()+WSLENV(C1).
    let (child, stdio) = spawn_wsl_process(
        &launch.distro,
        &launch.executable,
        &launch.argv,
        &work_dir,
        &launch.non_secret_env,
        &launch.secret_env,
    )
    .map_err(|err| {
        let _ = audit::write_launch_rejection_audit(&params, &err);
        err
    })?;
    // 6) RuntimeId 발급 + AgentRuntime 구성.
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
    let redaction_values = Arc::new(launch_redaction_values(
        &launch.non_secret_env,
        &launch.secret_env,
    ));
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
        redaction_values: redaction_values.clone(),
    };

    // 7) reader/stderr/child-wait thread 3개 spawn(§4.2·§4.3·§5.3).
    let shared = ReaderShared {
        message_log,
        message_seq,
        dropped_messages,
        exited: exited.clone(),
        redaction_values: redaction_values.clone(),
    };
    spawn_stdout_reader(app.clone(), id, Box::new(stdout), shared);
    spawn_stderr_reader_with_values(app.clone(), id, Box::new(stderr), redaction_values);
    spawn_child_wait(app.clone(), id, child, exited, exited_at, status);

    // 8) 상태 등록(process는 떴음; protocol initialize는 frontend adapter가 별도로 수행).
    insert_runtime(state, id, runtime)?;
    Ok(id)
}

/// start 경계의 launch 검증 래퍼. 실패 사유는 renderer params 전체 없이 redacted audit에 남긴다.
pub(crate) fn validate_launch_for_start<FExe, FEntry>(
    params: &AgentRuntimeStartParams,
    resolve_exe: FExe,
    resolve_entry: FEntry,
) -> Result<allowlist::ValidatedLaunch, String>
where
    FExe: Fn(&str, &str) -> Result<String, String>,
    FEntry: Fn(&str, &str) -> Result<String, String>,
{
    allowlist::validate_and_extract(params, resolve_exe, resolve_entry).map_err(|err| {
        let _ = audit::write_launch_rejection_audit(params, &err);
        err
    })
}

/// start 직전 executable version preflight를 수행하고, 실패는 redacted launch audit에 남긴다.
pub(crate) fn preflight_launch_for_start<FPreflight, FClaudeNativePreflight>(
    params: &AgentRuntimeStartParams,
    launch: &allowlist::ValidatedLaunch,
    preflight: FPreflight,
    preflight_claude_native: FClaudeNativePreflight,
) -> Result<String, String>
where
    FPreflight: Fn(&str, &str, &str) -> Result<String, String>,
    FClaudeNativePreflight:
        Fn(&str, &str, &str, &HashMap<String, String>) -> Result<String, String>,
{
    let version =
        preflight(&launch.provider, &launch.distro, &launch.executable).map_err(|err| {
            let _ = audit::write_launch_rejection_audit(params, &err);
            err
        })?;
    let trimmed = version.trim().to_string();
    if trimmed.is_empty() {
        let err = format!(
            "{} version preflight returned empty output",
            launch.provider
        );
        let _ = audit::write_launch_rejection_audit(params, &err);
        return Err(err);
    }
    if launch.provider == "claude" {
        let adapter_entry = launch
            .argv
            .first()
            .ok_or_else(|| "claude adapter entry missing from launch argv".to_string())?;
        let native_version = preflight_claude_native(
            &launch.distro,
            &launch.executable,
            adapter_entry,
            &launch.non_secret_env,
        )
        .map_err(|err| {
            let _ = audit::write_launch_rejection_audit(params, &err);
            err
        })?;
        if native_version.trim().is_empty() {
            let err = "claude native version preflight returned empty output".to_string();
            let _ = audit::write_launch_rejection_audit(params, &err);
            return Err(err);
        }
    }
    Ok(trimmed)
}

/// stdin write(§6.2). backend는 message가 request/notification/response인지 검사하지 않는다.
pub fn send(
    state: &AgentRuntimeState,
    runtime_id: RuntimeId,
    message: JsonRpcMessage,
) -> Result<(), String> {
    let (stdin, redaction_values) = {
        let runtimes = state.runtimes.lock().map_err(|e| e.to_string())?;
        let rt = runtimes.get(&runtime_id).ok_or("runtime not found")?;
        (rt.stdin.clone(), rt.redaction_values.clone())
    };
    write_message_with_values(runtime_id, &stdin, &message, &redaction_values)
}

/// launch env value를 stderr/debug-log redaction context로 수집한다.
fn launch_redaction_values(
    non_secret_env: &HashMap<String, String>,
    secret_env: &HashMap<String, String>,
) -> Vec<String> {
    let mut values = Vec::new();
    for value in non_secret_env.values().chain(secret_env.values()) {
        if !value.is_empty() && !values.contains(value) {
            values.push(value.clone());
        }
    }
    values
}

/// start params에서 test-mode/mock용 redaction context를 추출한다.
fn start_params_redaction_values(params: &AgentRuntimeStartParams) -> Arc<Vec<String>> {
    let AgentRuntimeStartParams::JsonrpcStdio { env, .. } = params else {
        return Arc::new(Vec::new());
    };
    let Some(env) = env else {
        return Arc::new(Vec::new());
    };
    let empty = HashMap::new();
    Arc::new(launch_redaction_values(env, &empty))
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
    shutdown_with_policy(
        state,
        runtime_id,
        DEFAULT_SHUTDOWN_POLICY,
        kill_by_stored_pid,
    )
}

/// shutdown 정책과 kill 함수를 주입해 S3 reap 경계를 테스트 가능하게 만든 내부 구현.
pub(crate) fn shutdown_with_policy<K>(
    state: &AgentRuntimeState,
    runtime_id: RuntimeId,
    policy: ShutdownPolicy,
    mut kill: K,
) -> Result<(), String>
where
    K: FnMut(&KillHandle),
{
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
    wait_until_exited(&exited, policy.grace_ms, policy.poll_ms);

    // 4) 여전히 살아있으면 저장된 pid/handle로 강제 종료(wait thread와 lock 경쟁 없음).
    if !exited.load(Ordering::SeqCst) {
        if let Some(handle) = &kill_handle {
            kill(handle);
        }
    }

    // 5) S3: child reap 보장 — kill 후 wait thread가 reap + exit emit을 끝내(exited=true)도록 대기.
    wait_until_exited(&exited, policy.reap_grace_ms, policy.poll_ms);

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

/// `exited` 플래그가 set되거나 timeout이 끝날 때까지 std-thread polling으로 대기한다.
fn wait_until_exited(exited: &AtomicBool, timeout_ms: u64, poll_ms: u64) {
    let poll_ms = poll_ms.max(1);
    let mut waited = 0u64;
    while waited < timeout_ms {
        if exited.load(Ordering::SeqCst) {
            break;
        }
        let sleep_ms = poll_ms.min(timeout_ms - waited);
        std::thread::sleep(std::time::Duration::from_millis(sleep_ms));
        waited += sleep_ms;
    }
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

const MOCK_FAIL_ENV: &str = "CLCOMX_AGENT_RUNTIME_MOCK_FAIL";
const CODEX_INITIALIZE_FIXTURE_JSONL: &str = include_str!(
    "../../../../src/lib/features/agent-runtime/adapters/__fixtures__/codex/codex-initialize.jsonl"
);
const CLAUDE_INITIALIZE_FIXTURE_JSONL: &str = include_str!(
    "../../../../src/lib/features/agent-runtime/adapters/__fixtures__/claude-acp/claude-initialize.jsonl"
);
const CLAUDE_INITIALIZE_SESSION_NEW_FIXTURE_JSONL: &str = include_str!(
    "../../../../src/lib/features/agent-runtime/adapters/__fixtures__/claude-acp/claude-initialize-session-new.jsonl"
);
const CLAUDE_SESSION_LOAD_REPLAY_FIXTURE_JSONL: &str = include_str!(
    "../../../../src/lib/features/agent-runtime/adapters/__fixtures__/claude-acp/claude-session-load-replay.jsonl"
);
const CLAUDE_PERMISSION_REQUEST_ID_OFFSET: u64 = 8000;

/// test-mode direct runtime의 stdin 대용 writer. client JSON-RPC 요청을 받아 provider별 mock 응답을 emit한다.
struct MockSink {
    app: AppHandle,
    runtime_id: RuntimeId,
    provider: String,
    work_dir: String,
    redaction_values: Arc<Vec<String>>,
    message_seq: Arc<AtomicU64>,
    line_buf: String,
    turn_seq: u64,
}

impl MockSink {
    /// mock sink를 생성해 runtime id/provider/workDir별 응답 상태를 보관한다.
    fn new(
        app: AppHandle,
        runtime_id: RuntimeId,
        provider: String,
        work_dir: String,
        redaction_values: Arc<Vec<String>>,
        message_seq: Arc<AtomicU64>,
    ) -> Self {
        Self {
            app,
            runtime_id,
            provider,
            work_dir,
            redaction_values,
            message_seq,
            line_buf: String::new(),
            turn_seq: 0,
        }
    }

    /// compact JSON-RPC 한 줄을 provider별 mock 응답 script로 변환해 emit한다.
    fn handle_line(&mut self, line: String) {
        let should_emit_post_start_fatal =
            mock_should_emit_post_start_fatal_error(&self.provider, &line);
        let script =
            mock_jsonrpc_response_script(&self.provider, &self.work_dir, &line, &mut self.turn_seq);
        for response in script.immediate {
            emit_mock_jsonrpc_line(
                &self.app,
                self.runtime_id,
                response,
                &self.redaction_values,
                &self.message_seq,
            );
        }
        if !script.delayed.is_empty() {
            let app = self.app.clone();
            let runtime_id = self.runtime_id;
            let redaction_values = self.redaction_values.clone();
            let message_seq = self.message_seq.clone();
            std::thread::spawn(move || {
                for (response, delay_ms) in script.delayed {
                    std::thread::sleep(std::time::Duration::from_millis(delay_ms));
                    emit_mock_jsonrpc_line(
                        &app,
                        runtime_id,
                        response,
                        &redaction_values,
                        &message_seq,
                    );
                }
            });
        }
        if should_emit_post_start_fatal {
            emit_mock_runtime_error(
                &self.app,
                self.runtime_id,
                "test-mode fatal runtime error",
                false,
                Some("framing_broken"),
            );
        }
    }
}

impl Write for MockSink {
    /// stdin write chunk를 newline 기준으로 모아 완성된 JSON-RPC line만 처리한다.
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        self.line_buf.push_str(&String::from_utf8_lossy(buf));
        while let Some(idx) = self.line_buf.find('\n') {
            let raw: String = self.line_buf.drain(..=idx).collect();
            let line = raw.trim_end_matches(['\n', '\r']).to_string();
            if !line.trim().is_empty() {
                self.handle_line(line);
            }
        }
        Ok(buf.len())
    }

    /// mock writer는 내부 buffering 외 flush 대상이 없으므로 성공만 반환한다.
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

/// test-mode start. 실제 process 없이 provider별 요청-응답 mock writer를 붙인다(§10.1).
fn start_mock(
    state: &AgentRuntimeState,
    app: &AppHandle,
    params: AgentRuntimeStartParams,
) -> Result<RuntimeId, String> {
    if std::env::var_os(MOCK_FAIL_ENV).is_some() {
        return Err("test-mode direct runtime failure".to_string());
    }
    let provider = mock_provider(&params)?;
    let work_dir = mock_work_dir(&params)?;
    let redaction_values = start_params_redaction_values(&params);
    let id = next_runtime_id(state)?;
    let message_seq = Arc::new(AtomicU64::new(0));
    let runtime = AgentRuntime {
        provider: provider.clone(),
        kill_handle: None,
        stdin: Arc::new(Mutex::new(Some(Box::new(MockSink::new(
            app.clone(),
            id,
            provider.clone(),
            work_dir,
            redaction_values.clone(),
            message_seq.clone(),
        )) as Box<dyn Write + Send>))),
        message_log: Arc::new(Mutex::new(VecDeque::new())),
        message_seq,
        pending_request_ids: Arc::new(Mutex::new(Vec::new())),
        status: Arc::new(Mutex::new("running".to_string())),
        started_at: now_millis(),
        exited_at: Arc::new(Mutex::new(None)),
        exited: Arc::new(AtomicBool::new(false)),
        dropped_messages: Arc::new(AtomicU64::new(0)),
        redaction_values,
    };
    insert_runtime(state, id, runtime)?;
    Ok(id)
}

/// mock provider 추출. websocket variant는 여기서도 reject(token 비로깅).
pub(crate) fn mock_provider(params: &AgentRuntimeStartParams) -> Result<String, String> {
    match params {
        AgentRuntimeStartParams::JsonrpcStdio { provider, .. } => Ok(provider.clone()),
        AgentRuntimeStartParams::Websocket { .. } => {
            Err("only jsonrpc-stdio transport is supported in v1".into())
        }
    }
}

/// test-mode start params에서 workDir를 추출하되 websocket variant는 token 노출 없이 거부한다.
fn mock_work_dir(params: &AgentRuntimeStartParams) -> Result<String, String> {
    match params {
        AgentRuntimeStartParams::JsonrpcStdio { work_dir, .. } => Ok(work_dir.clone()),
        AgentRuntimeStartParams::Websocket { .. } => {
            Err("only jsonrpc-stdio transport is supported in v1".into())
        }
    }
}

/// mock stdin 한 요청에 대한 응답 묶음. turn 완료 알림은 response resolve 뒤 처리되도록 지연 emit한다.
#[derive(Default)]
pub(crate) struct MockResponseScript {
    pub(crate) immediate: Vec<String>,
    pub(crate) delayed: Vec<(String, u64)>,
}

/// test-mode provider별 요청-응답 mock. 실제 process 없이 adapter handshake와 prompt 왕복을 검증한다.
pub(crate) fn mock_jsonrpc_response_script(
    provider: &str,
    work_dir: &str,
    line: &str,
    turn_seq: &mut u64,
) -> MockResponseScript {
    if let Some(script) = mock_initialize_fixture_response_script(provider, line) {
        return script;
    }
    let Ok(message) = serde_json::from_str::<serde_json::Value>(line) else {
        return MockResponseScript::default();
    };
    match provider {
        "codex" => mock_codex_response_script(work_dir, &message, turn_seq),
        "claude" => mock_claude_response_script(&message),
        _ => MockResponseScript::default(),
    }
}

/// test-mode에서 post-start fatal recovery E2E를 재현할 prompt인지 판정한다.
pub(crate) fn mock_should_emit_post_start_fatal_error(provider: &str, line: &str) -> bool {
    if provider != "codex" {
        return false;
    }
    let Ok(message) = serde_json::from_str::<serde_json::Value>(line) else {
        return false;
    };
    if message.get("method").and_then(serde_json::Value::as_str) != Some("turn/start") {
        return false;
    }
    mock_codex_prompt_text(&message).contains("fatal runtime error")
}

/// provider별 deterministic fixture를 재사용해 test-mode handshake/lifecycle 응답을 생성한다.
fn mock_initialize_fixture_response_script(
    provider: &str,
    line: &str,
) -> Option<MockResponseScript> {
    let fixtures: &[&str] = match provider {
        "codex" => &[CODEX_INITIALIZE_FIXTURE_JSONL],
        "claude" => &[
            CLAUDE_INITIALIZE_SESSION_NEW_FIXTURE_JSONL,
            CLAUDE_SESSION_LOAD_REPLAY_FIXTURE_JSONL,
            CLAUDE_INITIALIZE_FIXTURE_JSONL,
        ],
        _ => return None,
    };
    fixtures
        .iter()
        .find_map(|fixture| mock_fixture_response_script(fixture, line, false))
}

/// NDJSON `{direction,message}` fixture에서 현재 outbound request에 대응하는 inbound 블록을 추출한다.
fn mock_fixture_response_script(
    fixture_jsonl: &str,
    outbound_line: &str,
    require_params_match: bool,
) -> Option<MockResponseScript> {
    let outbound = serde_json::from_str::<serde_json::Value>(outbound_line).ok()?;
    let outbound_method = outbound.get("method")?.as_str()?;
    let outbound_id = outbound.get("id").cloned();
    let mut matched = false;
    let mut fixture_outbound_id = None;
    let mut literal_rewrites: Vec<(String, String)> = Vec::new();
    let mut immediate = Vec::new();

    for raw in fixture_jsonl.lines().filter(|line| !line.trim().is_empty()) {
        let envelope = serde_json::from_str::<serde_json::Value>(raw).ok()?;
        let direction = envelope.get("direction")?.as_str()?;
        let mut message = envelope.get("message")?.clone();

        if !matched {
            let fixture_method = message.get("method").and_then(serde_json::Value::as_str);
            if direction == "out"
                && fixture_method == Some(outbound_method)
                && (!require_params_match || message.get("params") == outbound.get("params"))
            {
                matched = true;
                fixture_outbound_id = message.get("id").cloned();
                literal_rewrites = fixture_literal_rewrites(&message, &outbound);
            }
            continue;
        }

        if direction == "out" {
            break;
        }
        if direction != "in" {
            continue;
        }
        rewrite_fixture_literals(&mut message, &literal_rewrites);
        if let (Some(fixture_id), Some(actual_id)) = (&fixture_outbound_id, &outbound_id) {
            if message.get("id") == Some(fixture_id) {
                message["id"] = actual_id.clone();
            }
        }
        immediate.push(serde_json::to_string(&message).ok()?);
    }

    if immediate.is_empty() {
        None
    } else {
        Some(MockResponseScript {
            immediate,
            delayed: Vec::new(),
        })
    }
}

/// fixture-local routing literal(sessionId/threadId/turnId)을 실제 outbound 값으로 바꾸기 위한 매핑을 만든다.
fn fixture_literal_rewrites(
    fixture_outbound: &serde_json::Value,
    actual_outbound: &serde_json::Value,
) -> Vec<(String, String)> {
    let mut rewrites = Vec::new();
    let Some(fixture_params) = fixture_outbound.get("params") else {
        return rewrites;
    };
    let Some(actual_params) = actual_outbound.get("params") else {
        return rewrites;
    };
    for key in ["sessionId", "threadId", "turnId"] {
        let fixture_value = fixture_params.get(key).and_then(serde_json::Value::as_str);
        let actual_value = actual_params.get(key).and_then(serde_json::Value::as_str);
        if let (Some(from), Some(to)) = (fixture_value, actual_value) {
            if from != to {
                rewrites.push((from.to_string(), to.to_string()));
            }
        }
    }
    rewrites
}

/// fixture response 전체에서 routing literal을 재귀 치환한다.
fn rewrite_fixture_literals(value: &mut serde_json::Value, rewrites: &[(String, String)]) {
    if rewrites.is_empty() {
        return;
    }
    match value {
        serde_json::Value::String(text) => {
            for (from, to) in rewrites {
                if text == from {
                    *text = to.clone();
                    break;
                }
            }
        }
        serde_json::Value::Array(items) => {
            for item in items {
                rewrite_fixture_literals(item, rewrites);
            }
        }
        serde_json::Value::Object(map) => {
            for child in map.values_mut() {
                rewrite_fixture_literals(child, rewrites);
            }
        }
        _ => {}
    }
}

/// Codex app-server mock 요청을 response와 delayed lifecycle notification으로 변환한다.
fn mock_codex_response_script(
    work_dir: &str,
    message: &serde_json::Value,
    turn_seq: &mut u64,
) -> MockResponseScript {
    let method = message.get("method").and_then(serde_json::Value::as_str);
    if method.is_none() && message.get("result").is_some() {
        return mock_codex_approval_decision_script(message);
    }
    let Some(id) = message.get("id").cloned() else {
        return MockResponseScript::default();
    };
    match method {
        Some("initialize") => MockResponseScript {
            immediate: vec![json_response(
                false,
                id,
                serde_json::json!({
                    "userAgent": "codex-test-mode",
                    "capabilities": {},
                }),
            )],
            delayed: Vec::new(),
        },
        Some("thread/start") | Some("thread/resume") | Some("thread/read") => {
            let cwd = message
                .pointer("/params/cwd")
                .and_then(serde_json::Value::as_str)
                .unwrap_or(work_dir);
            MockResponseScript {
                immediate: vec![json_response(
                    false,
                    id,
                    serde_json::json!({
                        "thread": {
                            "id": "t-mock",
                            "sessionId": "s-mock",
                            "cwd": cwd,
                            "turns": [],
                        },
                    }),
                )],
                delayed: Vec::new(),
            }
        }
        Some("turn/start") => {
            *turn_seq += 1;
            let turn_id = format!("turn-mock-{turn_seq}");
            let prompt = mock_codex_prompt_text(message);
            if prompt.contains("approval") {
                return mock_codex_approval_turn_script(
                    id,
                    work_dir,
                    *turn_seq,
                    !prompt.contains("inline"),
                );
            }
            if prompt.contains("location") {
                return mock_codex_location_turn_script(id, work_dir, *turn_seq);
            }
            let item_id = format!("agent-message-{turn_seq}");
            let message_text = format!("Mock Codex response: {prompt}");
            MockResponseScript {
                immediate: vec![json_response(
                    false,
                    id,
                    serde_json::json!({ "turn": { "id": turn_id } }),
                )],
                delayed: vec![
                    (
                        json_notification(
                            false,
                            "turn/started",
                            serde_json::json!({
                                "threadId": "t-mock",
                                "turn": { "id": turn_id },
                            }),
                        ),
                        10,
                    ),
                    (
                        json_notification(
                            false,
                            "item/started",
                            serde_json::json!({
                                "threadId": "t-mock",
                                "turnId": turn_id,
                                "item": {
                                    "type": "agentMessage",
                                    "id": item_id,
                                    "text": "",
                                    "phase": null,
                                    "memoryCitation": null,
                                },
                            }),
                        ),
                        10,
                    ),
                    (
                        json_notification(
                            false,
                            "item/agentMessage/delta",
                            serde_json::json!({
                                "threadId": "t-mock",
                                "turnId": turn_id,
                                "itemId": item_id,
                                "delta": message_text,
                            }),
                        ),
                        10,
                    ),
                    (
                        json_notification(
                            false,
                            "item/completed",
                            serde_json::json!({
                                "threadId": "t-mock",
                                "turnId": turn_id,
                                "item": {
                                    "type": "agentMessage",
                                    "id": item_id,
                                    "text": message_text,
                                    "phase": null,
                                    "memoryCitation": null,
                                },
                            }),
                        ),
                        10,
                    ),
                    (
                        json_notification(
                            false,
                            "turn/completed",
                            serde_json::json!({
                                "threadId": "t-mock",
                                "turn": { "id": turn_id, "status": "completed" },
                            }),
                        ),
                        10,
                    ),
                ],
            }
        }
        Some("turn/interrupt") => MockResponseScript {
            immediate: vec![json_response(false, id, serde_json::json!({}))],
            delayed: Vec::new(),
        },
        _ => MockResponseScript::default(),
    }
}

/// Codex location mock turn을 commandExecution item lifecycle로 생성한다.
fn mock_codex_location_turn_script(
    id: serde_json::Value,
    work_dir: &str,
    turn_seq: u64,
) -> MockResponseScript {
    let turn_id = format!("turn-mock-{turn_seq}");
    let item_id = format!("cmd-location-{turn_seq}");
    MockResponseScript {
        immediate: vec![json_response(
            false,
            id,
            serde_json::json!({ "turn": { "id": turn_id } }),
        )],
        delayed: vec![
            (
                json_notification(
                    false,
                    "turn/started",
                    serde_json::json!({
                        "threadId": "t-mock",
                        "turn": { "id": turn_id },
                    }),
                ),
                10,
            ),
            (
                json_notification(
                    false,
                    "item/started",
                    serde_json::json!({
                        "threadId": "t-mock",
                        "turnId": turn_id,
                        "item": mock_codex_location_command_item(
                            &item_id,
                            work_dir,
                            "inProgress",
                            serde_json::Value::Null,
                        ),
                    }),
                ),
                10,
            ),
            (
                json_notification(
                    false,
                    "item/completed",
                    serde_json::json!({
                        "threadId": "t-mock",
                        "turnId": turn_id,
                        "item": mock_codex_location_command_item(
                            &item_id,
                            work_dir,
                            "completed",
                            serde_json::json!("line 12"),
                        ),
                    }),
                ),
                10,
            ),
            (
                json_notification(
                    false,
                    "turn/completed",
                    serde_json::json!({
                        "threadId": "t-mock",
                        "turn": { "id": turn_id, "status": "completed" },
                    }),
                ),
                10,
            ),
        ],
    }
}

/// Codex command approval mock turn을 시작하고 approval request를 delayed emit한다.
fn mock_codex_approval_turn_script(
    id: serde_json::Value,
    work_dir: &str,
    turn_seq: u64,
    escalation: bool,
) -> MockResponseScript {
    let turn_id = format!("turn-mock-{turn_seq}");
    let item_id = format!("cmd-approval-{turn_seq}");
    let request_id = 7000 + turn_seq;
    let mut approval_params = serde_json::json!({
        "threadId": "t-mock",
        "turnId": turn_id,
        "itemId": item_id,
        "startedAtMs": 1,
        "command": "echo approval",
        "cwd": work_dir,
    });
    if escalation {
        approval_params["proposedExecpolicyAmendment"] = serde_json::json!({});
    }
    MockResponseScript {
        immediate: vec![json_response(
            false,
            id,
            serde_json::json!({ "turn": { "id": turn_id } }),
        )],
        delayed: vec![
            (
                json_notification(
                    false,
                    "turn/started",
                    serde_json::json!({
                        "threadId": "t-mock",
                        "turn": { "id": turn_id },
                    }),
                ),
                10,
            ),
            (
                json_notification(
                    false,
                    "item/started",
                    serde_json::json!({
                        "threadId": "t-mock",
                        "turnId": turn_id,
                        "item": mock_codex_command_item(
                            &item_id,
                            work_dir,
                            "inProgress",
                            serde_json::Value::Null,
                        ),
                    }),
                ),
                10,
            ),
            (
                json_request(
                    false,
                    serde_json::json!(request_id),
                    "item/commandExecution/requestApproval",
                    approval_params,
                ),
                10,
            ),
        ],
    }
}

/// Codex approval 응답을 tool 완료/거절 및 turn 완료 notification으로 변환한다.
fn mock_codex_approval_decision_script(message: &serde_json::Value) -> MockResponseScript {
    let Some(request_id) = mock_jsonrpc_id_u64(message) else {
        return MockResponseScript::default();
    };
    if request_id < 7001 {
        return MockResponseScript::default();
    }
    let turn_seq = request_id - 7000;
    let turn_id = format!("turn-mock-{turn_seq}");
    let item_id = format!("cmd-approval-{turn_seq}");
    let decision = message
        .pointer("/result/decision")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("decline");
    let accepted = decision == "accept";
    let cancelled = decision == "cancel";
    let command_status = if accepted { "completed" } else { "declined" };
    let turn_status = if cancelled {
        "interrupted"
    } else {
        "completed"
    };
    let output = if accepted {
        "approval accepted"
    } else if cancelled {
        "approval cancelled"
    } else {
        "approval rejected"
    };
    MockResponseScript {
        immediate: Vec::new(),
        delayed: vec![
            (
                json_notification(
                    false,
                    "item/completed",
                    serde_json::json!({
                        "threadId": "t-mock",
                        "turnId": turn_id,
                        "item": mock_codex_command_item(
                            &item_id,
                            "/home/tester/work",
                            command_status,
                            serde_json::json!(output),
                        ),
                    }),
                ),
                10,
            ),
            (
                json_notification(
                    false,
                    "turn/completed",
                    serde_json::json!({
                        "threadId": "t-mock",
                        "turn": { "id": turn_id, "status": turn_status },
                    }),
                ),
                10,
            ),
        ],
    }
}

/// Codex commandExecution item fixture를 생성한다.
fn mock_codex_command_item(
    item_id: &str,
    work_dir: &str,
    status: &str,
    aggregated_output: serde_json::Value,
) -> serde_json::Value {
    let exit_code = if status == "completed" { 0 } else { 1 };
    serde_json::json!({
        "type": "commandExecution",
        "id": item_id,
        "command": "echo approval",
        "cwd": work_dir,
        "processId": null,
        "source": "agent",
        "status": status,
        "commandActions": [],
        "aggregatedOutput": aggregated_output,
        "exitCode": exit_code,
        "durationMs": 1,
    })
}

/// Codex location E2E fixture용 commandExecution item을 생성한다.
fn mock_codex_location_command_item(
    item_id: &str,
    work_dir: &str,
    status: &str,
    aggregated_output: serde_json::Value,
) -> serde_json::Value {
    let exit_code = if status == "completed" { 0 } else { 1 };
    serde_json::json!({
        "type": "commandExecution",
        "id": item_id,
        "command": "sed -n '12p' src/lib/example.ts",
        "cwd": work_dir,
        "processId": null,
        "source": "agent",
        "status": status,
        "commandActions": [],
        "aggregatedOutput": aggregated_output,
        "exitCode": exit_code,
        "durationMs": 1,
        "locations": [
            {
                "path": "src/lib/example.ts",
                "line": 12,
                "column": 4,
            },
        ],
    })
}

/// Claude ACP mock 요청을 response와 session/update notification으로 변환한다.
fn mock_claude_response_script(message: &serde_json::Value) -> MockResponseScript {
    let method = message.get("method").and_then(serde_json::Value::as_str);
    if method.is_none() && message.get("result").is_some() {
        return mock_claude_permission_decision_script(message);
    }
    let Some(id) = message.get("id").cloned() else {
        return MockResponseScript::default();
    };
    match method {
        Some("initialize") => MockResponseScript {
            immediate: vec![json_response(
                true,
                id,
                serde_json::json!({
                    "protocolVersion": 1,
                    "agentCapabilities": {
                        "loadSession": true,
                        "sessionCapabilities": { "resume": true },
                        "promptCapabilities": { "image": false, "embeddedContext": false },
                    },
                    "authMethods": [],
                    "agentInfo": { "name": "claude-test-mode", "version": "test" },
                }),
            )],
            delayed: Vec::new(),
        },
        Some("session/new") | Some("session/resume") | Some("session/load") => MockResponseScript {
            immediate: vec![json_response(
                true,
                id,
                serde_json::json!({
                    "sessionId": "s-mock",
                    "modes": {
                        "currentModeId": "default",
                        "availableModes": [{ "id": "default", "name": "Default" }],
                    },
                    "configOptions": [],
                }),
            )],
            delayed: Vec::new(),
        },
        Some("session/prompt") => {
            let prompt_text = mock_claude_prompt_text(message);
            if prompt_text.contains("approval") || prompt_text.contains("permission") {
                mock_claude_permission_prompt_script(id, message)
            } else {
                let session_id = message
                    .pointer("/params/sessionId")
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or("s-mock");
                let delayed = if prompt_text.contains("late update") {
                    vec![(
                        json_notification(
                            true,
                            "session/update",
                            serde_json::json!({
                                "sessionId": session_id,
                                "update": {
                                    "sessionUpdate": "plan_update",
                                    "id": "late-plan",
                                    "status": "completed",
                                },
                            }),
                        ),
                        50,
                    )]
                } else {
                    Vec::new()
                };
                MockResponseScript {
                    immediate: vec![
                        json_notification(
                            true,
                            "session/update",
                            serde_json::json!({
                                "sessionId": session_id,
                                "update": {
                                    "sessionUpdate": "agent_message_chunk",
                                    "messageId": "m-mock",
                                    "content": { "type": "text", "text": "Mock Claude response" },
                                },
                            }),
                        ),
                        json_response(true, id, serde_json::json!({ "stopReason": "end_turn" })),
                    ],
                    delayed,
                }
            }
        }
        _ => MockResponseScript::default(),
    }
}

/// Claude ACP permission prompt mock. `session/prompt` 응답은 permission 결정 후 원래 id로 resolve한다.
fn mock_claude_permission_prompt_script(
    prompt_id: serde_json::Value,
    message: &serde_json::Value,
) -> MockResponseScript {
    let session_id = message
        .pointer("/params/sessionId")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("s-mock");
    let Some(permission_id) = mock_claude_permission_request_id(&prompt_id) else {
        return MockResponseScript::default();
    };
    let tool_call_id = mock_claude_permission_tool_call_id(&prompt_id);
    MockResponseScript {
        immediate: vec![
            json_notification(
                true,
                "session/update",
                serde_json::json!({
                    "sessionId": session_id,
                    "update": {
                        "sessionUpdate": "tool_call",
                        "toolCallId": tool_call_id,
                        "title": "Edit file",
                        "kind": "edit",
                        "status": "pending",
                    },
                }),
            ),
            json_request(
                true,
                permission_id,
                "session/request_permission",
                serde_json::json!({
                    "sessionId": session_id,
                    "toolCall": { "toolCallId": tool_call_id, "title": "Edit file" },
                    "options": [
                        { "optionId": "allow", "name": "Allow", "kind": "allow_once" },
                        { "optionId": "reject", "name": "Reject", "kind": "reject_once" }
                    ],
                }),
            ),
        ],
        delayed: Vec::new(),
    }
}

/// Claude permission 응답을 tool_call_update와 원래 `session/prompt` 응답으로 변환한다.
fn mock_claude_permission_decision_script(message: &serde_json::Value) -> MockResponseScript {
    let Some(permission_id) = message.get("id").cloned() else {
        return MockResponseScript::default();
    };
    let Some(prompt_id) = mock_claude_prompt_id_from_permission_id(&permission_id) else {
        return MockResponseScript::default();
    };
    let selected = message
        .pointer("/result/outcome/outcome")
        .and_then(serde_json::Value::as_str)
        == Some("selected");
    let option_id = message
        .pointer("/result/outcome/optionId")
        .and_then(serde_json::Value::as_str);
    let accepted = selected && option_id != Some("reject");
    let status = if accepted { "completed" } else { "failed" };
    let stop_reason = if accepted { "end_turn" } else { "cancelled" };
    let session_id = "s-mock";
    let tool_call_id = mock_claude_permission_tool_call_id(&prompt_id);
    MockResponseScript {
        immediate: vec![
            json_notification(
                true,
                "session/update",
                serde_json::json!({
                    "sessionId": session_id,
                    "update": {
                        "sessionUpdate": "tool_call_update",
                        "toolCallId": tool_call_id,
                        "status": status,
                        "content": [
                            {
                                "type": "diff",
                                "path": "mock-claude.txt",
                                "oldText": "before\n",
                                "newText": if accepted { "after\n" } else { "before\n" }
                            }
                        ],
                    },
                }),
            ),
            json_response(
                true,
                prompt_id,
                serde_json::json!({ "stopReason": stop_reason }),
            ),
        ],
        delayed: Vec::new(),
    }
}

/// JSON-RPC id를 number/string 양쪽에서 u64로 추출한다.
fn mock_jsonrpc_id_u64(message: &serde_json::Value) -> Option<u64> {
    message
        .get("id")
        .and_then(|id| id.as_u64().or_else(|| id.as_str()?.parse::<u64>().ok()))
}

/// Codex `turn/start` input 배열에서 첫 text 입력을 진단용 echo 문구로 추출한다.
fn mock_codex_prompt_text(message: &serde_json::Value) -> String {
    message
        .pointer("/params/input")
        .and_then(serde_json::Value::as_array)
        .and_then(|items| {
            items
                .iter()
                .find_map(|item| item.get("text").and_then(serde_json::Value::as_str))
        })
        .unwrap_or("prompt")
        .to_string()
}

/// Claude `session/prompt` content 배열에서 첫 text block을 진단용 분기 문구로 추출한다.
fn mock_claude_prompt_text(message: &serde_json::Value) -> String {
    message
        .pointer("/params/prompt")
        .and_then(serde_json::Value::as_array)
        .and_then(|items| {
            items
                .iter()
                .find_map(|item| item.get("text").and_then(serde_json::Value::as_str))
        })
        .unwrap_or("prompt")
        .to_string()
}

/// 원래 `session/prompt` id에서 대응 permission request id를 만든다.
fn mock_claude_permission_request_id(prompt_id: &serde_json::Value) -> Option<serde_json::Value> {
    if let Some(id) = prompt_id.as_u64() {
        return Some(serde_json::json!(CLAUDE_PERMISSION_REQUEST_ID_OFFSET + id));
    }
    prompt_id
        .as_str()
        .map(|id| serde_json::json!(format!("permission:{id}")))
}

/// permission request id에서 원래 `session/prompt` id를 복원한다.
fn mock_claude_prompt_id_from_permission_id(
    permission_id: &serde_json::Value,
) -> Option<serde_json::Value> {
    if let Some(id) = permission_id.as_u64() {
        return id
            .checked_sub(CLAUDE_PERMISSION_REQUEST_ID_OFFSET)
            .map(|prompt_id| serde_json::json!(prompt_id));
    }
    permission_id.as_str().and_then(|id| {
        id.strip_prefix("permission:")
            .map(|prompt_id| serde_json::json!(prompt_id))
    })
}

/// prompt id 기반으로 stable mock toolCallId를 만든다.
fn mock_claude_permission_tool_call_id(prompt_id: &serde_json::Value) -> String {
    let suffix = prompt_id
        .as_u64()
        .map(|id| id.to_string())
        .or_else(|| prompt_id.as_str().map(ToString::to_string))
        .unwrap_or_else(|| "unknown".to_string());
    format!("tc-permission-{suffix}")
}

/// mock JSON-RPC response line을 compact JSON으로 직렬화한다.
fn json_response(jsonrpc: bool, id: serde_json::Value, result: serde_json::Value) -> String {
    let mut value = serde_json::json!({ "id": id, "result": result });
    if jsonrpc {
        value["jsonrpc"] = serde_json::json!("2.0");
    }
    serde_json::to_string(&value).expect("mock response json")
}

/// mock JSON-RPC notification line을 compact JSON으로 직렬화한다.
fn json_notification(jsonrpc: bool, method: &str, params: serde_json::Value) -> String {
    let mut value = serde_json::json!({ "method": method, "params": params });
    if jsonrpc {
        value["jsonrpc"] = serde_json::json!("2.0");
    }
    serde_json::to_string(&value).expect("mock notification json")
}

/// mock JSON-RPC request line을 compact JSON으로 직렬화한다.
fn json_request(
    jsonrpc: bool,
    id: serde_json::Value,
    method: &str,
    params: serde_json::Value,
) -> String {
    let mut value = serde_json::json!({ "id": id, "method": method, "params": params });
    if jsonrpc {
        value["jsonrpc"] = serde_json::json!("2.0");
    }
    serde_json::to_string(&value).expect("mock request json")
}

/// mock inbound line을 raw debug log와 Tauri `agent-runtime-message` event로 보낸다.
fn emit_mock_jsonrpc_line(
    app: &AppHandle,
    runtime_id: RuntimeId,
    line: String,
    redaction_values: &[String],
    message_seq: &AtomicU64,
) {
    let seq = message_seq.fetch_add(1, Ordering::SeqCst) + 1;
    let _ =
        write_protocol_debug_log_with_values(runtime_id, "in", &line, redaction_values, Some(seq));
    if let Ok(value) = serde_json::from_str::<serde_json::Value>(&line) {
        let _ = app.emit(
            "agent-runtime-message",
            types::AgentRuntimeEvent::Message {
                runtime_id,
                message: value,
            },
        );
    }
}

/// mock runtime의 transport 진단 error event를 보낸다.
fn emit_mock_runtime_error(
    app: &AppHandle,
    runtime_id: RuntimeId,
    message: &str,
    recoverable: bool,
    code: Option<&str>,
) {
    let _ = app.emit(
        "agent-runtime-error",
        types::AgentRuntimeEvent::Error {
            runtime_id,
            message: message.to_string(),
            recoverable,
            code: code.map(str::to_string),
        },
    );
}

#[cfg(test)]
pub(crate) fn test_state_with_runtime(provider: &str) -> (AgentRuntimeState, RuntimeId) {
    let state = AgentRuntimeState::default();
    let id = next_runtime_id(&state).expect("next id");
    let runtime = AgentRuntime {
        provider: provider.to_string(),
        kill_handle: None,
        stdin: Arc::new(Mutex::new(Some(
            Box::new(std::io::sink()) as Box<dyn Write + Send>
        ))),
        message_log: Arc::new(Mutex::new(VecDeque::new())),
        message_seq: Arc::new(AtomicU64::new(0)),
        pending_request_ids: Arc::new(Mutex::new(vec!["7".to_string()])),
        status: Arc::new(Mutex::new("running".to_string())),
        started_at: now_millis(),
        exited_at: Arc::new(Mutex::new(None)),
        exited: Arc::new(AtomicBool::new(false)),
        dropped_messages: Arc::new(AtomicU64::new(0)),
        redaction_values: Arc::new(Vec::new()),
    };
    insert_runtime(&state, id, runtime).expect("insert");
    (state, id)
}

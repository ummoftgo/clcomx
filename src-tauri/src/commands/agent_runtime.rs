//! Direct Agent Runtime — 얇은 #[tauri::command] 래퍼 6종(15 §8.2).
//!
//! 정본: `07-tauri-process-runtime.md` §2.1. 로직·상태는 `features/agent_runtime/`에 두고
//! 여기서는 command 진입점만 둔다. 모든 command는 `Result<T, String>` 반환(전역 에러 컨벤션).

use crate::app_env::is_test_mode;
pub use crate::features::agent_runtime::types::{
    AgentRuntimeCancelTarget, AgentRuntimeSnapshot, AgentRuntimeStartParams, JsonRpcMessage,
    RuntimeId,
};
use crate::features::agent_runtime::{self, resolver, AgentRuntimeState};
use tauri::AppHandle;

/// 새 direct runtime 시작. backend가 provider로 신뢰 절대경로를 resolve해 process를 띄운다.
#[tauri::command]
pub fn agent_runtime_start(
    app: AppHandle,
    state: tauri::State<'_, AgentRuntimeState>,
    params: AgentRuntimeStartParams,
) -> Result<RuntimeId, String> {
    agent_runtime::start(state.inner(), &app, params)
}

/// stdin으로 JSON-RPC 메시지 전송(framing만, 의미 해석 없음).
#[tauri::command]
pub fn agent_runtime_send(
    state: tauri::State<'_, AgentRuntimeState>,
    runtime_id: RuntimeId,
    message: JsonRpcMessage,
) -> Result<(), String> {
    agent_runtime::send(state.inner(), runtime_id, message)
}

/// cancel. backend는 process target만 처리(turn/request는 frontend adapter가 wire 전송).
#[tauri::command]
pub fn agent_runtime_cancel(
    app: AppHandle,
    state: tauri::State<'_, AgentRuntimeState>,
    runtime_id: RuntimeId,
    target: AgentRuntimeCancelTarget,
) -> Result<(), String> {
    agent_runtime::cancel(state.inner(), &app, runtime_id, target)
}

/// graceful shutdown(stdin EOF → grace → kill → child reap → teardown).
#[tauri::command]
pub fn agent_runtime_shutdown(
    state: tauri::State<'_, AgentRuntimeState>,
    runtime_id: RuntimeId,
) -> Result<(), String> {
    agent_runtime::shutdown(state.inner(), runtime_id)
}

/// runtime 상태 스냅샷(late-attach 진단용).
#[tauri::command]
pub fn agent_runtime_get_snapshot(
    state: tauri::State<'_, AgentRuntimeState>,
    runtime_id: RuntimeId,
) -> Result<AgentRuntimeSnapshot, String> {
    agent_runtime::get_snapshot(state.inner(), runtime_id)
}

/// Claude adapter entry(`claude-agent-acp` `dist/index.js`) 신뢰 절대경로 resolve(통합 갭 G1, 15 §8.1).
///
/// frontend Claude adapter의 `resolveLaunch`가 `adapterEntryPath`를 얻는 경로다. backend가 신뢰
/// 절대경로를 resolve하고(S1 경계), 실제 spawn 시 allowlist가 args[0]를 다시 검증한다(start 재검증).
/// test-mode(is_test_mode)에서는 실제 WSL 호출 없이 mock 절대경로를 돌려준다.
#[tauri::command]
pub fn agent_runtime_resolve_adapter_entry(
    provider: String,
    distro: String,
) -> Result<String, String> {
    // test-mode: 실제 WSL probe 없이 결정적 mock 절대경로 반환(start와 동일한 분기 정책, §10).
    if is_test_mode() {
        if provider != "claude" {
            return Err(format!(
                "adapter entry resolve is claude-only, got provider '{provider}'"
            ));
        }
        return Ok("/mock/claude-agent-acp/dist/index.js".to_string());
    }
    resolver::resolve_trusted_adapter_entry(&provider, &distro)
}

//! Direct Agent Runtime — 얇은 #[tauri::command] 래퍼 5종(15 §8.2).
//!
//! 정본: `07-tauri-process-runtime.md` §2.1. 로직·상태는 `features/agent_runtime/`에 두고
//! 여기서는 command 진입점만 둔다. 모든 command는 `Result<T, String>` 반환(전역 에러 컨벤션).

pub use crate::features::agent_runtime::types::{
    AgentRuntimeCancelTarget, AgentRuntimeSnapshot, AgentRuntimeStartParams, JsonRpcMessage,
    RuntimeId,
};
use crate::features::agent_runtime::{self, AgentRuntimeState};
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

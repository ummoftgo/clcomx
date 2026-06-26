use serde::{Deserialize, Serialize};

pub(crate) fn default_workspace_agent_id() -> String {
    "claude".into()
}

pub(crate) fn default_view_mode() -> String {
    "terminal".into()
}

/// `WorkspaceTabSnapshot.runtime_kind`의 기본값(10 §3.3, 15 §7.3). 기존 세션은 `"pty"`로 정규화한다.
pub(crate) fn default_runtime_kind() -> String {
    "pty".into()
}

/// direct runtime 세션 재개·복원용 메타 레코드(Rust 미러, 15 §7.3 정본).
/// transcript 전체가 아니라 메타만 저장하며, 비밀 3필드(`provider_session_id`/`provider_thread_id`/
/// `provider_resume_token`)는 디스크 저장 직전 scrub 대상이다(10 §6, 09 §7).
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct AgentRuntimeMetadataRecord {
    /// `SessionRuntimeKind`("pty" | "direct-codex" | "direct-claude").
    pub session_runtime_kind: String,
    /// `AgentProvider`("codex" | "claude" | "legacy-pty").
    pub provider: String,
    /// provider 원본 session id(resume 키). scrub 대상 — 평문 영속화 금지.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider_session_id: Option<String>,
    /// Codex thread id. scrub 대상.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider_thread_id: Option<String>,
    /// 마지막 완료 turn id(진단/표시용, 비밀 아님).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_turn_id: Option<String>,
    /// provider별 resume 토큰. scrub 대상.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider_resume_token: Option<String>,
    /// 협상된 protocol 버전(호환성 추적, 비밀 아님).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub protocol_version: Option<String>,
    /// adapter 바이너리 버전(호환성 추적).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub adapter_version: Option<String>,
    /// provider 바이너리 버전(호환성 추적).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider_version: Option<String>,
    /// replay 없는 재개 가능 여부(복원 전략 선택 입력).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub can_resume: Option<bool>,
    /// replay 가능 여부(복원 전략 선택 입력).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub can_load: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct EditorTabRef {
    pub wsl_path: String,
    pub line: Option<u32>,
    pub column: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceTabSnapshot {
    pub session_id: String,
    #[serde(default = "default_workspace_agent_id")]
    pub agent_id: String,
    pub distro: String,
    pub work_dir: String,
    pub title: String,
    #[serde(default)]
    pub pinned: bool,
    #[serde(default)]
    pub locked: bool,
    #[serde(default, alias = "claudeResumeId", alias = "claude_resume_id")]
    pub resume_token: Option<String>,
    pub pty_id: Option<u32>,
    #[serde(default)]
    pub aux_pty_id: Option<u32>,
    #[serde(default)]
    pub aux_visible: bool,
    #[serde(default)]
    pub aux_height_percent: Option<u16>,
    #[serde(default = "default_view_mode")]
    pub view_mode: String,
    #[serde(default)]
    pub editor_root_dir: String,
    #[serde(default)]
    pub open_editor_tabs: Vec<EditorTabRef>,
    #[serde(default)]
    pub active_editor_path: Option<String>,
    /// 세션 host 종류(15 §7.3). 기존 `workspace.json`(필드 부재)은 `default_runtime_kind`로 `"pty"` 정규화.
    #[serde(default = "default_runtime_kind")]
    pub runtime_kind: String,
    /// direct runtime 재개·복원용 메타(15 §7.3). 부재 시 `None`. 비밀 필드는 저장 직전 scrub(10 §6).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_runtime: Option<AgentRuntimeMetadataRecord>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct WindowSnapshot {
    pub label: String,
    pub name: String,
    pub role: String,
    pub tabs: Vec<WorkspaceTabSnapshot>,
    pub active_session_id: Option<String>,
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
    pub maximized: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct WorkspaceSnapshot {
    pub windows: Vec<WindowSnapshot>,
}

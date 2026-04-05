use serde::{Deserialize, Serialize};

pub(crate) fn default_workspace_agent_id() -> String {
    "claude".into()
}

pub(crate) fn default_view_mode() -> String {
    "terminal".into()
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

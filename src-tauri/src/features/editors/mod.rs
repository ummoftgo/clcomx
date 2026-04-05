use crate::commands::workspace::WorkspaceState;
use crate::commands::wsl::WslState;

mod detection;
mod editor_launch;
mod file_policy;
mod path_resolution;
mod search_index;
mod session_files;
mod types;

use self::detection::detect_available_editors;
pub use self::editor_launch::open_in_editor;
pub use self::path_resolution::resolve_terminal_path;
use self::session_files::{
    list_session_files_with_state, read_session_file_with_state, search_session_files_with_state,
    write_session_file_with_state,
};
pub use self::types::{
    DetectedEditor, SessionFileListResponse, SessionFileReadResponse, SessionFileSearchResponse,
    SessionFileWriteResponse,
};

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x08000000;

#[tauri::command]
pub async fn list_available_editors() -> Result<Vec<DetectedEditor>, String> {
    tauri::async_runtime::spawn_blocking(detect_available_editors)
        .await
        .map_err(|error| format!("Editor detection task failed: {error}"))
}

#[tauri::command]
pub fn search_session_files(
    workspace_state: tauri::State<'_, WorkspaceState>,
    wsl_state: tauri::State<'_, WslState>,
    session_id: String,
    root_dir: String,
    query: String,
    limit: Option<u16>,
) -> Result<SessionFileSearchResponse, String> {
    search_session_files_with_state(
        workspace_state.inner(),
        Some(wsl_state.inner()),
        &session_id,
        &root_dir,
        &query,
        limit,
    )
}

#[tauri::command]
pub fn list_session_files(
    workspace_state: tauri::State<'_, WorkspaceState>,
    wsl_state: tauri::State<'_, WslState>,
    session_id: String,
    root_dir: String,
    force_refresh: Option<bool>,
) -> Result<SessionFileListResponse, String> {
    list_session_files_with_state(
        workspace_state.inner(),
        Some(wsl_state.inner()),
        &session_id,
        &root_dir,
        force_refresh.unwrap_or(false),
    )
}

#[tauri::command]
pub fn read_session_file(
    workspace_state: tauri::State<'_, WorkspaceState>,
    session_id: String,
    wsl_path: String,
) -> Result<SessionFileReadResponse, String> {
    read_session_file_with_state(workspace_state.inner(), &session_id, &wsl_path)
}

#[tauri::command]
pub fn write_session_file(
    workspace_state: tauri::State<'_, WorkspaceState>,
    session_id: String,
    wsl_path: String,
    content: String,
    expected_mtime_ms: u64,
) -> Result<SessionFileWriteResponse, String> {
    write_session_file_with_state(
        workspace_state.inner(),
        &session_id,
        &wsl_path,
        &content,
        expected_mtime_ms,
    )
}

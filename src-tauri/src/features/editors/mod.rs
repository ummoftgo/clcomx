use crate::commands::settings::WorkspaceState;
use crate::commands::wsl::WslState;
#[cfg(test)]
use std::path::Path;

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
#[cfg(test)]
use self::detection::{editor_override_var, file_name_matches_editor};
#[cfg(all(test, windows))]
use self::detection::app_paths_registry_subkeys;
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builds_editor_override_var_names() {
        assert_eq!(
            editor_override_var("vscode"),
            "CLCOMX_WIN_EDITOR_VSCODE_PATH"
        );
        assert_eq!(
            editor_override_var("notepadpp"),
            "CLCOMX_WIN_EDITOR_NOTEPADPP_PATH"
        );
    }

    #[test]
    fn matches_editor_file_names_case_insensitively() {
        assert!(file_name_matches_editor(
            Path::new("Cursor.exe"),
            &["cursor", "Cursor.exe"]
        ));
        assert!(!file_name_matches_editor(
            Path::new("other.exe"),
            &["cursor", "Cursor.exe"]
        ));
    }

    #[cfg(windows)]
    #[test]
    fn builds_app_paths_subkeys_from_editor_ids() {
        let subkeys = app_paths_registry_subkeys("vscode");
        assert!(subkeys
            .iter()
            .any(|value| value.ends_with(r"App Paths\Code.exe")));
        assert!(subkeys.iter().any(|value| value
            .ends_with(r"WOW6432Node\Microsoft\Windows\CurrentVersion\App Paths\Code.exe")));
    }
}

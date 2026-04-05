use super::pty::PtyState;
use super::workspace::{
    emit_workspace_updated, snapshot_from_state, write_snapshot_to_state, write_workspace,
    WindowSnapshot, WorkspaceState,
};
use crate::features::bootstrap::build_app_bootstrap;
use crate::features::history::{
    load_tab_history_with_limit, record_tab_history_with_limit, remove_persisted_tab_history_entry,
    trim_tab_history_to_limit, TabHistoryEntry,
};
pub use crate::features::bootstrap::AppBootstrap;
use crate::features::settings::{read_settings, save_settings_payload};
#[allow(unused_imports)]
pub use crate::features::settings::{
    ClaudeCliFlagsPayload, EditorSettingsPayload, HistorySettingsPayload,
    InterfaceSettingsPayload, SettingsPayload, TerminalSettingsPayload, WindowPlacement,
    WorkspaceSettingsPayload, load_settings_or_default,
};
use crate::features::theme::load_custom_css_or_default;
use crate::features::workspace::{
    close_window_sessions_in_workspace, detach_session_to_new_window_in_workspace,
    move_session_to_window_in_workspace, move_window_sessions_to_main_in_workspace,
    open_empty_window_in_workspace, remove_window_in_workspace,
};
use std::collections::HashSet;
use std::sync::Mutex;
use tauri::{
    AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, WebviewUrl, WebviewWindowBuilder,
};

#[derive(Default)]
pub struct WindowReadyState {
    ready_labels: Mutex<HashSet<String>>,
}

impl WindowReadyState {
    fn mark_pending(&self, label: &str) -> Result<(), String> {
        self.ready_labels
            .lock()
            .map_err(|e| e.to_string())?
            .remove(label);
        Ok(())
    }

    fn mark_ready(&self, label: &str) -> Result<(), String> {
        self.ready_labels
            .lock()
            .map_err(|e| e.to_string())?
            .insert(label.to_string());
        Ok(())
    }

    fn is_ready(&self, label: &str) -> Result<bool, String> {
        Ok(self
            .ready_labels
            .lock()
            .map_err(|e| e.to_string())?
            .contains(label))
    }

    fn remove(&self, label: &str) -> Result<(), String> {
        self.ready_labels
            .lock()
            .map_err(|e| e.to_string())?
            .remove(label);
        Ok(())
    }
}

fn build_secondary_window(app: &AppHandle, snapshot: &WindowSnapshot) -> Result<(), String> {
    if app.get_webview_window(&snapshot.label).is_some() {
        return Ok(());
    }

    let builder =
        WebviewWindowBuilder::new(app, &snapshot.label, WebviewUrl::App("index.html".into()))
            .title(format!("CLCOMX - {}", snapshot.name))
            .visible(true)
            .resizable(true)
            .inner_size(1024.0, 720.0)
            .position(snapshot.x as f64, snapshot.y as f64);

    let window = builder.build().map_err(|e| e.to_string())?;
    let _ = window.set_position(PhysicalPosition::new(snapshot.x, snapshot.y));
    let _ = window.set_size(PhysicalSize::new(
        snapshot.width.max(640),
        snapshot.height.max(480),
    ));
    if snapshot.maximized {
        let _ = window.maximize();
    }
    let _ = window.set_focus();
    Ok(())
}

fn spawn_secondary_window_build(app: AppHandle, snapshot: WindowSnapshot) {
    std::thread::spawn(move || {
        if let Err(error) = build_secondary_window(&app, &snapshot) {
            eprintln!(
                "Failed to build secondary window {}: {}",
                snapshot.label, error
            );
        }
    });
}

pub fn restore_secondary_windows(
    app: &AppHandle,
    state: &WorkspaceState,
    ready_state: &WindowReadyState,
) -> Result<(), String> {
    let snapshot = snapshot_from_state(state)?;
    for window in snapshot
        .windows
        .iter()
        .filter(|window| window.label != "main")
    {
        ready_state.mark_pending(&window.label)?;
        spawn_secondary_window_build(app.clone(), window.clone());
    }
    Ok(())
}

#[tauri::command]
pub fn window_ready(
    app: AppHandle,
    ready_state: tauri::State<'_, WindowReadyState>,
    label: String,
) -> Result<(), String> {
    ready_state.inner().mark_ready(&label)?;
    let window = app.get_webview_window(&label).ok_or("Window not found")?;
    let _ = window.show();
    let _ = window.set_focus();
    let _ = app.emit("window-frontend-ready", label);
    Ok(())
}

#[tauri::command]
pub fn is_window_ready(
    ready_state: tauri::State<'_, WindowReadyState>,
    label: String,
) -> Result<bool, String> {
    ready_state.inner().is_ready(&label)
}

#[tauri::command]
pub fn load_settings() -> Result<Option<SettingsPayload>, String> {
    read_settings()
}

#[tauri::command]
pub fn load_tab_history() -> Result<Vec<TabHistoryEntry>, String> {
    let settings = load_settings_or_default();
    load_tab_history_with_limit(settings.history.tab_limit)
}

#[tauri::command]
pub fn save_settings(mut settings: SettingsPayload) -> Result<(), String> {
    settings = save_settings_payload(settings)?;
    let _ = load_tab_history_with_limit(settings.history.tab_limit)?;
    Ok(())
}

#[tauri::command]
pub fn record_tab_history(
    agent_id: String,
    distro: String,
    work_dir: String,
    title: String,
    resume_token: Option<String>,
) -> Result<Vec<TabHistoryEntry>, String> {
    let settings = load_settings_or_default();
    record_tab_history_with_limit(
        settings.history.tab_limit,
        agent_id,
        distro,
        work_dir,
        title,
        resume_token,
    )
}

#[tauri::command]
pub fn trim_tab_history(limit: u16) -> Result<Vec<TabHistoryEntry>, String> {
    trim_tab_history_to_limit(limit)
}

#[tauri::command]
pub fn remove_tab_history_entry(entry: TabHistoryEntry) -> Result<Vec<TabHistoryEntry>, String> {
    remove_persisted_tab_history_entry(entry)
}

#[tauri::command]
pub fn open_empty_window(
    app: AppHandle,
    state: tauri::State<'_, WorkspaceState>,
    ready_state: tauri::State<'_, WindowReadyState>,
    x: i32,
    y: i32,
    width: u32,
    height: u32,
) -> Result<String, String> {
    let mut runtime = snapshot_from_state(state.inner())?;
    let window_snapshot = open_empty_window_in_workspace(&mut runtime, x, y, width, height);
    let new_label = window_snapshot.label.clone();
    write_snapshot_to_state(state.inner(), runtime.clone())?;
    write_workspace(&runtime)?;
    ready_state.inner().mark_pending(&new_label)?;
    spawn_secondary_window_build(app.clone(), window_snapshot);
    emit_workspace_updated(&app, &runtime)?;
    Ok(new_label)
}

#[tauri::command]
pub fn detach_session_to_new_window(
    app: AppHandle,
    state: tauri::State<'_, WorkspaceState>,
    session_id: String,
    x: i32,
    y: i32,
    width: u32,
    height: u32,
) -> Result<(), String> {
    let mut runtime = snapshot_from_state(state.inner())?;
    let detached_window =
        detach_session_to_new_window_in_workspace(&mut runtime, &session_id, x, y, width, height)?;

    write_snapshot_to_state(state.inner(), runtime.clone())?;
    write_workspace(&runtime)?;
    spawn_secondary_window_build(app.clone(), detached_window);
    emit_workspace_updated(&app, &runtime)?;
    Ok(())
}

#[tauri::command]
pub fn move_window_sessions_to_main(
    app: AppHandle,
    state: tauri::State<'_, WorkspaceState>,
    ready_state: tauri::State<'_, WindowReadyState>,
    label: String,
) -> Result<(), String> {
    if label == "main" {
        return Ok(());
    }

    let mut runtime = snapshot_from_state(state.inner())?;
    move_window_sessions_to_main_in_workspace(&mut runtime, &label)?;

    write_snapshot_to_state(state.inner(), runtime.clone())?;
    write_workspace(&runtime)?;
    ready_state.inner().remove(&label)?;
    emit_workspace_updated(&app, &runtime)?;
    Ok(())
}

#[tauri::command]
pub fn move_session_to_window(
    app: AppHandle,
    state: tauri::State<'_, WorkspaceState>,
    ready_state: tauri::State<'_, WindowReadyState>,
    session_id: String,
    target_label: String,
) -> Result<(), String> {
    let mut runtime = snapshot_from_state(state.inner())?;
    let move_result =
        move_session_to_window_in_workspace(&mut runtime, &session_id, &target_label)?;

    if move_result.moved_within_same_window {
        write_snapshot_to_state(state.inner(), runtime)?;
        return Ok(());
    }
    write_snapshot_to_state(state.inner(), runtime.clone())?;
    write_workspace(&runtime)?;

    if target_label != "main" && app.get_webview_window(&target_label).is_none() {
        ready_state.inner().mark_pending(&target_label)?;
        spawn_secondary_window_build(app.clone(), move_result.target_snapshot.clone());
    }

    if let Some(target_window) = app.get_webview_window(&target_label) {
        let _ = target_window.set_focus();
    }

    emit_workspace_updated(&app, &runtime)?;
    Ok(())
}

#[tauri::command]
pub fn close_window_sessions(
    app: AppHandle,
    workspace_state: tauri::State<'_, WorkspaceState>,
    pty_state: tauri::State<'_, PtyState>,
    ready_state: tauri::State<'_, WindowReadyState>,
    label: String,
) -> Result<(), String> {
    if label == "main" {
        return Ok(());
    }

    let mut runtime = snapshot_from_state(workspace_state.inner())?;
    let closed = close_window_sessions_in_workspace(&mut runtime, &label);

    for pty_id in closed.pty_ids {
        super::pty::kill_pty_session(pty_state.inner(), pty_id)?;
    }
    for aux_pty_id in closed.aux_pty_ids {
        super::pty::kill_pty_session(pty_state.inner(), aux_pty_id)?;
    }

    write_snapshot_to_state(workspace_state.inner(), runtime.clone())?;
    write_workspace(&runtime)?;
    ready_state.inner().remove(&label)?;
    emit_workspace_updated(&app, &runtime)?;
    Ok(())
}

#[tauri::command]
pub fn remove_window(
    app: AppHandle,
    state: tauri::State<'_, WorkspaceState>,
    ready_state: tauri::State<'_, WindowReadyState>,
    label: String,
) -> Result<(), String> {
    if label == "main" {
        return Ok(());
    }

    let mut runtime = snapshot_from_state(state.inner())?;
    remove_window_in_workspace(&mut runtime, &label);

    write_snapshot_to_state(state.inner(), runtime.clone())?;
    write_workspace(&runtime)?;
    ready_state.inner().remove(&label)?;
    emit_workspace_updated(&app, &runtime)?;
    Ok(())
}

#[tauri::command]
pub fn close_app(app: AppHandle) -> Result<(), String> {
    for window in app.webview_windows().into_values() {
        let _ = window.destroy();
    }
    app.cleanup_before_exit();
    std::process::exit(0);
}

#[tauri::command]
pub fn bootstrap_app(state: tauri::State<'_, WorkspaceState>) -> Result<AppBootstrap, String> {
    build_app_bootstrap(state.inner())
}

#[tauri::command]
pub fn load_custom_css() -> Result<String, String> {
    load_custom_css_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;
    use std::sync::{Mutex, OnceLock};
    use std::time::{SystemTime, UNIX_EPOCH};

    const STATE_DIR_ENV: &str = "CLCOMX_STATE_DIR";

    fn env_lock() -> &'static Mutex<()> {
        static ENV_LOCK: OnceLock<Mutex<()>> = OnceLock::new();
        ENV_LOCK.get_or_init(|| Mutex::new(()))
    }

    fn unique_test_dir(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "clcomx-command-settings-tests-{}-{}-{}",
            name,
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos()
        ))
    }

    #[test]
    fn save_settings_retrims_persisted_tab_history_after_limit_changes() {
        let _guard = env_lock().lock().unwrap();
        let state_dir = unique_test_dir("save-settings-history-trim");
        let _ = fs::create_dir_all(&state_dir);
        let previous = std::env::var(STATE_DIR_ENV).ok();
        std::env::set_var(STATE_DIR_ENV, &state_dir);

        fs::write(
            state_dir.join("tab_history.json"),
            serde_json::to_string_pretty(&serde_json::json!({
                "items": [
                    {
                        "agentId": "claude",
                        "distro": "Ubuntu",
                        "workDir": "/a",
                        "title": "a",
                        "resumeToken": null,
                        "lastOpenedAt": "2"
                    },
                    {
                        "agentId": "claude",
                        "distro": "Ubuntu",
                        "workDir": "/b",
                        "title": "b",
                        "resumeToken": null,
                        "lastOpenedAt": "1"
                    }
                ]
            }))
            .unwrap(),
        )
        .unwrap();

        let mut settings = SettingsPayload::default();
        settings.history.tab_limit = 1;
        save_settings(settings).unwrap();

        let persisted = fs::read_to_string(state_dir.join("tab_history.json")).unwrap();
        let persisted: serde_json::Value = serde_json::from_str(&persisted).unwrap();
        let items = persisted
            .get("items")
            .and_then(|value| value.as_array())
            .cloned()
            .unwrap_or_default();

        if let Some(value) = previous {
            std::env::set_var(STATE_DIR_ENV, value);
        } else {
            std::env::remove_var(STATE_DIR_ENV);
        }
        let _ = fs::remove_dir_all(&state_dir);

        assert_eq!(items.len(), 1);
        assert_eq!(
            items[0].get("workDir").and_then(|value| value.as_str()),
            Some("/a")
        );
    }
}

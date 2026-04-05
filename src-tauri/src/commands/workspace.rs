use super::pty::PtyState;
use crate::features::workspace::{
    clear_session_pty_in_workspace, merge_workspace_snapshot,
    set_session_aux_terminal_state_in_workspace, set_session_pty_in_workspace,
    set_session_resume_token_in_workspace, update_window_geometry_in_workspace,
};
use tauri::{AppHandle, Emitter};

#[allow(unused_imports)]
pub use crate::features::workspace::{
    find_session_tab_snapshot, load_workspace_or_default, EditorTabRef, WindowSnapshot,
    WorkspaceSnapshot, WorkspaceState, WorkspaceTabSnapshot,
};
pub(crate) use crate::features::workspace::{
    snapshot_from_state, write_snapshot_to_state, write_workspace,
};

pub(crate) fn emit_workspace_updated(
    app: &AppHandle,
    snapshot: &WorkspaceSnapshot,
) -> Result<(), String> {
    app.emit("workspace-updated", snapshot.clone())
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn load_workspace(
    state: tauri::State<'_, WorkspaceState>,
) -> Result<Option<WorkspaceSnapshot>, String> {
    Ok(Some(snapshot_from_state(state.inner())?))
}

#[tauri::command]
pub fn save_workspace(
    app: AppHandle,
    state: tauri::State<'_, WorkspaceState>,
    workspace: WorkspaceSnapshot,
) -> Result<(), String> {
    let mut runtime = snapshot_from_state(state.inner())?;
    merge_workspace_snapshot(&mut runtime, workspace);
    write_snapshot_to_state(state.inner(), runtime.clone())?;
    write_workspace(&runtime)?;
    emit_workspace_updated(&app, &runtime)?;
    Ok(())
}

#[tauri::command]
pub fn set_session_pty(
    state: tauri::State<'_, WorkspaceState>,
    session_id: String,
    pty_id: u32,
) -> Result<(), String> {
    let mut runtime = snapshot_from_state(state.inner())?;
    set_session_pty_in_workspace(&mut runtime, &session_id, pty_id)?;
    write_snapshot_to_state(state.inner(), runtime)?;
    Ok(())
}

#[tauri::command]
pub fn set_session_resume_token(
    state: tauri::State<'_, WorkspaceState>,
    session_id: String,
    resume_token: Option<String>,
) -> Result<(), String> {
    let mut runtime = snapshot_from_state(state.inner())?;
    set_session_resume_token_in_workspace(&mut runtime, &session_id, resume_token)?;
    write_snapshot_to_state(state.inner(), runtime)?;
    Ok(())
}

#[tauri::command]
pub fn clear_session_pty(
    state: tauri::State<'_, WorkspaceState>,
    session_id: String,
) -> Result<(), String> {
    let mut runtime = snapshot_from_state(state.inner())?;
    clear_session_pty_in_workspace(&mut runtime, &session_id)?;
    write_snapshot_to_state(state.inner(), runtime)?;
    Ok(())
}

#[tauri::command]
pub fn set_session_aux_terminal_state(
    state: tauri::State<'_, WorkspaceState>,
    session_id: String,
    aux_pty_id: Option<u32>,
    aux_visible: bool,
    aux_height_percent: Option<u16>,
) -> Result<(), String> {
    let mut runtime = snapshot_from_state(state.inner())?;
    set_session_aux_terminal_state_in_workspace(
        &mut runtime,
        &session_id,
        aux_pty_id,
        aux_visible,
        aux_height_percent,
    )?;
    write_snapshot_to_state(state.inner(), runtime)?;
    Ok(())
}

#[tauri::command]
pub fn update_window_geometry(
    app: AppHandle,
    state: tauri::State<'_, WorkspaceState>,
    label: String,
    x: i32,
    y: i32,
    width: u32,
    height: u32,
    maximized: bool,
) -> Result<(), String> {
    let mut runtime = snapshot_from_state(state.inner())?;
    update_window_geometry_in_workspace(&mut runtime, &label, x, y, width, height, maximized)?;
    write_snapshot_to_state(state.inner(), runtime.clone())?;
    write_workspace(&runtime)?;
    emit_workspace_updated(&app, &runtime)?;
    Ok(())
}

#[tauri::command]
pub fn close_session(
    app: AppHandle,
    workspace_state: tauri::State<'_, WorkspaceState>,
    pty_state: tauri::State<'_, PtyState>,
    session_id: String,
) -> Result<(), String> {
    let mut runtime = snapshot_from_state(workspace_state.inner())?;
    let (tab, _) =
        crate::features::workspace::remove_session_from_workspace(&mut runtime, &session_id)
            .ok_or("Session not found")?;
    if let Some(pty_id) = tab.pty_id {
        super::pty::kill_pty_session(pty_state.inner(), pty_id)?;
    }
    if let Some(aux_pty_id) = tab.aux_pty_id {
        super::pty::kill_pty_session(pty_state.inner(), aux_pty_id)?;
    }
    write_snapshot_to_state(workspace_state.inner(), runtime.clone())?;
    write_workspace(&runtime)?;
    emit_workspace_updated(&app, &runtime)?;
    Ok(())
}

#[tauri::command]
pub fn close_session_by_pty(
    app: AppHandle,
    workspace_state: tauri::State<'_, WorkspaceState>,
    pty_state: tauri::State<'_, PtyState>,
    pty_id: u32,
) -> Result<(), String> {
    let mut runtime = snapshot_from_state(workspace_state.inner())?;
    let mut closed_session_id: Option<String> = None;

    for window in &mut runtime.windows {
        if let Some(index) = window
            .tabs
            .iter()
            .position(|tab| tab.pty_id == Some(pty_id))
        {
            closed_session_id = Some(window.tabs[index].session_id.clone());
            if let Some(aux_pty_id) = window.tabs[index].aux_pty_id {
                super::pty::kill_pty_session(pty_state.inner(), aux_pty_id)?;
            }
            window.tabs.remove(index);
            crate::features::workspace::ensure_active_session(window);
            break;
        }
    }

    if closed_session_id.is_none() {
        return Ok(());
    }

    super::pty::kill_pty_session(pty_state.inner(), pty_id)?;
    write_snapshot_to_state(workspace_state.inner(), runtime.clone())?;
    write_workspace(&runtime)?;
    emit_workspace_updated(&app, &runtime)?;
    Ok(())
}

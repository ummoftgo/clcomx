use crate::features::workspace::{
    normalize_window_snapshot, normalize_workspace_snapshot, WindowSnapshot, WorkspaceSnapshot,
    WorkspaceTabSnapshot,
};

use super::{CloseWindowSessionsResult, MoveSessionToWindowResult};

pub(crate) fn ensure_active_session(window: &mut WindowSnapshot) {
    if window.tabs.is_empty() {
        window.active_session_id = None;
        return;
    }

    if let Some(active_id) = &window.active_session_id {
        if window.tabs.iter().any(|tab| &tab.session_id == active_id) {
            return;
        }
    }

    window.active_session_id = window.tabs.first().map(|tab| tab.session_id.clone());
}

pub(crate) fn find_window_index(workspace: &WorkspaceSnapshot, label: &str) -> Option<usize> {
    workspace
        .windows
        .iter()
        .position(|window| window.label == label)
}

pub(crate) fn next_available_window_label(workspace: &WorkspaceSnapshot) -> String {
    let mut index = 1u32;
    loop {
        let candidate = format!("window-{index}");
        if workspace
            .windows
            .iter()
            .all(|window| window.label != candidate)
        {
            return candidate;
        }
        index += 1;
    }
}

pub(crate) fn merge_window_snapshot(
    existing: Option<&WindowSnapshot>,
    mut incoming: WindowSnapshot,
) -> WindowSnapshot {
    if let Some(existing) = existing {
        if incoming.name.is_empty() {
            incoming.name = existing.name.clone();
        }
        if incoming.role.is_empty() {
            incoming.role = existing.role.clone();
        }
        if incoming.width == 0 {
            incoming.width = existing.width;
        }
        if incoming.height == 0 {
            incoming.height = existing.height;
        }
        if incoming.x == 0 && incoming.y == 0 && (existing.x != 0 || existing.y != 0) {
            incoming.x = existing.x;
            incoming.y = existing.y;
        }
        if !incoming.maximized && existing.maximized {
            incoming.maximized = existing.maximized;
        }
    }

    normalize_window_snapshot(&mut incoming);
    ensure_active_session(&mut incoming);
    incoming
}

pub(crate) fn remove_session_from_workspace(
    workspace: &mut WorkspaceSnapshot,
    session_id: &str,
) -> Option<(WorkspaceTabSnapshot, String)> {
    for window in &mut workspace.windows {
        if let Some(index) = window
            .tabs
            .iter()
            .position(|tab| tab.session_id == session_id)
        {
            let tab = window.tabs.remove(index);
            ensure_active_session(window);
            return Some((tab, window.label.clone()));
        }
    }

    None
}

pub(crate) fn collect_window_ptys(workspace: &WorkspaceSnapshot, label: &str) -> Vec<u32> {
    workspace
        .windows
        .iter()
        .find(|window| window.label == label)
        .map(|window| {
            window
                .tabs
                .iter()
                .filter_map(|tab| tab.pty_id)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default()
}

pub(crate) fn open_empty_window_in_workspace(
    workspace: &mut WorkspaceSnapshot,
    x: i32,
    y: i32,
    width: u32,
    height: u32,
) -> WindowSnapshot {
    let new_label = next_available_window_label(workspace);
    let snapshot = WindowSnapshot {
        label: new_label.clone(),
        name: new_label,
        role: "secondary".into(),
        tabs: Vec::new(),
        active_session_id: None,
        x,
        y,
        width: width.max(640),
        height: height.max(480),
        maximized: false,
    };

    workspace.windows.push(snapshot.clone());
    normalize_workspace_snapshot(workspace);
    snapshot
}

pub(crate) fn detach_session_to_new_window_in_workspace(
    workspace: &mut WorkspaceSnapshot,
    session_id: &str,
    x: i32,
    y: i32,
    width: u32,
    height: u32,
) -> Result<WindowSnapshot, String> {
    let (tab, source_label) =
        remove_session_from_workspace(workspace, session_id).ok_or("Session not found")?;

    let new_label = next_available_window_label(workspace);

    workspace.windows.push(WindowSnapshot {
        label: new_label.clone(),
        name: new_label.clone(),
        role: "secondary".into(),
        tabs: vec![tab],
        active_session_id: Some(session_id.to_string()),
        x,
        y,
        width: width.max(640),
        height: height.max(480),
        maximized: false,
    });

    if let Some(source_window) = workspace
        .windows
        .iter_mut()
        .find(|window| window.label == source_label)
    {
        ensure_active_session(source_window);
    }

    workspace
        .windows
        .iter()
        .find(|window| window.label == new_label)
        .cloned()
        .ok_or("Detached window not found".into())
}

pub(crate) fn move_window_sessions_to_main_in_workspace(
    workspace: &mut WorkspaceSnapshot,
    label: &str,
) -> Result<(), String> {
    let index = find_window_index(workspace, label).ok_or("Window not found")?;
    let window = workspace.windows.remove(index);
    let main_index = find_window_index(workspace, "main").ok_or("Main window not found")?;

    let active_from_secondary = window.active_session_id.clone();
    workspace.windows[main_index].tabs.extend(window.tabs);
    if active_from_secondary.is_some() {
        workspace.windows[main_index].active_session_id = active_from_secondary;
    }
    ensure_active_session(&mut workspace.windows[main_index]);
    Ok(())
}

pub(crate) fn move_session_to_window_in_workspace(
    workspace: &mut WorkspaceSnapshot,
    session_id: &str,
    target_label: &str,
) -> Result<MoveSessionToWindowResult, String> {
    let (tab, source_label) =
        remove_session_from_workspace(workspace, session_id).ok_or("Session not found")?;

    if source_label == target_label {
        let target_snapshot =
            if let Some(source_index) = find_window_index(workspace, &source_label) {
                workspace.windows[source_index].tabs.push(tab);
                ensure_active_session(&mut workspace.windows[source_index]);
                workspace.windows[source_index].clone()
            } else {
                WindowSnapshot::default()
            };
        return Ok(MoveSessionToWindowResult {
            target_snapshot,
            moved_within_same_window: true,
        });
    }

    let target_index =
        find_window_index(workspace, target_label).ok_or("Target window not found")?;
    workspace.windows[target_index].tabs.push(tab);
    workspace.windows[target_index].active_session_id = Some(session_id.to_string());
    ensure_active_session(&mut workspace.windows[target_index]);
    normalize_workspace_snapshot(workspace);

    let target_snapshot = workspace
        .windows
        .iter()
        .find(|window| window.label == target_label)
        .cloned()
        .ok_or_else(|| "Target window snapshot not found".to_string())?;

    Ok(MoveSessionToWindowResult {
        target_snapshot,
        moved_within_same_window: false,
    })
}

pub(crate) fn close_window_sessions_in_workspace(
    workspace: &mut WorkspaceSnapshot,
    label: &str,
) -> CloseWindowSessionsResult {
    let pty_ids = collect_window_ptys(workspace, label);
    let aux_pty_ids = workspace
        .windows
        .iter()
        .find(|window| window.label == label)
        .map(|window| {
            window
                .tabs
                .iter()
                .filter_map(|tab| tab.aux_pty_id)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();

    workspace.windows.retain(|window| window.label != label);
    normalize_workspace_snapshot(workspace);

    CloseWindowSessionsResult {
        pty_ids,
        aux_pty_ids,
    }
}

pub(crate) fn remove_window_in_workspace(workspace: &mut WorkspaceSnapshot, label: &str) {
    workspace.windows.retain(|window| window.label != label);
    normalize_workspace_snapshot(workspace);
}

pub(crate) fn merge_workspace_snapshot(
    runtime: &mut WorkspaceSnapshot,
    incoming: WorkspaceSnapshot,
) {
    for incoming_window in incoming.windows {
        if let Some(index) = find_window_index(runtime, &incoming_window.label) {
            let merged = merge_window_snapshot(runtime.windows.get(index), incoming_window);
            runtime.windows[index] = merged;
        } else {
            runtime
                .windows
                .push(merge_window_snapshot(None, incoming_window));
        }
    }

    normalize_workspace_snapshot(runtime);
}

pub(crate) fn update_window_geometry_in_workspace(
    workspace: &mut WorkspaceSnapshot,
    label: &str,
    x: i32,
    y: i32,
    width: u32,
    height: u32,
    maximized: bool,
) -> Result<(), String> {
    let window = workspace
        .windows
        .iter_mut()
        .find(|window| window.label == label)
        .ok_or("Window not found")?;

    window.x = x;
    window.y = y;
    window.width = width.max(640);
    window.height = height.max(480);
    window.maximized = maximized;
    Ok(())
}

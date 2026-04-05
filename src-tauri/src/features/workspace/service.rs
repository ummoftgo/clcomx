use super::normalize_window_snapshot;
use super::types::{WindowSnapshot, WorkspaceSnapshot, WorkspaceTabSnapshot};

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

    super::normalize_workspace_snapshot(runtime);
}

pub(crate) fn set_session_pty_in_workspace(
    workspace: &mut WorkspaceSnapshot,
    session_id: &str,
    pty_id: u32,
) -> Result<(), String> {
    let tab = find_session_tab_mut(workspace, session_id)?;
    tab.pty_id = Some(pty_id);
    Ok(())
}

pub(crate) fn set_session_resume_token_in_workspace(
    workspace: &mut WorkspaceSnapshot,
    session_id: &str,
    resume_token: Option<String>,
) -> Result<(), String> {
    let tab = find_session_tab_mut(workspace, session_id)?;
    tab.resume_token = normalize_resume_token(resume_token);
    Ok(())
}

pub(crate) fn clear_session_pty_in_workspace(
    workspace: &mut WorkspaceSnapshot,
    session_id: &str,
) -> Result<(), String> {
    let tab = find_session_tab_mut(workspace, session_id)?;
    tab.pty_id = None;
    Ok(())
}

pub(crate) fn set_session_aux_terminal_state_in_workspace(
    workspace: &mut WorkspaceSnapshot,
    session_id: &str,
    aux_pty_id: Option<u32>,
    aux_visible: bool,
    aux_height_percent: Option<u16>,
) -> Result<(), String> {
    let tab = find_session_tab_mut(workspace, session_id)?;
    tab.aux_pty_id = aux_pty_id;
    tab.aux_visible = aux_visible;
    tab.aux_height_percent = aux_height_percent;
    Ok(())
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

fn find_session_tab_mut<'a>(
    workspace: &'a mut WorkspaceSnapshot,
    session_id: &str,
) -> Result<&'a mut WorkspaceTabSnapshot, String> {
    for window in &mut workspace.windows {
        if let Some(tab) = window
            .tabs
            .iter_mut()
            .find(|tab| tab.session_id == session_id)
        {
            return Ok(tab);
        }
    }

    Err("Session not found".into())
}

fn normalize_resume_token(resume_token: Option<String>) -> Option<String> {
    resume_token
        .as_ref()
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
        .map(|value| value.to_string())
}

#[cfg(test)]
mod tests {
    use super::{
        merge_workspace_snapshot, next_available_window_label,
        set_session_resume_token_in_workspace, update_window_geometry_in_workspace, WindowSnapshot,
        WorkspaceSnapshot, WorkspaceTabSnapshot,
    };

    #[test]
    fn next_available_window_label_reuses_gaps() {
        let workspace = WorkspaceSnapshot {
            windows: vec![
                WindowSnapshot {
                    label: "main".into(),
                    name: "main".into(),
                    role: "main".into(),
                    ..Default::default()
                },
                WindowSnapshot {
                    label: "window-2".into(),
                    name: "window-2".into(),
                    role: "secondary".into(),
                    ..Default::default()
                },
                WindowSnapshot {
                    label: "window-3".into(),
                    name: "window-3".into(),
                    role: "secondary".into(),
                    ..Default::default()
                },
            ],
        };

        assert_eq!(next_available_window_label(&workspace), "window-1");
    }

    #[test]
    fn merge_workspace_snapshot_updates_existing_window_and_adds_new_window() {
        let mut runtime = WorkspaceSnapshot {
            windows: vec![WindowSnapshot {
                label: "main".into(),
                name: "main".into(),
                role: "main".into(),
                tabs: vec![WorkspaceTabSnapshot {
                    session_id: "session-a".into(),
                    title: "existing".into(),
                    ..Default::default()
                }],
                active_session_id: Some("session-a".into()),
                width: 1200,
                height: 900,
                ..Default::default()
            }],
        };

        merge_workspace_snapshot(
            &mut runtime,
            WorkspaceSnapshot {
                windows: vec![
                    WindowSnapshot {
                        label: "main".into(),
                        width: 0,
                        height: 0,
                        ..Default::default()
                    },
                    WindowSnapshot {
                        label: "window-1".into(),
                        name: "window-1".into(),
                        role: "secondary".into(),
                        ..Default::default()
                    },
                ],
            },
        );

        assert_eq!(runtime.windows.len(), 2);
        assert_eq!(runtime.windows[0].width, 1200);
        assert_eq!(runtime.windows[0].height, 900);
        assert_eq!(runtime.windows[1].label, "window-1");
    }

    #[test]
    fn set_session_resume_token_in_workspace_trims_empty_values() {
        let mut workspace = WorkspaceSnapshot {
            windows: vec![WindowSnapshot {
                label: "main".into(),
                name: "main".into(),
                role: "main".into(),
                tabs: vec![WorkspaceTabSnapshot {
                    session_id: "session-a".into(),
                    ..Default::default()
                }],
                active_session_id: Some("session-a".into()),
                ..Default::default()
            }],
        };

        set_session_resume_token_in_workspace(
            &mut workspace,
            "session-a",
            Some("  resume-1  ".into()),
        )
        .unwrap();
        assert_eq!(
            workspace.windows[0].tabs[0].resume_token.as_deref(),
            Some("resume-1")
        );

        set_session_resume_token_in_workspace(&mut workspace, "session-a", Some("   ".into()))
            .unwrap();
        assert_eq!(workspace.windows[0].tabs[0].resume_token, None);
    }

    #[test]
    fn update_window_geometry_in_workspace_clamps_minimum_size() {
        let mut workspace = WorkspaceSnapshot {
            windows: vec![WindowSnapshot {
                label: "main".into(),
                name: "main".into(),
                role: "main".into(),
                ..Default::default()
            }],
        };

        update_window_geometry_in_workspace(&mut workspace, "main", 10, 20, 100, 200, true)
            .unwrap();

        let main_window = &workspace.windows[0];
        assert_eq!(main_window.x, 10);
        assert_eq!(main_window.y, 20);
        assert_eq!(main_window.width, 640);
        assert_eq!(main_window.height, 480);
        assert!(main_window.maximized);
    }
}

use super::normalize_window_snapshot;
use super::types::{WindowSnapshot, WorkspaceSnapshot, WorkspaceTabSnapshot};

pub(crate) struct MoveSessionToWindowResult {
    pub target_snapshot: WindowSnapshot,
    pub moved_within_same_window: bool,
}

pub(crate) struct CloseWindowSessionsResult {
    pub pty_ids: Vec<u32>,
    pub aux_pty_ids: Vec<u32>,
}

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
    super::normalize_workspace_snapshot(workspace);
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
        let target_snapshot = if let Some(source_index) = find_window_index(workspace, &source_label)
        {
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
    super::normalize_workspace_snapshot(workspace);

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
    super::normalize_workspace_snapshot(workspace);

    CloseWindowSessionsResult {
        pty_ids,
        aux_pty_ids,
    }
}

pub(crate) fn remove_window_in_workspace(workspace: &mut WorkspaceSnapshot, label: &str) {
    workspace.windows.retain(|window| window.label != label);
    super::normalize_workspace_snapshot(workspace);
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
        close_window_sessions_in_workspace, detach_session_to_new_window_in_workspace,
        merge_workspace_snapshot, move_session_to_window_in_workspace,
        move_window_sessions_to_main_in_workspace, next_available_window_label,
        open_empty_window_in_workspace, remove_window_in_workspace,
        set_session_resume_token_in_workspace, update_window_geometry_in_workspace,
        WindowSnapshot, WorkspaceSnapshot, WorkspaceTabSnapshot,
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

    #[test]
    fn open_empty_window_in_workspace_adds_secondary_window_snapshot() {
        let mut workspace = WorkspaceSnapshot {
            windows: vec![WindowSnapshot {
                label: "main".into(),
                name: "main".into(),
                role: "main".into(),
                ..Default::default()
            }],
        };

        let opened = open_empty_window_in_workspace(&mut workspace, 10, 20, 100, 120);

        assert_eq!(opened.label, "window-1");
        assert_eq!(opened.width, 640);
        assert_eq!(opened.height, 480);
        assert!(workspace.windows.iter().any(|window| window.label == "window-1"));
    }

    #[test]
    fn move_session_to_window_in_workspace_reports_same_window_move() {
        let session = WorkspaceTabSnapshot {
            session_id: "session-a".into(),
            title: "session-a".into(),
            ..Default::default()
        };
        let mut workspace = WorkspaceSnapshot {
            windows: vec![WindowSnapshot {
                label: "main".into(),
                name: "main".into(),
                role: "main".into(),
                tabs: vec![session],
                active_session_id: Some("session-a".into()),
                ..Default::default()
            }],
        };

        let moved =
            move_session_to_window_in_workspace(&mut workspace, "session-a", "main").unwrap();

        assert!(moved.moved_within_same_window);
        assert_eq!(moved.target_snapshot.label, "main");
        assert_eq!(workspace.windows[0].tabs.len(), 1);
    }

    #[test]
    fn close_window_sessions_in_workspace_returns_primary_and_aux_ptys() {
        let mut workspace = WorkspaceSnapshot {
            windows: vec![
                WindowSnapshot {
                    label: "main".into(),
                    name: "main".into(),
                    role: "main".into(),
                    ..Default::default()
                },
                WindowSnapshot {
                    label: "window-1".into(),
                    name: "window-1".into(),
                    role: "secondary".into(),
                    tabs: vec![WorkspaceTabSnapshot {
                        session_id: "session-a".into(),
                        title: "session-a".into(),
                        pty_id: Some(11),
                        aux_pty_id: Some(12),
                        ..Default::default()
                    }],
                    active_session_id: Some("session-a".into()),
                    ..Default::default()
                },
            ],
        };

        let closed = close_window_sessions_in_workspace(&mut workspace, "window-1");

        assert_eq!(closed.pty_ids, vec![11]);
        assert_eq!(closed.aux_pty_ids, vec![12]);
        assert_eq!(workspace.windows.len(), 1);
        assert_eq!(workspace.windows[0].label, "main");
    }

    #[test]
    fn detach_session_to_new_window_in_workspace_creates_secondary_window() {
        let mut workspace = WorkspaceSnapshot {
            windows: vec![WindowSnapshot {
                label: "main".into(),
                name: "main".into(),
                role: "main".into(),
                tabs: vec![WorkspaceTabSnapshot {
                    session_id: "session-a".into(),
                    title: "session-a".into(),
                    ..Default::default()
                }],
                active_session_id: Some("session-a".into()),
                ..Default::default()
            }],
        };

        let detached = detach_session_to_new_window_in_workspace(
            &mut workspace,
            "session-a",
            1,
            2,
            200,
            220,
        )
        .unwrap();

        assert_eq!(detached.label, "window-1");
        assert_eq!(workspace.windows.len(), 2);
        assert_eq!(workspace.windows[0].tabs.len(), 0);
        assert_eq!(workspace.windows[1].active_session_id.as_deref(), Some("session-a"));
    }

    #[test]
    fn move_window_sessions_to_main_in_workspace_merges_tabs_and_active_session() {
        let mut workspace = WorkspaceSnapshot {
            windows: vec![
                WindowSnapshot {
                    label: "main".into(),
                    name: "main".into(),
                    role: "main".into(),
                    tabs: vec![WorkspaceTabSnapshot {
                        session_id: "session-a".into(),
                        title: "session-a".into(),
                        ..Default::default()
                    }],
                    active_session_id: Some("session-a".into()),
                    ..Default::default()
                },
                WindowSnapshot {
                    label: "window-1".into(),
                    name: "window-1".into(),
                    role: "secondary".into(),
                    tabs: vec![WorkspaceTabSnapshot {
                        session_id: "session-b".into(),
                        title: "session-b".into(),
                        ..Default::default()
                    }],
                    active_session_id: Some("session-b".into()),
                    ..Default::default()
                },
            ],
        };

        move_window_sessions_to_main_in_workspace(&mut workspace, "window-1").unwrap();

        assert_eq!(workspace.windows.len(), 1);
        assert_eq!(workspace.windows[0].tabs.len(), 2);
        assert_eq!(workspace.windows[0].active_session_id.as_deref(), Some("session-b"));
    }

    #[test]
    fn remove_window_in_workspace_drops_secondary_window() {
        let mut workspace = WorkspaceSnapshot {
            windows: vec![
                WindowSnapshot {
                    label: "main".into(),
                    name: "main".into(),
                    role: "main".into(),
                    ..Default::default()
                },
                WindowSnapshot {
                    label: "window-1".into(),
                    name: "window-1".into(),
                    role: "secondary".into(),
                    ..Default::default()
                },
            ],
        };

        remove_window_in_workspace(&mut workspace, "window-1");

        assert_eq!(workspace.windows.len(), 1);
        assert_eq!(workspace.windows[0].label, "main");
    }
}

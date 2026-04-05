mod session_ops;
mod window_ops;

use super::types::WindowSnapshot;

pub(crate) use self::session_ops::{
    clear_session_pty_in_workspace, set_session_aux_terminal_state_in_workspace,
    set_session_pty_in_workspace, set_session_resume_token_in_workspace,
};
#[cfg(test)]
use self::window_ops::next_available_window_label;
pub(crate) use self::window_ops::{
    close_window_sessions_in_workspace, detach_session_to_new_window_in_workspace,
    ensure_active_session, merge_workspace_snapshot, move_session_to_window_in_workspace,
    move_window_sessions_to_main_in_workspace, open_empty_window_in_workspace,
    remove_session_from_workspace, remove_window_in_workspace, update_window_geometry_in_workspace,
};

pub(crate) struct MoveSessionToWindowResult {
    pub target_snapshot: WindowSnapshot,
    pub moved_within_same_window: bool,
}

pub(crate) struct CloseWindowSessionsResult {
    pub pty_ids: Vec<u32>,
    pub aux_pty_ids: Vec<u32>,
}

#[cfg(test)]
mod tests {
    use super::{
        close_window_sessions_in_workspace, detach_session_to_new_window_in_workspace,
        merge_workspace_snapshot, move_session_to_window_in_workspace,
        move_window_sessions_to_main_in_workspace, next_available_window_label,
        open_empty_window_in_workspace, remove_window_in_workspace,
        set_session_resume_token_in_workspace, update_window_geometry_in_workspace,
    };
    use crate::features::workspace::{WindowSnapshot, WorkspaceSnapshot, WorkspaceTabSnapshot};

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
    fn open_empty_window_in_workspace_appends_secondary_window() {
        let mut workspace = WorkspaceSnapshot {
            windows: vec![WindowSnapshot {
                label: "main".into(),
                name: "main".into(),
                role: "main".into(),
                ..Default::default()
            }],
        };

        let snapshot = open_empty_window_in_workspace(&mut workspace, 0, 0, 800, 600);
        assert_eq!(snapshot.label, "window-1");
        assert_eq!(workspace.windows.len(), 2);
        assert_eq!(workspace.windows[1].label, "window-1");
    }

    #[test]
    fn detach_session_to_new_window_moves_tab() {
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
            10,
            20,
            900,
            700,
        )
        .unwrap();

        assert_eq!(detached.label, "window-1");
        assert_eq!(workspace.windows.len(), 2);
        assert_eq!(workspace.windows[0].tabs.len(), 0);
        assert_eq!(workspace.windows[1].tabs[0].session_id, "session-a");
    }

    #[test]
    fn move_window_sessions_to_main_in_workspace_merges_tabs() {
        let mut workspace = WorkspaceSnapshot {
            windows: vec![
                WindowSnapshot {
                    label: "main".into(),
                    name: "main".into(),
                    role: "main".into(),
                    tabs: vec![WorkspaceTabSnapshot {
                        session_id: "session-a".into(),
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
        assert_eq!(
            workspace.windows[0].active_session_id.as_deref(),
            Some("session-b")
        );
    }

    #[test]
    fn move_session_to_window_in_workspace_returns_target_snapshot() {
        let mut workspace = WorkspaceSnapshot {
            windows: vec![
                WindowSnapshot {
                    label: "main".into(),
                    name: "main".into(),
                    role: "main".into(),
                    tabs: vec![WorkspaceTabSnapshot {
                        session_id: "session-a".into(),
                        ..Default::default()
                    }],
                    active_session_id: Some("session-a".into()),
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

        let result =
            move_session_to_window_in_workspace(&mut workspace, "session-a", "window-1").unwrap();
        assert!(!result.moved_within_same_window);
        assert_eq!(result.target_snapshot.label, "window-1");
        assert_eq!(result.target_snapshot.tabs.len(), 1);
        assert_eq!(
            workspace.windows[1].active_session_id.as_deref(),
            Some("session-a")
        );
    }

    #[test]
    fn close_window_sessions_in_workspace_collects_main_and_aux_ptys() {
        let mut workspace = WorkspaceSnapshot {
            windows: vec![WindowSnapshot {
                label: "window-1".into(),
                name: "window-1".into(),
                role: "secondary".into(),
                tabs: vec![
                    WorkspaceTabSnapshot {
                        session_id: "session-a".into(),
                        pty_id: Some(11),
                        aux_pty_id: Some(91),
                        ..Default::default()
                    },
                    WorkspaceTabSnapshot {
                        session_id: "session-b".into(),
                        pty_id: Some(12),
                        aux_pty_id: None,
                        ..Default::default()
                    },
                ],
                ..Default::default()
            }],
        };

        let result = close_window_sessions_in_workspace(&mut workspace, "window-1");
        assert_eq!(result.pty_ids, vec![11, 12]);
        assert_eq!(result.aux_pty_ids, vec![91]);
        assert_eq!(workspace.windows.len(), 1);
        assert_eq!(workspace.windows[0].label, "main");
    }

    #[test]
    fn remove_window_in_workspace_drops_matching_window() {
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

use super::types::{WindowSnapshot, WorkspaceSnapshot, WorkspaceTabSnapshot};
use super::normalize_window_snapshot;

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

#[cfg(test)]
mod tests {
    use super::{next_available_window_label, WindowSnapshot, WorkspaceSnapshot};

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
}

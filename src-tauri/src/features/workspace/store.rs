use super::types::{
    default_view_mode, default_workspace_agent_id, EditorTabRef, WindowSnapshot, WorkspaceSnapshot,
};
use crate::app_env::{ensure_parent_dir, state_path};
use std::fs;
use std::path::PathBuf;

const DEFAULT_WINDOW_WIDTH: u32 = 1024;
const DEFAULT_WINDOW_HEIGHT: u32 = 720;

fn workspace_path() -> Result<PathBuf, String> {
    state_path("workspace.json")
}

fn normalize_workspace_agent_id(value: &str) -> String {
    let normalized = value.trim().to_lowercase();
    if normalized.is_empty() {
        default_workspace_agent_id()
    } else {
        normalized
    }
}

fn normalize_resume_token(resume_token: Option<String>) -> Option<String> {
    resume_token
        .as_ref()
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
        .map(|value| value.to_string())
}

fn default_main_window_snapshot() -> WindowSnapshot {
    WindowSnapshot {
        label: "main".into(),
        name: "main".into(),
        role: "main".into(),
        tabs: Vec::new(),
        active_session_id: None,
        x: 0,
        y: 0,
        width: DEFAULT_WINDOW_WIDTH,
        height: DEFAULT_WINDOW_HEIGHT,
        maximized: false,
    }
}

pub(crate) fn normalize_window_snapshot(window: &mut WindowSnapshot) {
    if window.label.is_empty() {
        window.label = "main".into();
    }
    if window.name.is_empty() {
        window.name = window.label.clone();
    }
    if window.role.is_empty() {
        window.role = if window.label == "main" {
            "main".into()
        } else {
            "secondary".into()
        };
    }
    if window.width == 0 {
        window.width = DEFAULT_WINDOW_WIDTH;
    }
    if window.height == 0 {
        window.height = DEFAULT_WINDOW_HEIGHT;
    }
    for tab in &mut window.tabs {
        if tab.agent_id.trim().is_empty() {
            tab.agent_id = default_workspace_agent_id();
        }
        tab.agent_id = normalize_workspace_agent_id(&tab.agent_id);
        tab.resume_token = normalize_resume_token(tab.resume_token.clone());
        if tab.view_mode.trim().to_ascii_lowercase() != "editor" {
            tab.view_mode = default_view_mode();
        } else {
            tab.view_mode = "editor".into();
        }
        tab.editor_root_dir = tab.editor_root_dir.trim().to_string();
        if tab.editor_root_dir.is_empty() {
            tab.editor_root_dir = tab.work_dir.trim().to_string();
        }
        tab.open_editor_tabs = tab
            .open_editor_tabs
            .iter()
            .filter_map(|entry| {
                let wsl_path = entry.wsl_path.trim().to_string();
                if wsl_path.is_empty() {
                    None
                } else {
                    Some(EditorTabRef {
                        wsl_path,
                        line: entry.line,
                        column: entry.column,
                    })
                }
            })
            .collect();
        tab.active_editor_path = tab
            .active_editor_path
            .as_ref()
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty());
    }
}

pub fn normalize_workspace_snapshot(workspace: &mut WorkspaceSnapshot) {
    for window in &mut workspace.windows {
        normalize_window_snapshot(window);
    }

    if !workspace
        .windows
        .iter()
        .any(|window| window.label == "main")
    {
        workspace.windows.insert(0, default_main_window_snapshot());
    }
}

fn default_workspace_snapshot() -> WorkspaceSnapshot {
    let mut workspace = WorkspaceSnapshot {
        windows: vec![default_main_window_snapshot()],
    };
    normalize_workspace_snapshot(&mut workspace);
    workspace
}

fn scrub_workspace_resume_tokens(workspace: &mut WorkspaceSnapshot) -> bool {
    let mut changed = false;
    for window in &mut workspace.windows {
        for tab in &mut window.tabs {
            if tab.resume_token.take().is_some() {
                changed = true;
            }
        }
    }
    changed
}

fn sanitize_workspace_for_persist(workspace: &WorkspaceSnapshot) -> WorkspaceSnapshot {
    let mut persisted = workspace.clone();
    for window in &mut persisted.windows {
        for tab in &mut window.tabs {
            tab.pty_id = None;
        }
    }
    scrub_workspace_resume_tokens(&mut persisted);
    persisted
}

fn read_workspace() -> Result<Option<WorkspaceSnapshot>, String> {
    let path = workspace_path()?;
    if !path.exists() {
        return Ok(None);
    }

    let contents = fs::read_to_string(&path)
        .map_err(|e| format!("Failed to read {}: {}", path.display(), e))?;
    let mut workspace = serde_json::from_str::<WorkspaceSnapshot>(&contents)
        .map_err(|e| format!("Invalid workspace.json: {}", e))?;
    normalize_workspace_snapshot(&mut workspace);
    if scrub_workspace_resume_tokens(&mut workspace) {
        if let Err(error) = write_workspace(&workspace) {
            eprintln!("{error}");
        }
    }

    Ok(Some(workspace))
}

pub fn write_workspace(workspace: &WorkspaceSnapshot) -> Result<(), String> {
    let path = workspace_path()?;
    ensure_parent_dir(&path)?;
    let contents = serde_json::to_string_pretty(&sanitize_workspace_for_persist(workspace))
        .map_err(|e| format!("Failed to serialize workspace: {}", e))?;

    fs::write(&path, contents).map_err(|e| format!("Failed to write {}: {}", path.display(), e))
}

pub fn load_workspace_or_default() -> WorkspaceSnapshot {
    match read_workspace() {
        Ok(Some(workspace)) => workspace,
        Ok(None) => default_workspace_snapshot(),
        Err(error) => {
            eprintln!("{error}");
            default_workspace_snapshot()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{load_workspace_or_default, sanitize_workspace_for_persist};
    use crate::app_env::test_support::set_state_dir_env;
    use crate::features::workspace::{
        WindowSnapshot, WorkspaceSnapshot, WorkspaceTabSnapshot,
    };
    use std::fs;

    fn tab_with_resume_token() -> WorkspaceTabSnapshot {
        WorkspaceTabSnapshot {
            session_id: "session-1".into(),
            agent_id: "claude".into(),
            distro: "Ubuntu".into(),
            work_dir: "/workspace".into(),
            title: "Workspace".into(),
            pinned: false,
            locked: false,
            resume_token: Some("resume-secret".into()),
            pty_id: Some(7),
            aux_pty_id: None,
            aux_visible: false,
            aux_height_percent: None,
            view_mode: "terminal".into(),
            editor_root_dir: "/workspace".into(),
            open_editor_tabs: Vec::new(),
            active_editor_path: None,
        }
    }

    #[test]
    fn sanitize_workspace_for_persist_strips_runtime_and_resume_handles() {
        let workspace = WorkspaceSnapshot {
            windows: vec![WindowSnapshot {
                label: "main".into(),
                name: "main".into(),
                role: "main".into(),
                tabs: vec![tab_with_resume_token()],
                active_session_id: Some("session-1".into()),
                x: 0,
                y: 0,
                width: 1024,
                height: 720,
                maximized: false,
            }],
        };

        let persisted = sanitize_workspace_for_persist(&workspace);
        let tab = &persisted.windows[0].tabs[0];

        assert_eq!(tab.pty_id, None);
        assert_eq!(tab.resume_token, None);
    }

    #[test]
    fn load_workspace_scrubs_legacy_persisted_resume_tokens() {
        let state_dir = std::env::temp_dir().join(format!(
            "clcomx-workspace-token-scrub-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&state_dir);
        fs::create_dir_all(&state_dir).unwrap();
        let _guard = set_state_dir_env(&state_dir);
        fs::write(
            state_dir.join("workspace.json"),
            r#"{
  "windows": [
    {
      "label": "main",
      "name": "main",
      "role": "main",
      "tabs": [
        {
          "sessionId": "session-1",
          "agentId": "claude",
          "distro": "Ubuntu",
          "workDir": "/workspace",
          "title": "Workspace",
          "pinned": false,
          "locked": false,
          "resumeToken": "legacy-resume-secret",
          "ptyId": 7
        }
      ],
      "activeSessionId": "session-1",
      "x": 0,
      "y": 0,
      "width": 1024,
      "height": 720,
      "maximized": false
    }
  ]
}"#,
        )
        .unwrap();

        let workspace = load_workspace_or_default();
        let persisted = fs::read_to_string(state_dir.join("workspace.json")).unwrap();

        let _ = fs::remove_dir_all(&state_dir);
        assert_eq!(workspace.windows[0].tabs[0].resume_token, None);
        assert!(!persisted.contains("legacy-resume-secret"));
    }
}

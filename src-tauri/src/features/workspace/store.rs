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

fn sanitize_workspace_for_persist(workspace: &WorkspaceSnapshot) -> WorkspaceSnapshot {
    let mut persisted = workspace.clone();
    for window in &mut persisted.windows {
        for tab in &mut window.tabs {
            tab.pty_id = None;
        }
    }
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

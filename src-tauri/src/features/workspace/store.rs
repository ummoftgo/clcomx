use super::types::{
    default_runtime_kind, default_view_mode, default_workspace_agent_id, EditorTabRef,
    WindowSnapshot, WorkspaceSnapshot,
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
        if tab.runtime_kind.trim().is_empty() {
            tab.runtime_kind = default_runtime_kind();
        }
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

/// direct runtime 메타의 비밀 3필드(`provider_session_id`/`provider_thread_id`/`provider_resume_token`)를
/// 제거한다(10 §6, 15 §7.3 보안 경계). 하나라도 비웠으면 `true`를 돌려준다.
fn scrub_agent_runtime_secrets(tab: &mut crate::features::workspace::WorkspaceTabSnapshot) -> bool {
    let mut changed = false;
    if let Some(meta) = tab.agent_runtime.as_mut() {
        if meta.provider_session_id.take().is_some() {
            changed = true;
        }
        if meta.provider_thread_id.take().is_some() {
            changed = true;
        }
        if meta.provider_resume_token.take().is_some() {
            changed = true;
        }
    }
    changed
}

fn scrub_workspace_resume_tokens(workspace: &mut WorkspaceSnapshot) -> bool {
    let mut changed = false;
    for window in &mut workspace.windows {
        for tab in &mut window.tabs {
            if tab.resume_token.take().is_some() {
                changed = true;
            }
            // read 경로: legacy 파일에 우연히 남은 direct 비밀도 한 번 더 제거(10 §6).
            if scrub_agent_runtime_secrets(tab) {
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
            // 디스크 저장 직전 최종 scrub: direct runtime 메타의 비밀 3필드 제거(정본 경계, 15 §7.3).
            scrub_agent_runtime_secrets(tab);
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
        AgentRuntimeMetadataRecord, WindowSnapshot, WorkspaceSnapshot, WorkspaceTabSnapshot,
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
            runtime_kind: "pty".into(),
            agent_runtime: None,
        }
    }

    /// direct runtime 메타(비밀 3필드 포함)를 채운 탭. scrub 검증용.
    fn tab_with_direct_runtime() -> WorkspaceTabSnapshot {
        WorkspaceTabSnapshot {
            session_id: "session-direct".into(),
            agent_id: "codex".into(),
            distro: "Ubuntu".into(),
            work_dir: "/workspace".into(),
            title: "Direct".into(),
            pinned: false,
            locked: false,
            resume_token: None,
            pty_id: None,
            aux_pty_id: None,
            aux_visible: false,
            aux_height_percent: None,
            view_mode: "terminal".into(),
            editor_root_dir: "/workspace".into(),
            open_editor_tabs: Vec::new(),
            active_editor_path: None,
            runtime_kind: "direct-codex".into(),
            agent_runtime: Some(AgentRuntimeMetadataRecord {
                session_runtime_kind: "direct-codex".into(),
                provider: "codex".into(),
                provider_session_id: Some("sess-secret".into()),
                provider_thread_id: Some("thread-secret".into()),
                provider_resume_token: Some("resume-token-secret".into()),
                last_turn_id: Some("turn-9".into()),
                protocol_version: Some("1".into()),
                adapter_version: Some("0.1.0".into()),
                provider_version: Some("0.142.0".into()),
                sandbox: Some("workspace-write".into()),
                approval_policy: Some("on-request".into()),
                approvals_reviewer: Some("auto_review".into()),
                permission_mode: Some("bypassPermissions".into()),
                session_mode: Some("bypassPermissions".into()),
                can_resume: Some(true),
                can_load: Some(true),
            }),
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

    #[test]
    fn legacy_workspace_without_runtime_fields_defaults_to_pty() {
        // runtime_kind/agent_runtime 필드가 없는 기존 workspace.json은 forward/backward 호환:
        // runtime_kind == "pty", agent_runtime == None으로 deserialize되어야 한다(10 §3.3, §5).
        let state_dir = std::env::temp_dir().join(format!(
            "clcomx-workspace-legacy-runtime-{}",
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
          "locked": false
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
        let _ = fs::remove_dir_all(&state_dir);

        let tab = &workspace.windows[0].tabs[0];
        assert_eq!(tab.runtime_kind, "pty");
        assert!(tab.agent_runtime.is_none());
    }

    #[test]
    fn sanitize_workspace_for_persist_strips_agent_runtime_secrets() {
        let workspace = WorkspaceSnapshot {
            windows: vec![WindowSnapshot {
                label: "main".into(),
                name: "main".into(),
                role: "main".into(),
                tabs: vec![tab_with_direct_runtime()],
                active_session_id: Some("session-direct".into()),
                x: 0,
                y: 0,
                width: 1024,
                height: 720,
                maximized: false,
            }],
        };

        let persisted = sanitize_workspace_for_persist(&workspace);
        let meta = persisted.windows[0].tabs[0]
            .agent_runtime
            .as_ref()
            .expect("agent_runtime retained for non-secret fields");

        // 비밀 3필드는 제거.
        assert_eq!(meta.provider_session_id, None);
        assert_eq!(meta.provider_thread_id, None);
        assert_eq!(meta.provider_resume_token, None);
        // 비-비밀 필드는 보존.
        assert_eq!(meta.session_runtime_kind, "direct-codex");
        assert_eq!(meta.provider, "codex");
        assert_eq!(meta.last_turn_id.as_deref(), Some("turn-9"));
        assert_eq!(meta.sandbox.as_deref(), Some("workspace-write"));
        assert_eq!(meta.approval_policy.as_deref(), Some("on-request"));
        assert_eq!(meta.approvals_reviewer.as_deref(), Some("auto_review"));
        assert_eq!(meta.permission_mode.as_deref(), Some("bypassPermissions"));
        assert_eq!(meta.session_mode.as_deref(), Some("bypassPermissions"));
        assert_eq!(meta.can_load, Some(true));

        // 디스크로 나가는 JSON에도 비밀 문자열이 부재해야 한다(scrub 정본 경계).
        let json = serde_json::to_string(&sanitize_workspace_for_persist(&workspace)).unwrap();
        assert!(!json.contains("sess-secret"));
        assert!(!json.contains("thread-secret"));
        assert!(!json.contains("resume-token-secret"));
        assert!(!json.contains("providerSessionId"));
        assert!(!json.contains("providerThreadId"));
        assert!(!json.contains("providerResumeToken"));
    }

    #[test]
    fn write_workspace_omits_agent_runtime_secrets_on_disk() {
        let state_dir = std::env::temp_dir().join(format!(
            "clcomx-workspace-direct-scrub-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&state_dir);
        fs::create_dir_all(&state_dir).unwrap();
        let _guard = set_state_dir_env(&state_dir);

        let workspace = WorkspaceSnapshot {
            windows: vec![WindowSnapshot {
                label: "main".into(),
                name: "main".into(),
                role: "main".into(),
                tabs: vec![tab_with_direct_runtime()],
                active_session_id: Some("session-direct".into()),
                x: 0,
                y: 0,
                width: 1024,
                height: 720,
                maximized: false,
            }],
        };

        super::write_workspace(&workspace).unwrap();
        let persisted = fs::read_to_string(state_dir.join("workspace.json")).unwrap();
        let _ = fs::remove_dir_all(&state_dir);

        assert!(!persisted.contains("sess-secret"));
        assert!(!persisted.contains("thread-secret"));
        assert!(!persisted.contains("resume-token-secret"));
        // 비-비밀 메타는 디스크에 남는다.
        assert!(persisted.contains("direct-codex"));
        assert!(persisted.contains("turn-9"));
        assert!(persisted.contains("workspace-write"));
        assert!(persisted.contains("on-request"));
        assert!(persisted.contains("auto_review"));
    }
}

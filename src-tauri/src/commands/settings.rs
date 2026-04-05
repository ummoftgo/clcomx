use super::workspace::WorkspaceState;
use crate::features::bootstrap::build_app_bootstrap;
pub use crate::features::bootstrap::AppBootstrap;
use crate::features::history::{
    load_tab_history_with_limit, record_tab_history_with_limit, remove_persisted_tab_history_entry,
    trim_tab_history_to_limit, TabHistoryEntry,
};
#[allow(unused_imports)]
pub use crate::features::settings::{
    load_settings_or_default, ClaudeCliFlagsPayload, EditorSettingsPayload, HistorySettingsPayload,
    InterfaceSettingsPayload, SettingsPayload, TerminalSettingsPayload, WindowPlacement,
    WorkspaceSettingsPayload,
};
use crate::features::settings::{read_settings, save_settings_payload};
use crate::features::theme::load_custom_css_or_default;
use tauri::State;

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
pub fn bootstrap_app(state: State<'_, WorkspaceState>) -> Result<AppBootstrap, String> {
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

use crate::app_env::{
    is_terminal_debug_hooks_enabled, is_test_mode, soft_follow_experiment_override,
};
use crate::features::history::{load_tab_history_with_limit, TabHistoryEntry};
use crate::features::settings::{load_settings_or_default, SettingsPayload};
use crate::features::theme::{load_theme_pack_or_default, ThemePackPayload};
use crate::features::workspace::{snapshot_from_state, WorkspaceSnapshot, WorkspaceState};
use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppBootstrap {
    pub settings: SettingsPayload,
    pub tab_history: Vec<TabHistoryEntry>,
    pub workspace: Option<WorkspaceSnapshot>,
    pub theme_pack: ThemePackPayload,
    pub test_mode: bool,
    pub debug_terminal_hooks: bool,
    pub soft_follow_experiment: Option<bool>,
}

pub(crate) fn build_app_bootstrap(state: &WorkspaceState) -> Result<AppBootstrap, String> {
    Ok(AppBootstrap {
        settings: load_settings_or_default(),
        tab_history: load_tab_history_or_default(),
        workspace: Some(snapshot_from_state(state)?),
        theme_pack: load_theme_pack_or_default(),
        test_mode: is_test_mode(),
        debug_terminal_hooks: is_terminal_debug_hooks_enabled(),
        soft_follow_experiment: soft_follow_experiment_override(),
    })
}

fn load_tab_history_or_default() -> Vec<TabHistoryEntry> {
    let settings = load_settings_or_default();
    match load_tab_history_with_limit(settings.history.tab_limit) {
        Ok(entries) => entries,
        Err(error) => {
            eprintln!("{error}");
            Vec::new()
        }
    }
}

use std::env;
use std::fs;
use std::path::{Path, PathBuf};

const STATE_DIR_ENV: &str = "CLCOMX_STATE_DIR";
const TEST_MODE_ENV: &str = "CLCOMX_TEST_MODE";
const DEBUG_TERMINAL_HOOKS_ENV: &str = "CLCOMX_DEBUG_TERMINAL_HOOKS";
const SOFT_FOLLOW_EXPERIMENT_ENV: &str = "CLCOMX_SOFT_FOLLOW_EXPERIMENT";
const TEST_DISTRO_ENV: &str = "CLCOMX_TEST_DISTRO";
const TEST_HOME_ENV: &str = "CLCOMX_TEST_HOME";

fn is_truthy_env_var(name: &str) -> bool {
    matches!(
        env::var(name)
            .unwrap_or_default()
            .trim()
            .to_ascii_lowercase()
            .as_str(),
        "1" | "true" | "yes" | "on"
    )
}

pub fn is_test_mode() -> bool {
    is_truthy_env_var(TEST_MODE_ENV)
}

pub fn is_terminal_debug_hooks_enabled() -> bool {
    is_truthy_env_var(DEBUG_TERMINAL_HOOKS_ENV)
}

pub fn is_soft_follow_experiment_enabled() -> bool {
    is_truthy_env_var(SOFT_FOLLOW_EXPERIMENT_ENV)
}

pub fn state_root_dir() -> Result<PathBuf, String> {
    if let Ok(value) = env::var(STATE_DIR_ENV) {
        let trimmed = value.trim();
        if !trimmed.is_empty() {
            return Ok(PathBuf::from(trimmed));
        }
    }

    env::current_dir().map_err(|e| e.to_string())
}

pub fn state_path(name: &str) -> Result<PathBuf, String> {
    Ok(state_root_dir()?.join(name))
}

pub fn ensure_parent_dir(path: &Path) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create {}: {}", parent.display(), e))?;
    }
    Ok(())
}

pub fn test_distro_name() -> String {
    env::var(TEST_DISTRO_ENV)
        .ok()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| "clcomx-test".into())
}

pub fn test_home_path() -> String {
    env::var(TEST_HOME_ENV)
        .ok()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| "/home/tester".into())
}

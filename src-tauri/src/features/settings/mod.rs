use crate::app_env::{ensure_parent_dir, state_path};
use crate::features::history::{clamp_tab_history_limit, DEFAULT_TAB_HISTORY_LIMIT};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fs;
use std::path::PathBuf;

const DEFAULT_DRAFT_MAX_ROWS: u16 = 5;
const MIN_DRAFT_MAX_ROWS: u16 = 1;
const MAX_DRAFT_MAX_ROWS: u16 = 999;
const DEFAULT_SCROLLBACK: u32 = 10_000;
const MIN_SCROLLBACK: u32 = 1_000;
const MAX_SCROLLBACK: u32 = 200_000;
const DEFAULT_EDITOR_FONT_SIZE: u16 = 14;
const MIN_EDITOR_FONT_SIZE: u16 = 10;
const MAX_EDITOR_FONT_SIZE: u16 = 24;
const DEFAULT_TERMINAL_RENDERER: &str = "dom";
const DEFAULT_CLAUDE_FOOTER_GHOSTING_MITIGATION: bool = true;
const DEFAULT_CLAUDE_ENABLE_AUTO_MODE: bool = true;
const DEFAULT_AUX_TERMINAL_SHORTCUT: &str = "Ctrl+`";
const DEFAULT_AUX_TERMINAL_HEIGHT: u16 = 28;
const MIN_AUX_TERMINAL_HEIGHT: u16 = 18;
const MAX_AUX_TERMINAL_HEIGHT: u16 = 70;
const DEFAULT_UI_SCALE: u16 = 100;
const MIN_UI_SCALE: u16 = 80;
const MAX_UI_SCALE: u16 = 200;
const DEFAULT_WINDOW_COLS: u16 = 120;
const DEFAULT_WINDOW_ROWS: u16 = 36;
const MIN_WINDOW_COLS: u16 = 60;
const MAX_WINDOW_COLS: u16 = 300;
const MIN_WINDOW_ROWS: u16 = 10;
const MAX_WINDOW_ROWS: u16 = 100;
const DEFAULT_LANGUAGE: &str = "system";
const DEFAULT_FILE_OPEN_MODE: &str = "picker";
const DEFAULT_FILE_OPEN_TARGET: &str = "external";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct WindowPlacement {
    pub monitor: Option<String>,
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
    pub maximized: bool,
}

impl Default for WindowPlacement {
    fn default() -> Self {
        Self {
            monitor: None,
            x: 0,
            y: 0,
            width: 1024,
            height: 720,
            maximized: false,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct InterfaceSettingsPayload {
    pub theme: String,
    pub ui_scale: u16,
    pub ui_font_family: String,
    pub ui_font_family_fallback: String,
    pub window_default_cols: u16,
    pub window_default_rows: u16,
    pub file_open_mode: String,
    pub file_open_target: String,
    pub default_editor_id: String,
}

impl Default for InterfaceSettingsPayload {
    fn default() -> Self {
        Self {
            theme: "dracula".into(),
            ui_scale: DEFAULT_UI_SCALE,
            ui_font_family: "Pretendard, Segoe UI, system-ui".into(),
            ui_font_family_fallback: "Malgun Gothic, Apple SD Gothic Neo, sans-serif".into(),
            window_default_cols: DEFAULT_WINDOW_COLS,
            window_default_rows: DEFAULT_WINDOW_ROWS,
            file_open_mode: DEFAULT_FILE_OPEN_MODE.into(),
            file_open_target: DEFAULT_FILE_OPEN_TARGET.into(),
            default_editor_id: String::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct ClaudeCliFlagsPayload {
    pub enable_auto_mode: bool,
}

impl Default for ClaudeCliFlagsPayload {
    fn default() -> Self {
        Self {
            enable_auto_mode: DEFAULT_CLAUDE_ENABLE_AUTO_MODE,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct TerminalSettingsPayload {
    pub font_family: String,
    pub font_family_fallback: String,
    pub font_size: u16,
    pub renderer: String,
    pub claude_footer_ghosting_mitigation: bool,
    pub claude_cli_flags: ClaudeCliFlagsPayload,
    pub scrollback: u32,
    pub draft_max_rows: u16,
    pub aux_terminal_shortcut: String,
    pub aux_terminal_default_height: u16,
}

impl Default for TerminalSettingsPayload {
    fn default() -> Self {
        Self {
            font_family: "JetBrains Mono, Cascadia Code, Consolas".into(),
            font_family_fallback: "Malgun Gothic, NanumGothicCoding, monospace".into(),
            font_size: 14,
            renderer: DEFAULT_TERMINAL_RENDERER.into(),
            claude_footer_ghosting_mitigation: DEFAULT_CLAUDE_FOOTER_GHOSTING_MITIGATION,
            claude_cli_flags: ClaudeCliFlagsPayload::default(),
            scrollback: DEFAULT_SCROLLBACK,
            draft_max_rows: DEFAULT_DRAFT_MAX_ROWS,
            aux_terminal_shortcut: DEFAULT_AUX_TERMINAL_SHORTCUT.into(),
            aux_terminal_default_height: DEFAULT_AUX_TERMINAL_HEIGHT,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct EditorSettingsPayload {
    pub font_family: String,
    pub font_family_fallback: String,
    pub font_size: u16,
}

impl Default for EditorSettingsPayload {
    fn default() -> Self {
        Self {
            font_family: "JetBrains Mono, Cascadia Code, Consolas".into(),
            font_family_fallback: "Malgun Gothic, NanumGothicCoding, monospace".into(),
            font_size: DEFAULT_EDITOR_FONT_SIZE,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct WorkspaceSettingsPayload {
    pub default_agent_id: String,
    pub default_distro: String,
    pub default_start_paths_by_distro: BTreeMap<String, String>,
}

impl Default for WorkspaceSettingsPayload {
    fn default() -> Self {
        Self {
            default_agent_id: default_agent_id(),
            default_distro: String::new(),
            default_start_paths_by_distro: BTreeMap::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct HistorySettingsPayload {
    pub tab_limit: u16,
}

impl Default for HistorySettingsPayload {
    fn default() -> Self {
        Self {
            tab_limit: DEFAULT_TAB_HISTORY_LIMIT,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct SettingsPayload {
    pub language: String,
    pub interface: InterfaceSettingsPayload,
    pub workspace: WorkspaceSettingsPayload,
    pub terminal: TerminalSettingsPayload,
    pub editor: EditorSettingsPayload,
    pub history: HistorySettingsPayload,
    pub main_window: Option<WindowPlacement>,
}

impl Default for SettingsPayload {
    fn default() -> Self {
        Self {
            language: DEFAULT_LANGUAGE.into(),
            interface: InterfaceSettingsPayload::default(),
            workspace: WorkspaceSettingsPayload::default(),
            terminal: TerminalSettingsPayload::default(),
            editor: EditorSettingsPayload::default(),
            history: HistorySettingsPayload::default(),
            main_window: None,
        }
    }
}

pub(crate) fn read_settings() -> Result<Option<SettingsPayload>, String> {
    let path = settings_path()?;
    if !path.exists() {
        return Ok(None);
    }

    let contents = fs::read_to_string(&path)
        .map_err(|e| format!("Failed to read {}: {}", path.display(), e))?;
    let raw = serde_json::from_str::<serde_json::Value>(&contents)
        .map_err(|e| format!("Invalid setting.json: {}", e))?;
    let settings = parse_settings_value(&raw)?;

    Ok(Some(settings))
}

pub fn load_settings_or_default() -> SettingsPayload {
    let settings = match read_settings() {
        Ok(Some(settings)) => settings,
        Ok(None) => SettingsPayload::default(),
        Err(error) => {
            eprintln!("{error}");
            SettingsPayload::default()
        }
    };

    normalize_settings_payload(settings)
}

pub(crate) fn save_settings_payload(settings: SettingsPayload) -> Result<SettingsPayload, String> {
    let settings = normalize_settings_payload(settings);
    let path = settings_path()?;
    ensure_parent_dir(&path)?;
    let contents = serde_json::to_string_pretty(&settings)
        .map_err(|e| format!("Failed to serialize settings: {}", e))?;

    fs::write(&path, contents).map_err(|e| format!("Failed to write {}: {}", path.display(), e))?;
    Ok(settings)
}

fn settings_path() -> Result<PathBuf, String> {
    state_path("setting.json")
}

fn default_agent_id() -> String {
    "claude".into()
}

fn normalize_agent_id(value: &str) -> String {
    let normalized = value.trim().to_lowercase();
    if normalized.is_empty() {
        default_agent_id()
    } else {
        normalized
    }
}

fn clamp_draft_max_rows(rows: u16) -> u16 {
    rows.clamp(MIN_DRAFT_MAX_ROWS, MAX_DRAFT_MAX_ROWS)
}

fn clamp_scrollback(value: u32) -> u32 {
    value.clamp(MIN_SCROLLBACK, MAX_SCROLLBACK)
}

fn clamp_editor_font_size(value: u16) -> u16 {
    value.clamp(MIN_EDITOR_FONT_SIZE, MAX_EDITOR_FONT_SIZE)
}

fn normalize_font_family(value: &str, default: &str) -> String {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        default.into()
    } else {
        trimmed.into()
    }
}

fn normalize_terminal_renderer(value: &str) -> String {
    match value.trim().to_ascii_lowercase().as_str() {
        "webgl" => "webgl".into(),
        _ => DEFAULT_TERMINAL_RENDERER.into(),
    }
}

fn clamp_aux_terminal_height(value: u16) -> u16 {
    value.clamp(MIN_AUX_TERMINAL_HEIGHT, MAX_AUX_TERMINAL_HEIGHT)
}

fn clamp_ui_scale(scale: u16) -> u16 {
    scale.clamp(MIN_UI_SCALE, MAX_UI_SCALE)
}

fn clamp_window_cols(cols: u16) -> u16 {
    cols.clamp(MIN_WINDOW_COLS, MAX_WINDOW_COLS)
}

fn clamp_window_rows(rows: u16) -> u16 {
    rows.clamp(MIN_WINDOW_ROWS, MAX_WINDOW_ROWS)
}

fn normalize_language(value: &str) -> String {
    let normalized = value.trim().to_lowercase();
    if normalized.starts_with("en") {
        return "en".into();
    }
    if normalized.starts_with("ko") {
        return "ko".into();
    }
    DEFAULT_LANGUAGE.into()
}

fn normalize_file_open_mode(value: &str) -> String {
    match value.trim().to_ascii_lowercase().as_str() {
        "default" => "default".into(),
        _ => DEFAULT_FILE_OPEN_MODE.into(),
    }
}

fn normalize_file_open_target(value: &str) -> String {
    match value.trim().to_ascii_lowercase().as_str() {
        "internal" => "internal".into(),
        _ => DEFAULT_FILE_OPEN_TARGET.into(),
    }
}

fn normalize_aux_terminal_shortcut(value: &str) -> String {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        DEFAULT_AUX_TERMINAL_SHORTCUT.into()
    } else {
        trimmed.into()
    }
}

fn lookup_value<'a>(value: &'a serde_json::Value, path: &[&str]) -> Option<&'a serde_json::Value> {
    let mut current = value;
    for segment in path {
        current = current.get(*segment)?;
    }
    Some(current)
}

fn string_from_paths(value: &serde_json::Value, paths: &[&[&str]], fallback: &str) -> String {
    for path in paths {
        if let Some(found) = lookup_value(value, path).and_then(|entry| entry.as_str()) {
            return found.to_string();
        }
    }

    fallback.to_string()
}

fn u16_from_paths(value: &serde_json::Value, paths: &[&[&str]], fallback: u16) -> u16 {
    for path in paths {
        if let Some(found) = lookup_value(value, path).and_then(|entry| entry.as_u64()) {
            if let Ok(parsed) = u16::try_from(found) {
                return parsed;
            }
        }
    }

    fallback
}

fn u32_from_paths(value: &serde_json::Value, paths: &[&[&str]], fallback: u32) -> u32 {
    for path in paths {
        if let Some(found) = lookup_value(value, path).and_then(|entry| entry.as_u64()) {
            if let Ok(parsed) = u32::try_from(found) {
                return parsed;
            }
        }
    }

    fallback
}

fn bool_from_paths(value: &serde_json::Value, paths: &[&[&str]], fallback: bool) -> bool {
    for path in paths {
        if let Some(found) = lookup_value(value, path).and_then(|entry| entry.as_bool()) {
            return found;
        }
    }

    fallback
}

fn string_map_from_paths(value: &serde_json::Value, paths: &[&[&str]]) -> BTreeMap<String, String> {
    for path in paths {
        let Some(found) = lookup_value(value, path).and_then(|entry| entry.as_object()) else {
            continue;
        };

        let mut result = BTreeMap::new();
        for (key, entry) in found {
            let normalized_key = key.trim();
            let normalized_value = entry.as_str().map(|item| item.trim()).unwrap_or_default();
            if normalized_key.is_empty() || normalized_value.is_empty() {
                continue;
            }
            result.insert(normalized_key.to_string(), normalized_value.to_string());
        }
        return result;
    }

    BTreeMap::new()
}

fn parse_settings_value(value: &serde_json::Value) -> Result<SettingsPayload, String> {
    let mut settings = SettingsPayload::default();

    settings.language = normalize_language(&string_from_paths(
        value,
        &[&["language"]],
        DEFAULT_LANGUAGE,
    ));

    settings.interface.theme = string_from_paths(
        value,
        &[&["interface", "theme"], &["theme"]],
        &settings.interface.theme,
    );
    settings.interface.ui_scale = clamp_ui_scale(u16_from_paths(
        value,
        &[&["interface", "uiScale"]],
        settings.interface.ui_scale,
    ));
    settings.interface.ui_font_family = string_from_paths(
        value,
        &[&["interface", "uiFontFamily"]],
        &settings.interface.ui_font_family,
    );
    settings.interface.ui_font_family_fallback = string_from_paths(
        value,
        &[&["interface", "uiFontFamilyFallback"]],
        &settings.interface.ui_font_family_fallback,
    );
    settings.interface.window_default_cols = clamp_window_cols(u16_from_paths(
        value,
        &[&["interface", "windowDefaultCols"], &["terminalCols"]],
        settings.interface.window_default_cols,
    ));
    settings.interface.window_default_rows = clamp_window_rows(u16_from_paths(
        value,
        &[&["interface", "windowDefaultRows"], &["terminalRows"]],
        settings.interface.window_default_rows,
    ));
    settings.interface.file_open_mode = normalize_file_open_mode(&string_from_paths(
        value,
        &[&["interface", "fileOpenMode"]],
        &settings.interface.file_open_mode,
    ));
    settings.interface.file_open_target = normalize_file_open_target(&string_from_paths(
        value,
        &[&["interface", "fileOpenTarget"]],
        &settings.interface.file_open_target,
    ));
    settings.interface.default_editor_id = string_from_paths(
        value,
        &[&["interface", "defaultEditorId"]],
        &settings.interface.default_editor_id,
    )
    .trim()
    .to_string();
    settings.workspace.default_distro =
        string_from_paths(value, &[&["workspace", "defaultDistro"]], "")
            .trim()
            .to_string();
    settings.workspace.default_agent_id = normalize_agent_id(&string_from_paths(
        value,
        &[&["workspace", "defaultAgentId"]],
        &settings.workspace.default_agent_id,
    ));
    settings.workspace.default_start_paths_by_distro =
        string_map_from_paths(value, &[&["workspace", "defaultStartPathsByDistro"]]);

    settings.terminal.font_family = string_from_paths(
        value,
        &[&["terminal", "fontFamily"], &["fontFamily"]],
        &settings.terminal.font_family,
    );
    settings.terminal.font_family_fallback = string_from_paths(
        value,
        &[&["terminal", "fontFamilyFallback"], &["fontFamilyFallback"]],
        &settings.terminal.font_family_fallback,
    );
    settings.terminal.font_size = u16_from_paths(
        value,
        &[&["terminal", "fontSize"], &["fontSize"]],
        settings.terminal.font_size,
    );
    settings.terminal.font_family = normalize_font_family(
        &settings.terminal.font_family,
        "JetBrains Mono, Cascadia Code, Consolas",
    );
    settings.terminal.font_family_fallback = normalize_font_family(
        &settings.terminal.font_family_fallback,
        "Malgun Gothic, NanumGothicCoding, monospace",
    );
    settings.terminal.renderer = normalize_terminal_renderer(&string_from_paths(
        value,
        &[&["terminal", "renderer"]],
        &settings.terminal.renderer,
    ));
    settings.terminal.claude_footer_ghosting_mitigation = bool_from_paths(
        value,
        &[&["terminal", "claudeFooterGhostingMitigation"]],
        settings.terminal.claude_footer_ghosting_mitigation,
    );
    settings.terminal.claude_cli_flags.enable_auto_mode = bool_from_paths(
        value,
        &[&["terminal", "claudeCliFlags", "enableAutoMode"]],
        settings.terminal.claude_cli_flags.enable_auto_mode,
    );
    settings.terminal.scrollback = clamp_scrollback(u32_from_paths(
        value,
        &[&["terminal", "scrollback"]],
        settings.terminal.scrollback,
    ));
    settings.terminal.draft_max_rows = clamp_draft_max_rows(u16_from_paths(
        value,
        &[&["terminal", "draftMaxRows"], &["composerMaxRows"]],
        settings.terminal.draft_max_rows,
    ));
    settings.terminal.aux_terminal_shortcut = normalize_aux_terminal_shortcut(&string_from_paths(
        value,
        &[&["terminal", "auxTerminalShortcut"]],
        &settings.terminal.aux_terminal_shortcut,
    ));
    settings.terminal.aux_terminal_default_height = clamp_aux_terminal_height(u16_from_paths(
        value,
        &[&["terminal", "auxTerminalDefaultHeight"]],
        settings.terminal.aux_terminal_default_height,
    ));
    settings.editor.font_family = string_from_paths(
        value,
        &[&["editor", "fontFamily"]],
        &settings.terminal.font_family,
    )
    .trim()
    .to_string();
    settings.editor.font_family =
        normalize_font_family(&settings.editor.font_family, &settings.terminal.font_family);
    settings.editor.font_family_fallback = string_from_paths(
        value,
        &[&["editor", "fontFamilyFallback"]],
        &settings.terminal.font_family_fallback,
    )
    .trim()
    .to_string();
    settings.editor.font_family_fallback = normalize_font_family(
        &settings.editor.font_family_fallback,
        &settings.terminal.font_family_fallback,
    );
    settings.editor.font_size = clamp_editor_font_size(u16_from_paths(
        value,
        &[&["editor", "fontSize"]],
        settings.terminal.font_size,
    ));

    settings.history.tab_limit = clamp_tab_history_limit(u16_from_paths(
        value,
        &[&["history", "tabLimit"], &["tabHistoryLimit"]],
        settings.history.tab_limit,
    ));

    settings.main_window = match lookup_value(value, &["mainWindow"]) {
        Some(entry) if entry.is_null() => None,
        Some(entry) => Some(
            serde_json::from_value::<WindowPlacement>(entry.clone())
                .map_err(|e| format!("Invalid mainWindow in setting.json: {}", e))?,
        ),
        None => None,
    };

    Ok(settings)
}

fn normalize_settings_payload(mut settings: SettingsPayload) -> SettingsPayload {
    settings.language = normalize_language(&settings.language);
    settings.interface.ui_scale = clamp_ui_scale(settings.interface.ui_scale);
    settings.interface.window_default_cols =
        clamp_window_cols(settings.interface.window_default_cols);
    settings.interface.window_default_rows =
        clamp_window_rows(settings.interface.window_default_rows);
    settings.interface.file_open_mode =
        normalize_file_open_mode(&settings.interface.file_open_mode);
    settings.interface.file_open_target =
        normalize_file_open_target(&settings.interface.file_open_target);
    settings.interface.default_editor_id = settings.interface.default_editor_id.trim().to_string();
    settings.workspace.default_agent_id = normalize_agent_id(&settings.workspace.default_agent_id);
    settings.workspace.default_distro = settings.workspace.default_distro.trim().to_string();
    settings.workspace.default_start_paths_by_distro = settings
        .workspace
        .default_start_paths_by_distro
        .into_iter()
        .filter_map(|(key, value)| {
            let normalized_key = key.trim().to_string();
            let normalized_value = value.trim().to_string();
            if normalized_key.is_empty() || normalized_value.is_empty() {
                None
            } else {
                Some((normalized_key, normalized_value))
            }
        })
        .collect();
    settings.terminal.font_family = normalize_font_family(
        &settings.terminal.font_family,
        "JetBrains Mono, Cascadia Code, Consolas",
    );
    settings.terminal.font_family_fallback = normalize_font_family(
        &settings.terminal.font_family_fallback,
        "Malgun Gothic, NanumGothicCoding, monospace",
    );
    settings.terminal.draft_max_rows = clamp_draft_max_rows(settings.terminal.draft_max_rows);
    settings.terminal.renderer = normalize_terminal_renderer(&settings.terminal.renderer);
    settings.terminal.scrollback = clamp_scrollback(settings.terminal.scrollback);
    settings.terminal.aux_terminal_shortcut =
        normalize_aux_terminal_shortcut(&settings.terminal.aux_terminal_shortcut);
    settings.terminal.aux_terminal_default_height =
        clamp_aux_terminal_height(settings.terminal.aux_terminal_default_height);
    settings.editor.font_family = settings.editor.font_family.trim().to_string();
    if settings.editor.font_family.is_empty() {
        settings.editor.font_family = settings.terminal.font_family.clone();
    }
    settings.editor.font_family_fallback = settings.editor.font_family_fallback.trim().to_string();
    if settings.editor.font_family_fallback.is_empty() {
        settings.editor.font_family_fallback = settings.terminal.font_family_fallback.clone();
    }
    settings.editor.font_size = clamp_editor_font_size(settings.editor.font_size);
    settings.history.tab_limit = clamp_tab_history_limit(settings.history.tab_limit);
    settings
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::features::history::MIN_TAB_HISTORY_LIMIT;
    use serde_json::json;
    use std::collections::BTreeMap;
    use std::fs;
    use std::path::PathBuf;
    use std::sync::{Mutex, OnceLock};
    use std::time::{SystemTime, UNIX_EPOCH};

    const EXAMPLE_DISTRO: &str = "ExampleDistro";
    const SECOND_DISTRO: &str = "SecondDistro";
    const EXAMPLE_PATH: &str = "/home/tester/work";
    const SECOND_PATH: &str = "/srv/app";
    const STATE_DIR_ENV: &str = "CLCOMX_STATE_DIR";

    fn env_lock() -> &'static Mutex<()> {
        static ENV_LOCK: OnceLock<Mutex<()>> = OnceLock::new();
        ENV_LOCK.get_or_init(|| Mutex::new(()))
    }

    fn unique_test_dir(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "clcomx-settings-tests-{}-{}-{}",
            name,
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos()
        ))
    }

    #[test]
    fn parse_settings_value_migrates_legacy_flat_fields() {
        let raw = json!({
            "language": "ko-KR",
            "theme": "tokyo-night",
            "fontFamily": "Fira Code",
            "fontFamilyFallback": "monospace",
            "fontSize": 16,
            "composerMaxRows": 8,
            "tabHistoryLimit": 25,
            "terminalCols": 144,
            "terminalRows": 42
        });

        let parsed = parse_settings_value(&raw).unwrap();

        assert_eq!(parsed.language, "ko");
        assert_eq!(parsed.interface.theme, "tokyo-night");
        assert_eq!(parsed.interface.window_default_cols, 144);
        assert_eq!(parsed.interface.window_default_rows, 42);
        assert_eq!(parsed.terminal.font_family, "Fira Code");
        assert_eq!(parsed.terminal.font_family_fallback, "monospace");
        assert_eq!(parsed.terminal.font_size, 16);
        assert_eq!(parsed.editor.font_family, "Fira Code");
        assert_eq!(parsed.editor.font_family_fallback, "monospace");
        assert_eq!(parsed.editor.font_size, 16);
        assert_eq!(parsed.terminal.renderer, DEFAULT_TERMINAL_RENDERER);
        assert!(parsed.terminal.claude_footer_ghosting_mitigation);
        assert_eq!(parsed.terminal.draft_max_rows, 8);
        assert_eq!(parsed.history.tab_limit, 25);
    }

    #[test]
    fn parse_settings_value_reads_explicit_editor_settings() {
        let raw = json!({
            "terminal": {
                "fontFamily": "JetBrains Mono",
                "fontFamilyFallback": "NanumGothicCoding",
                "fontSize": 14
            },
            "editor": {
                "fontFamily": "Fira Code",
                "fontFamilyFallback": "monospace",
                "fontSize": 18
            }
        });

        let parsed = parse_settings_value(&raw).unwrap();

        assert_eq!(parsed.editor.font_family, "Fira Code");
        assert_eq!(parsed.editor.font_family_fallback, "monospace");
        assert_eq!(parsed.editor.font_size, 18);
        assert_eq!(parsed.terminal.font_family, "JetBrains Mono");
        assert_eq!(parsed.terminal.font_size, 14);
    }

    #[test]
    fn parse_settings_value_trims_editor_font_settings_without_clamping_terminal_font_size() {
        let raw = json!({
            "terminal": {
                "fontFamily": " JetBrains Mono ",
                "fontFamilyFallback": " NanumGothicCoding ",
                "fontSize": 99
            },
            "editor": {
                "fontFamily": "  ",
                "fontFamilyFallback": "  IBM Plex Sans KR, monospace  ",
                "fontSize": 1
            }
        });

        let parsed = parse_settings_value(&raw).unwrap();

        assert_eq!(parsed.terminal.font_family, "JetBrains Mono");
        assert_eq!(parsed.terminal.font_family_fallback, "NanumGothicCoding");
        assert_eq!(parsed.terminal.font_size, 99);
        assert_eq!(parsed.editor.font_family, "JetBrains Mono");
        assert_eq!(
            parsed.editor.font_family_fallback,
            "IBM Plex Sans KR, monospace"
        );
        assert_eq!(parsed.editor.font_size, MIN_EDITOR_FONT_SIZE);
    }

    #[test]
    fn parse_settings_value_normalizes_terminal_renderer() {
        let raw = json!({
            "terminal": {
                "renderer": "WEBGL"
            }
        });

        let parsed = parse_settings_value(&raw).unwrap();
        assert_eq!(parsed.terminal.renderer, "webgl");

        let invalid = json!({
            "terminal": {
                "renderer": "canvas"
            }
        });

        let invalid_parsed = parse_settings_value(&invalid).unwrap();
        assert_eq!(invalid_parsed.terminal.renderer, DEFAULT_TERMINAL_RENDERER);
    }

    #[test]
    fn parse_settings_value_reads_claude_footer_ghosting_mitigation() {
        let raw = json!({
            "terminal": {
                "claudeFooterGhostingMitigation": false
            }
        });

        let parsed = parse_settings_value(&raw).unwrap();

        assert!(!parsed.terminal.claude_footer_ghosting_mitigation);
    }

    #[test]
    fn parse_settings_value_reads_claude_cli_flags() {
        let raw = json!({
            "terminal": {
                "claudeCliFlags": {
                    "enableAutoMode": false
                }
            }
        });

        let parsed = parse_settings_value(&raw).unwrap();

        assert!(!parsed.terminal.claude_cli_flags.enable_auto_mode);
    }

    #[test]
    fn parse_settings_value_clamps_ui_and_history_values() {
        let raw = json!({
            "language": "fr",
            "interface": {
                "uiScale": 999,
                "windowDefaultCols": 999,
                "windowDefaultRows": 1
            },
            "history": {
                "tabLimit": 0
            }
        });

        let parsed = parse_settings_value(&raw).unwrap();

        assert_eq!(parsed.language, DEFAULT_LANGUAGE);
        assert_eq!(parsed.interface.ui_scale, MAX_UI_SCALE);
        assert_eq!(parsed.interface.window_default_cols, MAX_WINDOW_COLS);
        assert_eq!(parsed.interface.window_default_rows, MIN_WINDOW_ROWS);
        assert_eq!(parsed.history.tab_limit, MIN_TAB_HISTORY_LIMIT);
    }

    #[test]
    fn parse_settings_value_reads_workspace_defaults() {
        let raw = json!({
            "workspace": {
                "defaultAgentId": "codex",
                "defaultDistro": EXAMPLE_DISTRO,
                "defaultStartPathsByDistro": {
                    EXAMPLE_DISTRO: EXAMPLE_PATH,
                    SECOND_DISTRO: SECOND_PATH
                }
            }
        });

        let parsed = parse_settings_value(&raw).unwrap();

        assert_eq!(parsed.workspace.default_agent_id, "codex");
        assert_eq!(parsed.workspace.default_distro, EXAMPLE_DISTRO);
        assert_eq!(
            parsed
                .workspace
                .default_start_paths_by_distro
                .get(EXAMPLE_DISTRO),
            Some(&EXAMPLE_PATH.to_string())
        );
        assert_eq!(
            parsed
                .workspace
                .default_start_paths_by_distro
                .get(SECOND_DISTRO),
            Some(&SECOND_PATH.to_string())
        );
    }

    #[test]
    fn load_settings_or_default_reads_and_normalizes_settings_from_disk() {
        let _guard = env_lock().lock().unwrap();
        let state_dir = unique_test_dir("load-settings");
        let _ = fs::create_dir_all(&state_dir);
        let previous = std::env::var(STATE_DIR_ENV).ok();
        std::env::set_var(STATE_DIR_ENV, &state_dir);

        let path = state_dir.join("setting.json");
        fs::write(
            &path,
            serde_json::to_string_pretty(&json!({
                "language": "ko-KR",
                "interface": {
                    "uiScale": 999,
                    "windowDefaultCols": 999,
                    "windowDefaultRows": 1,
                    "fileOpenMode": "bogus",
                    "fileOpenTarget": "bogus",
                    "defaultEditorId": "  vscode  "
                },
                "workspace": {
                    "defaultAgentId": "  ",
                    "defaultDistro": " Ubuntu ",
                    "defaultStartPathsByDistro": {
                        " Ubuntu ": " /home/tester/work ",
                        "": "/ignored"
                    }
                },
                "terminal": {
                    "fontFamily": " ",
                    "fontFamilyFallback": " ",
                    "renderer": "canvas",
                    "draftMaxRows": 0,
                    "auxTerminalShortcut": " ",
                    "auxTerminalDefaultHeight": 999
                },
                "editor": {
                    "fontFamily": " ",
                    "fontFamilyFallback": " ",
                    "fontSize": 1
                },
                "history": {
                    "tabLimit": 0
                }
            }))
            .unwrap(),
        )
        .unwrap();

        let loaded = load_settings_or_default();

        if let Some(value) = previous {
            std::env::set_var(STATE_DIR_ENV, value);
        } else {
            std::env::remove_var(STATE_DIR_ENV);
        }
        let _ = fs::remove_dir_all(&state_dir);

        assert_eq!(loaded.language, "ko");
        assert_eq!(loaded.interface.ui_scale, MAX_UI_SCALE);
        assert_eq!(loaded.interface.window_default_cols, MAX_WINDOW_COLS);
        assert_eq!(loaded.interface.window_default_rows, MIN_WINDOW_ROWS);
        assert_eq!(loaded.interface.file_open_mode, DEFAULT_FILE_OPEN_MODE);
        assert_eq!(loaded.interface.file_open_target, DEFAULT_FILE_OPEN_TARGET);
        assert_eq!(loaded.interface.default_editor_id, "vscode");
        assert_eq!(loaded.workspace.default_agent_id, "claude");
        assert_eq!(loaded.workspace.default_distro, "Ubuntu");
        assert_eq!(
            loaded
                .workspace
                .default_start_paths_by_distro
                .get("Ubuntu"),
            Some(&"/home/tester/work".to_string())
        );
        assert_eq!(loaded.terminal.font_family, "JetBrains Mono, Cascadia Code, Consolas");
        assert_eq!(
            loaded.terminal.font_family_fallback,
            "Malgun Gothic, NanumGothicCoding, monospace"
        );
        assert_eq!(loaded.terminal.renderer, DEFAULT_TERMINAL_RENDERER);
        assert_eq!(loaded.terminal.draft_max_rows, MIN_DRAFT_MAX_ROWS);
        assert_eq!(
            loaded.terminal.aux_terminal_shortcut,
            DEFAULT_AUX_TERMINAL_SHORTCUT
        );
        assert_eq!(
            loaded.terminal.aux_terminal_default_height,
            MAX_AUX_TERMINAL_HEIGHT
        );
        assert_eq!(loaded.editor.font_family, loaded.terminal.font_family);
        assert_eq!(
            loaded.editor.font_family_fallback,
            loaded.terminal.font_family_fallback
        );
        assert_eq!(loaded.editor.font_size, MIN_EDITOR_FONT_SIZE);
        assert_eq!(loaded.history.tab_limit, MIN_TAB_HISTORY_LIMIT);
    }

    #[test]
    fn save_settings_payload_normalizes_before_persisting_to_disk() {
        let _guard = env_lock().lock().unwrap();
        let state_dir = unique_test_dir("save-settings");
        let _ = fs::create_dir_all(&state_dir);
        let previous = std::env::var(STATE_DIR_ENV).ok();
        std::env::set_var(STATE_DIR_ENV, &state_dir);

        let mut settings = SettingsPayload::default();
        settings.language = "en-US".into();
        settings.interface.ui_scale = 999;
        settings.interface.file_open_mode = "bogus".into();
        settings.interface.file_open_target = "bogus".into();
        settings.interface.default_editor_id = "  code  ".into();
        settings.workspace.default_agent_id = " ".into();
        settings.workspace.default_distro = " Ubuntu ".into();
        settings.workspace.default_start_paths_by_distro = BTreeMap::from([
            (" Ubuntu ".into(), " /home/tester/work ".into()),
            (" ".into(), " /ignored ".into()),
        ]);
        settings.terminal.font_family = " ".into();
        settings.terminal.font_family_fallback = " ".into();
        settings.terminal.renderer = "canvas".into();
        settings.terminal.draft_max_rows = 0;
        settings.terminal.aux_terminal_shortcut = " ".into();
        settings.terminal.aux_terminal_default_height = 0;
        settings.editor.font_family = " ".into();
        settings.editor.font_family_fallback = " ".into();
        settings.editor.font_size = 0;
        settings.history.tab_limit = 0;

        let saved = save_settings_payload(settings).unwrap();
        let persisted = read_settings().unwrap().unwrap();

        if let Some(value) = previous {
            std::env::set_var(STATE_DIR_ENV, value);
        } else {
            std::env::remove_var(STATE_DIR_ENV);
        }
        let _ = fs::remove_dir_all(&state_dir);

        assert_eq!(saved.language, "en");
        assert_eq!(saved.interface.ui_scale, MAX_UI_SCALE);
        assert_eq!(saved.interface.file_open_mode, DEFAULT_FILE_OPEN_MODE);
        assert_eq!(saved.interface.file_open_target, DEFAULT_FILE_OPEN_TARGET);
        assert_eq!(saved.interface.default_editor_id, "code");
        assert_eq!(saved.workspace.default_agent_id, "claude");
        assert_eq!(saved.workspace.default_distro, "Ubuntu");
        assert_eq!(
            saved.workspace.default_start_paths_by_distro,
            BTreeMap::from([("Ubuntu".into(), "/home/tester/work".into())])
        );
        assert_eq!(saved.terminal.font_family, "JetBrains Mono, Cascadia Code, Consolas");
        assert_eq!(
            saved.terminal.font_family_fallback,
            "Malgun Gothic, NanumGothicCoding, monospace"
        );
        assert_eq!(saved.terminal.renderer, DEFAULT_TERMINAL_RENDERER);
        assert_eq!(saved.terminal.draft_max_rows, MIN_DRAFT_MAX_ROWS);
        assert_eq!(
            saved.terminal.aux_terminal_shortcut,
            DEFAULT_AUX_TERMINAL_SHORTCUT
        );
        assert_eq!(
            saved.terminal.aux_terminal_default_height,
            MIN_AUX_TERMINAL_HEIGHT
        );
        assert_eq!(saved.editor.font_family, saved.terminal.font_family);
        assert_eq!(
            saved.editor.font_family_fallback,
            saved.terminal.font_family_fallback
        );
        assert_eq!(saved.editor.font_size, MIN_EDITOR_FONT_SIZE);
        assert_eq!(saved.history.tab_limit, MIN_TAB_HISTORY_LIMIT);
        assert_eq!(persisted.language, saved.language);
        assert_eq!(persisted.history.tab_limit, saved.history.tab_limit);
        assert_eq!(persisted.workspace.default_distro, saved.workspace.default_distro);
    }
}

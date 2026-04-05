use super::pty::PtyState;
use crate::app_env::{
    ensure_parent_dir, is_terminal_debug_hooks_enabled, is_test_mode,
    soft_follow_experiment_override, state_path,
};
use crate::features::history::{
    clamp_tab_history_limit, load_tab_history_with_limit, record_tab_history_with_limit,
    remove_persisted_tab_history_entry, trim_tab_history_to_limit, TabHistoryEntry,
    DEFAULT_TAB_HISTORY_LIMIT,
};
use crate::features::theme::{
    load_custom_css_or_default, load_theme_pack_or_default, ThemePackPayload,
};
use crate::features::workspace::{
    clear_session_pty_in_workspace, collect_window_ptys, ensure_active_session, find_window_index,
    merge_workspace_snapshot, next_available_window_label, normalize_workspace_snapshot,
    remove_session_from_workspace, set_session_aux_terminal_state_in_workspace,
    set_session_pty_in_workspace, set_session_resume_token_in_workspace, snapshot_from_state,
    update_window_geometry_in_workspace, write_snapshot_to_state, write_workspace,
};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashSet};
use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::{
    AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, WebviewUrl, WebviewWindowBuilder,
};

#[allow(unused_imports)]
pub use crate::features::workspace::{
    find_session_tab_snapshot, load_workspace_or_default, EditorTabRef, WindowSnapshot,
    WorkspaceSnapshot, WorkspaceState, WorkspaceTabSnapshot,
};

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

#[derive(Default)]
pub struct WindowReadyState {
    ready_labels: Mutex<HashSet<String>>,
}

impl WindowReadyState {
    fn mark_pending(&self, label: &str) -> Result<(), String> {
        self.ready_labels
            .lock()
            .map_err(|e| e.to_string())?
            .remove(label);
        Ok(())
    }

    fn mark_ready(&self, label: &str) -> Result<(), String> {
        self.ready_labels
            .lock()
            .map_err(|e| e.to_string())?
            .insert(label.to_string());
        Ok(())
    }

    fn is_ready(&self, label: &str) -> Result<bool, String> {
        Ok(self
            .ready_labels
            .lock()
            .map_err(|e| e.to_string())?
            .contains(label))
    }

    fn remove(&self, label: &str) -> Result<(), String> {
        self.ready_labels
            .lock()
            .map_err(|e| e.to_string())?
            .remove(label);
        Ok(())
    }
}

fn read_settings() -> Result<Option<SettingsPayload>, String> {
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

    settings.main_window = lookup_value(value, &["mainWindow"])
        .map(|entry| serde_json::from_value::<WindowPlacement>(entry.clone()))
        .transpose()
        .map_err(|e| format!("Invalid mainWindow in setting.json: {}", e))?;

    Ok(settings)
}

pub fn load_settings_or_default() -> SettingsPayload {
    let mut settings = match read_settings() {
        Ok(Some(settings)) => settings,
        Ok(None) => SettingsPayload::default(),
        Err(error) => {
            eprintln!("{error}");
            SettingsPayload::default()
        }
    };

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

pub fn load_tab_history_or_default() -> Vec<TabHistoryEntry> {
    let settings = load_settings_or_default();
    match load_tab_history_with_limit(settings.history.tab_limit) {
        Ok(entries) => entries,
        Err(error) => {
            eprintln!("{error}");
            Vec::new()
        }
    }
}

fn emit_workspace_updated(app: &AppHandle, snapshot: &WorkspaceSnapshot) -> Result<(), String> {
    app.emit("workspace-updated", snapshot.clone())
        .map_err(|e| e.to_string())
}

fn build_secondary_window(app: &AppHandle, snapshot: &WindowSnapshot) -> Result<(), String> {
    if app.get_webview_window(&snapshot.label).is_some() {
        return Ok(());
    }

    let builder =
        WebviewWindowBuilder::new(app, &snapshot.label, WebviewUrl::App("index.html".into()))
            .title(format!("CLCOMX - {}", snapshot.name))
            .visible(true)
            .resizable(true)
            .inner_size(1024.0, 720.0)
            .position(snapshot.x as f64, snapshot.y as f64);

    let window = builder.build().map_err(|e| e.to_string())?;
    let _ = window.set_position(PhysicalPosition::new(snapshot.x, snapshot.y));
    let _ = window.set_size(PhysicalSize::new(
        snapshot.width.max(640),
        snapshot.height.max(480),
    ));
    if snapshot.maximized {
        let _ = window.maximize();
    }
    let _ = window.set_focus();
    Ok(())
}

fn spawn_secondary_window_build(app: AppHandle, snapshot: WindowSnapshot) {
    std::thread::spawn(move || {
        if let Err(error) = build_secondary_window(&app, &snapshot) {
            eprintln!(
                "Failed to build secondary window {}: {}",
                snapshot.label, error
            );
        }
    });
}

pub fn restore_secondary_windows(
    app: &AppHandle,
    state: &WorkspaceState,
    ready_state: &WindowReadyState,
) -> Result<(), String> {
    let snapshot = snapshot_from_state(state)?;
    for window in snapshot
        .windows
        .iter()
        .filter(|window| window.label != "main")
    {
        ready_state.mark_pending(&window.label)?;
        spawn_secondary_window_build(app.clone(), window.clone());
    }
    Ok(())
}

#[tauri::command]
pub fn window_ready(
    app: AppHandle,
    ready_state: tauri::State<'_, WindowReadyState>,
    label: String,
) -> Result<(), String> {
    ready_state.inner().mark_ready(&label)?;
    let window = app.get_webview_window(&label).ok_or("Window not found")?;
    let _ = window.show();
    let _ = window.set_focus();
    let _ = app.emit("window-frontend-ready", label);
    Ok(())
}

#[tauri::command]
pub fn is_window_ready(
    ready_state: tauri::State<'_, WindowReadyState>,
    label: String,
) -> Result<bool, String> {
    ready_state.inner().is_ready(&label)
}

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
pub fn load_workspace(
    state: tauri::State<'_, WorkspaceState>,
) -> Result<Option<WorkspaceSnapshot>, String> {
    Ok(Some(snapshot_from_state(state.inner())?))
}

#[tauri::command]
pub fn save_settings(mut settings: SettingsPayload) -> Result<(), String> {
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
    let path = settings_path()?;
    ensure_parent_dir(&path)?;
    let contents = serde_json::to_string_pretty(&settings)
        .map_err(|e| format!("Failed to serialize settings: {}", e))?;

    fs::write(&path, contents).map_err(|e| format!("Failed to write {}: {}", path.display(), e))?;
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
pub fn save_workspace(
    app: AppHandle,
    state: tauri::State<'_, WorkspaceState>,
    workspace: WorkspaceSnapshot,
) -> Result<(), String> {
    let mut runtime = snapshot_from_state(state.inner())?;
    merge_workspace_snapshot(&mut runtime, workspace);
    write_snapshot_to_state(state.inner(), runtime.clone())?;
    write_workspace(&runtime)?;
    emit_workspace_updated(&app, &runtime)?;
    Ok(())
}

#[tauri::command]
pub fn set_session_pty(
    state: tauri::State<'_, WorkspaceState>,
    session_id: String,
    pty_id: u32,
) -> Result<(), String> {
    let mut runtime = snapshot_from_state(state.inner())?;
    set_session_pty_in_workspace(&mut runtime, &session_id, pty_id)?;
    write_snapshot_to_state(state.inner(), runtime)?;
    Ok(())
}

#[tauri::command]
pub fn set_session_resume_token(
    state: tauri::State<'_, WorkspaceState>,
    session_id: String,
    resume_token: Option<String>,
) -> Result<(), String> {
    let mut runtime = snapshot_from_state(state.inner())?;
    set_session_resume_token_in_workspace(&mut runtime, &session_id, resume_token)?;
    write_snapshot_to_state(state.inner(), runtime)?;
    Ok(())
}

#[tauri::command]
pub fn clear_session_pty(
    state: tauri::State<'_, WorkspaceState>,
    session_id: String,
) -> Result<(), String> {
    let mut runtime = snapshot_from_state(state.inner())?;
    clear_session_pty_in_workspace(&mut runtime, &session_id)?;
    write_snapshot_to_state(state.inner(), runtime)?;
    Ok(())
}

#[tauri::command]
pub fn set_session_aux_terminal_state(
    state: tauri::State<'_, WorkspaceState>,
    session_id: String,
    aux_pty_id: Option<u32>,
    aux_visible: bool,
    aux_height_percent: Option<u16>,
) -> Result<(), String> {
    let mut runtime = snapshot_from_state(state.inner())?;
    set_session_aux_terminal_state_in_workspace(
        &mut runtime,
        &session_id,
        aux_pty_id,
        aux_visible,
        aux_height_percent,
    )?;
    write_snapshot_to_state(state.inner(), runtime)?;
    Ok(())
}

#[tauri::command]
pub fn update_window_geometry(
    app: AppHandle,
    state: tauri::State<'_, WorkspaceState>,
    label: String,
    x: i32,
    y: i32,
    width: u32,
    height: u32,
    maximized: bool,
) -> Result<(), String> {
    let mut runtime = snapshot_from_state(state.inner())?;
    update_window_geometry_in_workspace(&mut runtime, &label, x, y, width, height, maximized)?;
    write_snapshot_to_state(state.inner(), runtime.clone())?;
    write_workspace(&runtime)?;
    emit_workspace_updated(&app, &runtime)?;
    Ok(())
}

#[tauri::command]
pub fn open_empty_window(
    app: AppHandle,
    state: tauri::State<'_, WorkspaceState>,
    ready_state: tauri::State<'_, WindowReadyState>,
    x: i32,
    y: i32,
    width: u32,
    height: u32,
) -> Result<String, String> {
    let mut runtime = snapshot_from_state(state.inner())?;
    let new_label = next_available_window_label(&runtime);

    let window_snapshot = WindowSnapshot {
        label: new_label.clone(),
        name: new_label.clone(),
        role: "secondary".into(),
        tabs: Vec::new(),
        active_session_id: None,
        x,
        y,
        width: width.max(640),
        height: height.max(480),
        maximized: false,
    };

    runtime.windows.push(window_snapshot.clone());
    normalize_workspace_snapshot(&mut runtime);
    write_snapshot_to_state(state.inner(), runtime.clone())?;
    write_workspace(&runtime)?;
    ready_state.inner().mark_pending(&new_label)?;
    spawn_secondary_window_build(app.clone(), window_snapshot);
    emit_workspace_updated(&app, &runtime)?;
    Ok(new_label)
}

#[tauri::command]
pub fn detach_session_to_new_window(
    app: AppHandle,
    state: tauri::State<'_, WorkspaceState>,
    session_id: String,
    x: i32,
    y: i32,
    width: u32,
    height: u32,
) -> Result<(), String> {
    let mut runtime = snapshot_from_state(state.inner())?;
    let (tab, source_label) =
        remove_session_from_workspace(&mut runtime, &session_id).ok_or("Session not found")?;

    let new_label = next_available_window_label(&runtime);

    runtime.windows.push(WindowSnapshot {
        label: new_label.clone(),
        name: new_label.clone(),
        role: "secondary".into(),
        tabs: vec![tab],
        active_session_id: Some(session_id),
        x,
        y,
        width: width.max(640),
        height: height.max(480),
        maximized: false,
    });

    if let Some(source_window) = runtime
        .windows
        .iter_mut()
        .find(|window| window.label == source_label)
    {
        ensure_active_session(source_window);
    }

    let detached_window = runtime
        .windows
        .iter()
        .find(|window| window.label == new_label)
        .cloned()
        .ok_or("Detached window not found")?;

    write_snapshot_to_state(state.inner(), runtime.clone())?;
    write_workspace(&runtime)?;
    spawn_secondary_window_build(app.clone(), detached_window);
    emit_workspace_updated(&app, &runtime)?;
    Ok(())
}

#[tauri::command]
pub fn close_session(
    app: AppHandle,
    workspace_state: tauri::State<'_, WorkspaceState>,
    pty_state: tauri::State<'_, PtyState>,
    session_id: String,
) -> Result<(), String> {
    let mut runtime = snapshot_from_state(workspace_state.inner())?;
    let (tab, _) =
        remove_session_from_workspace(&mut runtime, &session_id).ok_or("Session not found")?;
    if let Some(pty_id) = tab.pty_id {
        super::pty::kill_pty_session(pty_state.inner(), pty_id)?;
    }
    if let Some(aux_pty_id) = tab.aux_pty_id {
        super::pty::kill_pty_session(pty_state.inner(), aux_pty_id)?;
    }
    write_snapshot_to_state(workspace_state.inner(), runtime.clone())?;
    write_workspace(&runtime)?;
    emit_workspace_updated(&app, &runtime)?;
    Ok(())
}

#[tauri::command]
pub fn close_session_by_pty(
    app: AppHandle,
    workspace_state: tauri::State<'_, WorkspaceState>,
    pty_state: tauri::State<'_, PtyState>,
    pty_id: u32,
) -> Result<(), String> {
    let mut runtime = snapshot_from_state(workspace_state.inner())?;
    let mut closed_session_id: Option<String> = None;

    for window in &mut runtime.windows {
        if let Some(index) = window
            .tabs
            .iter()
            .position(|tab| tab.pty_id == Some(pty_id))
        {
            closed_session_id = Some(window.tabs[index].session_id.clone());
            if let Some(aux_pty_id) = window.tabs[index].aux_pty_id {
                super::pty::kill_pty_session(pty_state.inner(), aux_pty_id)?;
            }
            window.tabs.remove(index);
            ensure_active_session(window);
            break;
        }
    }

    if closed_session_id.is_none() {
        return Ok(());
    }

    super::pty::kill_pty_session(pty_state.inner(), pty_id)?;
    write_snapshot_to_state(workspace_state.inner(), runtime.clone())?;
    write_workspace(&runtime)?;
    emit_workspace_updated(&app, &runtime)?;
    Ok(())
}

#[tauri::command]
pub fn move_window_sessions_to_main(
    app: AppHandle,
    state: tauri::State<'_, WorkspaceState>,
    ready_state: tauri::State<'_, WindowReadyState>,
    label: String,
) -> Result<(), String> {
    if label == "main" {
        return Ok(());
    }

    let mut runtime = snapshot_from_state(state.inner())?;
    let index = find_window_index(&runtime, &label).ok_or("Window not found")?;
    let window = runtime.windows.remove(index);
    let main_index = find_window_index(&runtime, "main").ok_or("Main window not found")?;

    let active_from_secondary = window.active_session_id.clone();
    runtime.windows[main_index].tabs.extend(window.tabs);
    if active_from_secondary.is_some() {
        runtime.windows[main_index].active_session_id = active_from_secondary;
    }
    ensure_active_session(&mut runtime.windows[main_index]);

    write_snapshot_to_state(state.inner(), runtime.clone())?;
    write_workspace(&runtime)?;
    ready_state.inner().remove(&label)?;
    emit_workspace_updated(&app, &runtime)?;
    Ok(())
}

#[tauri::command]
pub fn move_session_to_window(
    app: AppHandle,
    state: tauri::State<'_, WorkspaceState>,
    ready_state: tauri::State<'_, WindowReadyState>,
    session_id: String,
    target_label: String,
) -> Result<(), String> {
    let mut runtime = snapshot_from_state(state.inner())?;
    let (tab, source_label) =
        remove_session_from_workspace(&mut runtime, &session_id).ok_or("Session not found")?;

    if source_label == target_label {
        if let Some(source_index) = find_window_index(&runtime, &source_label) {
            runtime.windows[source_index].tabs.push(tab);
            ensure_active_session(&mut runtime.windows[source_index]);
        }
        write_snapshot_to_state(state.inner(), runtime)?;
        return Ok(());
    }

    let target_index =
        find_window_index(&runtime, &target_label).ok_or("Target window not found")?;
    runtime.windows[target_index].tabs.push(tab);
    runtime.windows[target_index].active_session_id = Some(session_id);
    ensure_active_session(&mut runtime.windows[target_index]);

    normalize_workspace_snapshot(&mut runtime);
    write_snapshot_to_state(state.inner(), runtime.clone())?;
    write_workspace(&runtime)?;

    if target_label != "main" && app.get_webview_window(&target_label).is_none() {
        let target_snapshot = runtime
            .windows
            .iter()
            .find(|window| window.label == target_label)
            .cloned()
            .ok_or("Target window snapshot not found")?;
        ready_state.inner().mark_pending(&target_label)?;
        spawn_secondary_window_build(app.clone(), target_snapshot);
    }

    if let Some(target_window) = app.get_webview_window(&target_label) {
        let _ = target_window.set_focus();
    }

    emit_workspace_updated(&app, &runtime)?;
    Ok(())
}

#[tauri::command]
pub fn close_window_sessions(
    app: AppHandle,
    workspace_state: tauri::State<'_, WorkspaceState>,
    pty_state: tauri::State<'_, PtyState>,
    ready_state: tauri::State<'_, WindowReadyState>,
    label: String,
) -> Result<(), String> {
    if label == "main" {
        return Ok(());
    }

    let mut runtime = snapshot_from_state(workspace_state.inner())?;
    let pty_ids = collect_window_ptys(&runtime, &label);
    let aux_pty_ids = runtime
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
    runtime.windows.retain(|window| window.label != label);
    normalize_workspace_snapshot(&mut runtime);

    for pty_id in pty_ids {
        super::pty::kill_pty_session(pty_state.inner(), pty_id)?;
    }
    for aux_pty_id in aux_pty_ids {
        super::pty::kill_pty_session(pty_state.inner(), aux_pty_id)?;
    }

    write_snapshot_to_state(workspace_state.inner(), runtime.clone())?;
    write_workspace(&runtime)?;
    ready_state.inner().remove(&label)?;
    emit_workspace_updated(&app, &runtime)?;
    Ok(())
}

#[tauri::command]
pub fn remove_window(
    app: AppHandle,
    state: tauri::State<'_, WorkspaceState>,
    ready_state: tauri::State<'_, WindowReadyState>,
    label: String,
) -> Result<(), String> {
    if label == "main" {
        return Ok(());
    }

    let mut runtime = snapshot_from_state(state.inner())?;
    runtime.windows.retain(|window| window.label != label);
    normalize_workspace_snapshot(&mut runtime);

    write_snapshot_to_state(state.inner(), runtime.clone())?;
    write_workspace(&runtime)?;
    ready_state.inner().remove(&label)?;
    emit_workspace_updated(&app, &runtime)?;
    Ok(())
}

#[tauri::command]
pub fn close_app(app: AppHandle) -> Result<(), String> {
    for window in app.webview_windows().into_values() {
        let _ = window.destroy();
    }
    app.cleanup_before_exit();
    std::process::exit(0);
}

#[tauri::command]
pub fn bootstrap_app(state: tauri::State<'_, WorkspaceState>) -> Result<AppBootstrap, String> {
    Ok(AppBootstrap {
        settings: load_settings_or_default(),
        tab_history: load_tab_history_or_default(),
        workspace: Some(snapshot_from_state(state.inner())?),
        theme_pack: load_theme_pack_or_default(),
        test_mode: is_test_mode(),
        debug_terminal_hooks: is_terminal_debug_hooks_enabled(),
        soft_follow_experiment: soft_follow_experiment_override(),
    })
}

#[tauri::command]
pub fn load_custom_css() -> Result<String, String> {
    load_custom_css_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::features::history::MIN_TAB_HISTORY_LIMIT;

    const EXAMPLE_DISTRO: &str = "ExampleDistro";
    const SECOND_DISTRO: &str = "SecondDistro";
    const EXAMPLE_PATH: &str = "/home/tester/work";
    const SECOND_PATH: &str = "/srv/app";
    use serde_json::json;

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

}

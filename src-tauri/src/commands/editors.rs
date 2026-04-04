use crate::app_env::is_test_mode;
use crate::commands::pty::{get_runtime_snapshot, PtyState};
use crate::commands::settings::{find_session_tab_snapshot, WorkspaceState, WorkspaceTabSnapshot};
use crate::commands::wsl::{list_wsl_files, search_wsl_files, WslState};
use serde::Serialize;
use std::collections::{HashMap, HashSet, VecDeque};
use std::env;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Arc, Condvar, Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x08000000;

#[cfg(windows)]
use windows::{
    core::PCWSTR,
    Win32::System::Registry::{
        RegCloseKey, RegOpenKeyExW, RegQueryValueExW, HKEY, HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE,
        KEY_READ, KEY_WOW64_32KEY, KEY_WOW64_64KEY, REG_SAM_FLAGS, REG_VALUE_TYPE,
    },
};

const SUPPORTED_EDITORS: &[&str] = &[
    "vscode",
    "cursor",
    "windsurf",
    "phpstorm",
    "notepadpp",
    "sublime",
];
static EDITOR_DETECTION_CACHE: OnceLock<Mutex<Option<Vec<DetectedEditor>>>> = OnceLock::new();
static SESSION_FILE_SEARCH_CACHE: OnceLock<Mutex<HashMap<String, CachedFileIndex>>> =
    OnceLock::new();
static SESSION_FILE_SEARCH_IN_FLIGHT: OnceLock<Mutex<HashMap<String, Arc<SearchIndexBuildState>>>> =
    OnceLock::new();

const MAX_SESSION_FILE_BYTES: u64 = 2 * 1024 * 1024;
const SEARCH_TEXT_SAMPLE_BYTES: u64 = 8 * 1024;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DetectedEditor {
    pub id: String,
    pub label: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedTerminalPath {
    pub raw: String,
    pub wsl_path: String,
    pub copy_text: String,
    pub windows_path: String,
    pub line: Option<u32>,
    pub column: Option<u32>,
    pub is_directory: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum TerminalPathResolution {
    Resolved {
        path: ResolvedTerminalPath,
    },
    Candidates {
        raw: String,
        candidates: Vec<ResolvedTerminalPath>,
    },
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SessionFileMatch {
    pub wsl_path: String,
    pub relative_path: String,
    pub basename: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SessionFileSearchResponse {
    pub root_dir: String,
    pub results: Vec<SessionFileMatch>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SessionFileListResponse {
    pub root_dir: String,
    pub results: Vec<SessionFileMatch>,
    pub last_updated_ms: u64,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SessionFileReadResponse {
    pub wsl_path: String,
    pub content: String,
    pub language_id: String,
    pub size_bytes: u64,
    pub mtime_ms: u64,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SessionFileWriteResponse {
    pub wsl_path: String,
    pub size_bytes: u64,
    pub mtime_ms: u64,
}

#[derive(Debug, Clone)]
struct CachedFileEntry {
    wsl_path: String,
    relative_path: String,
    basename: String,
    basename_lower: String,
    relative_lower: String,
}

#[derive(Debug, Clone)]
struct CachedFileIndex {
    entries: Vec<CachedFileEntry>,
    last_updated_ms: u64,
}

#[derive(Debug)]
struct SearchIndexBuildState {
    status: Mutex<SearchIndexBuildStatus>,
    ready: Condvar,
}

#[derive(Debug)]
enum SearchIndexBuildStatus {
    Building,
    Ready(Result<CachedFileIndex, String>),
}

fn editor_label(editor_id: &str) -> &'static str {
    match editor_id {
        "vscode" => "VS Code",
        "cursor" => "Cursor",
        "windsurf" => "Windsurf",
        "phpstorm" => "PhpStorm",
        "notepadpp" => "Notepad++",
        "sublime" => "Sublime Text",
        _ => "Editor",
    }
}

fn normalize_editor_id(value: &str) -> Option<&'static str> {
    let normalized = value.trim().to_ascii_lowercase();
    SUPPORTED_EDITORS
        .iter()
        .copied()
        .find(|candidate| *candidate == normalized)
}

fn editor_cli_names(editor_id: &str) -> &'static [&'static str] {
    match editor_id {
        "vscode" => &["code", "code-insiders", "Code.exe"],
        "cursor" => &["cursor", "Cursor.exe"],
        "windsurf" => &["windsurf", "Windsurf.exe"],
        "phpstorm" => &["PhpStorm.cmd", "PhpStorm", "phpstorm64.exe", "phpstorm.exe"],
        "notepadpp" => &["notepad++", "notepad++.exe"],
        "sublime" => &["subl", "sublime_text", "sublime_text.exe"],
        _ => &[],
    }
}

fn editor_override_var(editor_id: &str) -> String {
    format!(
        "CLCOMX_WIN_EDITOR_{}_PATH",
        editor_id
            .chars()
            .map(|ch| if ch.is_ascii_alphanumeric() {
                ch.to_ascii_uppercase()
            } else {
                '_'
            })
            .collect::<String>()
    )
}

fn env_path(name: &str) -> Option<PathBuf> {
    env::var_os(name).map(PathBuf::from)
}

fn editor_search_roots(editor_id: &str) -> Vec<PathBuf> {
    let mut roots = Vec::new();

    let local_app_data = env_path("LOCALAPPDATA");
    let program_files = env_path("ProgramFiles");
    let program_files_x86 = env_path("ProgramFiles(x86)");

    match editor_id {
        "vscode" => {
            if let Some(base) = &local_app_data {
                roots.push(base.join("Programs"));
            }
            if let Some(base) = &program_files {
                roots.push(base.clone());
            }
            if let Some(base) = &program_files_x86 {
                roots.push(base.clone());
            }
        }
        "cursor" | "windsurf" => {
            if let Some(base) = &local_app_data {
                roots.push(base.join("Programs"));
            }
            if let Some(base) = &program_files {
                roots.push(base.clone());
            }
        }
        "phpstorm" => {
            if let Some(base) = &local_app_data {
                roots.push(base.join("JetBrains").join("Toolbox").join("scripts"));
                roots.push(base.join("JetBrains").join("Toolbox").join("apps"));
                roots.push(base.join("Programs"));
            }
            if let Some(base) = &program_files {
                roots.push(base.join("JetBrains"));
            }
            if let Some(base) = &program_files_x86 {
                roots.push(base.join("JetBrains"));
            }
        }
        "notepadpp" => {
            if let Some(base) = &program_files {
                roots.push(base.clone());
            }
            if let Some(base) = &program_files_x86 {
                roots.push(base.clone());
            }
        }
        "sublime" => {
            if let Some(base) = &local_app_data {
                roots.push(base.join("Programs"));
            }
            if let Some(base) = &program_files {
                roots.push(base.clone());
            }
            if let Some(base) = &program_files_x86 {
                roots.push(base.clone());
            }
        }
        _ => {}
    }

    roots
}

fn editor_known_paths(editor_id: &str) -> Vec<PathBuf> {
    let mut candidates = Vec::new();

    let local_app_data = env_path("LOCALAPPDATA");
    let program_files = env_path("ProgramFiles");
    let program_files_x86 = env_path("ProgramFiles(x86)");

    match editor_id {
        "vscode" => {
            if let Some(base) = &local_app_data {
                candidates.push(
                    base.join("Programs")
                        .join("Microsoft VS Code")
                        .join("Code.exe"),
                );
            }
            if let Some(base) = &program_files {
                candidates.push(base.join("Microsoft VS Code").join("Code.exe"));
            }
            if let Some(base) = &program_files_x86 {
                candidates.push(base.join("Microsoft VS Code").join("Code.exe"));
            }
        }
        "cursor" => {
            if let Some(base) = &local_app_data {
                candidates.push(base.join("Programs").join("Cursor").join("Cursor.exe"));
            }
            if let Some(base) = &program_files {
                candidates.push(base.join("Cursor").join("Cursor.exe"));
            }
        }
        "windsurf" => {
            if let Some(base) = &local_app_data {
                candidates.push(base.join("Programs").join("Windsurf").join("Windsurf.exe"));
            }
            if let Some(base) = &program_files {
                candidates.push(base.join("Windsurf").join("Windsurf.exe"));
            }
        }
        "phpstorm" => {
            if let Some(base) = &local_app_data {
                candidates.push(
                    base.join("JetBrains")
                        .join("Toolbox")
                        .join("scripts")
                        .join("PhpStorm.cmd"),
                );
                candidates.push(
                    base.join("Programs")
                        .join("PhpStorm")
                        .join("bin")
                        .join("phpstorm64.exe"),
                );
                candidates.push(
                    base.join("Programs")
                        .join("PhpStorm")
                        .join("bin")
                        .join("phpstorm.bat"),
                );
            }
            if let Some(base) = &program_files {
                candidates.push(
                    base.join("JetBrains")
                        .join("PhpStorm")
                        .join("bin")
                        .join("phpstorm64.exe"),
                );
                candidates.push(
                    base.join("JetBrains")
                        .join("PhpStorm")
                        .join("bin")
                        .join("phpstorm.bat"),
                );
            }
            if let Some(base) = &program_files_x86 {
                candidates.push(
                    base.join("JetBrains")
                        .join("PhpStorm")
                        .join("bin")
                        .join("phpstorm64.exe"),
                );
                candidates.push(
                    base.join("JetBrains")
                        .join("PhpStorm")
                        .join("bin")
                        .join("phpstorm.bat"),
                );
            }
        }
        "notepadpp" => {
            if let Some(base) = &program_files {
                candidates.push(base.join("Notepad++").join("notepad++.exe"));
            }
            if let Some(base) = &program_files_x86 {
                candidates.push(base.join("Notepad++").join("notepad++.exe"));
            }
        }
        "sublime" => {
            if let Some(base) = &local_app_data {
                candidates.push(
                    base.join("Programs")
                        .join("Sublime Text")
                        .join("sublime_text.exe"),
                );
            }
            if let Some(base) = &program_files {
                candidates.push(base.join("Sublime Text").join("sublime_text.exe"));
                candidates.push(base.join("Sublime Text 3").join("sublime_text.exe"));
            }
        }
        _ => {}
    }

    candidates
}

fn file_name_matches_editor(path: &Path, names: &[&str]) -> bool {
    let Some(file_name) = path.file_name().and_then(|value| value.to_str()) else {
        return false;
    };

    names
        .iter()
        .any(|name| file_name.eq_ignore_ascii_case(name))
}

#[cfg(windows)]
fn app_paths_registry_names(editor_id: &str) -> Vec<&'static str> {
    let mut names: Vec<&'static str> = editor_cli_names(editor_id)
        .iter()
        .copied()
        .filter(|name| name.to_ascii_lowercase().ends_with(".exe"))
        .collect();

    if editor_id == "phpstorm" {
        names.push("PhpStorm.exe");
    }

    names.sort_unstable();
    names.dedup();
    names
}

#[cfg(windows)]
fn app_paths_registry_subkeys(editor_id: &str) -> Vec<String> {
    app_paths_registry_names(editor_id)
        .into_iter()
        .flat_map(|exe_name| {
            [
                format!(r"Software\Microsoft\Windows\CurrentVersion\App Paths\{exe_name}"),
                format!(
                    r"Software\WOW6432Node\Microsoft\Windows\CurrentVersion\App Paths\{exe_name}"
                ),
            ]
        })
        .collect()
}

#[cfg(windows)]
fn registry_string_value(root: HKEY, subkey: &str, sam: u32) -> Option<String> {
    unsafe {
        let mut opened = HKEY::default();
        let subkey_wide = encode_editor_registry_wide(subkey);

        if RegOpenKeyExW(
            root,
            PCWSTR::from_raw(subkey_wide.as_ptr()),
            Some(0),
            KEY_READ | REG_SAM_FLAGS(sam),
            &mut opened,
        )
        .is_err()
        {
            return None;
        }

        let mut value_type = REG_VALUE_TYPE(0);
        let mut byte_len = 0u32;
        if RegQueryValueExW(
            opened,
            PCWSTR::null(),
            None,
            Some(&mut value_type),
            None,
            Some(&mut byte_len),
        )
        .is_err()
            || byte_len == 0
        {
            let _ = RegCloseKey(opened);
            return None;
        }

        let mut buffer = vec![0u8; byte_len as usize];
        let query_result = RegQueryValueExW(
            opened,
            PCWSTR::null(),
            None,
            Some(&mut value_type),
            Some(buffer.as_mut_ptr()),
            Some(&mut byte_len),
        );
        let _ = RegCloseKey(opened);

        if query_result.is_err() {
            return None;
        }

        let u16_len = (byte_len as usize) / 2;
        let wide = std::slice::from_raw_parts(buffer.as_ptr() as *const u16, u16_len);
        let value = String::from_utf16_lossy(wide)
            .trim_end_matches('\0')
            .trim()
            .to_string();

        if value.is_empty() {
            None
        } else {
            Some(value)
        }
    }
}

#[cfg(windows)]
fn registry_app_path(editor_id: &str) -> Option<PathBuf> {
    let roots = [HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE];
    let views = [KEY_WOW64_64KEY, KEY_WOW64_32KEY, REG_SAM_FLAGS(0)];

    for subkey in app_paths_registry_subkeys(editor_id) {
        for root in roots {
            for sam in views {
                let Some(value) = registry_string_value(root, &subkey, sam.0) else {
                    continue;
                };

                let candidate = PathBuf::from(value.trim_matches('"'));
                if candidate.exists() {
                    return Some(candidate);
                }
            }
        }
    }

    None
}

#[cfg(not(windows))]
fn registry_app_path(_editor_id: &str) -> Option<PathBuf> {
    None
}

#[cfg(windows)]
fn encode_editor_registry_wide(value: &str) -> Vec<u16> {
    value.encode_utf16().chain(std::iter::once(0)).collect()
}

fn search_editor_binary_in_roots(editor_id: &str, max_depth: usize) -> Option<PathBuf> {
    let names = editor_cli_names(editor_id);
    if names.is_empty() {
        return None;
    }

    let mut stack: Vec<(PathBuf, usize)> = editor_search_roots(editor_id)
        .into_iter()
        .filter(|root| root.exists())
        .map(|root| (root, 0usize))
        .collect();

    while let Some((dir, depth)) = stack.pop() {
        let Ok(entries) = fs::read_dir(&dir) else {
            continue;
        };

        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_file() && file_name_matches_editor(&path, names) {
                return Some(path);
            }

            if depth < max_depth && path.is_dir() {
                stack.push((path, depth + 1));
            }
        }
    }

    None
}

#[cfg(windows)]
fn where_first(names: &[&str]) -> Option<PathBuf> {
    for name in names {
        let mut command = Command::new("where.exe");
        command.arg(name).creation_flags(CREATE_NO_WINDOW);

        let Ok(output) = command.output() else {
            continue;
        };
        if !output.status.success() {
            continue;
        }

        let text = String::from_utf8_lossy(&output.stdout);
        for line in text.lines() {
            let candidate = PathBuf::from(line.trim());
            if candidate.exists() {
                return Some(candidate);
            }
        }
    }

    None
}

#[cfg(not(windows))]
fn where_first(_names: &[&str]) -> Option<PathBuf> {
    None
}

fn detect_editor_binary(editor_id: &str) -> Option<PathBuf> {
    if is_test_mode() {
        return Some(PathBuf::from(format!(r"C:\Mock\{}.exe", editor_id)));
    }

    if let Some(path) = env::var_os(editor_override_var(editor_id))
        .map(PathBuf::from)
        .filter(|candidate| candidate.exists())
    {
        return Some(path);
    }

    if let Some(path) = where_first(editor_cli_names(editor_id)) {
        return Some(path);
    }

    if let Some(path) = editor_known_paths(editor_id)
        .into_iter()
        .find(|candidate| candidate.exists())
    {
        return Some(path);
    }

    if let Some(path) = registry_app_path(editor_id) {
        return Some(path);
    }

    search_editor_binary_in_roots(editor_id, 3)
}

fn detect_available_editors() -> Vec<DetectedEditor> {
    let cache = EDITOR_DETECTION_CACHE.get_or_init(|| Mutex::new(None));
    if let Ok(guard) = cache.lock() {
        if let Some(editors) = guard.as_ref() {
            return editors.clone();
        }
    }

    let detected = SUPPORTED_EDITORS
        .iter()
        .copied()
        .filter(|editor_id| detect_editor_binary(editor_id).is_some())
        .map(|editor_id| DetectedEditor {
            id: editor_id.to_string(),
            label: editor_label(editor_id).to_string(),
        })
        .collect::<Vec<_>>();

    if let Ok(mut guard) = cache.lock() {
        *guard = Some(detected.clone());
    }

    detected
}

fn parse_line_and_column(value: &str) -> (String, Option<u32>, Option<u32>) {
    let trimmed = value.trim();

    if let Some(parsed) = parse_colon_line_and_column(trimmed) {
        return parsed;
    }

    if let Some(parsed) = parse_wrapped_line_and_column(trimmed, '(', ')') {
        return parsed;
    }

    if let Some(parsed) = parse_wrapped_line_and_column(trimmed, '[', ']') {
        return parsed;
    }

    (trimmed.to_string(), None, None)
}

fn parse_colon_line_and_column(value: &str) -> Option<(String, Option<u32>, Option<u32>)> {
    let (before_column, column_part) = value.rsplit_once(':')?;
    let parsed_column = column_part.parse::<u32>().ok()?;

    if let Some((before_line, line_part)) = before_column.rsplit_once(':') {
        if let Ok(parsed_line) = line_part.parse::<u32>() {
            return Some((
                before_line.to_string(),
                Some(parsed_line),
                Some(parsed_column),
            ));
        }
    }

    Some((before_column.to_string(), Some(parsed_column), None))
}

fn parse_wrapped_line_and_column(
    value: &str,
    open: char,
    close: char,
) -> Option<(String, Option<u32>, Option<u32>)> {
    let trimmed = value.trim_end();
    if !trimmed.ends_with(close) {
        return None;
    }

    let open_index = trimmed.rfind(open)?;
    if open_index == 0 {
        return None;
    }

    let content = trimmed[open_index + 1..trimmed.len() - 1].trim();
    if content.is_empty() {
        return None;
    }

    let (path, line, column) = if let Some((line_part, column_part)) = content.split_once(',') {
        let line = line_part.trim().parse::<u32>().ok()?;
        let column = column_part.trim().parse::<u32>().ok()?;
        (
            trimmed[..open_index].trim_end().to_string(),
            Some(line),
            Some(column),
        )
    } else {
        let line = content.parse::<u32>().ok()?;
        (
            trimmed[..open_index].trim_end().to_string(),
            Some(line),
            None,
        )
    };

    Some((path, line, column))
}

fn normalize_posix_path(value: &str) -> String {
    let absolute = value.starts_with('/');
    let mut parts: Vec<&str> = Vec::new();

    for segment in value.split('/') {
        match segment {
            "" | "." => {}
            ".." => {
                parts.pop();
            }
            other => parts.push(other),
        }
    }

    if absolute {
        if parts.is_empty() {
            "/".into()
        } else {
            format!("/{}", parts.join("/"))
        }
    } else if parts.is_empty() {
        ".".into()
    } else {
        parts.join("/")
    }
}

fn derive_home_dir(work_dir: &str) -> Option<String> {
    let mut segments = work_dir.split('/').filter(|segment| !segment.is_empty());
    match (segments.next(), segments.next()) {
        (Some("home"), Some(user)) if !user.trim().is_empty() => Some(format!("/home/{user}")),
        _ => None,
    }
}

fn resolve_home_dir_from(home_dir: Option<&str>, work_dir: &str) -> Option<String> {
    if let Some(home) = home_dir
        .map(|value| value.trim())
        .filter(|value| value.starts_with('/') && !value.is_empty())
    {
        return Some(normalize_posix_path(home));
    }

    derive_home_dir(work_dir)
}

fn workspace_context_matches(tab: &WorkspaceTabSnapshot, distro: &str, work_dir: &str) -> bool {
    let requested_distro = distro.trim();
    if !requested_distro.is_empty() && !tab.distro.trim().eq_ignore_ascii_case(requested_distro) {
        return false;
    }

    let requested_work_dir = work_dir.trim();
    if !requested_work_dir.is_empty()
        && normalize_posix_path(&tab.work_dir) != normalize_posix_path(requested_work_dir)
    {
        return false;
    }

    true
}

fn session_home_dir(
    workspace_state: Option<&WorkspaceState>,
    pty_state: Option<&PtyState>,
    session_id: Option<&str>,
    distro: &str,
    work_dir: &str,
) -> Option<String> {
    let session_id = session_id
        .map(str::trim)
        .filter(|value| !value.is_empty())?;
    let workspace_state = workspace_state?;
    let pty_state = pty_state?;
    let tab = find_session_tab_snapshot(workspace_state, session_id)
        .ok()
        .flatten()?;

    if !workspace_context_matches(&tab, distro, work_dir) {
        return None;
    }

    let pty_id = tab.pty_id?;
    get_runtime_snapshot(pty_state, pty_id)
        .ok()
        .and_then(|snapshot| snapshot.home_dir)
}

fn resolve_effective_home_dir(
    workspace_state: Option<&WorkspaceState>,
    pty_state: Option<&PtyState>,
    session_id: Option<&str>,
    home_dir_hint: Option<&str>,
    distro: &str,
    work_dir: &str,
) -> Option<String> {
    if let Some(home_dir) =
        session_home_dir(workspace_state, pty_state, session_id, distro, work_dir)
    {
        return Some(home_dir);
    }

    if let Some(home_dir) = resolve_home_dir_from(home_dir_hint, work_dir) {
        return Some(home_dir);
    }

    if is_test_mode() {
        return env::var_os("HOME").and_then(|value| value.into_string().ok());
    }

    None
}

fn resolve_wsl_path_from(
    home_dir: Option<&str>,
    raw_path: &str,
    work_dir: &str,
) -> Result<String, String> {
    let trimmed = raw_path.trim();

    if trimmed == "~" {
        return resolve_home_dir_from(home_dir, work_dir)
            .ok_or_else(|| "Failed to resolve home directory for '~' path".to_string());
    }

    if let Some(rest) = trimmed.strip_prefix("~/") {
        let home_dir = resolve_home_dir_from(home_dir, work_dir)
            .ok_or_else(|| format!("Failed to resolve home directory for path: {trimmed}"))?;
        return Ok(normalize_posix_path(&format!("{home_dir}/{rest}")));
    }

    if trimmed.starts_with('/') {
        return Ok(normalize_posix_path(trimmed));
    }

    let base = if work_dir.trim().is_empty() {
        "/".into()
    } else {
        work_dir.trim().to_string()
    };

    Ok(normalize_posix_path(&format!(
        "{}/{}",
        base.trim_end_matches('/'),
        trimmed
    )))
}

fn wsl_path_to_windows(path: &str, distro: &str) -> Result<String, String> {
    if distro.trim().is_empty() {
        return Err("WSL distro is required".into());
    }

    if let Some(rest) = path.strip_prefix("/mnt/") {
        let mut segments = rest.splitn(2, '/');
        let drive = segments
            .next()
            .ok_or("Failed to resolve Windows drive from /mnt path")?;
        if drive.len() != 1 {
            return Err("Unsupported /mnt path".into());
        }

        let drive_letter = drive.chars().next().unwrap().to_ascii_uppercase();
        let tail = segments.next().unwrap_or("").replace('/', "\\");
        return Ok(if tail.is_empty() {
            format!(r"{drive_letter}:\")
        } else {
            format!(r"{drive_letter}:\{tail}")
        });
    }

    let rest = path.trim_start_matches('/');
    Ok(if rest.is_empty() {
        format!(r"\\wsl.localhost\{distro}")
    } else {
        format!(r"\\wsl.localhost\{distro}\{}", rest.replace('/', "\\"))
    })
}

#[cfg(not(windows))]
fn canonicalize_wsl_path_for_access(path: &str, _distro: &str) -> Option<String> {
    fs::canonicalize(path)
        .ok()
        .map(|resolved| normalize_posix_path(&resolved.to_string_lossy()))
}

#[cfg(windows)]
fn canonicalize_wsl_path_for_access(path: &str, distro: &str) -> Option<String> {
    if path.trim().is_empty() || distro.trim().is_empty() {
        return None;
    }

    let mut command = Command::new("wsl.exe");
    command.args([
        "-d",
        distro.trim(),
        "-e",
        "sh",
        "-lc",
        "if command -v realpath >/dev/null 2>&1; then realpath -e -- \"$1\"; else readlink -f -- \"$1\"; fi",
        "clcomx-path-canonicalize",
        path,
    ]);
    command.creation_flags(CREATE_NO_WINDOW);

    let output = command.output().ok()?;
    if !output.status.success() {
        return None;
    }

    output
        .stdout
        .split(|byte| *byte == b'\n' || *byte == b'\r')
        .find_map(|line| {
            let value = String::from_utf8_lossy(line).trim().to_string();
            if value.is_empty() {
                None
            } else {
                Some(normalize_posix_path(&value))
            }
        })
}

fn resolve_existing_windows_path(
    wsl_path: &str,
    distro: &str,
) -> Result<(String, fs::Metadata), String> {
    let windows_path = wsl_path_to_windows(wsl_path, distro)?;
    if let Ok(metadata) = std::fs::metadata(&windows_path) {
        return Ok((windows_path, metadata));
    }

    if let Some(canonical_wsl_path) =
        canonicalize_wsl_path_for_access(wsl_path, distro).filter(|value| value != wsl_path)
    {
        let canonical_windows_path = wsl_path_to_windows(&canonical_wsl_path, distro)?;
        if let Ok(metadata) = std::fs::metadata(&canonical_windows_path) {
            return Ok((canonical_windows_path, metadata));
        }

        #[cfg(not(windows))]
        if let Ok(metadata) = std::fs::metadata(&canonical_wsl_path) {
            return Ok((canonical_windows_path, metadata));
        }
    }

    #[cfg(not(windows))]
    if let Ok(metadata) = std::fs::metadata(wsl_path) {
        return Ok((windows_path, metadata));
    }

    Err(format!("Path does not exist: {wsl_path}"))
}

fn resolve_existing_access_path(
    wsl_path: &str,
    distro: &str,
) -> Result<(PathBuf, fs::Metadata), String> {
    #[cfg(windows)]
    {
        let windows_path = wsl_path_to_windows(wsl_path, distro)?;
        if let Ok(metadata) = fs::metadata(&windows_path) {
            return Ok((PathBuf::from(windows_path), metadata));
        }

        if let Some(canonical_wsl_path) =
            canonicalize_wsl_path_for_access(wsl_path, distro).filter(|value| value != wsl_path)
        {
            let canonical_windows_path = wsl_path_to_windows(&canonical_wsl_path, distro)?;
            if let Ok(metadata) = fs::metadata(&canonical_windows_path) {
                return Ok((PathBuf::from(canonical_windows_path), metadata));
            }
        }
    }

    #[cfg(not(windows))]
    {
        let direct = PathBuf::from(wsl_path);
        if let Ok(metadata) = fs::metadata(&direct) {
            return Ok((direct, metadata));
        }

        if let Some(canonical_wsl_path) =
            canonicalize_wsl_path_for_access(wsl_path, distro).filter(|value| value != wsl_path)
        {
            let canonical = PathBuf::from(canonical_wsl_path);
            if let Ok(metadata) = fs::metadata(&canonical) {
                return Ok((canonical, metadata));
            }
        }
    }

    Err(format!("Path does not exist: {wsl_path}"))
}

fn normalize_root_dir(root_dir: &str, work_dir: &str) -> String {
    if root_dir.trim().is_empty() {
        return normalize_posix_path(work_dir);
    }

    normalize_posix_path(root_dir)
}

fn path_is_within_root(path: &str, root: &str) -> bool {
    let normalized_path = normalize_posix_path(path);
    let normalized_root = normalize_posix_path(root);

    if normalized_root == "/" {
        return normalized_path.starts_with('/');
    }

    normalized_path == normalized_root
        || normalized_path
            .strip_prefix(&format!("{normalized_root}/"))
            .is_some()
}

fn session_root_violation(session_tab: &WorkspaceTabSnapshot) -> String {
    format!(
        "Path must stay within the session working directory: {}",
        session_tab.work_dir
    )
}

fn ensure_session_file_allowed(
    wsl_path: &str,
    session_tab: &WorkspaceTabSnapshot,
) -> Result<String, String> {
    let normalized_path = normalize_posix_path(wsl_path);
    let session_root = normalize_posix_path(&session_tab.work_dir);
    if !path_is_within_root(&normalized_path, &session_root) {
        return Err(session_root_violation(session_tab));
    }

    Ok(normalized_path)
}

fn ensure_search_root_allowed(
    root_dir: &str,
    session_tab: &WorkspaceTabSnapshot,
) -> Result<String, String> {
    let normalized_root = normalize_root_dir(root_dir, &session_tab.work_dir);
    let session_root = normalize_posix_path(&session_tab.work_dir);

    if !path_is_within_root(&normalized_root, &session_root) {
        return Err(format!(
            "Search root must stay within the session working directory: {}",
            session_tab.work_dir
        ));
    }

    Ok(normalized_root)
}

fn canonical_access_path(path: &Path) -> PathBuf {
    fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf())
}

fn access_path_is_within_root(path: &Path, root: &Path) -> bool {
    let canonical_path = canonical_access_path(path);
    let canonical_root = canonical_access_path(root);
    canonical_path == canonical_root || canonical_path.starts_with(&canonical_root)
}

#[allow(dead_code)]
fn access_path_is_within_canonical_root(path: &Path, canonical_root: &Path) -> bool {
    let canonical_path = canonical_access_path(path);
    canonical_path == canonical_root || canonical_path.starts_with(canonical_root)
}

fn ensure_resolved_path_within_session_root(
    session_tab: &WorkspaceTabSnapshot,
    normalized_path: &str,
    access_path: &Path,
) -> Result<(), String> {
    let session_root = normalize_posix_path(&session_tab.work_dir);
    if !path_is_within_root(normalized_path, &session_root) {
        return Err(session_root_violation(session_tab));
    }

    let (root_access_path, root_metadata) =
        resolve_existing_access_path(&session_root, &session_tab.distro)?;
    if !root_metadata.is_dir() {
        return Err(format!(
            "Session working directory is not a directory: {}",
            session_tab.work_dir
        ));
    }

    if access_path_is_within_root(access_path, &root_access_path) {
        return Ok(());
    }

    Err(session_root_violation(session_tab))
}

fn ensure_text_file_policy_from_metadata(metadata: &fs::Metadata) -> Result<(), String> {
    if metadata.len() > MAX_SESSION_FILE_BYTES {
        return Err("FileTooLarge".into());
    }

    Ok(())
}

fn sniff_file_is_binary(path: &Path) -> Result<bool, String> {
    let mut file = fs::File::open(path)
        .map_err(|error| format!("Failed to read {}: {error}", path.display()))?;
    let mut buffer = [0u8; SEARCH_TEXT_SAMPLE_BYTES as usize];
    let read = file
        .read(&mut buffer)
        .map_err(|error| format!("Failed to read {}: {error}", path.display()))?;
    Ok(is_binary_bytes(&buffer[..read]))
}

fn ensure_text_file_policy(path: &Path, metadata: &fs::Metadata) -> Result<(), String> {
    ensure_text_file_policy_from_metadata(metadata)?;
    if sniff_file_is_binary(path)? {
        return Err("BinaryFile".into());
    }

    Ok(())
}

#[allow(dead_code)]
fn is_likely_text_path(path: &str) -> bool {
    let basename = basename_for_path(path);
    if basename.eq_ignore_ascii_case("Dockerfile") {
        return true;
    }

    matches!(
        Path::new(&basename)
            .extension()
            .and_then(|value| value.to_str())
            .unwrap_or("")
            .to_ascii_lowercase()
            .as_str(),
        "ts"
            | "tsx"
            | "js"
            | "jsx"
            | "json"
            | "rs"
            | "md"
            | "py"
            | "sh"
            | "svelte"
            | "toml"
            | "yml"
            | "yaml"
            | "html"
            | "css"
            | "scss"
            | "txt"
            | "lock"
            | "xml"
            | "svg"
    )
}

fn file_search_cache() -> &'static Mutex<HashMap<String, CachedFileIndex>> {
    SESSION_FILE_SEARCH_CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn file_search_in_flight() -> &'static Mutex<HashMap<String, Arc<SearchIndexBuildState>>> {
    SESSION_FILE_SEARCH_IN_FLIGHT.get_or_init(|| Mutex::new(HashMap::new()))
}

fn cache_key(session_id: &str, root_dir: &str) -> String {
    format!("{}::{}", session_id.trim(), normalize_posix_path(root_dir))
}

fn current_time_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .ok()
        .map(|value| u64::try_from(value.as_millis()).unwrap_or(u64::MAX))
        .unwrap_or(0)
}

fn cache_index(
    entries: Vec<CachedFileEntry>,
) -> CachedFileIndex {
    CachedFileIndex {
        entries,
        last_updated_ms: current_time_ms(),
    }
}

fn begin_search_index_build(key: &str) -> (Arc<SearchIndexBuildState>, bool) {
    if let Ok(mut in_flight) = file_search_in_flight().lock() {
        if let Some(state) = in_flight.get(key) {
            return (state.clone(), false);
        }

        let state = Arc::new(SearchIndexBuildState {
            status: Mutex::new(SearchIndexBuildStatus::Building),
            ready: Condvar::new(),
        });
        in_flight.insert(key.to_string(), state.clone());
        return (state, true);
    }

    (
        Arc::new(SearchIndexBuildState {
            status: Mutex::new(SearchIndexBuildStatus::Building),
            ready: Condvar::new(),
        }),
        true,
    )
}

fn wait_for_search_index_build(
    state: &Arc<SearchIndexBuildState>,
) -> Result<CachedFileIndex, String> {
    let mut guard = state
        .status
        .lock()
        .map_err(|error| format!("Search index wait lock failed: {error}"))?;

    loop {
        match &*guard {
            SearchIndexBuildStatus::Building => {
                guard = state
                    .ready
                    .wait(guard)
                    .map_err(|error| format!("Search index wait failed: {error}"))?;
            }
            SearchIndexBuildStatus::Ready(result) => return result.clone(),
        }
    }
}

fn finish_search_index_build(
    key: &str,
    state: &Arc<SearchIndexBuildState>,
    result: Result<CachedFileIndex, String>,
) {
    if let Ok(mut guard) = state.status.lock() {
        *guard = SearchIndexBuildStatus::Ready(result.clone());
    }
    state.ready.notify_all();

    if let Ok(mut in_flight) = file_search_in_flight().lock() {
        if let Some(existing) = in_flight.get(key) {
            if Arc::ptr_eq(existing, state) {
                in_flight.remove(key);
            }
        }
    }
}

fn build_search_index_cache_once<F>(
    session_id: &str,
    root_dir: &str,
    build: F,
) -> Result<CachedFileIndex, String>
where
    F: FnOnce() -> Result<CachedFileIndex, String>,
{
    let key = cache_key(session_id, root_dir);
    let (state, is_leader) = begin_search_index_build(&key);

    if !is_leader {
        return wait_for_search_index_build(&state);
    }

    let result = build();
    if let Ok(index) = &result {
        if let Ok(mut cache) = file_search_cache().lock() {
            cache.insert(key.clone(), index.clone());
        }
    }
    finish_search_index_build(&key, &state, result.clone());
    result
}

fn upsert_search_cache_path(session_id: &str, wsl_path: &str) {
    let normalized_path = normalize_posix_path(wsl_path);
    let basename = basename_for_path(&normalized_path);
    if let Ok(mut cache) = file_search_cache().lock() {
        for (key, index) in cache.iter_mut() {
            let Some((cached_session_id, cached_root)) = key.split_once("::") else {
                continue;
            };
            if cached_session_id != session_id.trim() {
                continue;
            }
            if !path_is_within_root(&normalized_path, cached_root) {
                continue;
            }

            let relative_path = relative_wsl_path(cached_root, &normalized_path);
            if let Some(entry) = index.entries.iter_mut().find(|entry| entry.wsl_path == normalized_path) {
                entry.relative_path = relative_path.clone();
                entry.relative_lower = relative_path.to_ascii_lowercase();
                entry.basename = basename.clone();
                entry.basename_lower = basename.to_ascii_lowercase();
            } else {
                index.entries.push(CachedFileEntry {
                    wsl_path: normalized_path.clone(),
                    relative_path: relative_path.clone(),
                    basename: basename.clone(),
                    basename_lower: basename.to_ascii_lowercase(),
                    relative_lower: relative_path.to_ascii_lowercase(),
                });
            }
            index.last_updated_ms = current_time_ms();
        }
    }
}

fn trim_terminal_token(value: &str) -> String {
    let mut trimmed = value.trim();

    loop {
        let Some(first) = trimmed.chars().next() else {
            break;
        };
        let Some(last) = trimmed.chars().next_back() else {
            break;
        };

        let removable_pair = matches!((first, last), ('"', '"') | ('\'', '\'') | ('`', '`'))
            || matches!(
                (first, last),
                ('(', ')') | ('[', ']') | ('{', '}') | ('<', '>')
            );

        if !removable_pair || trimmed.len() < 2 {
            break;
        }

        trimmed = trimmed[1..trimmed.len() - 1].trim();
    }

    trimmed.to_string()
}

fn build_copy_text(path: &str, line: Option<u32>, column: Option<u32>) -> String {
    match (line, column) {
        (Some(line), Some(column)) => format!("{path}:{line}:{column}"),
        (Some(line), None) => format!("{path}:{line}"),
        _ => path.to_string(),
    }
}

fn is_bare_filename_candidate(raw_path: &str) -> bool {
    let trimmed = raw_path.trim();
    if trimmed.is_empty()
        || trimmed == "."
        || trimmed == ".."
        || trimmed.starts_with("~/")
        || trimmed.starts_with('/')
        || trimmed.starts_with("\\\\")
    {
        return false;
    }

    if trimmed.len() >= 2 {
        let bytes = trimmed.as_bytes();
        if bytes[1] == b':' && bytes[0].is_ascii_alphabetic() {
            return false;
        }
    }

    !trimmed.contains('/') && !trimmed.contains('\\')
}

fn is_heavy_directory_name(name: &str) -> bool {
    matches!(
        name.to_ascii_lowercase().as_str(),
        ".git"
            | "node_modules"
            | "target"
            | "dist"
            | "build"
            | "coverage"
            | ".next"
            | ".svelte-kit"
    )
}

fn sorted_directory_entries(dir: &Path) -> Vec<fs::DirEntry> {
    let Ok(entries) = fs::read_dir(dir) else {
        return Vec::new();
    };

    let mut entries = entries.flatten().collect::<Vec<_>>();
    entries.sort_by(|left, right| {
        let left_name = left.file_name().to_string_lossy().to_ascii_lowercase();
        let right_name = right.file_name().to_string_lossy().to_ascii_lowercase();
        left_name.cmp(&right_name)
    });
    entries
}

fn collect_bare_filename_matches(
    work_dir: &str,
    basename: &str,
    max_depth: usize,
    max_results: usize,
) -> Vec<PathBuf> {
    let root = Path::new(work_dir);
    if basename.trim().is_empty() || !root.exists() {
        return Vec::new();
    }

    let mut queue: VecDeque<(PathBuf, usize)> = VecDeque::from([(root.to_path_buf(), 0usize)]);
    let mut matches = Vec::new();

    while let Some((dir, depth)) = queue.pop_front() {
        if matches.len() >= max_results {
            break;
        }

        for entry in sorted_directory_entries(&dir) {
            let path = entry.path();
            let Ok(file_type) = entry.file_type() else {
                continue;
            };

            if path
                .file_name()
                .and_then(|value| value.to_str())
                .is_some_and(|name| name == basename)
            {
                matches.push(path.clone());
                if matches.len() >= max_results {
                    break;
                }
            }

            if depth >= max_depth || !file_type.is_dir() {
                continue;
            }

            let Some(name) = path.file_name().and_then(|value| value.to_str()) else {
                continue;
            };
            if is_heavy_directory_name(name) {
                continue;
            }

            queue.push_back((path, depth + 1));
        }
    }

    matches.sort_by(|left, right| {
        candidate_sort_key(root, left).cmp(&candidate_sort_key(root, right))
    });
    matches
}

fn candidate_sort_key(root: &Path, path: &Path) -> (usize, usize, usize, String) {
    let relative = path.strip_prefix(root).unwrap_or(path);
    let relative_string = relative.to_string_lossy().to_string();
    let component_count = relative.components().count();
    let is_directory = path.is_dir() as usize;
    (
        component_count,
        relative_string.len(),
        is_directory,
        relative_string.to_ascii_lowercase(),
    )
}

fn relative_wsl_path(root_dir: &str, path: &str) -> String {
    let normalized_root = normalize_posix_path(root_dir);
    let normalized_path = normalize_posix_path(path);
    if normalized_path == normalized_root {
        return ".".into();
    }

    if normalized_root == "/" {
        return normalized_path.trim_start_matches('/').to_string();
    }

    normalized_path
        .strip_prefix(&format!("{normalized_root}/"))
        .unwrap_or(normalized_path.as_str())
        .to_string()
}

fn basename_for_path(path: &str) -> String {
    Path::new(path)
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or(path)
        .to_string()
}

fn session_tab_context(
    workspace_state: &WorkspaceState,
    session_id: &str,
) -> Result<WorkspaceTabSnapshot, String> {
    find_session_tab_snapshot(workspace_state, session_id)?
        .ok_or_else(|| format!("Unknown session: {session_id}"))
}

fn is_binary_bytes(bytes: &[u8]) -> bool {
    bytes.contains(&0)
}

fn read_text_file_with_policy(path: &Path, metadata: &fs::Metadata) -> Result<(String, u64), String> {
    ensure_text_file_policy_from_metadata(metadata)?;
    let bytes =
        fs::read(path).map_err(|error| format!("Failed to read {}: {error}", path.display()))?;

    let size_bytes = u64::try_from(bytes.len()).unwrap_or(u64::MAX);
    if is_binary_bytes(&bytes) {
        return Err("BinaryFile".into());
    }

    let content = String::from_utf8(bytes).map_err(|_| "BinaryFile".to_string())?;
    Ok((content, size_bytes))
}

fn metadata_mtime_ms(metadata: &fs::Metadata) -> u64 {
    metadata
        .modified()
        .ok()
        .and_then(|value| value.duration_since(UNIX_EPOCH).ok())
        .map(|value| u64::try_from(value.as_millis()).unwrap_or(u64::MAX))
        .unwrap_or(0)
}

fn infer_language_id(wsl_path: &str) -> String {
    let basename = basename_for_path(wsl_path);
    if basename.eq_ignore_ascii_case("Dockerfile") {
        return "dockerfile".into();
    }
    if basename.to_ascii_lowercase().ends_with(".blade.php") {
        return "php".into();
    }

    match Path::new(&basename)
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_ascii_lowercase()
        .as_str()
    {
        "ts" => "typescript".into(),
        "tsx" => "typescriptreact".into(),
        "js" => "javascript".into(),
        "jsx" => "javascriptreact".into(),
        "php" | "phtml" => "php".into(),
        "json" => "json".into(),
        "rs" => "rust".into(),
        "md" => "markdown".into(),
        "py" => "python".into(),
        "sh" => "shell".into(),
        "svelte" => "svelte".into(),
        "toml" => "toml".into(),
        "yml" | "yaml" => "yaml".into(),
        "html" => "html".into(),
        "css" => "css".into(),
        "scss" => "scss".into(),
        "txt" => "plaintext".into(),
        _ => "plaintext".into(),
    }
}

fn access_path_to_wsl_path(access_root: &Path, root_dir: &str, file_path: &Path) -> Option<String> {
    let relative = file_path.strip_prefix(access_root).ok()?;
    let relative = relative.to_string_lossy().replace('\\', "/");
    if relative.is_empty() {
        return Some(normalize_posix_path(root_dir));
    }

    Some(normalize_posix_path(&format!(
        "{}/{}",
        normalize_posix_path(root_dir).trim_end_matches('/'),
        relative
    )))
}

fn collect_search_index_entries(
    root_dir: &str,
    distro: &str,
) -> Result<Vec<CachedFileEntry>, String> {
    let (access_root, metadata) = resolve_existing_access_path(root_dir, distro)?;
    if !metadata.is_dir() {
        return Err(format!("Search root is not a directory: {root_dir}"));
    }

    let mut queue: VecDeque<PathBuf> = VecDeque::from([access_root.clone()]);
    let mut entries = Vec::new();

    while let Some(dir) = queue.pop_front() {
        for entry in sorted_directory_entries(&dir) {
            let path = entry.path();
            let Ok(file_type) = entry.file_type() else {
                continue;
            };

            if file_type.is_dir() {
                let Some(name) = path.file_name().and_then(|value| value.to_str()) else {
                    continue;
                };
                if is_heavy_directory_name(name) {
                    continue;
                }
                queue.push_back(path);
                continue;
            }

            if !file_type.is_file() {
                continue;
            }

            let Ok(metadata) = entry.metadata() else {
                continue;
            };
            if ensure_text_file_policy(&path, &metadata).is_err() {
                continue;
            }

            let Some(wsl_path) = access_path_to_wsl_path(&access_root, root_dir, &path) else {
                continue;
            };
            let relative_path = relative_wsl_path(root_dir, &wsl_path);
            let basename = basename_for_path(&wsl_path);
            entries.push(CachedFileEntry {
                basename_lower: basename.to_ascii_lowercase(),
                relative_lower: relative_path.to_ascii_lowercase(),
                wsl_path,
                relative_path,
                basename,
            });
        }
    }

    Ok(entries)
}

fn ensure_search_index(
    session_id: &str,
    root_dir: &str,
    distro: &str,
) -> Result<Vec<CachedFileEntry>, String> {
    Ok(ensure_search_index_cache(session_id, root_dir, distro)?.entries)
}

fn ensure_search_index_cache(
    session_id: &str,
    root_dir: &str,
    distro: &str,
) -> Result<CachedFileIndex, String> {
    let key = cache_key(session_id, root_dir);
    if let Ok(cache) = file_search_cache().lock() {
        if let Some(index) = cache.get(&key) {
            return Ok(index.clone());
        }
    }

    build_search_index_cache_once(session_id, root_dir, || {
        let entries = collect_search_index_entries(root_dir, distro)?;
        Ok(cache_index(entries))
    })
}

#[cfg(not(windows))]
fn build_search_entries_from_relative_candidates(
    session_tab: &WorkspaceTabSnapshot,
    normalized_root: &str,
    relative_candidates: &[String],
) -> Vec<CachedFileEntry> {
    relative_candidates
        .iter()
        .filter_map(|relative_path| {
            let trimmed = relative_path.trim().trim_start_matches("./");
            if trimmed.is_empty() {
                return None;
            }

            let wsl_path = normalize_posix_path(&format!(
                "{}/{}",
                normalized_root.trim_end_matches('/'),
                trimmed
            ));
            let (access_path, metadata) =
                resolve_existing_access_path(&wsl_path, &session_tab.distro).ok()?;
            ensure_resolved_path_within_session_root(session_tab, &wsl_path, &access_path).ok()?;
            if !metadata.is_file() {
                return None;
            }
            ensure_text_file_policy(&access_path, &metadata).ok()?;

            let relative_path = relative_wsl_path(normalized_root, &wsl_path);
            let basename = basename_for_path(&wsl_path);
            Some(CachedFileEntry {
                basename_lower: basename.to_ascii_lowercase(),
                relative_lower: relative_path.to_ascii_lowercase(),
                wsl_path,
                relative_path,
                basename,
            })
        })
        .collect()
}

#[cfg(windows)]
fn is_safe_relative_search_candidate(relative_path: &str) -> bool {
    use std::path::Component;

    let path = Path::new(relative_path);
    path.components().all(|component| {
        matches!(component, Component::Normal(_) | Component::CurDir)
    })
}

fn build_cached_entries_from_relative_candidates(
    normalized_root: &str,
    relative_candidates: &[String],
) -> Vec<CachedFileEntry> {
    let mut entries = Vec::new();
    let mut seen = HashSet::new();

    for relative_path in relative_candidates {
        let trimmed = relative_path.trim().trim_start_matches("./");
        if trimmed.is_empty() {
            continue;
        }
        #[cfg(windows)]
        if !is_safe_relative_search_candidate(trimmed) {
            continue;
        }

        let wsl_path = normalize_posix_path(&format!(
            "{}/{}",
            normalized_root.trim_end_matches('/'),
            trimmed
        ));
        if !seen.insert(wsl_path.clone()) {
            continue;
        }

        let relative_path = relative_wsl_path(normalized_root, &wsl_path);
        let basename = basename_for_path(&wsl_path);
        entries.push(CachedFileEntry {
            basename_lower: basename.to_ascii_lowercase(),
            relative_lower: relative_path.to_ascii_lowercase(),
            wsl_path,
            relative_path,
            basename,
        });
    }

    entries
}

#[cfg(windows)]
fn build_ranked_search_entries_from_relative_candidates(
    _session_tab: &WorkspaceTabSnapshot,
    normalized_root: &str,
    root_access_path: &Path,
    canonical_root_access_path: &Path,
    relative_candidates: &[String],
    max_results: usize,
) -> Vec<CachedFileEntry> {
    let mut entries = Vec::new();

    for relative_path in relative_candidates {
        let trimmed = relative_path.trim().trim_start_matches("./");
        if trimmed.is_empty() || !is_safe_relative_search_candidate(trimmed) {
            continue;
        }

        let candidate_access_path =
            root_access_path.join(trimmed.replace('/', &std::path::MAIN_SEPARATOR.to_string()));
        let Ok(metadata) = fs::symlink_metadata(&candidate_access_path) else {
            continue;
        };
        if metadata.file_type().is_symlink() || !metadata.is_file() {
            continue;
        }
        if !access_path_is_within_canonical_root(&candidate_access_path, canonical_root_access_path)
        {
            continue;
        }
        if ensure_text_file_policy_from_metadata(&metadata).is_err() {
            continue;
        }
        if !is_likely_text_path(trimmed)
            && sniff_file_is_binary(&candidate_access_path).unwrap_or(true)
        {
            continue;
        }

        let wsl_path = normalize_posix_path(&format!(
            "{}/{}",
            normalized_root.trim_end_matches('/'),
            trimmed
        ));
        let basename = basename_for_path(&wsl_path);
        let relative_path = relative_wsl_path(normalized_root, &wsl_path);
        entries.push(CachedFileEntry {
            basename_lower: basename.to_ascii_lowercase(),
            relative_lower: relative_path.to_ascii_lowercase(),
            wsl_path,
            relative_path,
            basename,
        });

        if entries.len() >= max_results {
            break;
        }
    }

    entries
}

#[cfg(not(windows))]
fn build_ranked_search_entries_from_relative_candidates(
    session_tab: &WorkspaceTabSnapshot,
    normalized_root: &str,
    _root_access_path: &Path,
    _canonical_root_access_path: &Path,
    relative_candidates: &[String],
    max_results: usize,
) -> Vec<CachedFileEntry> {
    build_search_entries_from_relative_candidates(session_tab, normalized_root, relative_candidates)
        .into_iter()
        .take(max_results)
        .collect()
}

fn search_rank(
    entry: &CachedFileEntry,
    query_lower: &str,
) -> Option<(usize, usize, usize, usize, String)> {
    if query_lower.is_empty() {
        return Some((
            4,
            entry.relative_path.matches('/').count(),
            entry.relative_path.len(),
            entry.basename.len(),
            entry.relative_lower.clone(),
        ));
    }

    let bucket = if entry.basename_lower == query_lower {
        0
    } else if entry.basename_lower.starts_with(query_lower) {
        1
    } else if entry.basename_lower.contains(query_lower) {
        2
    } else if entry.relative_lower.contains(query_lower) {
        3
    } else {
        return None;
    };

    Some((
        bucket,
        entry.relative_path.matches('/').count(),
        entry.relative_path.len(),
        entry.basename.len(),
        entry.relative_lower.clone(),
    ))
}

fn list_session_files_with_state(
    workspace_state: &WorkspaceState,
    wsl_state: Option<&WslState>,
    session_id: &str,
    root_dir: &str,
    force_refresh: bool,
) -> Result<SessionFileListResponse, String> {
    let session_tab = session_tab_context(workspace_state, session_id)?;
    let normalized_root = ensure_search_root_allowed(root_dir, &session_tab)?;

    if !force_refresh {
        let key = cache_key(session_id, &normalized_root);
        if let Ok(cache) = file_search_cache().lock() {
            if let Some(index) = cache.get(&key) {
                return Ok(SessionFileListResponse {
                    root_dir: normalized_root,
                    results: index
                        .entries
                        .iter()
                        .map(|entry| SessionFileMatch {
                            wsl_path: entry.wsl_path.clone(),
                            relative_path: entry.relative_path.clone(),
                            basename: entry.basename.clone(),
                        })
                        .collect(),
                    last_updated_ms: index.last_updated_ms,
                });
            }
        }
    }

    let (root_access_path, root_metadata) =
        resolve_existing_access_path(&normalized_root, &session_tab.distro)?;
    if !root_metadata.is_dir() {
        return Err(format!("Search root is not a directory: {normalized_root}"));
    }
    ensure_resolved_path_within_session_root(&session_tab, &normalized_root, &root_access_path)?;

    let index = if cfg!(test) || !cfg!(windows) {
        if force_refresh {
            build_search_index_cache_once(session_id, &normalized_root, || {
                let entries = collect_search_index_entries(&normalized_root, &session_tab.distro)?;
                Ok(cache_index(entries))
            })?
        } else {
            ensure_search_index_cache(session_id, &normalized_root, &session_tab.distro)?
        }
    } else {
        build_search_index_cache_once(session_id, &normalized_root, || {
            let relative_candidates = list_wsl_files(
                wsl_state.ok_or("WSL state is unavailable")?,
                &session_tab.distro,
                &normalized_root,
            )?;
            Ok(cache_index(build_cached_entries_from_relative_candidates(
                &normalized_root,
                &relative_candidates,
            )))
        })?
    };

    Ok(SessionFileListResponse {
        root_dir: normalized_root,
        results: index
            .entries
            .iter()
            .map(|entry| SessionFileMatch {
                wsl_path: entry.wsl_path.clone(),
                relative_path: entry.relative_path.clone(),
                basename: entry.basename.clone(),
            })
            .collect(),
        last_updated_ms: index.last_updated_ms,
    })
}

fn search_session_files_with_state(
    workspace_state: &WorkspaceState,
    wsl_state: Option<&WslState>,
    session_id: &str,
    root_dir: &str,
    query: &str,
    limit: Option<u16>,
) -> Result<SessionFileSearchResponse, String> {
    let session_tab = session_tab_context(workspace_state, session_id)?;
    let normalized_root = ensure_search_root_allowed(root_dir, &session_tab)?;
    let trimmed_query = query.trim();
    if trimmed_query.is_empty() {
        return Ok(SessionFileSearchResponse {
            root_dir: normalized_root,
            results: Vec::new(),
        });
    }

    let (root_access_path, root_metadata) =
        resolve_existing_access_path(&normalized_root, &session_tab.distro)?;
    if !root_metadata.is_dir() {
        return Err(format!("Search root is not a directory: {normalized_root}"));
    }
    ensure_resolved_path_within_session_root(&session_tab, &normalized_root, &root_access_path)?;

    let max_results = usize::from(limit.unwrap_or(80).clamp(1, 200));
    let query_lower = trimmed_query.to_ascii_lowercase();

    let entries = if cfg!(test) || !cfg!(windows) {
        ensure_search_index(session_id, &normalized_root, &session_tab.distro)?
    } else {
        let canonical_root_access_path = canonical_access_path(&root_access_path);
        let shell_limit = max_results
            .saturating_mul(4)
            .clamp(max_results.saturating_add(20), 400);
        let relative_candidates = search_wsl_files(
            wsl_state.ok_or("WSL state is unavailable")?,
            &session_tab.distro,
            &normalized_root,
            trimmed_query,
            shell_limit,
        )?;
        build_ranked_search_entries_from_relative_candidates(
            &session_tab,
            &normalized_root,
            &root_access_path,
            &canonical_root_access_path,
            &relative_candidates,
            max_results,
        )
    };

    Ok(SessionFileSearchResponse {
        root_dir: normalized_root,
        results: if cfg!(windows) && !cfg!(test) {
            entries
                .into_iter()
                .take(max_results)
                .map(|entry| SessionFileMatch {
                    wsl_path: entry.wsl_path,
                    relative_path: entry.relative_path,
                    basename: entry.basename,
                })
                .collect()
        } else {
            let mut results = entries
                .iter()
                .filter_map(|entry| search_rank(entry, &query_lower).map(|rank| (rank, entry)))
                .collect::<Vec<_>>();
            results.sort_by(|left, right| left.0.cmp(&right.0));
            results
                .into_iter()
                .take(max_results)
                .map(|(_, entry)| SessionFileMatch {
                    wsl_path: entry.wsl_path.clone(),
                    relative_path: entry.relative_path.clone(),
                    basename: entry.basename.clone(),
                })
                .collect()
        },
    })
}

fn read_session_file_with_state(
    workspace_state: &WorkspaceState,
    session_id: &str,
    wsl_path: &str,
) -> Result<SessionFileReadResponse, String> {
    let session_tab = session_tab_context(workspace_state, session_id)?;
    let normalized_path = ensure_session_file_allowed(wsl_path, &session_tab)?;
    let (access_path, metadata) =
        resolve_existing_access_path(&normalized_path, &session_tab.distro)?;
    ensure_resolved_path_within_session_root(&session_tab, &normalized_path, &access_path)?;
    if !metadata.is_file() {
        return Err(format!("Path is not a file: {normalized_path}"));
    }

    let (content, size_bytes) = read_text_file_with_policy(&access_path, &metadata)?;

    Ok(SessionFileReadResponse {
        wsl_path: normalized_path.clone(),
        content,
        language_id: infer_language_id(&normalized_path),
        size_bytes,
        mtime_ms: metadata_mtime_ms(&metadata),
    })
}

fn write_session_file_with_state(
    workspace_state: &WorkspaceState,
    session_id: &str,
    wsl_path: &str,
    content: &str,
    expected_mtime_ms: u64,
) -> Result<SessionFileWriteResponse, String> {
    let session_tab = session_tab_context(workspace_state, session_id)?;
    let normalized_path = ensure_session_file_allowed(wsl_path, &session_tab)?;
    let (access_path, metadata) =
        resolve_existing_access_path(&normalized_path, &session_tab.distro)?;
    ensure_resolved_path_within_session_root(&session_tab, &normalized_path, &access_path)?;
    if !metadata.is_file() {
        return Err(format!("Path is not a file: {normalized_path}"));
    }

    let current_mtime_ms = metadata_mtime_ms(&metadata);
    if current_mtime_ms != expected_mtime_ms {
        return Err("FileModifiedOnDisk".into());
    }

    read_text_file_with_policy(&access_path, &metadata).map(|_| ())?;

    let content_bytes = content.as_bytes();
    let size_bytes = u64::try_from(content_bytes.len()).unwrap_or(u64::MAX);
    if size_bytes > MAX_SESSION_FILE_BYTES {
        return Err("FileTooLarge".into());
    }

    fs::write(&access_path, content_bytes)
        .map_err(|error| format!("Failed to write {}: {error}", access_path.display()))?;

    let metadata = fs::metadata(&access_path)
        .map_err(|error| format!("Failed to stat {}: {error}", access_path.display()))?;

    upsert_search_cache_path(session_id, &normalized_path);

    Ok(SessionFileWriteResponse {
        wsl_path: normalized_path,
        size_bytes: u64::try_from(metadata.len()).unwrap_or(u64::MAX),
        mtime_ms: metadata_mtime_ms(&metadata),
    })
}

fn resolve_terminal_path_record(
    raw: &str,
    wsl_path: String,
    line: Option<u32>,
    column: Option<u32>,
    distro: &str,
) -> Result<ResolvedTerminalPath, String> {
    let (windows_path, metadata) = resolve_existing_windows_path(&wsl_path, distro)?;

    Ok(ResolvedTerminalPath {
        raw: raw.to_string(),
        copy_text: build_copy_text(&wsl_path, line, column),
        wsl_path,
        windows_path,
        line,
        column,
        is_directory: metadata.is_dir(),
    })
}

fn spawn_editor_process(
    editor_id: &str,
    executable: &Path,
    windows_path: &str,
    line: Option<u32>,
    column: Option<u32>,
    is_directory: bool,
) -> Result<(), String> {
    if is_directory && editor_id == "notepadpp" {
        return Err("Notepad++ cannot open folders".into());
    }

    let mut command = Command::new(executable);

    #[cfg(windows)]
    command.creation_flags(CREATE_NO_WINDOW);

    match editor_id {
        "vscode" | "cursor" | "windsurf" => {
            if is_directory {
                command.arg(windows_path);
            } else if let Some(line) = line {
                let column = column.unwrap_or(1);
                command.args(["--goto", &format!("{windows_path}:{line}:{column}")]);
            } else {
                command.arg(windows_path);
            }
        }
        "sublime" => {
            if is_directory {
                command.arg(windows_path);
            } else if let Some(line) = line {
                let column = column.unwrap_or(1);
                command.arg(format!("{windows_path}:{line}:{column}"));
            } else {
                command.arg(windows_path);
            }
        }
        "phpstorm" => {
            if let Some(line) = line {
                command.args(["--line", &line.to_string()]);
            }
            command.arg(windows_path);
        }
        "notepadpp" => {
            if let Some(line) = line {
                command.arg(format!("-n{line}"));
            }
            if let Some(column) = column {
                command.arg(format!("-c{column}"));
            }
            command.arg(windows_path);
        }
        _ => return Err("Unsupported editor".into()),
    }

    command
        .spawn()
        .map_err(|error| format!("Failed to launch {}: {error}", editor_label(editor_id)))?;

    Ok(())
}

#[tauri::command]
pub async fn list_available_editors() -> Result<Vec<DetectedEditor>, String> {
    tauri::async_runtime::spawn_blocking(detect_available_editors)
        .await
        .map_err(|error| format!("Editor detection task failed: {error}"))
}

fn resolve_terminal_path_with_state(
    workspace_state: Option<&WorkspaceState>,
    pty_state: Option<&PtyState>,
    raw: String,
    distro: String,
    work_dir: String,
    session_id: Option<String>,
    home_dir_hint: Option<String>,
) -> Result<TerminalPathResolution, String> {
    let cleaned = trim_terminal_token(&raw);
    if cleaned.is_empty() {
        return Err("Path is empty".into());
    }

    let (raw_path, line, column) = parse_line_and_column(&cleaned);
    let effective_home_dir = resolve_effective_home_dir(
        workspace_state,
        pty_state,
        session_id.as_deref(),
        home_dir_hint.as_deref(),
        &distro,
        &work_dir,
    );
    let direct_wsl_path =
        resolve_wsl_path_from(effective_home_dir.as_deref(), &raw_path, &work_dir)?;

    if let Ok(path) = resolve_terminal_path_record(&cleaned, direct_wsl_path, line, column, &distro)
    {
        return Ok(TerminalPathResolution::Resolved { path });
    }

    if !is_bare_filename_candidate(&raw_path) {
        return Err(format!(
            "Path does not exist: {}",
            resolve_wsl_path_from(effective_home_dir.as_deref(), &raw_path, &work_dir)?
        ));
    }

    let matches = collect_bare_filename_matches(&work_dir, &raw_path, 8, 16);
    if matches.is_empty() {
        return Err(format!(
            "Path does not exist: {}",
            resolve_wsl_path_from(effective_home_dir.as_deref(), &raw_path, &work_dir)?
        ));
    }

    let mut candidates = matches
        .into_iter()
        .filter_map(|candidate| {
            let normalized = normalize_posix_path(&candidate.to_string_lossy());
            resolve_terminal_path_record(&cleaned, normalized, line, column, &distro).ok()
        })
        .collect::<Vec<_>>();

    if candidates.is_empty() {
        return Err(format!(
            "Path does not exist: {}",
            resolve_wsl_path_from(effective_home_dir.as_deref(), &raw_path, &work_dir)?
        ));
    }

    if candidates.len() == 1 {
        let path = candidates.remove(0);
        return Ok(TerminalPathResolution::Resolved { path });
    }

    Ok(TerminalPathResolution::Candidates {
        raw: cleaned,
        candidates,
    })
}

#[tauri::command]
pub fn resolve_terminal_path(
    workspace_state: tauri::State<'_, WorkspaceState>,
    pty_state: tauri::State<'_, PtyState>,
    raw: String,
    distro: String,
    work_dir: String,
    session_id: Option<String>,
    home_dir_hint: Option<String>,
) -> Result<TerminalPathResolution, String> {
    resolve_terminal_path_with_state(
        Some(workspace_state.inner()),
        Some(pty_state.inner()),
        raw,
        distro,
        work_dir,
        session_id,
        home_dir_hint,
    )
}

#[tauri::command]
pub fn search_session_files(
    workspace_state: tauri::State<'_, WorkspaceState>,
    wsl_state: tauri::State<'_, WslState>,
    session_id: String,
    root_dir: String,
    query: String,
    limit: Option<u16>,
) -> Result<SessionFileSearchResponse, String> {
    search_session_files_with_state(
        workspace_state.inner(),
        Some(wsl_state.inner()),
        &session_id,
        &root_dir,
        &query,
        limit,
    )
}

#[tauri::command]
pub fn list_session_files(
    workspace_state: tauri::State<'_, WorkspaceState>,
    wsl_state: tauri::State<'_, WslState>,
    session_id: String,
    root_dir: String,
    force_refresh: Option<bool>,
) -> Result<SessionFileListResponse, String> {
    list_session_files_with_state(
        workspace_state.inner(),
        Some(wsl_state.inner()),
        &session_id,
        &root_dir,
        force_refresh.unwrap_or(false),
    )
}

#[tauri::command]
pub fn read_session_file(
    workspace_state: tauri::State<'_, WorkspaceState>,
    session_id: String,
    wsl_path: String,
) -> Result<SessionFileReadResponse, String> {
    read_session_file_with_state(workspace_state.inner(), &session_id, &wsl_path)
}

#[tauri::command]
pub fn write_session_file(
    workspace_state: tauri::State<'_, WorkspaceState>,
    session_id: String,
    wsl_path: String,
    content: String,
    expected_mtime_ms: u64,
) -> Result<SessionFileWriteResponse, String> {
    write_session_file_with_state(
        workspace_state.inner(),
        &session_id,
        &wsl_path,
        &content,
        expected_mtime_ms,
    )
}

#[tauri::command]
pub fn open_in_editor(
    editor_id: String,
    windows_path: String,
    line: Option<u32>,
    column: Option<u32>,
    is_directory: bool,
) -> Result<(), String> {
    let normalized_editor_id =
        normalize_editor_id(&editor_id).ok_or("Unsupported editor".to_string())?;

    if is_test_mode() {
        if detect_editor_binary(normalized_editor_id).is_none() {
            return Err("Editor is not available".into());
        }
        return Ok(());
    }

    let executable = detect_editor_binary(normalized_editor_id)
        .ok_or_else(|| format!("{} is not installed", editor_label(normalized_editor_id)))?;

    if !Path::new(&windows_path).exists() {
        return Err(format!("Path does not exist: {windows_path}"));
    }

    spawn_editor_process(
        normalized_editor_id,
        &executable,
        &windows_path,
        line,
        column,
        is_directory,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn workspace_state_with_session(
        session_id: &str,
        distro: &str,
        work_dir: &str,
        pty_id: Option<u32>,
    ) -> WorkspaceState {
        let tab = crate::commands::settings::WorkspaceTabSnapshot {
            session_id: session_id.to_string(),
            agent_id: "claude".into(),
            distro: distro.to_string(),
            work_dir: work_dir.to_string(),
            title: "session".into(),
            pinned: false,
            locked: false,
            resume_token: None,
            pty_id,
            aux_pty_id: None,
            aux_visible: false,
            aux_height_percent: None,
            view_mode: "terminal".into(),
            editor_root_dir: work_dir.to_string(),
            open_editor_tabs: Vec::new(),
            active_editor_path: None,
        };

        let window = crate::commands::settings::WindowSnapshot {
            label: "main".into(),
            name: "main".into(),
            role: "main".into(),
            tabs: vec![tab],
            active_session_id: Some(session_id.to_string()),
            x: 0,
            y: 0,
            width: 1024,
            height: 720,
            maximized: false,
        };

        WorkspaceState::new(crate::commands::settings::WorkspaceSnapshot {
            windows: vec![window],
        })
    }

    #[test]
    fn parses_line_and_column_suffixes() {
        assert_eq!(
            parse_line_and_column("src/App.svelte:12:4"),
            ("src/App.svelte".into(), Some(12), Some(4))
        );
        assert_eq!(
            parse_line_and_column("Cargo.toml:8"),
            ("Cargo.toml".into(), Some(8), None)
        );
        assert_eq!(
            parse_line_and_column("/home/tester/work/file.ts"),
            ("/home/tester/work/file.ts".into(), None, None)
        );
        assert_eq!(
            parse_line_and_column("src/front/index.ts(12,3)"),
            ("src/front/index.ts".into(), Some(12), Some(3))
        );
        assert_eq!(
            parse_line_and_column("src/front/index.ts[12,3]"),
            ("src/front/index.ts".into(), Some(12), Some(3))
        );
    }

    #[test]
    fn preserves_wrapped_tokens_without_stripping_suffix_brackets() {
        assert_eq!(trim_terminal_token("(../README.md:4)"), "../README.md:4");
        assert_eq!(
            trim_terminal_token("'src/App.svelte:12:3'"),
            "src/App.svelte:12:3"
        );
        assert_eq!(trim_terminal_token("foo.ts(12,3)"), "foo.ts(12,3)");
    }

    #[test]
    fn detects_bare_filename_candidates_only_without_path_separators() {
        assert!(is_bare_filename_candidate("index.ts"));
        assert!(is_bare_filename_candidate("Cargo.toml"));
        assert!(!is_bare_filename_candidate("src/index.ts"));
        assert!(!is_bare_filename_candidate("~/index.ts"));
        assert!(!is_bare_filename_candidate(r"C:\index.ts"));
        assert!(!is_bare_filename_candidate(
            r"\\wsl.localhost\Ubuntu-20.04\index.ts"
        ));
    }

    #[test]
    fn collects_bare_filename_matches_in_shortest_relative_path_order() {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time went backwards")
            .as_nanos();
        let root = env::temp_dir().join(format!("clcomx-path-resolution-{unique}"));

        fs::create_dir_all(root.join("src/front")).unwrap();
        fs::create_dir_all(root.join("src/admin")).unwrap();
        fs::create_dir_all(root.join("node_modules")).unwrap();
        fs::create_dir_all(root.join("deep/nested")).unwrap();

        fs::write(root.join("src/front/index.ts"), "front").unwrap();
        fs::write(root.join("src/admin/index.ts"), "admin").unwrap();
        fs::write(root.join("node_modules/index.ts"), "skip").unwrap();
        fs::write(root.join("deep/nested/index.ts"), "nested").unwrap();

        let matches = collect_bare_filename_matches(root.to_str().unwrap(), "index.ts", 8, 16);
        let relative_paths = matches
            .iter()
            .map(|path| {
                path.strip_prefix(&root)
                    .unwrap()
                    .to_string_lossy()
                    .replace('\\', "/")
            })
            .collect::<Vec<_>>();

        assert_eq!(
            relative_paths,
            vec![
                "src/admin/index.ts".to_string(),
                "src/front/index.ts".to_string(),
                "deep/nested/index.ts".to_string(),
            ]
        );

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn resolves_bare_filename_to_candidates_when_multiple_matches_exist() {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time went backwards")
            .as_nanos();
        let root = env::temp_dir().join(format!("clcomx-path-resolution-resolve-{unique}"));

        fs::create_dir_all(root.join("alpha")).unwrap();
        fs::create_dir_all(root.join("beta/nested")).unwrap();
        fs::write(root.join("alpha/settings.toml"), "alpha").unwrap();
        fs::write(root.join("beta/nested/settings.toml"), "beta").unwrap();

        let result = resolve_terminal_path_with_state(
            None,
            None,
            "settings.toml".into(),
            "Ubuntu-20.04".into(),
            root.to_str().unwrap().into(),
            None,
            None,
        )
        .expect("resolution should succeed");

        match result {
            TerminalPathResolution::Candidates { raw, candidates } => {
                assert_eq!(raw, "settings.toml");
                assert_eq!(candidates.len(), 2);
                assert!(candidates[0].wsl_path.ends_with("alpha/settings.toml"));
                assert!(candidates[1]
                    .wsl_path
                    .ends_with("beta/nested/settings.toml"));
                assert!(candidates.iter().all(|candidate| candidate.line.is_none()));
            }
            other => panic!("expected candidates, got {other:?}"),
        }

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn resolves_relative_and_home_paths() {
        assert_eq!(
            resolve_wsl_path_from(None, "src/App.svelte", "/home/tester/work/clcomx").unwrap(),
            "/home/tester/work/clcomx/src/App.svelte"
        );
        assert_eq!(
            resolve_wsl_path_from(None, "../README.md", "/home/tester/work/clcomx/src").unwrap(),
            "/home/tester/work/clcomx/README.md"
        );
        assert_eq!(
            resolve_wsl_path_from(None, "~/notes/todo.md", "/home/tester/work/clcomx").unwrap(),
            "/home/tester/notes/todo.md"
        );
    }

    #[test]
    fn prefers_home_env_for_tilde_paths_when_workdir_is_outside_home() {
        assert_eq!(
            resolve_home_dir_from(Some("/home/tester"), "/mnt/c/Users/tester/project"),
            Some("/home/tester".into())
        );
        assert_eq!(
            resolve_wsl_path_from(
                Some("/home/tester"),
                "~/.claude/skills/code-quality-review/SKILL.md",
                "/mnt/c/Users/tester/project"
            )
            .unwrap(),
            "/home/tester/.claude/skills/code-quality-review/SKILL.md"
        );
    }

    #[test]
    fn fails_tilde_resolution_when_home_cannot_be_determined() {
        assert_eq!(
            resolve_home_dir_from(None, "/mnt/c/Users/tester/project"),
            None
        );
        assert!(resolve_wsl_path_from(
            None,
            "~/.claude/settings.json",
            "/mnt/c/Users/tester/project"
        )
        .is_err());
    }

    #[test]
    fn resolves_tilde_paths_with_explicit_home_directory() {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time went backwards")
            .as_nanos();
        let home = env::temp_dir().join(format!("clcomx-home-resolution-{unique}"));
        let skill_dir = home.join(".claude/skills/code-quality-review");
        fs::create_dir_all(&skill_dir).unwrap();
        fs::write(skill_dir.join("SKILL.md"), "skill").unwrap();

        let result = resolve_terminal_path_with_state(
            None,
            None,
            "~/.claude/skills/code-quality-review/SKILL.md".into(),
            "Ubuntu-20.04".into(),
            "/mnt/c/Users/tester/project".into(),
            None,
            Some(home.to_string_lossy().to_string()),
        )
        .expect("resolution should succeed");

        match result {
            TerminalPathResolution::Resolved { path } => {
                let expected = normalize_posix_path(&format!(
                    "{}/.claude/skills/code-quality-review/SKILL.md",
                    home.to_string_lossy()
                ));
                assert_eq!(path.wsl_path, expected);
                assert!(path
                    .copy_text
                    .ends_with(".claude/skills/code-quality-review/SKILL.md"));
            }
            other => panic!("expected resolved path, got {other:?}"),
        }

        let _ = fs::remove_dir_all(&home);
    }

    #[test]
    fn prefers_session_cached_home_directory_over_stale_hint() {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time went backwards")
            .as_nanos();
        let session_home = env::temp_dir().join(format!("clcomx-session-home-{unique}"));
        let hinted_home = env::temp_dir().join(format!("clcomx-stale-home-{unique}"));
        let skill_dir = session_home.join(".claude/skills/code-quality-review");
        fs::create_dir_all(&skill_dir).unwrap();
        fs::write(skill_dir.join("SKILL.md"), "skill").unwrap();

        let workspace_state = workspace_state_with_session(
            "session-1",
            "Ubuntu-20.04",
            "/mnt/c/Users/tester/project",
            Some(41),
        );
        let pty_state = crate::commands::pty::test_state_with_session(
            41,
            &[(1, "alpha")],
            1,
            120,
            36,
            Some(&session_home.to_string_lossy()),
        );

        let result = resolve_terminal_path_with_state(
            Some(&workspace_state),
            Some(&pty_state),
            "~/.claude/skills/code-quality-review/SKILL.md".into(),
            "Ubuntu-20.04".into(),
            "/mnt/c/Users/tester/project".into(),
            Some("session-1".into()),
            Some(hinted_home.to_string_lossy().to_string()),
        )
        .expect("resolution should succeed");

        match result {
            TerminalPathResolution::Resolved { path } => {
                let expected = normalize_posix_path(&format!(
                    "{}/.claude/skills/code-quality-review/SKILL.md",
                    session_home.to_string_lossy()
                ));
                assert_eq!(path.wsl_path, expected);
                assert!(path
                    .copy_text
                    .ends_with(".claude/skills/code-quality-review/SKILL.md"));
            }
            other => panic!("expected resolved path, got {other:?}"),
        }

        let _ = fs::remove_dir_all(&session_home);
    }

    #[test]
    fn ignores_session_cached_home_directory_when_workspace_context_mismatches() {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time went backwards")
            .as_nanos();
        let session_home = env::temp_dir().join(format!("clcomx-mismatch-session-home-{unique}"));
        let hinted_home = env::temp_dir().join(format!("clcomx-mismatch-hint-home-{unique}"));
        let session_skill_dir = session_home.join(".claude/skills/code-quality-review");
        let hinted_skill_dir = hinted_home.join(".claude/skills/code-quality-review");
        fs::create_dir_all(&session_skill_dir).unwrap();
        fs::create_dir_all(&hinted_skill_dir).unwrap();
        fs::write(session_skill_dir.join("SKILL.md"), "session").unwrap();
        fs::write(hinted_skill_dir.join("SKILL.md"), "hint").unwrap();

        let workspace_state = workspace_state_with_session(
            "session-2",
            "Ubuntu-22.04",
            "/mnt/c/Users/tester/other-project",
            Some(42),
        );
        let pty_state = crate::commands::pty::test_state_with_session(
            42,
            &[(1, "alpha")],
            1,
            120,
            36,
            Some(&session_home.to_string_lossy()),
        );

        let result = resolve_terminal_path_with_state(
            Some(&workspace_state),
            Some(&pty_state),
            "~/.claude/skills/code-quality-review/SKILL.md".into(),
            "Ubuntu-20.04".into(),
            "/mnt/c/Users/tester/project".into(),
            Some("session-2".into()),
            Some(hinted_home.to_string_lossy().to_string()),
        )
        .expect("resolution should succeed");

        match result {
            TerminalPathResolution::Resolved { path } => {
                let expected = normalize_posix_path(&format!(
                    "{}/.claude/skills/code-quality-review/SKILL.md",
                    hinted_home.to_string_lossy()
                ));
                assert_eq!(path.wsl_path, expected);
                assert!(path
                    .copy_text
                    .ends_with(".claude/skills/code-quality-review/SKILL.md"));
            }
            other => panic!("expected resolved path, got {other:?}"),
        }

        let _ = fs::remove_dir_all(&session_home);
        let _ = fs::remove_dir_all(&hinted_home);
    }

    #[test]
    fn converts_wsl_paths_to_windows_paths() {
        assert_eq!(
            wsl_path_to_windows("/mnt/c/Users/tester/file.ts", "Ubuntu-22.04").unwrap(),
            r"C:\Users\tester\file.ts"
        );
        assert_eq!(
            wsl_path_to_windows("/home/tester/work/file.ts", "Ubuntu-22.04").unwrap(),
            r"\\wsl.localhost\Ubuntu-22.04\home\tester\work\file.ts"
        );
    }

    #[cfg(unix)]
    #[test]
    fn canonicalizes_symlinked_wsl_paths_before_windows_lookup() {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time went backwards")
            .as_nanos();
        let root = env::temp_dir().join(format!("clcomx-symlink-resolution-{unique}"));
        let real_dir = root.join("work/skills/skills/code-quality-review");
        let home_dir = root.join("home/tester/.claude");
        let skills_link = home_dir.join("skills");
        let nested_link = skills_link.join("code-quality-review");

        fs::create_dir_all(&real_dir).unwrap();
        fs::create_dir_all(&home_dir).unwrap();
        fs::write(real_dir.join("SKILL.md"), "skill").unwrap();
        std::os::unix::fs::symlink(root.join("work/skills"), &skills_link).unwrap();
        std::os::unix::fs::symlink(&real_dir, &nested_link).unwrap();

        let symlinked = normalize_posix_path(&format!(
            "{}/home/tester/.claude/skills/code-quality-review/SKILL.md",
            root.to_string_lossy()
        ));
        let canonical = normalize_posix_path(&real_dir.join("SKILL.md").to_string_lossy());
        let resolved = resolve_terminal_path_record(
            "~/.claude/skills/code-quality-review/SKILL.md",
            symlinked.clone(),
            None,
            None,
            "Ubuntu-20.04",
        )
        .expect("resolution should succeed");

        assert_eq!(resolved.wsl_path, symlinked);
        assert_eq!(
            resolved.windows_path,
            wsl_path_to_windows(&canonical, "Ubuntu-20.04").unwrap()
        );

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn trims_wrapping_terminal_noise() {
        assert_eq!(
            trim_terminal_token("'src/App.svelte:12:3'"),
            "src/App.svelte:12:3"
        );
        assert_eq!(trim_terminal_token("(../README.md:4)"), "../README.md:4");
    }

    #[test]
    fn builds_editor_override_var_names() {
        assert_eq!(
            editor_override_var("vscode"),
            "CLCOMX_WIN_EDITOR_VSCODE_PATH"
        );
        assert_eq!(
            editor_override_var("notepadpp"),
            "CLCOMX_WIN_EDITOR_NOTEPADPP_PATH"
        );
    }

    #[test]
    fn detects_likely_text_paths_from_common_editor_extensions() {
        assert!(is_likely_text_path("src/App.svelte"));
        assert!(is_likely_text_path("Dockerfile"));
        assert!(!is_likely_text_path("assets/image.png"));
        assert!(!is_likely_text_path("bin/program"));
    }

    #[test]
    fn matches_editor_file_names_case_insensitively() {
        assert!(file_name_matches_editor(
            Path::new("Cursor.exe"),
            &["cursor", "Cursor.exe"]
        ));
        assert!(!file_name_matches_editor(
            Path::new("other.exe"),
            &["cursor", "Cursor.exe"]
        ));
    }

    #[cfg(windows)]
    #[test]
    fn builds_app_paths_subkeys_from_editor_ids() {
        let subkeys = app_paths_registry_subkeys("vscode");
        assert!(subkeys
            .iter()
            .any(|value| value.ends_with(r"App Paths\Code.exe")));
        assert!(subkeys.iter().any(|value| value
            .ends_with(r"WOW6432Node\Microsoft\Windows\CurrentVersion\App Paths\Code.exe")));
    }

    #[test]
    fn search_session_files_returns_empty_results_for_empty_query() {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time went backwards")
            .as_nanos();
        let root = env::temp_dir().join(format!("clcomx-editor-search-empty-{unique}"));
        fs::create_dir_all(root.join("src")).unwrap();
        fs::write(root.join("src/main.ts"), "console.log('ok');").unwrap();

        let workspace_state =
            workspace_state_with_session("session-1", "Ubuntu-20.04", root.to_str().unwrap(), None);
        let result = search_session_files_with_state(
            &workspace_state,
            None,
            "session-1",
            root.to_str().unwrap(),
            "",
            Some(50),
        )
        .expect("search should succeed");

        assert!(result.results.is_empty());

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn search_session_files_filters_binary_large_and_heavy_entries() {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time went backwards")
            .as_nanos();
        let root = env::temp_dir().join(format!("clcomx-editor-search-{unique}"));
        fs::create_dir_all(root.join("src")).unwrap();
        fs::create_dir_all(root.join(".config")).unwrap();
        fs::create_dir_all(root.join("node_modules")).unwrap();

        fs::write(root.join("src/main.ts"), "console.log('ok');").unwrap();
        fs::write(root.join(".config/app.yml"), "theme: dark\n").unwrap();
        fs::write(root.join("node_modules/skip.ts"), "skip").unwrap();
        fs::write(root.join("src/image.bin"), [0, 1, 2, 3]).unwrap();
        fs::write(
            root.join("src/large.txt"),
            "a".repeat((MAX_SESSION_FILE_BYTES as usize) + 1),
        )
        .unwrap();

        let workspace_state =
            workspace_state_with_session("session-1", "Ubuntu-20.04", root.to_str().unwrap(), None);
        let result = search_session_files_with_state(
            &workspace_state,
            None,
            "session-1",
            root.to_str().unwrap(),
            ".",
            Some(50),
        )
        .expect("search should succeed");

        let relative_paths = result
            .results
            .iter()
            .map(|entry| entry.relative_path.as_str())
            .collect::<Vec<_>>();

        assert!(relative_paths.contains(&"src/main.ts"));
        assert!(relative_paths.contains(&".config/app.yml"));
        assert!(!relative_paths.contains(&"node_modules/skip.ts"));
        assert!(!relative_paths.contains(&"src/image.bin"));
        assert!(!relative_paths.contains(&"src/large.txt"));

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn search_session_files_rejects_root_outside_session_directory() {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time went backwards")
            .as_nanos();
        let session_root = env::temp_dir().join(format!("clcomx-editor-root-{unique}"));
        let outside_root = env::temp_dir().join(format!("clcomx-editor-root-outside-{unique}"));
        fs::create_dir_all(&session_root).unwrap();
        fs::create_dir_all(&outside_root).unwrap();

        let workspace_state = workspace_state_with_session(
            "session-1",
            "Ubuntu-20.04",
            session_root.to_str().unwrap(),
            None,
        );
        let error = search_session_files_with_state(
            &workspace_state,
            None,
            "session-1",
            outside_root.to_str().unwrap(),
            "",
            None,
        )
        .expect_err("search should fail");

        assert!(error.contains("Search root must stay within the session working directory"));

        let _ = fs::remove_dir_all(&session_root);
        let _ = fs::remove_dir_all(&outside_root);
    }

    #[test]
    fn read_session_file_rejects_paths_outside_session_directory() {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time went backwards")
            .as_nanos();
        let session_root = env::temp_dir().join(format!("clcomx-editor-read-root-{unique}"));
        let outside_root = env::temp_dir().join(format!("clcomx-editor-read-outside-{unique}"));
        fs::create_dir_all(&session_root).unwrap();
        fs::create_dir_all(&outside_root).unwrap();
        fs::write(outside_root.join("notes.md"), "# outside").unwrap();

        let workspace_state = workspace_state_with_session(
            "session-1",
            "Ubuntu-20.04",
            session_root.to_str().unwrap(),
            None,
        );
        let error = read_session_file_with_state(
            &workspace_state,
            "session-1",
            outside_root.join("notes.md").to_str().unwrap(),
        )
        .expect_err("read should fail");

        assert!(error.contains("Path must stay within the session working directory"));

        let _ = fs::remove_dir_all(&session_root);
        let _ = fs::remove_dir_all(&outside_root);
    }

    #[test]
    fn read_session_file_returns_content_language_and_mtime() {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time went backwards")
            .as_nanos();
        let root = env::temp_dir().join(format!("clcomx-editor-read-{unique}"));
        fs::create_dir_all(root.join("src")).unwrap();
        let file = root.join("src/lib.rs");
        fs::write(&file, "fn main() {}\n").unwrap();

        let workspace_state =
            workspace_state_with_session("session-1", "Ubuntu-20.04", root.to_str().unwrap(), None);
        let response =
            read_session_file_with_state(&workspace_state, "session-1", file.to_str().unwrap())
                .expect("read should succeed");

        assert_eq!(response.content, "fn main() {}\n");
        assert_eq!(response.language_id, "rust");
        assert_eq!(response.size_bytes, 13);
        assert!(response.mtime_ms > 0);

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn infer_language_id_detects_php_family_files() {
        assert_eq!(infer_language_id("/home/user/work/project/app/Controller.php"), "php");
        assert_eq!(infer_language_id("/home/user/work/project/views/index.phtml"), "php");
        assert_eq!(
            infer_language_id("/home/user/work/project/resources/views/welcome.blade.php"),
            "php"
        );
    }

    #[test]
    fn read_session_file_rejects_binary_and_large_files() {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time went backwards")
            .as_nanos();
        let root = env::temp_dir().join(format!("clcomx-editor-read-policy-{unique}"));
        fs::create_dir_all(root.join("src")).unwrap();
        let binary_file = root.join("src/image.bin");
        let large_file = root.join("src/large.txt");
        fs::write(&binary_file, [0, 1, 2, 3]).unwrap();
        fs::write(
            &large_file,
            "a".repeat((MAX_SESSION_FILE_BYTES as usize) + 1),
        )
        .unwrap();

        let workspace_state =
            workspace_state_with_session("session-1", "Ubuntu-20.04", root.to_str().unwrap(), None);

        let binary_error = read_session_file_with_state(
            &workspace_state,
            "session-1",
            binary_file.to_str().unwrap(),
        )
        .expect_err("binary read should fail");
        assert_eq!(binary_error, "BinaryFile");

        let large_error = read_session_file_with_state(
            &workspace_state,
            "session-1",
            large_file.to_str().unwrap(),
        )
        .expect_err("large read should fail");
        assert_eq!(large_error, "FileTooLarge");

        let _ = fs::remove_dir_all(&root);
    }

    #[cfg(unix)]
    #[test]
    fn search_session_files_allows_symlinked_session_root() {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time went backwards")
            .as_nanos();
        let base = env::temp_dir().join(format!("clcomx-editor-search-symlink-{unique}"));
        let real_root = base.join("real-root");
        let session_root = base.join("session-root");
        fs::create_dir_all(real_root.join("src")).unwrap();
        fs::write(real_root.join("src/main.ts"), "console.log('ok');\n").unwrap();
        std::os::unix::fs::symlink(&real_root, &session_root).unwrap();

        let workspace_state = workspace_state_with_session(
            "session-1",
            "Ubuntu-20.04",
            session_root.to_str().unwrap(),
            None,
        );
        let response =
            search_session_files_with_state(&workspace_state, None, "session-1", "", "main", None)
                .expect("search should succeed");

        assert_eq!(
            response.root_dir,
            normalize_posix_path(session_root.to_str().unwrap())
        );
        assert_eq!(response.results.len(), 1);
        assert_eq!(
            response.results[0].wsl_path,
            normalize_posix_path(&session_root.join("src/main.ts").to_string_lossy())
        );

        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn list_session_files_returns_cached_results_until_forced_refresh() {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time went backwards")
            .as_nanos();
        let root = env::temp_dir().join(format!("clcomx-editor-list-cache-{unique}"));
        fs::create_dir_all(root.join("src")).unwrap();
        fs::write(root.join("src/main.ts"), "console.log('ok');\n").unwrap();

        let workspace_state =
            workspace_state_with_session("session-1", "Ubuntu-20.04", root.to_str().unwrap(), None);

        let initial = list_session_files_with_state(
            &workspace_state,
            None,
            "session-1",
            root.to_str().unwrap(),
            false,
        )
        .expect("list should succeed");
        assert_eq!(initial.results.len(), 1);

        fs::write(root.join("src/second.ts"), "console.log('later');\n").unwrap();

        let cached = list_session_files_with_state(
            &workspace_state,
            None,
            "session-1",
            root.to_str().unwrap(),
            false,
        )
        .expect("cached list should succeed");
        assert_eq!(cached.results.len(), 1);

        let refreshed = list_session_files_with_state(
            &workspace_state,
            None,
            "session-1",
            root.to_str().unwrap(),
            true,
        )
        .expect("force refresh should succeed");
        assert_eq!(refreshed.results.len(), 2);
        assert!(refreshed.last_updated_ms >= initial.last_updated_ms);

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn in_flight_search_index_build_waits_for_existing_work() {
        use std::sync::{
            atomic::{AtomicBool, AtomicUsize, Ordering},
            Arc,
        };

        let session_id = "session-1";
        let root_dir = "/tmp/clcomx-in-flight-search-index";
        let key = cache_key(session_id, root_dir);
        let first_state = Arc::new(SearchIndexBuildState {
            status: Mutex::new(SearchIndexBuildStatus::Building),
            ready: Condvar::new(),
        });

        if let Ok(mut inflight) = file_search_in_flight().lock() {
            inflight.insert(key.clone(), first_state.clone());
        }

        let build_count = Arc::new(AtomicUsize::new(0));
        let follower_entered = Arc::new(AtomicBool::new(false));
        let follower_state = first_state.clone();
        let follower_count = build_count.clone();
        let follower_flag = follower_entered.clone();
        let follower = std::thread::spawn(move || {
            follower_flag.store(true, Ordering::SeqCst);
            let result = wait_for_search_index_build(&follower_state)
                .expect("follower should receive completed result");
            follower_count.fetch_add(result.entries.len(), Ordering::SeqCst);
        });

        while !follower_entered.load(Ordering::SeqCst) {
            std::thread::yield_now();
        }

        let result = Ok(cache_index(vec![CachedFileEntry {
            wsl_path: "/tmp/clcomx-in-flight-search-index/src/main.ts".into(),
            relative_path: "src/main.ts".into(),
            basename: "main.ts".into(),
            basename_lower: "main.ts".into(),
            relative_lower: "src/main.ts".into(),
        }]));

        finish_search_index_build(&key, &first_state, result.clone());

        let cached = wait_for_search_index_build(&first_state)
            .expect("leader should read completed result");
        assert_eq!(cached.entries.len(), 1);

        follower.join().expect("follower should finish");
        assert_eq!(build_count.load(Ordering::SeqCst), 1);

        if let Ok(mut inflight) = file_search_in_flight().lock() {
            inflight.remove(&key);
        }
    }

    #[cfg(unix)]
    #[test]
    fn read_session_file_allows_symlinked_session_root() {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time went backwards")
            .as_nanos();
        let base = env::temp_dir().join(format!("clcomx-editor-read-symlink-{unique}"));
        let real_root = base.join("real-root");
        let session_root = base.join("session-root");
        let file = real_root.join("src/lib.rs");
        fs::create_dir_all(file.parent().unwrap()).unwrap();
        fs::write(&file, "fn main() {}\n").unwrap();
        std::os::unix::fs::symlink(&real_root, &session_root).unwrap();

        let workspace_state = workspace_state_with_session(
            "session-1",
            "Ubuntu-20.04",
            session_root.to_str().unwrap(),
            None,
        );
        let response = read_session_file_with_state(
            &workspace_state,
            "session-1",
            session_root.join("src/lib.rs").to_str().unwrap(),
        )
        .expect("read should succeed");

        assert_eq!(response.content, "fn main() {}\n");
        assert_eq!(
            response.wsl_path,
            normalize_posix_path(&session_root.join("src/lib.rs").to_string_lossy())
        );

        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn write_session_file_updates_file_and_touches_session_cache() {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time went backwards")
            .as_nanos();
        let root = env::temp_dir().join(format!("clcomx-editor-write-{unique}"));
        fs::create_dir_all(root.join("src")).unwrap();
        let file = root.join("src/main.ts");
        fs::write(&file, "console.log('old');\n").unwrap();

        let workspace_state =
            workspace_state_with_session("session-1", "Ubuntu-20.04", root.to_str().unwrap(), None);
        let initial_search = search_session_files_with_state(
            &workspace_state,
            None,
            "session-1",
            root.to_str().unwrap(),
            "main",
            Some(20),
        )
        .expect("initial search should succeed");
        assert_eq!(initial_search.results.len(), 1);

        let read =
            read_session_file_with_state(&workspace_state, "session-1", file.to_str().unwrap())
                .expect("read should succeed");
        let write = write_session_file_with_state(
            &workspace_state,
            "session-1",
            file.to_str().unwrap(),
            "console.log('new');\n",
            read.mtime_ms,
        )
        .expect("write should succeed");

        assert!(write.mtime_ms >= read.mtime_ms);
        assert_eq!(fs::read_to_string(&file).unwrap(), "console.log('new');\n");

        let cache = file_search_cache().lock().unwrap();
        let key = cache_key("session-1", root.to_str().unwrap());
        let index = cache.get(&key).expect("cache entry should remain available");
        assert!(index
            .entries
            .iter()
            .any(|entry| entry.wsl_path == normalize_posix_path(&file.to_string_lossy())));
        drop(cache);

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn write_session_file_rejects_mtime_conflicts() {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time went backwards")
            .as_nanos();
        let root = env::temp_dir().join(format!("clcomx-editor-write-conflict-{unique}"));
        fs::create_dir_all(root.join("src")).unwrap();
        let file = root.join("src/main.ts");
        fs::write(&file, "console.log('old');\n").unwrap();

        let workspace_state =
            workspace_state_with_session("session-1", "Ubuntu-20.04", root.to_str().unwrap(), None);
        let read =
            read_session_file_with_state(&workspace_state, "session-1", file.to_str().unwrap())
                .expect("read should succeed");
        std::thread::sleep(std::time::Duration::from_millis(5));
        fs::write(&file, "console.log('changed elsewhere');\n").unwrap();

        let error = write_session_file_with_state(
            &workspace_state,
            "session-1",
            file.to_str().unwrap(),
            "console.log('new');\n",
            read.mtime_ms,
        )
        .expect_err("write should fail");

        assert_eq!(error, "FileModifiedOnDisk");

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn write_session_file_rejects_binary_targets_and_large_content() {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time went backwards")
            .as_nanos();
        let root = env::temp_dir().join(format!("clcomx-editor-write-policy-{unique}"));
        fs::create_dir_all(root.join("src")).unwrap();
        let binary_file = root.join("src/image.bin");
        let text_file = root.join("src/main.ts");
        fs::write(&binary_file, [0, 1, 2, 3]).unwrap();
        fs::write(&text_file, "console.log('ok');\n").unwrap();

        let workspace_state =
            workspace_state_with_session("session-1", "Ubuntu-20.04", root.to_str().unwrap(), None);

        let binary_mtime = metadata_mtime_ms(&fs::metadata(&binary_file).unwrap());
        let binary_error = write_session_file_with_state(
            &workspace_state,
            "session-1",
            binary_file.to_str().unwrap(),
            "text now\n",
            binary_mtime,
        )
        .expect_err("binary write should fail");
        assert_eq!(binary_error, "BinaryFile");

        let text_read = read_session_file_with_state(
            &workspace_state,
            "session-1",
            text_file.to_str().unwrap(),
        )
        .expect("text read should succeed");
        let large_error = write_session_file_with_state(
            &workspace_state,
            "session-1",
            text_file.to_str().unwrap(),
            &"a".repeat((MAX_SESSION_FILE_BYTES as usize) + 1),
            text_read.mtime_ms,
        )
        .expect_err("oversized write should fail");
        assert_eq!(large_error, "FileTooLarge");

        let _ = fs::remove_dir_all(&root);
    }

    #[cfg(unix)]
    #[test]
    fn read_session_file_rejects_symlink_escape_outside_session_directory() {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time went backwards")
            .as_nanos();
        let session_root = env::temp_dir().join(format!("clcomx-editor-symlink-root-{unique}"));
        let outside_root = env::temp_dir().join(format!("clcomx-editor-symlink-outside-{unique}"));
        fs::create_dir_all(&session_root).unwrap();
        fs::create_dir_all(&outside_root).unwrap();
        fs::write(outside_root.join("secret.txt"), "secret").unwrap();
        std::os::unix::fs::symlink(
            outside_root.join("secret.txt"),
            session_root.join("link.txt"),
        )
        .unwrap();

        let workspace_state = workspace_state_with_session(
            "session-1",
            "Ubuntu-20.04",
            session_root.to_str().unwrap(),
            None,
        );
        let error = read_session_file_with_state(
            &workspace_state,
            "session-1",
            session_root.join("link.txt").to_str().unwrap(),
        )
        .expect_err("read should fail");

        assert!(error.contains("Path must stay within the session working directory"));

        let _ = fs::remove_dir_all(&session_root);
        let _ = fs::remove_dir_all(&outside_root);
    }
}

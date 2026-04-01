use crate::app_env::is_test_mode;
use serde::Serialize;
use std::collections::VecDeque;
use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Mutex, OnceLock};

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

    Ok(normalize_posix_path(&format!("{}/{}", base.trim_end_matches('/'), trimmed)))
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

fn resolve_terminal_path_record(
    raw: &str,
    wsl_path: String,
    line: Option<u32>,
    column: Option<u32>,
    distro: &str,
) -> Result<ResolvedTerminalPath, String> {
    let windows_path = wsl_path_to_windows(&wsl_path, distro)?;
    let metadata = std::fs::metadata(&windows_path)
        .or_else(|_| {
            if Path::new(&wsl_path).exists() {
                std::fs::metadata(&wsl_path)
            } else {
                Err(std::io::Error::new(
                    std::io::ErrorKind::NotFound,
                    format!("Path does not exist: {wsl_path}"),
                ))
            }
        })
        .map_err(|_| format!("Path does not exist: {wsl_path}"))?;

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

#[tauri::command]
pub fn resolve_terminal_path(
    raw: String,
    distro: String,
    work_dir: String,
    home_dir: Option<String>,
) -> Result<TerminalPathResolution, String> {
    let cleaned = trim_terminal_token(&raw);
    if cleaned.is_empty() {
        return Err("Path is empty".into());
    }

    let (raw_path, line, column) = parse_line_and_column(&cleaned);
    let effective_home_dir = home_dir.or_else(|| {
        env::var_os("HOME").and_then(|value| value.into_string().ok())
    });
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

        let result = resolve_terminal_path(
            "settings.toml".into(),
            "Ubuntu-20.04".into(),
            root.to_str().unwrap().into(),
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
        assert!(resolve_wsl_path_from(None, "~/.claude/settings.json", "/mnt/c/Users/tester/project")
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

        let result = resolve_terminal_path(
            "~/.claude/skills/code-quality-review/SKILL.md".into(),
            "Ubuntu-20.04".into(),
            "/mnt/c/Users/tester/project".into(),
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
                assert!(path.copy_text.ends_with(".claude/skills/code-quality-review/SKILL.md"));
            }
            other => panic!("expected resolved path, got {other:?}"),
        }

        let _ = fs::remove_dir_all(&home);
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
}

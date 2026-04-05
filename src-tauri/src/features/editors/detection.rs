use super::types::DetectedEditor;
use crate::app_env::is_test_mode;
#[cfg(windows)]
use crate::features::editors::CREATE_NO_WINDOW;
use std::env;
use std::fs;
#[cfg(windows)]
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
#[cfg(windows)]
use std::process::Command;
use std::sync::{Mutex, OnceLock};

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

pub(super) fn editor_label(editor_id: &str) -> &'static str {
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

pub(super) fn normalize_editor_id(value: &str) -> Option<&'static str> {
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

pub(super) fn editor_override_var(editor_id: &str) -> String {
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

pub(super) fn file_name_matches_editor(path: &Path, names: &[&str]) -> bool {
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
pub(super) fn app_paths_registry_subkeys(editor_id: &str) -> Vec<String> {
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

pub(super) fn detect_editor_binary(editor_id: &str) -> Option<PathBuf> {
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

pub(super) fn detect_available_editors() -> Vec<DetectedEditor> {
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

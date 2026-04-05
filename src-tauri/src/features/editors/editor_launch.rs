use super::detection::{detect_editor_binary, editor_label, normalize_editor_id};
#[cfg(windows)]
use super::CREATE_NO_WINDOW;
use crate::app_env::is_test_mode;
use std::path::Path;
use std::process::Command;

#[cfg(windows)]
use std::os::windows::process::CommandExt;

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

use super::detection::{detect_editor_binary, editor_label, normalize_editor_id};
#[cfg(windows)]
use super::CREATE_NO_WINDOW;
use crate::app_env::{
    ensure_parent_dir, is_test_mode, is_test_mode_editor_real_launch_enabled, state_path,
};
use std::fs::OpenOptions;
use std::io::Write;
use std::path::Path;
use std::process::Command;

#[cfg(windows)]
use std::os::windows::process::CommandExt;

const TEST_MODE_EDITOR_OPEN_LOG_FILE: &str = "editor-open-events.jsonl";

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

/// test mode에서 외부 editor 실행 요청 payload를 E2E가 관찰할 수 있게 기록한다.
fn record_test_mode_editor_open(
    editor_id: &str,
    windows_path: &str,
    line: Option<u32>,
    column: Option<u32>,
    is_directory: bool,
) -> Result<(), String> {
    let path = state_path(TEST_MODE_EDITOR_OPEN_LOG_FILE)?;
    ensure_parent_dir(&path)?;

    let payload = serde_json::json!({
        "editorId": editor_id,
        "windowsPath": windows_path,
        "line": line,
        "column": column,
        "isDirectory": is_directory,
    });
    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|error| format!("Failed to open {}: {error}", path.display()))?;

    // 여러 editor open 시도를 한 파일에 JSONL로 누적해 E2E가 마지막 호출을 확인한다.
    writeln!(file, "{payload}")
        .map_err(|error| format!("Failed to write {}: {error}", path.display()))
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

    let executable = detect_editor_binary(normalized_editor_id);

    if is_test_mode() {
        if executable.is_none() {
            return Err("Editor is not available".into());
        }
        record_test_mode_editor_open(
            normalized_editor_id,
            &windows_path,
            line,
            column,
            is_directory,
        )?;
        if !is_test_mode_editor_real_launch_enabled() {
            return Ok(());
        }
    }

    let executable = executable
        .ok_or_else(|| format!("{} is not installed", editor_label(normalized_editor_id)))?;

    if !is_test_mode() && !Path::new(&windows_path).exists() {
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
    use crate::app_env::test_support::{
        set_state_dir_env, set_test_mode_editor_real_launch_env, set_test_mode_env,
    };
    use crate::features::editors::detection::editor_override_var;
    use serde_json::Value;
    use std::env;
    use std::ffi::{OsStr, OsString};
    use std::fs;
    use std::path::{Path, PathBuf};
    use std::thread;
    use std::time::{Duration, SystemTime, UNIX_EPOCH};

    fn unique_state_dir(label: &str) -> std::path::PathBuf {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time went backwards")
            .as_nanos();
        env::temp_dir().join(format!("clcomx-{label}-{unique}"))
    }

    struct EnvVarGuard {
        name: String,
        previous: Option<OsString>,
    }

    impl EnvVarGuard {
        fn set(name: impl Into<String>, value: impl AsRef<OsStr>) -> Self {
            let name = name.into();
            let previous = env::var_os(&name);
            env::set_var(&name, value);
            Self { name, previous }
        }
    }

    impl Drop for EnvVarGuard {
        fn drop(&mut self) {
            if let Some(previous) = &self.previous {
                env::set_var(&self.name, previous);
            } else {
                env::remove_var(&self.name);
            }
        }
    }

    fn write_fake_editor_script(state_dir: &Path) -> PathBuf {
        #[cfg(windows)]
        {
            let path = state_dir.join("fake-editor.cmd");
            fs::write(
                &path,
                "@echo off\r\n>>\"%CLCOMX_FAKE_EDITOR_LOG%\" echo %*\r\n",
            )
            .unwrap();
            path
        }

        #[cfg(not(windows))]
        {
            let path = state_dir.join("fake-editor.sh");
            fs::write(
                &path,
                "#!/bin/sh\nprintf '%s\\n' \"$@\" >> \"$CLCOMX_FAKE_EDITOR_LOG\"\n",
            )
            .unwrap();

            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                let mut permissions = fs::metadata(&path).unwrap().permissions();
                permissions.set_mode(0o755);
                fs::set_permissions(&path, permissions).unwrap();
            }

            path
        }
    }

    fn wait_for_file_text(path: &Path) -> String {
        for _ in 0..50 {
            if let Ok(text) = fs::read_to_string(path) {
                if !text.trim().is_empty() {
                    return text;
                }
            }
            thread::sleep(Duration::from_millis(20));
        }

        panic!("timed out waiting for {}", path.display());
    }

    #[test]
    fn test_mode_open_in_editor_records_launch_payload() {
        let state_dir = unique_state_dir("editor-open-log");
        fs::create_dir_all(&state_dir).unwrap();
        let _state_guard = set_state_dir_env(&state_dir);
        let _test_mode_guard = set_test_mode_env();

        open_in_editor(
            "cursor".into(),
            r"C:\workspace\a\src\app.ts".into(),
            Some(12),
            Some(4),
            false,
        )
        .expect("test-mode editor launch should succeed");

        let log_path = state_dir.join("editor-open-events.jsonl");
        let log_text = fs::read_to_string(&log_path).expect("editor launch log should exist");
        let payload: Value =
            serde_json::from_str(log_text.trim()).expect("launch log should be JSONL");

        assert_eq!(payload["editorId"], "cursor");
        assert_eq!(payload["windowsPath"], r"C:\workspace\a\src\app.ts");
        assert_eq!(payload["line"], 12);
        assert_eq!(payload["column"], 4);
        assert_eq!(payload["isDirectory"], false);

        let _ = fs::remove_dir_all(&state_dir);
    }

    #[test]
    fn test_mode_real_editor_launch_spawns_override_with_line_args() {
        let state_dir = unique_state_dir("editor-real-launch");
        fs::create_dir_all(&state_dir).unwrap();
        let fake_editor_path = write_fake_editor_script(&state_dir);
        let fake_editor_log = state_dir.join("fake-editor-args.txt");
        let _state_guard = set_state_dir_env(&state_dir);
        let _test_mode_guard = set_test_mode_env();
        let _real_launch_guard = set_test_mode_editor_real_launch_env();
        let _editor_override_guard =
            EnvVarGuard::set(editor_override_var("cursor"), fake_editor_path.as_os_str());
        let _fake_log_guard =
            EnvVarGuard::set("CLCOMX_FAKE_EDITOR_LOG", fake_editor_log.as_os_str());

        open_in_editor(
            "cursor".into(),
            r"C:\workspace\a\src\app.ts".into(),
            Some(12),
            Some(4),
            false,
        )
        .expect("test-mode real editor launch should spawn the override");

        let args = wait_for_file_text(&fake_editor_log);
        assert!(args.contains("--goto"));
        assert!(args.contains(r"C:\workspace\a\src\app.ts:12:4"));

        let _ = fs::remove_dir_all(&state_dir);
    }
}

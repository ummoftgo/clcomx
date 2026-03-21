use crate::app_env::{is_test_mode, test_distro_name, test_home_path};
use serde::Serialize;
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::process::{Command, Stdio};
use std::sync::Mutex;

#[cfg(windows)]
use std::os::windows::process::CommandExt;

/// Persistent WSL shell for fast command execution.
/// Keeps one bash process per distro to avoid wsl.exe startup overhead.
struct WslShell {
    stdin: std::process::ChildStdin,
    stdout: BufReader<std::process::ChildStdout>,
}

impl WslShell {
    fn spawn(distro: &str) -> Result<Self, String> {
        let mut cmd = Command::new("wsl.exe");
        cmd.args(["-d", distro, "-e", "bash", "--norc", "--noprofile"])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());

        #[cfg(windows)]
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW

        let mut child = cmd.spawn().map_err(|e| e.to_string())?;

        let stdin = child.stdin.take().ok_or("Failed to open stdin")?;
        let stdout = BufReader::new(child.stdout.take().ok_or("Failed to open stdout")?);

        Ok(WslShell { stdin, stdout })
    }

    fn exec(&mut self, cmd: &str) -> Result<Vec<String>, String> {
        // Use a unique marker to know when output ends
        let marker = format!("__CLCOMX_END_{}__", std::process::id());
        let full_cmd = format!("{}\necho '{}'\n", cmd, marker);

        self.stdin
            .write_all(full_cmd.as_bytes())
            .map_err(|e| e.to_string())?;
        self.stdin.flush().map_err(|e| e.to_string())?;

        let mut lines = Vec::new();
        loop {
            let mut line = String::new();
            match self.stdout.read_line(&mut line) {
                Ok(0) => break, // EOF
                Ok(_) => {
                    let trimmed = line.trim_end_matches('\n').trim_end_matches('\r');
                    if trimmed == marker {
                        break;
                    }
                    lines.push(trimmed.to_string());
                }
                Err(_) => break,
            }
        }
        Ok(lines)
    }
}

#[derive(Default)]
pub struct WslState {
    shells: Mutex<HashMap<String, WslShell>>,
    distro_cache: Mutex<Option<Vec<String>>>,
}

impl WslState {
    fn get_or_spawn_shell(
        &self,
        distro: &str,
    ) -> Result<std::sync::MutexGuard<'_, HashMap<String, WslShell>>, String> {
        let mut shells = self.shells.lock().map_err(|e| e.to_string())?;
        if !shells.contains_key(distro) {
            let shell = WslShell::spawn(distro)?;
            shells.insert(distro.to_string(), shell);
        }
        Ok(shells)
    }
}

fn mock_directory_entries(path: &str) -> Vec<WslEntry> {
    let home = test_home_path();
    match path {
        "/" => vec![WslEntry {
            name: "home".into(),
            path: "/home".into(),
        }],
        "/home" => vec![WslEntry {
            name: home.trim_start_matches("/home/").to_string(),
            path: home.clone(),
        }],
        p if p == home => vec![
            WslEntry {
                name: "workspace".into(),
                path: format!("{home}/workspace"),
            },
            WslEntry {
                name: "projects".into(),
                path: format!("{home}/projects"),
            },
        ],
        p if p == format!("{home}/workspace") => vec![
            WslEntry {
                name: "clcomx".into(),
                path: format!("{home}/workspace/clcomx"),
            },
            WslEntry {
                name: "demo".into(),
                path: format!("{home}/workspace/demo"),
            },
        ],
        p if p == format!("{home}/projects") => vec![WslEntry {
            name: "sample".into(),
            path: format!("{home}/projects/sample"),
        }],
        _ => Vec::new(),
    }
}

#[tauri::command]
pub fn list_wsl_distros(state: tauri::State<'_, WslState>) -> Result<Vec<String>, String> {
    if is_test_mode() {
        return Ok(vec![test_distro_name()]);
    }

    // Check cache first
    {
        let cache = state.distro_cache.lock().map_err(|e| e.to_string())?;
        if let Some(ref distros) = *cache {
            return Ok(distros.clone());
        }
    }

    let mut cmd = Command::new("wsl.exe");
    cmd.args(["-l", "-q"]);

    #[cfg(windows)]
    cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW

    let output = cmd.output().map_err(|e| e.to_string())?;

    if !output.status.success() {
        return Err("Failed to list WSL distributions".to_string());
    }

    // wsl.exe -l -q outputs UTF-16LE on Windows
    let raw = &output.stdout;
    let text = if raw.len() >= 2 && raw[0] == 0xFF && raw[1] == 0xFE {
        let u16s: Vec<u16> = raw[2..]
            .chunks_exact(2)
            .map(|c| u16::from_le_bytes([c[0], c[1]]))
            .collect();
        String::from_utf16_lossy(&u16s)
    } else if raw.iter().any(|&b| b == 0) {
        let u16s: Vec<u16> = raw
            .chunks_exact(2)
            .map(|c| u16::from_le_bytes([c[0], c[1]]))
            .collect();
        String::from_utf16_lossy(&u16s)
    } else {
        String::from_utf8_lossy(raw).to_string()
    };

    let distros: Vec<String> = text
        .lines()
        .map(|l| l.trim().trim_matches('\0'))
        .filter(|l| !l.is_empty())
        .map(|l| l.to_string())
        .collect();

    // Cache result
    {
        let mut cache = state.distro_cache.lock().map_err(|e| e.to_string())?;
        *cache = Some(distros.clone());
    }

    Ok(distros)
}

#[tauri::command]
pub fn list_wsl_directories(
    state: tauri::State<'_, WslState>,
    distro: String,
    path: String,
) -> Result<Vec<WslEntry>, String> {
    if is_test_mode() {
        if distro != test_distro_name() {
            return Ok(Vec::new());
        }
        return Ok(mock_directory_entries(&path));
    }

    let mut shells = state.get_or_spawn_shell(&distro)?;
    let shell = shells.get_mut(&distro).ok_or("Shell not found")?;

    let safe_path = path.replace('\'', "'\\''");
    let cmd = format!(
        "find '{}' -maxdepth 1 -mindepth 1 -type d 2>/dev/null | sort",
        safe_path
    );

    let lines = shell.exec(&cmd)?;

    let entries: Vec<WslEntry> = lines
        .into_iter()
        .filter(|l| !l.is_empty())
        .map(|l| {
            let name = l.rsplit('/').next().unwrap_or(&l).to_string();
            WslEntry {
                name,
                path: l,
            }
        })
        .collect();

    Ok(entries)
}

#[derive(Clone, Serialize)]
pub struct WslEntry {
    pub name: String,
    pub path: String,
}

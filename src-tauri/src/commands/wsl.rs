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

const SEARCH_EXCLUDED_DIRS: &[&str] = &[
    ".git",
    "node_modules",
    "target",
    "dist",
    "build",
    "coverage",
    ".next",
    ".svelte-kit",
];

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
                Ok(0) => break,
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

fn shell_single_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

fn build_rg_globs() -> String {
    SEARCH_EXCLUDED_DIRS
        .iter()
        .map(|dir| format!("--glob {}", shell_single_quote(&format!("!**/{dir}/**"))))
        .collect::<Vec<_>>()
        .join(" ")
}

fn build_find_prune_clause() -> String {
    SEARCH_EXCLUDED_DIRS
        .iter()
        .map(|dir| format!("-name {}", shell_single_quote(dir)))
        .collect::<Vec<_>>()
        .join(" -o ")
}

fn build_list_files_command(root_dir: &str) -> String {
    let root = shell_single_quote(root_dir);
    let rg_globs = build_rg_globs();
    let prune_clause = build_find_prune_clause();

    format!(
        "cd {root} 2>/dev/null || exit 0\n\
if command -v rg >/dev/null 2>&1; then\n\
  rg --files --hidden {rg_globs} 2>/dev/null\n\
else\n\
  find . \\( -type d \\( {prune_clause} \\) \\) -prune -o -type f -print 2>/dev/null | sed 's#^\\./##'\n\
fi"
    )
}

fn build_search_command(root_dir: &str, query: &str, limit: usize) -> String {
    let root = shell_single_quote(root_dir);
    let query = shell_single_quote(&query.to_ascii_lowercase());
    let rg_globs = build_rg_globs();
    let prune_clause = build_find_prune_clause();

    format!(
        "cd {root} 2>/dev/null || exit 0\n\
if command -v rg >/dev/null 2>&1; then\n\
  rg --files --hidden {rg_globs} 2>/dev/null\n\
else\n\
  find . \\( -type d \\( {prune_clause} \\) \\) -prune -o -type f -print 2>/dev/null | sed 's#^\\./##'\n\
fi | awk -v q={query} '\n\
{{\n\
  path=$0;\n\
  lower=tolower(path);\n\
  n=split(path, parts, \"/\");\n\
  base=tolower(parts[n]);\n\
  if (base == q) bucket=0;\n\
  else if (index(base, q) == 1) bucket=1;\n\
  else if (index(base, q) > 0) bucket=2;\n\
  else if (index(lower, q) > 0) bucket=3;\n\
  else next;\n\
  depth=n-1;\n\
  printf \"%d\\t%06d\\t%06d\\t%06d\\t%s\\t%s\\n\", bucket, depth, length(path), length(parts[n]), lower, path;\n\
}}' | sort -t $'\\t' -k1,1n -k2,2n -k3,3n -k4,4n -k5,5 | cut -f6- | head -n {limit}"
    )
}

pub fn search_wsl_files(
    state: &WslState,
    distro: &str,
    root_dir: &str,
    query: &str,
    limit: usize,
) -> Result<Vec<String>, String> {
    let trimmed_query = query.trim();
    if trimmed_query.is_empty() {
        return Ok(Vec::new());
    }

    if is_test_mode() {
        if distro != test_distro_name() {
            return Ok(Vec::new());
        }
        return Ok(mock_search_wsl_files(root_dir, trimmed_query, limit));
    }

    let bounded_limit = limit.clamp(1, 400);
    let mut shells = state.get_or_spawn_shell(distro)?;
    let shell = shells.get_mut(distro).ok_or("Shell not found")?;
    let lines = shell.exec(&build_search_command(root_dir, trimmed_query, bounded_limit))?;

    Ok(lines
        .into_iter()
        .map(|line| line.trim().to_string())
        .filter(|line| !line.is_empty() && line != ".")
        .collect())
}

pub fn list_wsl_files(
    state: &WslState,
    distro: &str,
    root_dir: &str,
) -> Result<Vec<String>, String> {
    if cfg!(test) || is_test_mode() {
        if distro != test_distro_name() {
            return Ok(Vec::new());
        }
        return Ok(mock_list_wsl_files(root_dir));
    }

    let mut shells = state.get_or_spawn_shell(distro)?;
    let shell = shells.get_mut(distro).ok_or("Shell not found")?;
    let lines = shell.exec(&build_list_files_command(root_dir))?;

    Ok(lines
        .into_iter()
        .map(|line| line.trim().to_string())
        .filter(|line| !line.is_empty() && line != ".")
        .collect())
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

fn mock_search_wsl_files(path: &str, query: &str, limit: usize) -> Vec<String> {
    let home = test_home_path();
    let root = path.trim_end_matches('/');
    let mut candidates = match root {
        p if p == format!("{home}/workspace/clcomx") => vec![
            "src/App.svelte".to_string(),
            "src/lib/components/InternalEditor.svelte".to_string(),
            "src/lib/components/EditorQuickOpenModal.svelte".to_string(),
            "src/lib/editor/model-store.ts".to_string(),
            ".claude/settings.json".to_string(),
        ],
        p if p == format!("{home}/workspace/demo") => vec!["README.md".to_string()],
        _ => Vec::new(),
    };

    let normalized_query = query.trim().to_ascii_lowercase();
    if normalized_query.is_empty() {
        return Vec::new();
    }

    candidates.retain(|candidate| candidate.to_ascii_lowercase().contains(&normalized_query));
    candidates.truncate(limit);
    candidates
}

fn mock_list_wsl_files(path: &str) -> Vec<String> {
    let home = test_home_path();
    match path.trim_end_matches('/') {
        p if p == format!("{home}/workspace/clcomx") => vec![
            "src/App.svelte".to_string(),
            "src/lib/components/InternalEditor.svelte".to_string(),
            "src/lib/components/EditorQuickOpenModal.svelte".to_string(),
            "src/lib/editor/model-store.ts".to_string(),
            ".claude/settings.json".to_string(),
        ],
        p if p == format!("{home}/workspace/demo") => vec!["README.md".to_string()],
        _ => Vec::new(),
    }
}

#[tauri::command]
pub fn list_wsl_distros(state: tauri::State<'_, WslState>) -> Result<Vec<String>, String> {
    if is_test_mode() {
        return Ok(vec![test_distro_name()]);
    }

    {
        let cache = state.distro_cache.lock().map_err(|e| e.to_string())?;
        if let Some(ref distros) = *cache {
            return Ok(distros.clone());
        }
    }

    let mut cmd = Command::new("wsl.exe");
    cmd.args(["-l", "-q"]);

    #[cfg(windows)]
    cmd.creation_flags(0x08000000);

    let output = cmd.output().map_err(|e| e.to_string())?;

    if !output.status.success() {
        return Err("Failed to list WSL distributions".to_string());
    }

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
            WslEntry { name, path: l }
        })
        .collect();

    Ok(entries)
}

#[derive(Clone, Serialize)]
pub struct WslEntry {
    pub name: String,
    pub path: String,
}

#[cfg(test)]
mod tests {
    use super::{build_list_files_command, build_search_command, list_wsl_files, search_wsl_files, WslState};

    #[test]
    fn search_wsl_files_returns_empty_without_spawning_for_empty_query() {
        let state = WslState::default();
        let result = search_wsl_files(&state, "ignored", "/home/tester/workspace", "", 120)
            .expect("empty query should short-circuit");

        assert!(result.is_empty());
    }

    #[test]
    fn build_search_command_is_bounded_and_has_rg_find_paths() {
        let command = build_search_command("/home/tester/workspace", "editor", 120);

        assert!(command.contains("command -v rg >/dev/null 2>&1"));
        assert!(command.contains("rg --files --hidden"));
        assert!(command.contains("find ."));
        assert!(command.contains("head -n 120"));
        assert!(command.contains("node_modules"));
        assert!(command.contains(".svelte-kit"));
    }

    #[test]
    fn build_list_files_command_has_rg_and_find_paths() {
        let command = build_list_files_command("/home/tester/workspace");

        assert!(command.contains("command -v rg >/dev/null 2>&1"));
        assert!(command.contains("rg --files --hidden"));
        assert!(command.contains("find ."));
        assert!(command.contains("node_modules"));
        assert!(command.contains(".svelte-kit"));
        assert!(!command.contains("awk -v q="));
    }

    #[test]
    fn list_wsl_files_uses_mock_data_in_test_mode() {
        let state = WslState::default();
        let files =
            list_wsl_files(&state, "clcomx-test", "/home/tester/workspace/clcomx").expect("list should succeed");

        assert!(files.iter().any(|value| value == "src/App.svelte"));
        assert!(files.iter().any(|value| value == ".claude/settings.json"));
    }
}

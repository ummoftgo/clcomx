use crate::app_env::is_test_mode;
use crate::commands::pty::{get_runtime_snapshot, PtyState};
use crate::commands::workspace::{find_session_tab_snapshot, WorkspaceState, WorkspaceTabSnapshot};
use std::collections::VecDeque;
use std::env;
use std::fs;
use std::path::{Path, PathBuf};

use super::types::{ResolvedTerminalPath, TerminalPathResolution};
#[cfg(windows)]
use super::CREATE_NO_WINDOW;

#[cfg(windows)]
use std::os::windows::process::CommandExt;
#[cfg(windows)]
use std::process::Command;

pub(super) fn parse_line_and_column(value: &str) -> (String, Option<u32>, Option<u32>) {
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

pub(super) fn normalize_posix_path(value: &str) -> String {
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

pub(super) fn resolve_home_dir_from(home_dir: Option<&str>, work_dir: &str) -> Option<String> {
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

pub(super) fn resolve_wsl_path_from(
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

pub(super) fn wsl_path_to_windows(path: &str, distro: &str) -> Result<String, String> {
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
pub(super) fn canonicalize_wsl_path_for_access(path: &str, _distro: &str) -> Option<String> {
    fs::canonicalize(path)
        .ok()
        .map(|resolved| normalize_posix_path(&resolved.to_string_lossy()))
}

#[cfg(windows)]
pub(super) fn canonicalize_wsl_path_for_access(path: &str, distro: &str) -> Option<String> {
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

pub(super) fn resolve_existing_access_path(
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

pub(super) fn path_is_within_root(path: &str, root: &str) -> bool {
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

pub(super) fn ensure_session_file_allowed(
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

pub(super) fn ensure_search_root_allowed(
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

pub(super) fn canonical_access_path(path: &Path) -> PathBuf {
    fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf())
}

fn access_path_is_within_root(path: &Path, root: &Path) -> bool {
    let canonical_path = canonical_access_path(path);
    let canonical_root = canonical_access_path(root);
    canonical_path == canonical_root || canonical_path.starts_with(&canonical_root)
}

#[cfg(windows)]
#[cfg(windows)]
#[cfg(windows)]
pub(super) fn access_path_is_within_canonical_root(path: &Path, canonical_root: &Path) -> bool {
    let canonical_path = canonical_access_path(path);
    canonical_path == canonical_root || canonical_path.starts_with(canonical_root)
}

pub(super) fn ensure_resolved_path_within_session_root(
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

pub(super) fn trim_terminal_token(value: &str) -> String {
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

pub(super) fn is_bare_filename_candidate(raw_path: &str) -> bool {
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

pub(super) fn is_heavy_directory_name(name: &str) -> bool {
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

pub(super) fn sorted_directory_entries(dir: &Path) -> Vec<fs::DirEntry> {
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

pub(super) fn collect_bare_filename_matches(
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

pub(super) fn relative_wsl_path(root_dir: &str, path: &str) -> String {
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

pub(super) fn basename_for_path(path: &str) -> String {
    Path::new(path)
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or(path)
        .to_string()
}

pub(super) fn access_path_to_wsl_path(
    access_root: &Path,
    root_dir: &str,
    file_path: &Path,
) -> Option<String> {
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

pub(super) fn resolve_terminal_path_record(
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

pub(super) fn resolve_terminal_path_with_state(
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

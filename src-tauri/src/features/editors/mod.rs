use crate::commands::settings::{find_session_tab_snapshot, WorkspaceState, WorkspaceTabSnapshot};
use crate::commands::wsl::{list_wsl_files, search_wsl_files, WslState};
#[cfg(test)]
use std::env;
use std::fs;
#[cfg(test)]
use std::path::Path;

mod detection;
mod editor_launch;
mod file_policy;
mod path_resolution;
mod search_index;
mod types;

use self::detection::detect_available_editors;
pub use self::editor_launch::open_in_editor;
use self::file_policy::{
    infer_language_id, metadata_mtime_ms, read_text_file_with_policy, MAX_SESSION_FILE_BYTES,
};
use self::path_resolution::{
    canonical_access_path, ensure_resolved_path_within_session_root, ensure_search_root_allowed,
    ensure_session_file_allowed, resolve_existing_access_path,
};
pub use self::path_resolution::resolve_terminal_path;
#[cfg(test)]
use self::path_resolution::normalize_posix_path;
use self::search_index::{
    build_cached_entries_from_relative_candidates, build_ranked_search_entries_from_relative_candidates,
    build_search_index_cache_once, cache_index, cached_list_response, collect_search_index_entries,
    ensure_search_index, ensure_search_index_cache, search_rank, upsert_search_cache_path,
};
#[cfg(test)]
use self::detection::{editor_override_var, file_name_matches_editor};
#[cfg(all(test, windows))]
use self::detection::app_paths_registry_subkeys;
pub use self::types::{
    DetectedEditor, SessionFileListResponse, SessionFileMatch, SessionFileReadResponse,
    SessionFileSearchResponse, SessionFileWriteResponse,
};

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x08000000;

fn session_tab_context(
    workspace_state: &WorkspaceState,
    session_id: &str,
) -> Result<WorkspaceTabSnapshot, String> {
    find_session_tab_snapshot(workspace_state, session_id)?
        .ok_or_else(|| format!("Unknown session: {session_id}"))
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
        if let Some(response) = cached_list_response(session_id, &normalized_root) {
            return Ok(response);
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

#[tauri::command]
pub async fn list_available_editors() -> Result<Vec<DetectedEditor>, String> {
    tauri::async_runtime::spawn_blocking(detect_available_editors)
        .await
        .map_err(|error| format!("Editor detection task failed: {error}"))
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

        let index = cached_list_response("session-1", root.to_str().unwrap())
            .expect("cache entry should remain available");
        assert!(index
            .results
            .iter()
            .any(|entry| entry.wsl_path == normalize_posix_path(&file.to_string_lossy())));

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

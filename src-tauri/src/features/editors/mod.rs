use crate::commands::settings::{find_session_tab_snapshot, WorkspaceState, WorkspaceTabSnapshot};
use crate::commands::wsl::{list_wsl_files, search_wsl_files, WslState};
use std::collections::{HashMap, HashSet, VecDeque};
#[cfg(test)]
use std::env;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Condvar, Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

mod detection;
mod editor_launch;
mod path_resolution;
mod types;

use self::detection::detect_available_editors;
pub use self::editor_launch::open_in_editor;
use self::path_resolution::{
    access_path_to_wsl_path, basename_for_path, canonical_access_path,
    ensure_resolved_path_within_session_root, ensure_search_root_allowed,
    ensure_session_file_allowed, is_heavy_directory_name, normalize_posix_path, path_is_within_root,
    relative_wsl_path, resolve_existing_access_path, sorted_directory_entries,
};
#[cfg(windows)]
use self::path_resolution::access_path_is_within_canonical_root;
pub use self::path_resolution::resolve_terminal_path;
#[cfg(test)]
use self::detection::{editor_override_var, file_name_matches_editor};
#[cfg(all(test, windows))]
use self::detection::app_paths_registry_subkeys;
use self::types::{CachedFileEntry, CachedFileIndex, SearchIndexBuildState, SearchIndexBuildStatus};
pub use self::types::{
    DetectedEditor, SessionFileListResponse, SessionFileMatch, SessionFileReadResponse,
    SessionFileSearchResponse, SessionFileWriteResponse,
};

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x08000000;

static SESSION_FILE_SEARCH_CACHE: OnceLock<Mutex<HashMap<String, CachedFileIndex>>> =
    OnceLock::new();
static SESSION_FILE_SEARCH_IN_FLIGHT: OnceLock<Mutex<HashMap<String, Arc<SearchIndexBuildState>>>> =
    OnceLock::new();

const MAX_SESSION_FILE_BYTES: u64 = 2 * 1024 * 1024;
const SEARCH_TEXT_SAMPLE_BYTES: u64 = 8 * 1024;

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

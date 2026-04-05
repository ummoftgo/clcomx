use super::file_policy::ensure_text_file_policy;
#[cfg(windows)]
use super::file_policy::{
    ensure_text_file_policy_from_metadata, is_likely_text_path, sniff_file_is_binary,
};
#[cfg(windows)]
use super::path_resolution::access_path_is_within_canonical_root;
#[cfg(not(windows))]
use super::path_resolution::ensure_resolved_path_within_session_root;
use super::path_resolution::{
    access_path_to_wsl_path, basename_for_path, is_heavy_directory_name, normalize_posix_path,
    path_is_within_root, relative_wsl_path, resolve_existing_access_path, sorted_directory_entries,
};
use super::types::{
    CachedFileEntry, CachedFileIndex, SearchIndexBuildState, SearchIndexBuildStatus,
    SessionFileListResponse, SessionFileMatch,
};
use crate::commands::settings::WorkspaceTabSnapshot;
use std::collections::{HashMap, HashSet, VecDeque};
#[cfg(windows)]
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Condvar, Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

static SESSION_FILE_SEARCH_CACHE: OnceLock<Mutex<HashMap<String, CachedFileIndex>>> =
    OnceLock::new();
static SESSION_FILE_SEARCH_IN_FLIGHT: OnceLock<Mutex<HashMap<String, Arc<SearchIndexBuildState>>>> =
    OnceLock::new();

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

pub(super) fn cache_index(entries: Vec<CachedFileEntry>) -> CachedFileIndex {
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

pub(super) fn cached_search_index(session_id: &str, root_dir: &str) -> Option<CachedFileIndex> {
    let key = cache_key(session_id, root_dir);
    file_search_cache()
        .lock()
        .ok()
        .and_then(|cache| cache.get(&key).cloned())
}

pub(super) fn cached_list_response(
    session_id: &str,
    root_dir: &str,
) -> Option<SessionFileListResponse> {
    let key = cache_key(session_id, root_dir);
    let cache = file_search_cache().lock().ok()?;
    let index = cache.get(&key)?;

    Some(SessionFileListResponse {
        root_dir: root_dir.to_string(),
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

pub(super) fn build_search_index_cache_once<F>(
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

pub(super) fn upsert_search_cache_path(session_id: &str, wsl_path: &str) {
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
            if let Some(entry) = index
                .entries
                .iter_mut()
                .find(|entry| entry.wsl_path == normalized_path)
            {
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

pub(super) fn collect_search_index_entries(
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

pub(super) fn ensure_search_index(
    session_id: &str,
    root_dir: &str,
    distro: &str,
) -> Result<Vec<CachedFileEntry>, String> {
    Ok(ensure_search_index_cache(session_id, root_dir, distro)?.entries)
}

pub(super) fn ensure_search_index_cache(
    session_id: &str,
    root_dir: &str,
    distro: &str,
) -> Result<CachedFileIndex, String> {
    if let Some(index) = cached_search_index(session_id, root_dir) {
        return Ok(index);
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
    path.components()
        .all(|component| matches!(component, Component::Normal(_) | Component::CurDir))
}

pub(super) fn build_cached_entries_from_relative_candidates(
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
pub(super) fn build_ranked_search_entries_from_relative_candidates(
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
pub(super) fn build_ranked_search_entries_from_relative_candidates(
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

pub(super) fn search_rank(
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

#[cfg(test)]
mod tests;

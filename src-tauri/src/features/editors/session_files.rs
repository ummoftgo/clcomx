use super::file_policy::{
    infer_language_id, metadata_mtime_ms, read_text_file_with_policy, MAX_SESSION_FILE_BYTES,
};
use super::path_resolution::{
    canonical_access_path, ensure_resolved_path_within_session_root, ensure_search_root_allowed,
    ensure_session_file_allowed, resolve_existing_access_path,
};
#[cfg(test)]
use super::path_resolution::normalize_posix_path;
use super::search_index::{
    build_cached_entries_from_relative_candidates, build_ranked_search_entries_from_relative_candidates,
    build_search_index_cache_once, cache_index, cached_list_response, collect_search_index_entries,
    ensure_search_index, ensure_search_index_cache, search_rank, upsert_search_cache_path,
};
use super::types::{
    SessionFileListResponse, SessionFileMatch, SessionFileReadResponse, SessionFileSearchResponse,
    SessionFileWriteResponse,
};
use crate::commands::settings::{find_session_tab_snapshot, WorkspaceState, WorkspaceTabSnapshot};
use crate::commands::wsl::{list_wsl_files, search_wsl_files, WslState};
use std::fs;

fn session_tab_context(
    workspace_state: &WorkspaceState,
    session_id: &str,
) -> Result<WorkspaceTabSnapshot, String> {
    find_session_tab_snapshot(workspace_state, session_id)?
        .ok_or_else(|| format!("Unknown session: {session_id}"))
}

pub(super) fn list_session_files_with_state(
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

pub(super) fn search_session_files_with_state(
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

pub(super) fn read_session_file_with_state(
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

pub(super) fn write_session_file_with_state(
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

#[cfg(test)]
mod tests;

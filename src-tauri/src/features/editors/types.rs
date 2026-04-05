use serde::Serialize;
use std::sync::{Condvar, Mutex};

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DetectedEditor {
    pub id: String,
    pub label: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedTerminalPath {
    pub raw: String,
    pub wsl_path: String,
    pub copy_text: String,
    pub windows_path: String,
    pub line: Option<u32>,
    pub column: Option<u32>,
    pub is_directory: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum TerminalPathResolution {
    Resolved {
        path: ResolvedTerminalPath,
    },
    Candidates {
        raw: String,
        candidates: Vec<ResolvedTerminalPath>,
    },
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SessionFileMatch {
    pub wsl_path: String,
    pub relative_path: String,
    pub basename: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SessionFileSearchResponse {
    pub root_dir: String,
    pub results: Vec<SessionFileMatch>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SessionFileListResponse {
    pub root_dir: String,
    pub results: Vec<SessionFileMatch>,
    pub last_updated_ms: u64,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SessionFileReadResponse {
    pub wsl_path: String,
    pub content: String,
    pub language_id: String,
    pub size_bytes: u64,
    pub mtime_ms: u64,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SessionFileWriteResponse {
    pub wsl_path: String,
    pub size_bytes: u64,
    pub mtime_ms: u64,
}

#[derive(Debug, Clone)]
pub(super) struct CachedFileEntry {
    pub(super) wsl_path: String,
    pub(super) relative_path: String,
    pub(super) basename: String,
    pub(super) basename_lower: String,
    pub(super) relative_lower: String,
}

#[derive(Debug, Clone)]
pub(super) struct CachedFileIndex {
    pub(super) entries: Vec<CachedFileEntry>,
    pub(super) last_updated_ms: u64,
}

#[derive(Debug)]
pub(super) struct SearchIndexBuildState {
    pub(super) status: Mutex<SearchIndexBuildStatus>,
    pub(super) ready: Condvar,
}

#[derive(Debug)]
pub(super) enum SearchIndexBuildStatus {
    Building,
    Ready(Result<CachedFileIndex, String>),
}

use crate::app_env::{ensure_parent_dir, state_path};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

pub const DEFAULT_TAB_HISTORY_LIMIT: u16 = 10;
pub const MIN_TAB_HISTORY_LIMIT: u16 = 1;
pub const MAX_TAB_HISTORY_LIMIT: u16 = 999;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TabHistoryEntry {
    #[serde(default = "default_agent_id")]
    pub agent_id: String,
    pub distro: String,
    pub work_dir: String,
    pub title: String,
    #[serde(default, alias = "claudeResumeId", alias = "claude_resume_id")]
    pub resume_token: Option<String>,
    pub last_opened_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
struct TabHistoryFile {
    items: Vec<TabHistoryEntry>,
}

pub(crate) fn clamp_tab_history_limit(limit: u16) -> u16 {
    limit.clamp(MIN_TAB_HISTORY_LIMIT, MAX_TAB_HISTORY_LIMIT)
}

pub(crate) fn load_tab_history_with_limit(limit: u16) -> Result<Vec<TabHistoryEntry>, String> {
    let mut entries = read_tab_history()?;
    if trim_tab_history_entries(&mut entries, limit) {
        write_tab_history(&entries)?;
    }
    Ok(entries)
}

pub(crate) fn record_tab_history_with_limit(
    limit: u16,
    agent_id: String,
    distro: String,
    work_dir: String,
    title: String,
    resume_token: Option<String>,
) -> Result<Vec<TabHistoryEntry>, String> {
    let mut entries = read_tab_history().unwrap_or_default();
    upsert_tab_history_entry(
        &mut entries,
        agent_id,
        distro,
        work_dir,
        title,
        resume_token,
    );
    trim_tab_history_entries(&mut entries, limit);
    write_tab_history(&entries)?;
    Ok(entries)
}

pub(crate) fn trim_tab_history_to_limit(limit: u16) -> Result<Vec<TabHistoryEntry>, String> {
    let mut entries = read_tab_history().unwrap_or_default();
    trim_tab_history_entries(&mut entries, limit);
    write_tab_history(&entries)?;
    Ok(entries)
}

pub(crate) fn remove_persisted_tab_history_entry(
    entry: TabHistoryEntry,
) -> Result<Vec<TabHistoryEntry>, String> {
    let mut entries = read_tab_history().unwrap_or_default();
    if remove_tab_history_entry_from_entries(&mut entries, &entry) {
        write_tab_history(&entries)?;
    }
    Ok(entries)
}

fn tab_history_path() -> Result<PathBuf, String> {
    state_path("tab_history.json")
}

fn default_agent_id() -> String {
    "claude".into()
}

fn normalize_agent_id(value: &str) -> String {
    let normalized = value.trim().to_lowercase();
    if normalized.is_empty() {
        default_agent_id()
    } else {
        normalized
    }
}

fn read_tab_history() -> Result<Vec<TabHistoryEntry>, String> {
    let path = tab_history_path()?;
    if !path.exists() {
        return Ok(Vec::new());
    }

    let contents = fs::read_to_string(&path)
        .map_err(|e| format!("Failed to read {}: {}", path.display(), e))?;
    let mut history = serde_json::from_str::<TabHistoryFile>(&contents)
        .map_err(|e| format!("Invalid tab_history.json: {}", e))?;
    for entry in &mut history.items {
        entry.resume_token = None;
    }

    Ok(history.items)
}

fn sanitize_tab_history_entries(entries: &[TabHistoryEntry]) -> Vec<TabHistoryEntry> {
    entries
        .iter()
        .cloned()
        .map(|mut entry| {
            entry.resume_token = None;
            entry
        })
        .collect()
}

fn write_tab_history(entries: &[TabHistoryEntry]) -> Result<(), String> {
    let path = tab_history_path()?;
    ensure_parent_dir(&path)?;
    let contents = serde_json::to_string_pretty(&TabHistoryFile {
        items: sanitize_tab_history_entries(entries),
    })
    .map_err(|e| format!("Failed to serialize tab history: {}", e))?;

    fs::write(&path, contents).map_err(|e| format!("Failed to write {}: {}", path.display(), e))
}

fn trim_tab_history_entries(entries: &mut Vec<TabHistoryEntry>, limit: u16) -> bool {
    let clamped_limit = clamp_tab_history_limit(limit) as usize;
    if entries.len() <= clamped_limit {
        return false;
    }

    entries.truncate(clamped_limit);
    true
}

fn tab_history_entries_match(left: &TabHistoryEntry, right: &TabHistoryEntry) -> bool {
    normalize_agent_id(&left.agent_id) == normalize_agent_id(&right.agent_id)
        && left.distro == right.distro
        && left.work_dir == right.work_dir
        && left.title == right.title
        && left.last_opened_at == right.last_opened_at
}

fn remove_tab_history_entry_from_entries(
    entries: &mut Vec<TabHistoryEntry>,
    entry: &TabHistoryEntry,
) -> bool {
    let Some(index) = entries
        .iter()
        .position(|candidate| tab_history_entries_match(candidate, entry))
    else {
        return false;
    };

    entries.remove(index);
    true
}

fn upsert_tab_history_entry(
    entries: &mut Vec<TabHistoryEntry>,
    agent_id: String,
    distro: String,
    work_dir: String,
    title: String,
    _resume_token: Option<String>,
) {
    let normalized_agent_id = normalize_agent_id(&agent_id);
    entries.retain(|entry| {
        !(normalize_agent_id(&entry.agent_id) == normalized_agent_id
            && entry.distro == distro
            && entry.work_dir == work_dir)
    });

    entries.insert(
        0,
        TabHistoryEntry {
            agent_id: normalized_agent_id,
            distro,
            work_dir,
            title,
            resume_token: None,
            last_opened_at: now_timestamp(),
        },
    );
}

fn now_timestamp() -> String {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::{
        remove_tab_history_entry_from_entries, trim_tab_history_entries, upsert_tab_history_entry,
        TabHistoryEntry,
    };

    const EXAMPLE_DISTRO: &str = "Ubuntu";

    #[test]
    fn trim_tab_history_respects_limit() {
        let mut entries = vec![
            TabHistoryEntry {
                agent_id: "claude".into(),
                distro: EXAMPLE_DISTRO.into(),
                work_dir: "/a".into(),
                title: "a".into(),
                resume_token: None,
                last_opened_at: "1".into(),
            },
            TabHistoryEntry {
                agent_id: "claude".into(),
                distro: EXAMPLE_DISTRO.into(),
                work_dir: "/b".into(),
                title: "b".into(),
                resume_token: None,
                last_opened_at: "2".into(),
            },
            TabHistoryEntry {
                agent_id: "claude".into(),
                distro: EXAMPLE_DISTRO.into(),
                work_dir: "/c".into(),
                title: "c".into(),
                resume_token: None,
                last_opened_at: "3".into(),
            },
        ];

        let changed = trim_tab_history_entries(&mut entries, 2);

        assert!(changed);
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].work_dir, "/a");
        assert_eq!(entries[1].work_dir, "/b");
    }

    #[test]
    fn upsert_tab_history_coalesces_resume_sessions_for_same_path() {
        let mut entries = vec![
            TabHistoryEntry {
                agent_id: "claude".into(),
                distro: EXAMPLE_DISTRO.into(),
                work_dir: "/same".into(),
                title: "same".into(),
                resume_token: Some("resume-a".into()),
                last_opened_at: "1".into(),
            },
            TabHistoryEntry {
                agent_id: "claude".into(),
                distro: EXAMPLE_DISTRO.into(),
                work_dir: "/same".into(),
                title: "same".into(),
                resume_token: Some("resume-b".into()),
                last_opened_at: "2".into(),
            },
            TabHistoryEntry {
                agent_id: "claude".into(),
                distro: EXAMPLE_DISTRO.into(),
                work_dir: "/same".into(),
                title: "same".into(),
                resume_token: None,
                last_opened_at: "3".into(),
            },
        ];

        upsert_tab_history_entry(
            &mut entries,
            "claude".into(),
            EXAMPLE_DISTRO.into(),
            "/same".into(),
            "same".into(),
            Some("resume-a".into()),
        );

        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].resume_token, None);

        upsert_tab_history_entry(
            &mut entries,
            "claude".into(),
            EXAMPLE_DISTRO.into(),
            "/same".into(),
            "same".into(),
            None,
        );

        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].resume_token, None);
    }

    #[test]
    fn upsert_tab_history_keeps_distinct_agents_for_same_path_without_resume_token() {
        let mut entries = vec![TabHistoryEntry {
            agent_id: "claude".into(),
            distro: EXAMPLE_DISTRO.into(),
            work_dir: "/same".into(),
            title: "same".into(),
            resume_token: None,
            last_opened_at: "1".into(),
        }];

        upsert_tab_history_entry(
            &mut entries,
            "codex".into(),
            EXAMPLE_DISTRO.into(),
            "/same".into(),
            "same".into(),
            None,
        );

        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].agent_id, "codex");
        assert_eq!(entries[1].agent_id, "claude");
    }

    #[test]
    fn upsert_tab_history_does_not_store_resume_tokens() {
        let mut entries = Vec::new();

        upsert_tab_history_entry(
            &mut entries,
            "claude".into(),
            EXAMPLE_DISTRO.into(),
            "/same".into(),
            "same".into(),
            Some("resume-secret".into()),
        );

        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].resume_token, None);
    }

    #[test]
    fn remove_tab_history_entry_keeps_other_entries_for_same_path() {
        let target = TabHistoryEntry {
            agent_id: "claude".into(),
            distro: EXAMPLE_DISTRO.into(),
            work_dir: "/same".into(),
            title: "same".into(),
            resume_token: Some("resume-a".into()),
            last_opened_at: "2".into(),
        };
        let mut entries = vec![
            TabHistoryEntry {
                agent_id: "claude".into(),
                distro: EXAMPLE_DISTRO.into(),
                work_dir: "/same".into(),
                title: "same".into(),
                resume_token: None,
                last_opened_at: "1".into(),
            },
            target.clone(),
            TabHistoryEntry {
                agent_id: "claude".into(),
                distro: EXAMPLE_DISTRO.into(),
                work_dir: "/same".into(),
                title: "same".into(),
                resume_token: Some("resume-b".into()),
                last_opened_at: "3".into(),
            },
        ];

        let removed = remove_tab_history_entry_from_entries(&mut entries, &target);

        assert!(removed);
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].resume_token, None);
        assert_eq!(entries[1].resume_token.as_deref(), Some("resume-b"));
    }

    #[test]
    fn remove_tab_history_entry_requires_exact_timestamp_match() {
        let target = TabHistoryEntry {
            agent_id: "claude".into(),
            distro: EXAMPLE_DISTRO.into(),
            work_dir: "/same".into(),
            title: "same".into(),
            resume_token: Some("resume-a".into()),
            last_opened_at: "2".into(),
        };
        let mut entries = vec![TabHistoryEntry {
            agent_id: "claude".into(),
            distro: EXAMPLE_DISTRO.into(),
            work_dir: "/same".into(),
            title: "same".into(),
            resume_token: Some("resume-a".into()),
            last_opened_at: "1".into(),
        }];

        let removed = remove_tab_history_entry_from_entries(&mut entries, &target);

        assert!(!removed);
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].last_opened_at, "1");
    }
}

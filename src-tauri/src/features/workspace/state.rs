use super::types::{WorkspaceSnapshot, WorkspaceTabSnapshot};
use std::sync::Mutex;

pub struct WorkspaceState {
    snapshot: Mutex<WorkspaceSnapshot>,
}

impl WorkspaceState {
    pub fn new(initial: WorkspaceSnapshot) -> Self {
        Self {
            snapshot: Mutex::new(initial),
        }
    }
}

pub fn snapshot_from_state(state: &WorkspaceState) -> Result<WorkspaceSnapshot, String> {
    state
        .snapshot
        .lock()
        .map(|snapshot| snapshot.clone())
        .map_err(|e| e.to_string())
}

pub fn write_snapshot_to_state(
    state: &WorkspaceState,
    snapshot: WorkspaceSnapshot,
) -> Result<(), String> {
    let mut guard = state.snapshot.lock().map_err(|e| e.to_string())?;
    *guard = snapshot;
    Ok(())
}

pub fn find_session_tab_snapshot(
    state: &WorkspaceState,
    session_id: &str,
) -> Result<Option<WorkspaceTabSnapshot>, String> {
    let snapshot = snapshot_from_state(state)?;
    Ok(snapshot
        .windows
        .into_iter()
        .flat_map(|window| window.tabs.into_iter())
        .find(|tab| tab.session_id == session_id))
}

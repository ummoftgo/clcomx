mod state;
mod store;
mod service;
mod types;

pub use self::state::{find_session_tab_snapshot, WorkspaceState};
pub use self::store::load_workspace_or_default;
pub use self::types::{EditorTabRef, WindowSnapshot, WorkspaceSnapshot, WorkspaceTabSnapshot};
pub(crate) use self::service::{
    collect_window_ptys, ensure_active_session, find_window_index, merge_window_snapshot,
    next_available_window_label, remove_session_from_workspace,
};
pub(crate) use self::state::{snapshot_from_state, write_snapshot_to_state};
pub(crate) use self::store::{normalize_window_snapshot, normalize_workspace_snapshot, write_workspace};

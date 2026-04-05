mod service;
mod state;
mod store;
mod types;

pub(crate) use self::service::{
    clear_session_pty_in_workspace, collect_window_ptys, ensure_active_session, find_window_index,
    merge_workspace_snapshot, next_available_window_label, remove_session_from_workspace,
    set_session_aux_terminal_state_in_workspace, set_session_pty_in_workspace,
    set_session_resume_token_in_workspace,
    update_window_geometry_in_workspace,
};
pub use self::state::{find_session_tab_snapshot, WorkspaceState};
pub(crate) use self::state::{snapshot_from_state, write_snapshot_to_state};
pub use self::store::load_workspace_or_default;
pub(crate) use self::store::{
    normalize_window_snapshot, normalize_workspace_snapshot, write_workspace,
};
pub use self::types::{EditorTabRef, WindowSnapshot, WorkspaceSnapshot, WorkspaceTabSnapshot};

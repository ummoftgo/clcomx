use crate::features::workspace::{WorkspaceSnapshot, WorkspaceTabSnapshot};

pub(crate) fn set_session_pty_in_workspace(
    workspace: &mut WorkspaceSnapshot,
    session_id: &str,
    pty_id: u32,
) -> Result<(), String> {
    let tab = find_session_tab_mut(workspace, session_id)?;
    tab.pty_id = Some(pty_id);
    Ok(())
}

pub(crate) fn set_session_resume_token_in_workspace(
    workspace: &mut WorkspaceSnapshot,
    session_id: &str,
    resume_token: Option<String>,
) -> Result<(), String> {
    let tab = find_session_tab_mut(workspace, session_id)?;
    tab.resume_token = normalize_resume_token(resume_token);
    Ok(())
}

pub(crate) fn clear_session_pty_in_workspace(
    workspace: &mut WorkspaceSnapshot,
    session_id: &str,
) -> Result<(), String> {
    let tab = find_session_tab_mut(workspace, session_id)?;
    tab.pty_id = None;
    Ok(())
}

pub(crate) fn set_session_aux_terminal_state_in_workspace(
    workspace: &mut WorkspaceSnapshot,
    session_id: &str,
    aux_pty_id: Option<u32>,
    aux_visible: bool,
    aux_height_percent: Option<u16>,
) -> Result<(), String> {
    let tab = find_session_tab_mut(workspace, session_id)?;
    tab.aux_pty_id = aux_pty_id;
    tab.aux_visible = aux_visible;
    tab.aux_height_percent = aux_height_percent;
    Ok(())
}

fn find_session_tab_mut<'a>(
    workspace: &'a mut WorkspaceSnapshot,
    session_id: &str,
) -> Result<&'a mut WorkspaceTabSnapshot, String> {
    for window in &mut workspace.windows {
        if let Some(tab) = window
            .tabs
            .iter_mut()
            .find(|tab| tab.session_id == session_id)
        {
            return Ok(tab);
        }
    }

    Err("Session not found".into())
}

fn normalize_resume_token(resume_token: Option<String>) -> Option<String> {
    resume_token
        .as_ref()
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
        .map(|value| value.to_string())
}

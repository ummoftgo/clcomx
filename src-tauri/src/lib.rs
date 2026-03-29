mod app_env;
mod commands;

use commands::clipboard::{
    clear_image_cache, get_image_cache_stats, open_image_cache_folder, save_clipboard_image,
};
use commands::editors::{list_available_editors, open_in_editor, resolve_terminal_path};
use commands::external::open_external_url;
use commands::fonts::list_monospace_fonts;
use commands::pty::{
    PtyState, pty_close_and_capture_resume, pty_get_output_delta_since, pty_get_output_snapshot,
    pty_get_runtime_snapshot, pty_kill, pty_resize, pty_spawn, pty_take_initial_output, pty_write,
};
use commands::settings::{
    WindowReadyState, WorkspaceState, bootstrap_app, close_app, close_session, close_session_by_pty,
    clear_session_pty, close_window_sessions, detach_session_to_new_window, load_settings,
    load_settings_or_default, is_window_ready, load_tab_history, load_workspace,
    load_workspace_or_default, move_session_to_window, move_window_sessions_to_main,
    open_empty_window, record_tab_history, remove_tab_history_entry, remove_window,
    restore_secondary_windows, save_settings, save_workspace, set_session_aux_terminal_state,
    set_session_pty, set_session_resume_token, trim_tab_history, update_window_geometry,
    window_ready,
};
use commands::wsl::{WslState, list_wsl_distros, list_wsl_directories};
use tauri::{Manager, PhysicalPosition, PhysicalSize};

fn restore_main_window(app: &tauri::AppHandle) {
    let settings = load_settings_or_default();
    let Some(main_window) = app.get_webview_window("main") else {
        return;
    };
    let Some(placement) = settings.main_window else {
        return;
    };

    let width = placement.width.max(640);
    let height = placement.height.max(480);

    let _ = main_window.set_position(PhysicalPosition::new(placement.x, placement.y));
    let _ = main_window.set_size(PhysicalSize::new(width, height));

    if placement.maximized {
        let _ = main_window.maximize();
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let initial_workspace = load_workspace_or_default();

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .manage(PtyState::default())
        .manage(WslState::default())
        .manage(WorkspaceState::new(initial_workspace))
        .manage(WindowReadyState::default())
        .setup(|app| {
            restore_main_window(app.handle());
            let workspace_state = app.state::<WorkspaceState>();
            let ready_state = app.state::<WindowReadyState>();
            restore_secondary_windows(app.handle(), workspace_state.inner(), ready_state.inner())?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            bootstrap_app,
            window_ready,
            is_window_ready,
            pty_spawn,
            pty_take_initial_output,
            pty_get_output_snapshot,
            pty_get_runtime_snapshot,
            pty_get_output_delta_since,
            pty_write,
            pty_resize,
            pty_kill,
            pty_close_and_capture_resume,
            load_settings,
            load_tab_history,
            load_workspace,
            record_tab_history,
            trim_tab_history,
            remove_tab_history_entry,
            save_settings,
            save_workspace,
            set_session_pty,
            set_session_aux_terminal_state,
            set_session_resume_token,
            clear_session_pty,
            open_empty_window,
            detach_session_to_new_window,
            move_session_to_window,
            close_session,
            close_session_by_pty,
            update_window_geometry,
            move_window_sessions_to_main,
            close_window_sessions,
            remove_window,
            close_app,
            save_clipboard_image,
            get_image_cache_stats,
            open_image_cache_folder,
            clear_image_cache,
            open_external_url,
            list_available_editors,
            resolve_terminal_path,
            open_in_editor,
            list_wsl_distros,
            list_wsl_directories,
            list_monospace_fonts,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

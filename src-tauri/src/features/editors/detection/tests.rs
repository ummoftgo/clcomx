use super::*;
use std::path::Path;

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
    assert!(subkeys
        .iter()
        .any(|value| value
            .ends_with(r"WOW6432Node\Microsoft\Windows\CurrentVersion\App Paths\Code.exe")));
}

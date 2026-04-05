use super::*;
use std::env;
use std::fs;
use std::time::{SystemTime, UNIX_EPOCH};

fn workspace_state_with_session(
    session_id: &str,
    distro: &str,
    work_dir: &str,
    pty_id: Option<u32>,
) -> WorkspaceState {
    let tab = crate::commands::workspace::WorkspaceTabSnapshot {
        session_id: session_id.to_string(),
        agent_id: "claude".into(),
        distro: distro.to_string(),
        work_dir: work_dir.to_string(),
        title: "session".into(),
        pinned: false,
        locked: false,
        resume_token: None,
        pty_id,
        aux_pty_id: None,
        aux_visible: false,
        aux_height_percent: None,
        view_mode: "terminal".into(),
        editor_root_dir: work_dir.to_string(),
        open_editor_tabs: Vec::new(),
        active_editor_path: None,
    };

    let window = crate::commands::workspace::WindowSnapshot {
        label: "main".into(),
        name: "main".into(),
        role: "main".into(),
        tabs: vec![tab],
        active_session_id: Some(session_id.to_string()),
        x: 0,
        y: 0,
        width: 1024,
        height: 720,
        maximized: false,
    };

    WorkspaceState::new(crate::commands::workspace::WorkspaceSnapshot {
        windows: vec![window],
    })
}

#[test]
fn search_session_files_returns_empty_results_for_empty_query() {
    let unique = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("system time went backwards")
        .as_nanos();
    let root = env::temp_dir().join(format!("clcomx-editor-search-empty-{unique}"));
    fs::create_dir_all(root.join("src")).unwrap();
    fs::write(root.join("src/main.ts"), "console.log('ok');").unwrap();

    let workspace_state =
        workspace_state_with_session("session-1", "Ubuntu-20.04", root.to_str().unwrap(), None);
    let result = search_session_files_with_state(
        &workspace_state,
        None,
        "session-1",
        root.to_str().unwrap(),
        "",
        Some(50),
    )
    .expect("search should succeed");

    assert!(result.results.is_empty());

    let _ = fs::remove_dir_all(&root);
}

#[test]
fn search_session_files_filters_binary_large_and_heavy_entries() {
    let unique = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("system time went backwards")
        .as_nanos();
    let root = env::temp_dir().join(format!("clcomx-editor-search-{unique}"));
    fs::create_dir_all(root.join("src")).unwrap();
    fs::create_dir_all(root.join(".config")).unwrap();
    fs::create_dir_all(root.join("node_modules")).unwrap();

    fs::write(root.join("src/main.ts"), "console.log('ok');").unwrap();
    fs::write(root.join(".config/app.yml"), "theme: dark\n").unwrap();
    fs::write(root.join("node_modules/skip.ts"), "skip").unwrap();
    fs::write(root.join("src/image.bin"), [0, 1, 2, 3]).unwrap();
    fs::write(
        root.join("src/large.txt"),
        "a".repeat((MAX_SESSION_FILE_BYTES as usize) + 1),
    )
    .unwrap();

    let workspace_state =
        workspace_state_with_session("session-1", "Ubuntu-20.04", root.to_str().unwrap(), None);
    let result = search_session_files_with_state(
        &workspace_state,
        None,
        "session-1",
        root.to_str().unwrap(),
        ".",
        Some(50),
    )
    .expect("search should succeed");

    let relative_paths = result
        .results
        .iter()
        .map(|entry| entry.relative_path.as_str())
        .collect::<Vec<_>>();

    assert!(relative_paths.contains(&"src/main.ts"));
    assert!(relative_paths.contains(&".config/app.yml"));
    assert!(!relative_paths.contains(&"node_modules/skip.ts"));
    assert!(!relative_paths.contains(&"src/image.bin"));
    assert!(!relative_paths.contains(&"src/large.txt"));

    let _ = fs::remove_dir_all(&root);
}

#[test]
fn search_session_files_rejects_root_outside_session_directory() {
    let unique = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("system time went backwards")
        .as_nanos();
    let session_root = env::temp_dir().join(format!("clcomx-editor-root-{unique}"));
    let outside_root = env::temp_dir().join(format!("clcomx-editor-root-outside-{unique}"));
    fs::create_dir_all(&session_root).unwrap();
    fs::create_dir_all(&outside_root).unwrap();

    let workspace_state = workspace_state_with_session(
        "session-1",
        "Ubuntu-20.04",
        session_root.to_str().unwrap(),
        None,
    );
    let error = search_session_files_with_state(
        &workspace_state,
        None,
        "session-1",
        outside_root.to_str().unwrap(),
        "",
        None,
    )
    .expect_err("search should fail");

    assert!(error.contains("Search root must stay within the session working directory"));

    let _ = fs::remove_dir_all(&session_root);
    let _ = fs::remove_dir_all(&outside_root);
}

#[test]
fn read_session_file_rejects_paths_outside_session_directory() {
    let unique = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("system time went backwards")
        .as_nanos();
    let session_root = env::temp_dir().join(format!("clcomx-editor-read-root-{unique}"));
    let outside_root = env::temp_dir().join(format!("clcomx-editor-read-outside-{unique}"));
    fs::create_dir_all(&session_root).unwrap();
    fs::create_dir_all(&outside_root).unwrap();
    fs::write(outside_root.join("notes.md"), "# outside").unwrap();

    let workspace_state = workspace_state_with_session(
        "session-1",
        "Ubuntu-20.04",
        session_root.to_str().unwrap(),
        None,
    );
    let error = read_session_file_with_state(
        &workspace_state,
        "session-1",
        outside_root.join("notes.md").to_str().unwrap(),
    )
    .expect_err("read should fail");

    assert!(error.contains("Path must stay within the session working directory"));

    let _ = fs::remove_dir_all(&session_root);
    let _ = fs::remove_dir_all(&outside_root);
}

#[test]
fn read_session_file_returns_content_language_and_mtime() {
    let unique = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("system time went backwards")
        .as_nanos();
    let root = env::temp_dir().join(format!("clcomx-editor-read-{unique}"));
    fs::create_dir_all(root.join("src")).unwrap();
    let file = root.join("src/lib.rs");
    fs::write(&file, "fn main() {}\n").unwrap();

    let workspace_state =
        workspace_state_with_session("session-1", "Ubuntu-20.04", root.to_str().unwrap(), None);
    let response =
        read_session_file_with_state(&workspace_state, "session-1", file.to_str().unwrap())
            .expect("read should succeed");

    assert_eq!(response.content, "fn main() {}\n");
    assert_eq!(response.language_id, "rust");
    assert_eq!(response.size_bytes, 13);
    assert!(response.mtime_ms > 0);

    let _ = fs::remove_dir_all(&root);
}

#[test]
fn read_session_file_rejects_binary_and_large_files() {
    let unique = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("system time went backwards")
        .as_nanos();
    let root = env::temp_dir().join(format!("clcomx-editor-read-policy-{unique}"));
    fs::create_dir_all(root.join("src")).unwrap();
    let binary_file = root.join("src/image.bin");
    let large_file = root.join("src/large.txt");
    fs::write(&binary_file, [0, 1, 2, 3]).unwrap();
    fs::write(
        &large_file,
        "a".repeat((MAX_SESSION_FILE_BYTES as usize) + 1),
    )
    .unwrap();

    let workspace_state =
        workspace_state_with_session("session-1", "Ubuntu-20.04", root.to_str().unwrap(), None);

    let binary_error =
        read_session_file_with_state(&workspace_state, "session-1", binary_file.to_str().unwrap())
            .expect_err("binary read should fail");
    assert_eq!(binary_error, "BinaryFile");

    let large_error =
        read_session_file_with_state(&workspace_state, "session-1", large_file.to_str().unwrap())
            .expect_err("large read should fail");
    assert_eq!(large_error, "FileTooLarge");

    let _ = fs::remove_dir_all(&root);
}

#[cfg(unix)]
#[test]
fn search_session_files_allows_symlinked_session_root() {
    let unique = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("system time went backwards")
        .as_nanos();
    let base = env::temp_dir().join(format!("clcomx-editor-search-symlink-{unique}"));
    let real_root = base.join("real-root");
    let session_root = base.join("session-root");
    fs::create_dir_all(real_root.join("src")).unwrap();
    fs::write(real_root.join("src/main.ts"), "console.log('ok');\n").unwrap();
    std::os::unix::fs::symlink(&real_root, &session_root).unwrap();

    let workspace_state = workspace_state_with_session(
        "session-1",
        "Ubuntu-20.04",
        session_root.to_str().unwrap(),
        None,
    );
    let response =
        search_session_files_with_state(&workspace_state, None, "session-1", "", "main", None)
            .expect("search should succeed");

    assert_eq!(
        response.root_dir,
        normalize_posix_path(session_root.to_str().unwrap())
    );
    assert_eq!(response.results.len(), 1);
    assert_eq!(
        response.results[0].wsl_path,
        normalize_posix_path(&session_root.join("src/main.ts").to_string_lossy())
    );

    let _ = fs::remove_dir_all(&base);
}

#[test]
fn list_session_files_returns_cached_results_until_forced_refresh() {
    let unique = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("system time went backwards")
        .as_nanos();
    let root = env::temp_dir().join(format!("clcomx-editor-list-cache-{unique}"));
    fs::create_dir_all(root.join("src")).unwrap();
    fs::write(root.join("src/main.ts"), "console.log('ok');\n").unwrap();

    let workspace_state =
        workspace_state_with_session("session-1", "Ubuntu-20.04", root.to_str().unwrap(), None);

    let initial = list_session_files_with_state(
        &workspace_state,
        None,
        "session-1",
        root.to_str().unwrap(),
        false,
    )
    .expect("list should succeed");
    assert_eq!(initial.results.len(), 1);

    fs::write(root.join("src/second.ts"), "console.log('later');\n").unwrap();

    let cached = list_session_files_with_state(
        &workspace_state,
        None,
        "session-1",
        root.to_str().unwrap(),
        false,
    )
    .expect("cached list should succeed");
    assert_eq!(cached.results.len(), 1);

    let refreshed = list_session_files_with_state(
        &workspace_state,
        None,
        "session-1",
        root.to_str().unwrap(),
        true,
    )
    .expect("force refresh should succeed");
    assert_eq!(refreshed.results.len(), 2);
    assert!(refreshed.last_updated_ms >= initial.last_updated_ms);

    let _ = fs::remove_dir_all(&root);
}

#[cfg(unix)]
#[test]
fn read_session_file_allows_symlinked_session_root() {
    let unique = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("system time went backwards")
        .as_nanos();
    let base = env::temp_dir().join(format!("clcomx-editor-read-symlink-{unique}"));
    let real_root = base.join("real-root");
    let session_root = base.join("session-root");
    let file = real_root.join("src/lib.rs");
    fs::create_dir_all(file.parent().unwrap()).unwrap();
    fs::write(&file, "fn main() {}\n").unwrap();
    std::os::unix::fs::symlink(&real_root, &session_root).unwrap();

    let workspace_state = workspace_state_with_session(
        "session-1",
        "Ubuntu-20.04",
        session_root.to_str().unwrap(),
        None,
    );
    let response = read_session_file_with_state(
        &workspace_state,
        "session-1",
        session_root.join("src/lib.rs").to_str().unwrap(),
    )
    .expect("read should succeed");

    assert_eq!(response.content, "fn main() {}\n");
    assert_eq!(
        response.wsl_path,
        normalize_posix_path(&session_root.join("src/lib.rs").to_string_lossy())
    );

    let _ = fs::remove_dir_all(&base);
}

#[test]
fn write_session_file_updates_file_and_touches_session_cache() {
    let unique = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("system time went backwards")
        .as_nanos();
    let root = env::temp_dir().join(format!("clcomx-editor-write-{unique}"));
    fs::create_dir_all(root.join("src")).unwrap();
    let file = root.join("src/main.ts");
    fs::write(&file, "console.log('old');\n").unwrap();

    let workspace_state =
        workspace_state_with_session("session-1", "Ubuntu-20.04", root.to_str().unwrap(), None);
    let initial_search = search_session_files_with_state(
        &workspace_state,
        None,
        "session-1",
        root.to_str().unwrap(),
        "main",
        Some(20),
    )
    .expect("initial search should succeed");
    assert_eq!(initial_search.results.len(), 1);

    let read = read_session_file_with_state(&workspace_state, "session-1", file.to_str().unwrap())
        .expect("read should succeed");
    let write = write_session_file_with_state(
        &workspace_state,
        "session-1",
        file.to_str().unwrap(),
        "console.log('new');\n",
        read.mtime_ms,
    )
    .expect("write should succeed");

    assert!(write.mtime_ms >= read.mtime_ms);
    assert_eq!(fs::read_to_string(&file).unwrap(), "console.log('new');\n");

    let index = cached_list_response("session-1", root.to_str().unwrap())
        .expect("cache entry should remain available");
    assert!(index
        .results
        .iter()
        .any(|entry| entry.wsl_path == normalize_posix_path(&file.to_string_lossy())));

    let _ = fs::remove_dir_all(&root);
}

#[test]
fn write_session_file_rejects_mtime_conflicts() {
    let unique = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("system time went backwards")
        .as_nanos();
    let root = env::temp_dir().join(format!("clcomx-editor-write-conflict-{unique}"));
    fs::create_dir_all(root.join("src")).unwrap();
    let file = root.join("src/main.ts");
    fs::write(&file, "console.log('old');\n").unwrap();

    let workspace_state =
        workspace_state_with_session("session-1", "Ubuntu-20.04", root.to_str().unwrap(), None);
    let read = read_session_file_with_state(&workspace_state, "session-1", file.to_str().unwrap())
        .expect("read should succeed");
    std::thread::sleep(std::time::Duration::from_millis(5));
    fs::write(&file, "console.log('changed elsewhere');\n").unwrap();

    let error = write_session_file_with_state(
        &workspace_state,
        "session-1",
        file.to_str().unwrap(),
        "console.log('new');\n",
        read.mtime_ms,
    )
    .expect_err("write should fail");

    assert_eq!(error, "FileModifiedOnDisk");

    let _ = fs::remove_dir_all(&root);
}

#[test]
fn write_session_file_rejects_binary_targets_and_large_content() {
    let unique = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("system time went backwards")
        .as_nanos();
    let root = env::temp_dir().join(format!("clcomx-editor-write-policy-{unique}"));
    fs::create_dir_all(root.join("src")).unwrap();
    let binary_file = root.join("src/image.bin");
    let text_file = root.join("src/main.ts");
    fs::write(&binary_file, [0, 1, 2, 3]).unwrap();
    fs::write(&text_file, "console.log('ok');\n").unwrap();

    let workspace_state =
        workspace_state_with_session("session-1", "Ubuntu-20.04", root.to_str().unwrap(), None);

    let binary_mtime = metadata_mtime_ms(&fs::metadata(&binary_file).unwrap());
    let binary_error = write_session_file_with_state(
        &workspace_state,
        "session-1",
        binary_file.to_str().unwrap(),
        "text now\n",
        binary_mtime,
    )
    .expect_err("binary write should fail");
    assert_eq!(binary_error, "BinaryFile");

    let text_read =
        read_session_file_with_state(&workspace_state, "session-1", text_file.to_str().unwrap())
            .expect("text read should succeed");
    let large_error = write_session_file_with_state(
        &workspace_state,
        "session-1",
        text_file.to_str().unwrap(),
        &"a".repeat((MAX_SESSION_FILE_BYTES as usize) + 1),
        text_read.mtime_ms,
    )
    .expect_err("oversized write should fail");
    assert_eq!(large_error, "FileTooLarge");

    let _ = fs::remove_dir_all(&root);
}

#[cfg(unix)]
#[test]
fn read_session_file_rejects_symlink_escape_outside_session_directory() {
    let unique = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("system time went backwards")
        .as_nanos();
    let session_root = env::temp_dir().join(format!("clcomx-editor-symlink-root-{unique}"));
    let outside_root = env::temp_dir().join(format!("clcomx-editor-symlink-outside-{unique}"));
    fs::create_dir_all(&session_root).unwrap();
    fs::create_dir_all(&outside_root).unwrap();
    fs::write(outside_root.join("secret.txt"), "secret").unwrap();
    std::os::unix::fs::symlink(
        outside_root.join("secret.txt"),
        session_root.join("link.txt"),
    )
    .unwrap();

    let workspace_state = workspace_state_with_session(
        "session-1",
        "Ubuntu-20.04",
        session_root.to_str().unwrap(),
        None,
    );
    let error = read_session_file_with_state(
        &workspace_state,
        "session-1",
        session_root.join("link.txt").to_str().unwrap(),
    )
    .expect_err("read should fail");

    assert!(error.contains("Path must stay within the session working directory"));

    let _ = fs::remove_dir_all(&session_root);
    let _ = fs::remove_dir_all(&outside_root);
}

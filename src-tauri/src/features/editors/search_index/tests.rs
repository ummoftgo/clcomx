use super::*;
use std::sync::{
    atomic::{AtomicBool, AtomicUsize, Ordering},
    Arc,
};

#[test]
fn in_flight_search_index_build_waits_for_existing_work() {
    let session_id = "session-1";
    let root_dir = "/tmp/clcomx-in-flight-search-index";
    let key = cache_key(session_id, root_dir);
    let first_state = Arc::new(SearchIndexBuildState {
        status: Mutex::new(SearchIndexBuildStatus::Building),
        ready: Condvar::new(),
    });

    if let Ok(mut inflight) = file_search_in_flight().lock() {
        inflight.insert(key.clone(), first_state.clone());
    }

    let build_count = Arc::new(AtomicUsize::new(0));
    let follower_entered = Arc::new(AtomicBool::new(false));
    let follower_state = first_state.clone();
    let follower_count = build_count.clone();
    let follower_flag = follower_entered.clone();
    let follower = std::thread::spawn(move || {
        follower_flag.store(true, Ordering::SeqCst);
        let result = wait_for_search_index_build(&follower_state)
            .expect("follower should receive completed result");
        follower_count.fetch_add(result.entries.len(), Ordering::SeqCst);
    });

    while !follower_entered.load(Ordering::SeqCst) {
        std::thread::yield_now();
    }

    let result = Ok(cache_index(vec![CachedFileEntry {
        wsl_path: "/tmp/clcomx-in-flight-search-index/src/main.ts".into(),
        relative_path: "src/main.ts".into(),
        basename: "main.ts".into(),
        basename_lower: "main.ts".into(),
        relative_lower: "src/main.ts".into(),
    }]));

    finish_search_index_build(&key, &first_state, result.clone());

    let cached =
        wait_for_search_index_build(&first_state).expect("leader should read completed result");
    assert_eq!(cached.entries.len(), 1);

    follower.join().expect("follower should finish");
    assert_eq!(build_count.load(Ordering::SeqCst), 1);

    if let Ok(mut inflight) = file_search_in_flight().lock() {
        inflight.remove(&key);
    }
}

#[test]
fn cached_list_response_shapes_cached_entries_without_cloning_callers() {
    let session_id = "session-1";
    let root_dir = "/tmp/clcomx-cached-list-response";
    let key = cache_key(session_id, root_dir);
    let index = cache_index(vec![CachedFileEntry {
        wsl_path: "/tmp/clcomx-cached-list-response/src/main.ts".into(),
        relative_path: "src/main.ts".into(),
        basename: "main.ts".into(),
        basename_lower: "main.ts".into(),
        relative_lower: "src/main.ts".into(),
    }]);

    if let Ok(mut cache) = file_search_cache().lock() {
        cache.insert(key.clone(), index.clone());
    }

    let response =
        cached_list_response(session_id, root_dir).expect("cached list response should exist");
    assert_eq!(response.root_dir, root_dir);
    assert_eq!(response.last_updated_ms, index.last_updated_ms);
    assert_eq!(response.results.len(), 1);
    assert_eq!(response.results[0].wsl_path, index.entries[0].wsl_path);

    if let Ok(mut cache) = file_search_cache().lock() {
        cache.remove(&key);
    }
}

#[test]
fn upsert_search_cache_path_updates_matching_cached_root() {
    let session_id = "session-1";
    let root_dir = "/tmp/clcomx-upsert-search-cache";
    let key = cache_key(session_id, root_dir);
    let existing = cache_index(vec![CachedFileEntry {
        wsl_path: "/tmp/clcomx-upsert-search-cache/src/main.ts".into(),
        relative_path: "src/main.ts".into(),
        basename: "main.ts".into(),
        basename_lower: "main.ts".into(),
        relative_lower: "src/main.ts".into(),
    }]);

    if let Ok(mut cache) = file_search_cache().lock() {
        cache.insert(key.clone(), existing.clone());
    }

    upsert_search_cache_path(session_id, "/tmp/clcomx-upsert-search-cache/src/new.ts");

    let updated =
        cached_list_response(session_id, root_dir).expect("updated cache response should exist");
    assert_eq!(updated.results.len(), 2);
    assert!(updated
        .results
        .iter()
        .any(|entry| entry.wsl_path == "/tmp/clcomx-upsert-search-cache/src/new.ts"));
    assert!(updated.last_updated_ms >= existing.last_updated_ms);

    if let Ok(mut cache) = file_search_cache().lock() {
        cache.remove(&key);
    }
}

//! Direct Agent Runtime — bounded transcript 캐시 파일 IO(OQ-16).
//! frontend가 scrub·bound한 JSON 문자열을 그대로 저장/로드한다(비밀 비포함, 암호화 불필요).
use base64::Engine;
use std::path::PathBuf;

fn cache_path(session_handle: &str) -> Result<PathBuf, String> {
    let safe = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(session_handle.as_bytes());
    crate::app_env::state_path(&format!("agent-runtime/transcript-{safe}.json"))
}

/// scrub된 transcript 스냅샷 JSON을 저장한다.
pub fn save_transcript_cache(session_handle: &str, json: &str) -> Result<(), String> {
    let path = cache_path(session_handle)?;
    crate::app_env::ensure_parent_dir(&path)?;
    std::fs::write(&path, json).map_err(|e| format!("write transcript cache: {e}"))
}

/// 저장된 스냅샷 JSON을 로드한다. 없음 → None.
pub fn load_transcript_cache(session_handle: &str) -> Result<Option<String>, String> {
    let path = cache_path(session_handle)?;
    match std::fs::read_to_string(&path) {
        Ok(s) => Ok(Some(s)),
        Err(ref e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("read transcript cache: {e}")),
    }
}

/// 캐시 파일을 삭제한다(탭 삭제 GC).
pub fn clear_transcript_cache(session_handle: &str) -> Result<(), String> {
    let path = cache_path(session_handle)?;
    match std::fs::remove_file(&path) {
        Ok(()) => Ok(()),
        Err(ref e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(format!("remove transcript cache: {e}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn save_load_clear_transcript_cache() {
        let _g = crate::app_env::test_support::set_state_dir_env(
            &std::env::temp_dir().join("clcomx-oq16-cache"),
        );
        save_transcript_cache("H", "{\"schemaVersion\":1}").unwrap();
        assert_eq!(
            load_transcript_cache("H").unwrap().as_deref(),
            Some("{\"schemaVersion\":1}")
        );
        clear_transcript_cache("H").unwrap();
        assert_eq!(load_transcript_cache("H").unwrap(), None);
    }
}

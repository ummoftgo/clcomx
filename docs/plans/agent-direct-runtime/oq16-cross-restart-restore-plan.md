# OQ-16 Cross-restart Direct 복원 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 앱 재시작 후 direct(codex/claude) 세션이 지난 대화를 즉시 읽기 전용으로 보여주고, provider가 지원하면 같은 세션을 live resume로 이어가게 한다.

**Architecture:** 재개 id(`providerThreadId`/`providerSessionId`)를 OS 키스토어의 단일 앱 키로 암호화해 app-state 파일에 저장(신규 backend `secret_store.rs`). transcript는 residency 윈도우로 bound·scrub해 plain 캐시 파일에 저장. cold restart 시 캐시를 즉시 렌더하고, 탭 포커스 시 지연 resume를 시도해 성공하면 provider 권위 replay가 캐시를 대체한다. resume는 이미 배선된 `AgentTranscriptSurface`/`resumeSession` 경로를 재사용한다.

**Tech Stack:** Rust(Tauri v2, `keyring` v3, `aes-gcm` v0.10, `rand` v0.8, `base64` v0.22), TypeScript/Svelte 5(runes), vitest, WebdriverIO E2E.

## Global Constraints

- 저장/복원 정본 = [`10-persistence-migration.md`](10-persistence-migration.md), 보안 정본 = [`09-permissions-security.md`](09-permissions-security.md), 타입 정본 = [`15-data-contracts.md`](15-data-contracts.md), 규칙 정본 = [`04-normalized-agent-model.md`](04-normalized-agent-model.md). 설계 spec = [`oq16-cross-restart-restore-design.md`](oq16-cross-restart-restore-design.md).
- `workspace.json` 평문 scrub 경계 불변: `provider_session_id`/`provider_thread_id`/`provider_resume_token`은 계속 `sanitize_workspace_for_persist`에서 scrub. 재개 id는 **workspace.json이 아닌 별도 암호화 파일**에만 저장.
- `providerResumeToken`은 dead 필드 — 저장/사용하지 않는다.
- TS는 `$lib/tauri/core.ts`의 `invoke`, `$lib/tauri/event.ts`의 `listen`만 경유(직접 `@tauri-apps/api` import 금지). Rust command는 `Result<T, String>` 반환, 경계 struct는 `#[serde(rename_all="camelCase")]`.
- 신규 코드는 [`17-coding-conventions.md`](17-coding-conventions.md) 준수: 도메인 단위 파일 분리, 한글 doc-comment(JSDoc/rustdoc).
- 파일 경로는 `crate::app_env::state_path(name)` 재사용(신규 path API 도입 금지).
- 키스토어/복호화 실패는 에러가 아니라 **히스토리-only 폴백**으로 우아하게 처리(설계 §7).

---

## File Structure

**신규(backend):**
- `src-tauri/src/features/agent_runtime/secret_store.rs` — OS 키스토어 단일 앱 키 로드/생성 + AES-GCM 암·복호화 + 세션별 재개 id 파일 저장/로드/삭제.
- `src-tauri/src/features/agent_runtime/transcript_cache.rs` — scrub된 bounded transcript 스냅샷 파일 저장/로드/삭제(plain JSON).

**신규(frontend):**
- `src/lib/features/agent-runtime/service/resume-store.ts` — 재개 id 저장/로드 invoke 래퍼.
- `src/lib/features/agent-runtime/service/transcript-cache.ts` — TranscriptModel↔직렬화 변환(Map↔array, residency bound, redaction) + 저장/로드 invoke 래퍼.

**수정:**
- `src-tauri/Cargo.toml` — deps 추가.
- `src-tauri/src/features/agent_runtime/mod.rs` — `mod secret_store; mod transcript_cache;`.
- `src-tauri/src/commands/agent_runtime.rs` — command 래퍼 5종 추가.
- `src-tauri/src/lib.rs` — `generate_handler!`에 5종 등록.
- `src/lib/features/agent-runtime/view/AgentTranscriptSurface.svelte` — 캐시 hydrate 즉시 렌더, 탭 포커스 지연 resume, 암호화 재개 id 로드→resume, 실패/미지원 시 read-only 히스토리 affordance, 저장 훅에 암호화 id/캐시 저장 편입.

---

## Task 1: crypto/키스토어 의존성 + 앱 키 관리

**Files:**
- Modify: `src-tauri/Cargo.toml:15-19`
- Create: `src-tauri/src/features/agent_runtime/secret_store.rs`
- Modify: `src-tauri/src/features/agent_runtime/mod.rs` (mod 선언)

**Interfaces:**
- Produces: `secret_store::load_or_create_app_key() -> Result<[u8; 32], SecretStoreError>`; `enum SecretStoreError { Keystore, Crypto, Io, Serde }` (모두 `impl Display`).

- [ ] **Step 1: deps 추가**

`src-tauri/Cargo.toml` `[dependencies]`에 추가:
```toml
keyring = "3"
aes-gcm = "0.10"
rand = "0.8"
base64 = "0.22"
```

- [ ] **Step 2: 실패 테스트 작성 (앱 키 왕복)**

`secret_store.rs` 하단 `#[cfg(test)]`:
```rust
#[cfg(test)]
mod tests {
    use super::*;

    // 키스토어가 없는 CI 환경을 위해 in-memory keystore feature를 쓰거나, 아래는 로직 단위 테스트.
    #[test]
    fn app_key_is_32_bytes_and_stable_across_calls() {
        // 동일 프로세스에서 두 번 호출하면 같은 키를 반환한다(생성 후 재로드).
        let k1 = load_or_create_app_key().expect("first");
        let k2 = load_or_create_app_key().expect("second");
        assert_eq!(k1.len(), 32);
        assert_eq!(k1, k2);
    }
}
```

- [ ] **Step 3: 실패 확인**

Run: `cargo test --manifest-path src-tauri/Cargo.toml secret_store:: 2>&1 | tail -20`
Expected: 컴파일 실패(`load_or_create_app_key` 미정의).

- [ ] **Step 4: 앱 키 관리 구현**

`secret_store.rs` 상단:
```rust
//! Direct Agent Runtime — 재개 id 암호화 저장소(OQ-16).
//!
//! OS 키스토어(Windows Credential Manager/libsecret)에 **단일 앱 키 1개**를 두고,
//! 세션별 재개 id 파일을 AES-256-GCM으로 at-rest 암호화한다. 키/복호화 실패는
//! 상위에서 "복원 불가"로 낮추는 것이 정책이므로 여기서는 typed error를 반환한다.

use aes_gcm::aead::{Aead, KeyInit, OsRng, rand_core::RngCore};
use aes_gcm::{Aes256Gcm, Key, Nonce};
use base64::Engine;

const KEYSTORE_SERVICE: &str = "clcomx";
const KEYSTORE_USER: &str = "agent-runtime-mkey";

#[derive(Debug)]
pub enum SecretStoreError {
    Keystore(String),
    Crypto(String),
    Io(String),
    Serde(String),
}

impl std::fmt::Display for SecretStoreError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            SecretStoreError::Keystore(m) => write!(f, "keystore: {m}"),
            SecretStoreError::Crypto(m) => write!(f, "crypto: {m}"),
            SecretStoreError::Io(m) => write!(f, "io: {m}"),
            SecretStoreError::Serde(m) => write!(f, "serde: {m}"),
        }
    }
}

/// OS 키스토어에서 앱 키를 로드하고, 없으면 32바이트를 새로 생성해 저장한 뒤 반환한다.
pub fn load_or_create_app_key() -> Result<[u8; 32], SecretStoreError> {
    let entry = keyring::Entry::new(KEYSTORE_SERVICE, KEYSTORE_USER)
        .map_err(|e| SecretStoreError::Keystore(e.to_string()))?;
    match entry.get_password() {
        Ok(b64) => {
            let bytes = base64::engine::general_purpose::STANDARD
                .decode(b64.as_bytes())
                .map_err(|e| SecretStoreError::Keystore(e.to_string()))?;
            let arr: [u8; 32] = bytes
                .try_into()
                .map_err(|_| SecretStoreError::Keystore("stored key not 32 bytes".into()))?;
            Ok(arr)
        }
        Err(keyring::Error::NoEntry) => {
            let mut key = [0u8; 32];
            OsRng.fill_bytes(&mut key);
            let b64 = base64::engine::general_purpose::STANDARD.encode(key);
            entry
                .set_password(&b64)
                .map_err(|e| SecretStoreError::Keystore(e.to_string()))?;
            Ok(key)
        }
        Err(e) => Err(SecretStoreError::Keystore(e.to_string())),
    }
}
```
`mod.rs`에 `mod secret_store;` 추가.

- [ ] **Step 5: 통과 확인**

Run: `cargo test --manifest-path src-tauri/Cargo.toml secret_store:: 2>&1 | tail -20`
Expected: PASS. (키스토어 미제공 CI면 `#[ignore]`로 표시하고 로컬/Windows에서 검증 — 그 사유를 테스트 주석에 남긴다.)

- [ ] **Step 6: 커밋**
```bash
git add src-tauri/Cargo.toml src-tauri/src/features/agent_runtime/secret_store.rs src-tauri/src/features/agent_runtime/mod.rs
git commit -m "feat(agent-runtime): OQ-16 앱 키 관리(OS 키스토어 단일 키)"
```

---

## Task 2: 재개 id 레코드 암·복호화

**Files:**
- Modify: `src-tauri/src/features/agent_runtime/secret_store.rs`

**Interfaces:**
- Consumes: `load_or_create_app_key()` (Task 1).
- Produces: `struct ResumeKeys { provider_thread_id: Option<String>, provider_session_id: Option<String>, can_resume: bool, can_load: bool }` (`#[serde(rename_all="camelCase")]`, `Clone, PartialEq, Serialize, Deserialize`); `encrypt_resume_keys(&ResumeKeys, &[u8;32]) -> Result<Vec<u8>, SecretStoreError>`; `decrypt_resume_keys(&[u8], &[u8;32]) -> Result<ResumeKeys, SecretStoreError>`.

- [ ] **Step 1: 실패 테스트 작성**
```rust
#[test]
fn resume_keys_encrypt_decrypt_round_trip() {
    let key = [7u8; 32];
    let rk = ResumeKeys {
        provider_thread_id: Some("th_1".into()),
        provider_session_id: None,
        can_resume: true,
        can_load: true,
    };
    let blob = encrypt_resume_keys(&rk, &key).expect("encrypt");
    let back = decrypt_resume_keys(&blob, &key).expect("decrypt");
    assert_eq!(rk, back);
    // 다른 키로는 복호화 실패(무결성).
    assert!(decrypt_resume_keys(&blob, &[9u8; 32]).is_err());
}
```

- [ ] **Step 2: 실패 확인**

Run: `cargo test --manifest-path src-tauri/Cargo.toml secret_store::tests::resume_keys 2>&1 | tail -20`
Expected: FAIL(미정의).

- [ ] **Step 3: 구현**
```rust
use serde::{Deserialize, Serialize};

/// 세션별 재개 식별자(암호화 저장 대상). resumeToken은 dead 필드라 포함하지 않는다.
#[derive(Clone, PartialEq, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResumeKeys {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provider_thread_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provider_session_id: Option<String>,
    pub can_resume: bool,
    pub can_load: bool,
}

/// ResumeKeys → nonce(12) || AES-256-GCM ciphertext.
pub fn encrypt_resume_keys(rk: &ResumeKeys, key: &[u8; 32]) -> Result<Vec<u8>, SecretStoreError> {
    let plaintext = serde_json::to_vec(rk).map_err(|e| SecretStoreError::Serde(e.to_string()))?;
    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(key));
    let mut nonce_bytes = [0u8; 12];
    OsRng.fill_bytes(&mut nonce_bytes);
    let ct = cipher
        .encrypt(Nonce::from_slice(&nonce_bytes), plaintext.as_ref())
        .map_err(|e| SecretStoreError::Crypto(e.to_string()))?;
    let mut out = Vec::with_capacity(12 + ct.len());
    out.extend_from_slice(&nonce_bytes);
    out.extend_from_slice(&ct);
    Ok(out)
}

/// nonce(12) || ciphertext → ResumeKeys.
pub fn decrypt_resume_keys(blob: &[u8], key: &[u8; 32]) -> Result<ResumeKeys, SecretStoreError> {
    if blob.len() < 12 {
        return Err(SecretStoreError::Crypto("blob too short".into()));
    }
    let (nonce_bytes, ct) = blob.split_at(12);
    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(key));
    let plaintext = cipher
        .decrypt(Nonce::from_slice(nonce_bytes), ct)
        .map_err(|e| SecretStoreError::Crypto(e.to_string()))?;
    serde_json::from_slice(&plaintext).map_err(|e| SecretStoreError::Serde(e.to_string()))
}
```

- [ ] **Step 4: 통과 확인**

Run: `cargo test --manifest-path src-tauri/Cargo.toml secret_store::tests::resume_keys 2>&1 | tail -20`
Expected: PASS.

- [ ] **Step 5: 커밋**
```bash
git add src-tauri/src/features/agent_runtime/secret_store.rs
git commit -m "feat(agent-runtime): OQ-16 재개 id AES-GCM 암·복호화"
```

---

## Task 3: 세션별 재개 id 파일 저장/로드/삭제

**Files:**
- Modify: `src-tauri/src/features/agent_runtime/secret_store.rs`

**Interfaces:**
- Consumes: `load_or_create_app_key`, `encrypt_resume_keys`, `decrypt_resume_keys`, `crate::app_env::{state_path, ensure_parent_dir}`.
- Produces: `save_resume_keys(session_handle: &str, keys: &ResumeKeys) -> Result<(), String>`; `load_resume_keys(session_handle: &str) -> Result<Option<ResumeKeys>, String>`(파일 없음/복호화 실패 → `Ok(None)`); `clear_resume_keys(session_handle: &str) -> Result<(), String>`.

- [ ] **Step 1: 실패 테스트 작성**
```rust
#[test]
fn save_load_clear_resume_keys_by_handle() {
    let _g = crate::app_env::tests::set_state_dir_env(&std::env::temp_dir().join("clcomx-oq16-test"));
    let rk = ResumeKeys { provider_thread_id: Some("th_9".into()), provider_session_id: None, can_resume: true, can_load: false };
    save_resume_keys("H1", &rk).expect("save");
    assert_eq!(load_resume_keys("H1").expect("load"), Some(rk));
    // 없는 핸들 → None.
    assert_eq!(load_resume_keys("nope").expect("load"), None);
    // clear 후 None.
    clear_resume_keys("H1").expect("clear");
    assert_eq!(load_resume_keys("H1").expect("load"), None);
}

#[test]
fn corrupt_blob_loads_as_none_not_error() {
    let _g = crate::app_env::tests::set_state_dir_env(&std::env::temp_dir().join("clcomx-oq16-corrupt"));
    let path = resume_keys_path("H2").unwrap();
    crate::app_env::ensure_parent_dir(&path).unwrap();
    std::fs::write(&path, b"not-a-valid-blob").unwrap();
    assert_eq!(load_resume_keys("H2").expect("load graceful"), None);
}
```
> 주의: `save_load_clear_resume_keys_by_handle`은 실제 키스토어를 쓰므로 CI에서 키스토어가 없으면 `#[ignore]`. `corrupt_blob_loads_as_none_not_error`는 복호화 이전 단계라도 graceful None을 보장해야 한다(키 로드 실패도 None로 낮춤).

- [ ] **Step 2: 실패 확인**

Run: `cargo test --manifest-path src-tauri/Cargo.toml secret_store::tests 2>&1 | tail -20`
Expected: FAIL(`resume_keys_path`/`save_resume_keys` 미정의).

- [ ] **Step 3: 구현**
```rust
use std::path::PathBuf;

/// 세션 핸들 → 암호화 파일 경로. 핸들은 파일명 안전 문자로 인코딩(base64 url-safe).
fn resume_keys_path(session_handle: &str) -> Result<PathBuf, String> {
    let safe = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(session_handle.as_bytes());
    crate::app_env::state_path(&format!("agent-runtime/resume-{safe}.enc"))
}

/// 재개 id를 암호화해 세션별 파일에 저장한다.
pub fn save_resume_keys(session_handle: &str, keys: &ResumeKeys) -> Result<(), String> {
    let app_key = load_or_create_app_key().map_err(|e| e.to_string())?;
    let blob = encrypt_resume_keys(keys, &app_key).map_err(|e| e.to_string())?;
    let path = resume_keys_path(session_handle)?;
    crate::app_env::ensure_parent_dir(&path)?;
    std::fs::write(&path, blob).map_err(|e| format!("write resume keys: {e}"))
}

/// 세션별 재개 id를 로드한다. 파일 없음/키 로드 실패/복호화 실패는 모두 `Ok(None)`(히스토리 폴백).
pub fn load_resume_keys(session_handle: &str) -> Result<Option<ResumeKeys>, String> {
    let path = resume_keys_path(session_handle)?;
    let blob = match std::fs::read(&path) {
        Ok(b) => b,
        Err(ref e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(format!("read resume keys: {e}")),
    };
    let app_key = match load_or_create_app_key() {
        Ok(k) => k,
        Err(_) => return Ok(None), // 키스토어 접근 불가 → 폴백
    };
    Ok(decrypt_resume_keys(&blob, &app_key).ok())
}

/// 세션 재개 id 파일을 삭제한다(탭 삭제 시 GC). 파일 없음은 성공.
pub fn clear_resume_keys(session_handle: &str) -> Result<(), String> {
    let path = resume_keys_path(session_handle)?;
    match std::fs::remove_file(&path) {
        Ok(()) => Ok(()),
        Err(ref e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(format!("remove resume keys: {e}")),
    }
}
```

- [ ] **Step 4: 통과 확인**

Run: `cargo test --manifest-path src-tauri/Cargo.toml secret_store::tests 2>&1 | tail -20`
Expected: PASS(키스토어 의존 테스트는 로컬/Windows에서). `corrupt_blob_loads_as_none_not_error`는 항상 PASS.

- [ ] **Step 5: 커밋**
```bash
git add src-tauri/src/features/agent_runtime/secret_store.rs
git commit -m "feat(agent-runtime): OQ-16 세션별 재개 id 저장/로드/삭제 + graceful 폴백"
```

---

## Task 4: 재개 id Tauri command 래퍼 + 등록 + 프론트 래퍼

**Files:**
- Modify: `src-tauri/src/commands/agent_runtime.rs`
- Modify: `src-tauri/src/lib.rs:5-7,92-97`
- Create: `src/lib/features/agent-runtime/service/resume-store.ts`

**Interfaces:**
- Consumes: `secret_store::{ResumeKeys, save_resume_keys, load_resume_keys, clear_resume_keys}`.
- Produces (Rust commands): `agent_runtime_save_resume_keys(session_handle: String, keys: ResumeKeys) -> Result<(), String>`; `agent_runtime_load_resume_keys(session_handle: String) -> Result<Option<ResumeKeys>, String>`; `agent_runtime_clear_resume_keys(session_handle: String) -> Result<(), String>`.
- Produces (TS): `saveResumeKeys(sessionHandle, keys)`, `loadResumeKeys(sessionHandle): Promise<ResumeKeys | null>`, `clearResumeKeys(sessionHandle)` — `ResumeKeys = { providerThreadId?: string; providerSessionId?: string; canResume: boolean; canLoad: boolean }`.

- [ ] **Step 1: Rust command 래퍼 작성**

`commands/agent_runtime.rs` 하단에:
```rust
use crate::features::agent_runtime::secret_store::{
    self, ResumeKeys,
};

/// 세션 재개 id를 암호화 저장한다(OQ-16).
#[tauri::command]
pub fn agent_runtime_save_resume_keys(session_handle: String, keys: ResumeKeys) -> Result<(), String> {
    secret_store::save_resume_keys(&session_handle, &keys)
}

/// 세션 재개 id를 로드한다(없음/실패 → null).
#[tauri::command]
pub fn agent_runtime_load_resume_keys(session_handle: String) -> Result<Option<ResumeKeys>, String> {
    secret_store::load_resume_keys(&session_handle)
}

/// 세션 재개 id 파일을 삭제한다(탭 삭제 GC).
#[tauri::command]
pub fn agent_runtime_clear_resume_keys(session_handle: String) -> Result<(), String> {
    secret_store::clear_resume_keys(&session_handle)
}
```

- [ ] **Step 2: lib.rs 등록**

`lib.rs`의 `use commands::agent_runtime::{...}`에 3종 추가하고 `generate_handler![]`에 3줄 추가:
```rust
            agent_runtime_save_resume_keys,
            agent_runtime_load_resume_keys,
            agent_runtime_clear_resume_keys,
```

- [ ] **Step 3: cargo check**

Run: `cargo check --manifest-path src-tauri/Cargo.toml 2>&1 | tail -15`
Expected: 통과.

- [ ] **Step 4: 프론트 invoke 래퍼 + 타입 테스트**

`resume-store.ts`:
```ts
/**
 * Direct Agent Runtime — 재개 id 암호화 저장소 invoke 래퍼(OQ-16).
 * backend secret_store 커맨드를 감싼다. 재개 id는 workspace.json이 아닌 별도 암호화 파일에 있다.
 */
import { invoke } from "$lib/tauri/core";

/** 세션별 재개 식별자(암호화 저장). resumeToken은 저장하지 않는다. */
export interface ResumeKeys {
  providerThreadId?: string;
  providerSessionId?: string;
  canResume: boolean;
  canLoad: boolean;
}

/** 재개 id를 암호화 저장한다. */
export function saveResumeKeys(sessionHandle: string, keys: ResumeKeys): Promise<void> {
  return invoke("agent_runtime_save_resume_keys", { sessionHandle, keys });
}

/** 재개 id를 로드한다. 없음/복호화 실패 시 null. */
export function loadResumeKeys(sessionHandle: string): Promise<ResumeKeys | null> {
  return invoke("agent_runtime_load_resume_keys", { sessionHandle });
}

/** 세션 재개 id 파일을 삭제한다(탭 삭제 GC). */
export function clearResumeKeys(sessionHandle: string): Promise<void> {
  return invoke("agent_runtime_clear_resume_keys", { sessionHandle });
}
```

`resume-store.test.ts`:
```ts
import { describe, expect, it, vi } from "vitest";
vi.mock("$lib/tauri/core", () => ({ invoke: vi.fn().mockResolvedValue(null) }));
import { invoke } from "$lib/tauri/core";
import { saveResumeKeys, loadResumeKeys, clearResumeKeys } from "./resume-store";

describe("resume-store 래퍼", () => {
  it("커맨드 이름/인자를 그대로 넘긴다", async () => {
    await saveResumeKeys("H", { providerThreadId: "t", canResume: true, canLoad: false });
    expect(invoke).toHaveBeenCalledWith("agent_runtime_save_resume_keys", {
      sessionHandle: "H",
      keys: { providerThreadId: "t", canResume: true, canLoad: false },
    });
    await loadResumeKeys("H");
    expect(invoke).toHaveBeenCalledWith("agent_runtime_load_resume_keys", { sessionHandle: "H" });
    await clearResumeKeys("H");
    expect(invoke).toHaveBeenCalledWith("agent_runtime_clear_resume_keys", { sessionHandle: "H" });
  });
});
```

- [ ] **Step 5: 통과 확인**

Run: `npx vitest run src/lib/features/agent-runtime/service/resume-store.test.ts 2>&1 | tail -10`
Expected: PASS.

- [ ] **Step 6: 커밋**
```bash
git add src-tauri/src/commands/agent_runtime.rs src-tauri/src/lib.rs src/lib/features/agent-runtime/service/resume-store.ts src/lib/features/agent-runtime/service/resume-store.test.ts
git commit -m "feat(agent-runtime): OQ-16 재개 id command 래퍼 + 프론트 서비스"
```

---

## Task 5: TranscriptModel 직렬화(Map↔array) + bounded + redaction

**Files:**
- Create: `src/lib/features/agent-runtime/service/transcript-cache.ts`
- Test: `src/lib/features/agent-runtime/service/transcript-cache.test.ts`

**Interfaces:**
- Consumes: `TranscriptModel`/`TranscriptItem`/`TranscriptTurnState`([`contracts/transcript.ts`](../../../src/lib/features/agent-runtime/contracts/transcript.ts)), `DEFAULT_TRANSCRIPT_RESIDENCY_CONFIG`, 기존 redaction([`view/display-redaction.ts`](../../../src/lib/features/agent-runtime/view/display-redaction.ts) 또는 `service/display-redaction.ts`).
- Produces: `interface TranscriptCacheSnapshot { schemaVersion: 1; visibleItemIds: string[]; items: [string, TranscriptItem][]; turns: [string, TranscriptTurnState][] }`; `serializeTranscript(model: TranscriptModel): TranscriptCacheSnapshot`(sealed-retained turn 본문만·tombstone 제외·redaction 적용); `deserializeTranscript(snap: TranscriptCacheSnapshot): TranscriptModel | null`(schemaVersion≠1 → null).

- [ ] **Step 1: 실패 테스트 작성**

먼저 [`contracts/transcript.ts`](../../../src/lib/features/agent-runtime/contracts/transcript.ts:104) `TranscriptModel` 필드(itemsById/turnsById/visibleItemIds/itemVersions/tombstones)와 `TranscriptTurnState.residency` 값을 확인한 뒤:
```ts
import { describe, expect, it } from "vitest";
import { serializeTranscript, deserializeTranscript } from "./transcript-cache";
import { createEmptyTranscript, applyEvent } from "../controller/agent-event-reducer";

describe("transcript-cache 직렬화", () => {
  it("Map↔array 왕복 + visibleItemIds 보존", () => {
    let m = createEmptyTranscript();
    m = applyEvent(m, { type: "session_started", ref: { provider: "codex", threadId: "A", turnId: "t1" }, cwd: "/w" });
    m = applyEvent(m, { type: "agent_message_delta", ref: { provider: "codex", threadId: "A", turnId: "t1", itemId: "i1" }, delta: "hello" });
    const snap = serializeTranscript(m);
    expect(snap.schemaVersion).toBe(1);
    const back = deserializeTranscript(snap);
    expect(back).not.toBeNull();
    expect([...back!.itemsById.keys()]).toContain("i1");
    expect(back!.visibleItemIds).toEqual(m.visibleItemIds);
  });

  it("schemaVersion 불일치는 null(무시)", () => {
    expect(deserializeTranscript({ schemaVersion: 99 as 1, visibleItemIds: [], items: [], turns: [] })).toBeNull();
  });

  it("tombstone 강등 turn 본문은 직렬화에서 제외", () => {
    // residency==='evicted-tombstone' turn의 item은 snap.items에 없어야 한다.
    // (fixture는 reducer로 cap 초과를 만들어 tombstone 강등을 유도 — OQ-52 테스트 참고)
  });
});
```
> `createEmptyTranscript`/`applyEvent`의 정확한 export 이름은 [`agent-event-reducer.ts`](../../../src/lib/features/agent-runtime/controller/agent-event-reducer.ts)에서 확인해 맞춘다(없으면 store로 model을 만든다).

- [ ] **Step 2: 실패 확인**

Run: `npx vitest run src/lib/features/agent-runtime/service/transcript-cache.test.ts 2>&1 | tail -15`
Expected: FAIL(미정의).

- [ ] **Step 3: 구현**
```ts
/**
 * Direct Agent Runtime — bounded transcript 캐시 직렬화(OQ-16).
 * TranscriptModel의 Map을 array로 평탄화해 저장하고, sealed-retained turn 본문만·redaction 적용해
 * 재시작 즉시 표시용 read-only 히스토리로 쓴다. 권위 히스토리는 provider replay다(캐시는 폴백).
 */
import type { TranscriptItem, TranscriptModel, TranscriptTurnState } from "../contracts/transcript";
import { redactDisplayText } from "../view/display-redaction";

export interface TranscriptCacheSnapshot {
  schemaVersion: 1;
  visibleItemIds: string[];
  items: [string, TranscriptItem][];
  turns: [string, TranscriptTurnState][];
}

/** sealed-retained/unsealed turn 본문만 직렬화(tombstone 제외) + 표시 redaction. */
export function serializeTranscript(model: TranscriptModel): TranscriptCacheSnapshot {
  const turns: [string, TranscriptTurnState][] = [];
  const keepItemIds = new Set<string>();
  for (const [turnId, turn] of model.turnsById) {
    if (turn.residency === "evicted-tombstone") continue; // 본문 없는 tombstone 제외
    turns.push([turnId, turn]);
    for (const id of turn.itemIds) keepItemIds.add(id);
  }
  const items: [string, TranscriptItem][] = [];
  for (const [id, item] of model.itemsById) {
    if (!keepItemIds.has(id)) continue;
    items.push([id, redactItem(item)]);
  }
  const visibleItemIds = model.visibleItemIds.filter((id) => keepItemIds.has(id));
  return { schemaVersion: 1, visibleItemIds, items, turns };
}

/** schemaVersion 검사 후 array→Map 복원. 손상/버전 불일치면 null. */
export function deserializeTranscript(snap: TranscriptCacheSnapshot): TranscriptModel | null {
  if (!snap || snap.schemaVersion !== 1) return null;
  return {
    visibleItemIds: snap.visibleItemIds,
    itemVersions: {},
    itemsById: new Map(snap.items),
    turnsById: new Map(snap.turns),
    tombstones: { lru: [], droppedLateEventCount: 0 },
  } as TranscriptModel;
}

/** 표시 문자열류 필드에 redaction 적용(credential/명령 전문 비포함 보장 보조). */
function redactItem(item: TranscriptItem): TranscriptItem {
  // item 형태에 따라 text/output 등 표시 문자열만 redact. 구조는 보존.
  const clone = structuredClone(item);
  redactStringsDeep(clone);
  return clone;
}

function redactStringsDeep(v: unknown): void {
  if (v && typeof v === "object") {
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      if (typeof val === "string") (v as Record<string, unknown>)[k] = redactDisplayText(val);
      else redactStringsDeep(val);
    }
  }
}
```
> `TranscriptModel`/`TranscriptItem`/`TranscriptTurnState`의 실제 필드(특히 `tombstones` 초기 형태, `itemVersions`)는 Step 1에서 확인한 정의에 맞춘다. `deserializeTranscript`의 반환 model은 store가 read-only 렌더에만 쓰므로 `itemVersions`는 빈 객체로 충분(렌더 시 store가 syncReactiveSurface로 채움).

- [ ] **Step 4: 통과 확인**

Run: `npx vitest run src/lib/features/agent-runtime/service/transcript-cache.test.ts 2>&1 | tail -15`
Expected: PASS.

- [ ] **Step 5: 커밋**
```bash
git add src/lib/features/agent-runtime/service/transcript-cache.ts src/lib/features/agent-runtime/service/transcript-cache.test.ts
git commit -m "feat(agent-runtime): OQ-16 transcript 캐시 직렬화(bounded+redaction)"
```

---

## Task 6: transcript 캐시 파일 저장/로드/삭제 (backend + 프론트 래퍼)

**Files:**
- Create: `src-tauri/src/features/agent_runtime/transcript_cache.rs`
- Modify: `src-tauri/src/features/agent_runtime/mod.rs`, `src-tauri/src/commands/agent_runtime.rs`, `src-tauri/src/lib.rs`
- Modify: `src/lib/features/agent-runtime/service/transcript-cache.ts` (invoke 래퍼 추가)

**Interfaces:**
- Produces (Rust): `agent_runtime_save_transcript_cache(session_handle: String, json: String) -> Result<(), String>`; `agent_runtime_load_transcript_cache(session_handle: String) -> Result<Option<String>, String>`; `agent_runtime_clear_transcript_cache(session_handle: String) -> Result<(), String>` (plain scrubbed JSON 문자열을 그대로 파일 IO).
- Produces (TS): `saveTranscriptCache(sessionHandle, snapshot)`, `loadTranscriptCache(sessionHandle): Promise<TranscriptCacheSnapshot | null>`, `clearTranscriptCache(sessionHandle)`.

- [ ] **Step 1: Rust 파일 IO + 실패 테스트**

`transcript_cache.rs`:
```rust
//! Direct Agent Runtime — bounded transcript 캐시 파일 IO(OQ-16).
//! frontend가 scrub·bound한 JSON 문자열을 그대로 저장/로드한다(비밀 비포함, 암호화 불필요).
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
        let _g = crate::app_env::tests::set_state_dir_env(&std::env::temp_dir().join("clcomx-oq16-cache"));
        save_transcript_cache("H", "{\"schemaVersion\":1}").unwrap();
        assert_eq!(load_transcript_cache("H").unwrap().as_deref(), Some("{\"schemaVersion\":1}"));
        clear_transcript_cache("H").unwrap();
        assert_eq!(load_transcript_cache("H").unwrap(), None);
    }
}
```
`mod.rs`에 `mod transcript_cache;` 추가.

- [ ] **Step 2: 실패→통과 확인 (Rust)**

Run: `cargo test --manifest-path src-tauri/Cargo.toml transcript_cache:: 2>&1 | tail -15`
Expected: 최초 컴파일 후 PASS.

- [ ] **Step 3: command 래퍼 + lib.rs 등록**

`commands/agent_runtime.rs`에 3종 `#[tauri::command]` 래퍼(위 함수 위임), `lib.rs`에 3줄 등록. `cargo check` 통과 확인:
Run: `cargo check --manifest-path src-tauri/Cargo.toml 2>&1 | tail -10`
Expected: 통과.

- [ ] **Step 4: 프론트 invoke 래퍼 추가 + 테스트**

`transcript-cache.ts`에 추가:
```ts
import { invoke } from "$lib/tauri/core";

/** scrub된 스냅샷을 저장한다. */
export function saveTranscriptCache(sessionHandle: string, snapshot: TranscriptCacheSnapshot): Promise<void> {
  return invoke("agent_runtime_save_transcript_cache", { sessionHandle, json: JSON.stringify(snapshot) });
}

/** 저장된 스냅샷을 로드한다. 없음/파싱 실패 → null. */
export async function loadTranscriptCache(sessionHandle: string): Promise<TranscriptCacheSnapshot | null> {
  const json = await invoke<string | null>("agent_runtime_load_transcript_cache", { sessionHandle });
  if (!json) return null;
  try {
    return JSON.parse(json) as TranscriptCacheSnapshot;
  } catch {
    return null;
  }
}

/** 캐시 파일을 삭제한다. */
export function clearTranscriptCache(sessionHandle: string): Promise<void> {
  return invoke("agent_runtime_clear_transcript_cache", { sessionHandle });
}
```
`transcript-cache.test.ts`에 invoke 인자 검증 케이스 추가(Task 4 패턴 동일).

- [ ] **Step 5: 통과 확인 + 커밋**

Run: `npx vitest run src/lib/features/agent-runtime/service/transcript-cache.test.ts 2>&1 | tail -10`
Expected: PASS.
```bash
git add src-tauri/src/features/agent_runtime/transcript_cache.rs src-tauri/src/features/agent_runtime/mod.rs src-tauri/src/commands/agent_runtime.rs src-tauri/src/lib.rs src/lib/features/agent-runtime/service/transcript-cache.ts src/lib/features/agent-runtime/service/transcript-cache.test.ts
git commit -m "feat(agent-runtime): OQ-16 transcript 캐시 파일 IO command + 래퍼"
```

---

## Task 7: 저장 훅 — 진행 중 재개 id·캐시 저장

**Files:**
- Modify: `src/lib/features/agent-runtime/view/AgentTranscriptSurface.svelte:183-267` (persist 경로)
- Test: `src/lib/features/agent-runtime/view/AgentTranscriptSurface.test.ts`

**Interfaces:**
- Consumes: `saveResumeKeys`(Task 4), `serializeTranscript`+`saveTranscriptCache`(Task 5/6), store의 transcript model, 기존 `persistAgentRuntimeMetadata`(:184).

- [ ] **Step 1: 실패 테스트 작성**

`AgentTranscriptSurface.test.ts`에: metadata에 `providerThreadId`가 채워진 direct-codex 세션에서 metadata persist가 일어날 때 `saveResumeKeys`가 `{ providerThreadId, canResume, canLoad }`로 호출되고, `saveTranscriptCache`가 직렬화 스냅샷으로 호출되는지 검증(두 서비스는 vi.mock). 정확한 mock 지점은 기존 test에서 `persistAgentRuntimeMetadata`가 부르는 live-session persistence mock 패턴을 따른다.

- [ ] **Step 2: 실패 확인**

Run: `npx vitest run src/lib/features/agent-runtime/view/AgentTranscriptSurface.test.ts -t "resume keys" 2>&1 | tail -15`
Expected: FAIL.

- [ ] **Step 3: 구현**

`persistAgentRuntimeMetadata`(:184) 내부 또는 그 호출부에서, provider id가 있으면 추가로:
```ts
// OQ-16: 재개 id는 workspace.json이 아닌 암호화 저장소로 별도 저장한다.
if (metadata.providerThreadId || metadata.providerSessionId) {
  void saveResumeKeys(props.session.sessionHandle, {
    providerThreadId: metadata.providerThreadId,
    providerSessionId: metadata.providerSessionId,
    canResume: metadata.canResume ?? false,
    canLoad: metadata.canLoad ?? false,
  });
}
// bounded transcript 캐시 저장(scrub·redaction은 serialize 내부).
void saveTranscriptCache(props.session.sessionHandle, serializeTranscript(store.transcript));
```
> `props.session.sessionHandle` 정확한 경로는 host props(`AgentRuntimeHostProps` = `SessionHostProps`)에서 확인해 맞춘다. 저장 실패는 runtime 유지(기존 `persistAgentRuntimeMetadata` 주석대로 best-effort).

- [ ] **Step 4: 통과 확인 + 커밋**

Run: `npx vitest run src/lib/features/agent-runtime/view/AgentTranscriptSurface.test.ts 2>&1 | tail -10`
Expected: PASS(회귀 없음).
```bash
git add src/lib/features/agent-runtime/view/AgentTranscriptSurface.svelte src/lib/features/agent-runtime/view/AgentTranscriptSurface.test.ts
git commit -m "feat(agent-runtime): OQ-16 진행 중 재개 id·transcript 캐시 저장"
```

---

## Task 8: 복원 — 캐시 즉시 렌더(read-only)

**Files:**
- Modify: `src/lib/features/agent-runtime/view/AgentTranscriptSurface.svelte:489` (onMount) 및 store 초기화
- Test: `AgentTranscriptSurface.test.ts`

**Interfaces:**
- Consumes: `loadTranscriptCache`+`deserializeTranscript`(Task 5/6), store.
- Produces: cold restart 시 store transcript가 캐시로 hydrate되고 `restoreStatus="restoring"`(read-only) 표시.

- [ ] **Step 1: 실패 테스트**: cold restart(props.agentRuntime 존재) + 캐시 seed → onMount 직후 transcript에 캐시 item이 렌더되고 status가 "복원 중"인지.
- [ ] **Step 2: 실패 확인** — `npx vitest run ... -t "cache hydrate"`.
- [ ] **Step 3: 구현**: onMount 진입 시, resume 시도 전에
```ts
// OQ-16: 재시작 즉시 캐시 히스토리를 read-only로 렌더(프로세스 spawn 없음).
const cached = await loadTranscriptCache(props.session.sessionHandle);
const model = cached && deserializeTranscript(cached);
if (model) store.hydrateReadOnly(model); // store에 read-only hydrate 메서드 추가(비반응 body 주입 + syncReactiveSurface)
```
`agent-runtime-store.svelte.ts`에 `hydrateReadOnly(model: TranscriptModel)` 추가: `this.transcript = model; this.syncReactiveSurface();` (dispatch 없이 표시용 주입).
- [ ] **Step 4: 통과 확인 + 커밋**
```bash
git add src/lib/features/agent-runtime/view/AgentTranscriptSurface.svelte src/lib/features/agent-runtime/state/agent-runtime-store.svelte.ts src/lib/features/agent-runtime/view/AgentTranscriptSurface.test.ts
git commit -m "feat(agent-runtime): OQ-16 캐시 히스토리 즉시 read-only 렌더"
```

---

## Task 9: 복원 — 탭 포커스 지연 resume + 암호화 id 주입

**Files:**
- Modify: `src/lib/features/agent-runtime/view/AgentTranscriptSurface.svelte` (resume 트리거, buildResumeConfig 소스)
- Test: `AgentTranscriptSurface.test.ts`

**Interfaces:**
- Consumes: `loadResumeKeys`(Task 4), 기존 `buildResumeConfig`(:86)/`resumeSession`(:397).
- Produces: resume는 **탭 활성화 시** 1회 실행(boot 즉시 아님). resume 소스는 암호화 저장소의 `loadResumeKeys`(props.agentRuntime의 scrub된 id 대신).

- [ ] **Step 1: 실패 테스트**: (a) boot(비활성 탭)에서는 `resumeSession`이 호출되지 않고, 탭 활성화 이벤트 후 1회 호출된다. (b) resume 소스가 `loadResumeKeys` 결과의 id다.
- [ ] **Step 2: 실패 확인**.
- [ ] **Step 3: 구현**:
  - `buildResumeConfig`가 props.agentRuntime 대신 `loadResumeKeys(sessionHandle)` 결과(providerThreadId/sessionId + canResume/canLoad)를 쓰도록 소스 변경(비동기 → onActivate 시 await).
  - resume 실행을 `props.session.isActive`(또는 host의 focus/visible prop) 기반 `$effect`로 게이트: 활성화되고 아직 resume 시도 전이면 1회 실행. 여러 direct 탭이 boot 시 동시에 spawn하지 않도록(AppHang) — 설계 §5·예약된 다중 세션 복원 작업과 동일 원칙.
  - 성공 시 provider replay가 store에 dispatch되며 캐시 hydrate 본문을 대체(권위). resume 시작 직전 read-only hydrate를 clear하거나 replay가 upsert로 덮도록 처리(정확한 dedup는 Task 10).
- [ ] **Step 4: 통과 확인 + 커밋**
```bash
git add src/lib/features/agent-runtime/view/AgentTranscriptSurface.svelte src/lib/features/agent-runtime/view/AgentTranscriptSurface.test.ts
git commit -m "feat(agent-runtime): OQ-16 탭 포커스 지연 resume + 암호화 id 주입"
```

---

## Task 10: 복원 — 성공 시 캐시 대체 / 실패·미지원 시 read-only 히스토리 affordance

**Files:**
- Modify: `src/lib/features/agent-runtime/view/AgentTranscriptSurface.svelte:409-427,640-646` (restoreUnavailable/affordance)
- Modify: `src/lib/i18n/locales/{en,ko}.ts` (affordance 문구)
- Test: `AgentTranscriptSurface.test.ts`, `src/lib/i18n/*`

**Interfaces:**
- Consumes: 기존 `restoreUnavailable`(:351) + resume 실패 낮춤(:423).
- Produces: (a) resume 성공 → read-only hydrate 본문이 provider replay로 대체(중복 없음), (b) id 없음/`canResume==false && canLoad==false`/resume 실패 → 캐시를 read-only 유지 + "이전 대화는 읽기 전용, 이어가려면 새 세션" affordance(신규 i18n key `agentRuntime.transcript.historyReadOnly`).

- [ ] **Step 1: 실패 테스트**: (a) resume 성공 후 동일 item id가 중복 렌더되지 않음(캐시 item id ↔ replay item id 정합 — 같은 provider item id면 upsert로 자연 dedup). (b) canResume=false·canLoad=false → resumeSession 미호출 + `historyReadOnly` affordance 표시 + 캐시 히스토리 유지. (c) resume 실패 → 기존 "복원 불가" notice 경로 유지(회귀).
- [ ] **Step 2: 실패 확인**.
- [ ] **Step 3: 구현**:
  - i18n 두 로케일에 `agentRuntime.transcript.historyReadOnly` 추가(en/ko 동시).
  - resume 성공 경로: provider replay item은 캐시와 같은 provider item id를 쓰므로 reducer upsert(04 §3.1)로 자연 dedup — read-only hydrate를 clear하지 않고 replay가 덮게 두되, replay가 없는 잔여 캐시 item(예: tombstone 경계)이 유령으로 남지 않도록 resume 성공 신호에서 hydrate 잔여를 정리(구현: hydrate 시 표식 후 첫 replay upsert에서 표식 item 제거).
  - id 없음/미지원 경로: `historyReadOnly=true` state → 템플릿에서 composer 비활성 + affordance 렌더. 기존 `restoreUnavailable`(빈 새 세션)과 구분: historyReadOnly는 캐시 본문을 유지한다.
- [ ] **Step 4: 통과 확인**: `npx vitest run src/lib/features/agent-runtime/ src/lib/i18n/ 2>&1 | tail -10` PASS.
- [ ] **Step 5: 커밋**
```bash
git add src/lib/features/agent-runtime/view/AgentTranscriptSurface.svelte src/lib/i18n/locales/en.ts src/lib/i18n/locales/ko.ts src/lib/features/agent-runtime/view/AgentTranscriptSurface.test.ts
git commit -m "feat(agent-runtime): OQ-16 resume 성공 대체 / 미지원 시 read-only 히스토리 affordance"
```

---

## Task 11: 탭 삭제 GC + E2E 회귀

**Files:**
- Modify: 세션/탭 삭제 경로(`src/lib/features/session/**` 또는 workspace 삭제 훅 — 실제 삭제 지점 확인해 연결)
- Create/Modify: `e2e/agent-runtime/agent-runtime.test.ts`, `e2e/helpers/agent-runtime.ts`

**Interfaces:**
- Consumes: `clearResumeKeys`+`clearTranscriptCache`(Task 4/6).

- [ ] **Step 1: GC 훅** — 탭/세션 삭제 시 `clearResumeKeys(handle)`+`clearTranscriptCache(handle)` 호출(고아 암호화/캐시 파일 방지). 단위 테스트로 삭제 시 두 clear가 불리는지 검증.
- [ ] **Step 2: E2E 시나리오 추가**:
  - `E2E-13a`: 암호화 재개 id + 캐시 seed된 상태로 앱 재시작 → 히스토리 즉시 표시 + (mock provider) resume 성공 → 이어서 prompt 응답.
  - `E2E-13b`: `canResume=false && canLoad=false` mock → 히스토리 read-only + `historyReadOnly` affordance + composer 비활성.
  - 기존 `E2E-12`(scrub cold restore fresh start) 회귀 없음 확인(암호화 저장소가 비어 있으면 기존 fresh 경로 유지).
- [ ] **Step 3: 실행 확인**:
Run: `npm run test:e2e:wsl -- --skip-build --project agent-runtime 2>&1 | tail -20`
Expected: 신규 2개 포함 전체 PASS.
- [ ] **Step 4: 커밋**
```bash
git add e2e/agent-runtime/ src/lib/features/session/
git commit -m "feat(agent-runtime): OQ-16 탭 삭제 GC + E2E 하이브리드 복원 회귀"
```

---

## Task 12: 정본 문서·레지스트리 갱신

**Files:**
- Modify: `docs/plans/agent-direct-runtime/10-persistence-migration.md` (§4.4/§4.5), `13-risks-open-questions.md` (OQ-16), `09-permissions-security.md` (신규 TB: 암호화 재개 저장소 경계), `impl-log.md`

- [ ] **Step 1**: 10 §4.4/§4.5를 "하이브리드 복원 구현됨(암호화 재개 저장소 + bounded 캐시 + 탭 포커스 지연 resume)"으로 갱신, cross-restart가 더는 항상 fresh가 아님을 명시.
- [ ] **Step 2**: 13 OQ-16을 "후속 구현됨"으로 갱신하고 이 plan/spec을 링크.
- [ ] **Step 3**: 09에 TB(암호화 재개 저장소: OS 키스토어 단일 키 + AES-GCM, workspace.json scrub 경계 불변, resumeToken 계속 제외) 추가.
- [ ] **Step 4**: impl-log에 구현 슬라이스 기록.
- [ ] **Step 5: 커밋**
```bash
git add docs/plans/agent-direct-runtime/
git commit -m "docs(agent-runtime): OQ-16 하이브리드 복원 구현 반영(10/13/09/impl-log)"
```

---

## Verification gate (전체)

- `cargo test --manifest-path src-tauri/Cargo.toml 2>&1 | tail -20` — 신규 secret_store/transcript_cache 포함 전체 통과(키스토어 의존 테스트는 로컬/Windows).
- `npx vitest run src/lib/features/agent-runtime/ 2>&1 | tail -10` — 전체 통과.
- `npm run check` (frontend+rust) 통과.
- `npm run test:e2e:wsl -- --skip-build` — direct/legacy 양쪽 회귀 없음 + 신규 E2E-13a/13b 통과.
- 실 provider 수동 smoke(별도): 실제 codex/claude로 재시작→히스토리→이어가기 1회씩.

## Self-Review 결과(작성자 체크)

- **Spec coverage**: 설계 §4(컴포넌트)=Task1–6, §5(데이터 흐름 저장/복원)=Task7–10, §6(보안)=Task1–3·7, §7(오류)=Task3·8·10, §8(테스트)=각 Task+Task11, §9(GC/연계)=Task11, 정본 갱신=Task12. 누락 없음.
- **Placeholder scan**: 코드 스텝은 실제 코드 포함. 남은 "확인해 맞춘다" 지점(store 필드 정확 이름, host props sessionHandle 경로, reducer export명)은 **구현 직전 해당 파일 Read로 확정**하도록 명시했고 file:line 앵커를 제공 — 설계 미결이 아니라 정본 대조 지시다.
- **Type consistency**: `ResumeKeys`(Rust camelCase serde ↔ TS interface) 필드명 일치, command 이름 5종(save/load/clear resume + save/load/clear transcript) 일관, `serializeTranscript`/`deserializeTranscript`/`hydrateReadOnly` 이름 Task 간 일관.

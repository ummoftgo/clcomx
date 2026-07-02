//! Direct Agent Runtime — 재개 id 암호화 저장소(OQ-16).
//!
//! OS 키스토어(Windows Credential Manager/libsecret)에 **단일 앱 키 1개**를 두고,
//! 세션별 재개 id 파일을 AES-256-GCM으로 at-rest 암호화한다. 키/복호화 실패는
//! 상위에서 "복원 불가"로 낮추는 것이 정책이므로 여기서는 typed error를 반환한다.
//!
//! 앱 키의 난수는 `aes-gcm`이 아니라 [`rand::rngs::OsRng`]에서 얻는다.

use aes_gcm::aead::{Aead, KeyInit};
use aes_gcm::{Aes256Gcm, Key, Nonce};
use base64::Engine;
use rand::RngCore;
use serde::{Deserialize, Serialize};

const KEYSTORE_SERVICE: &str = "clcomx";
const KEYSTORE_USER: &str = "agent-runtime-mkey";

/// 앱 키 저장소 동작 중 발생 가능한 오류 분류.
#[derive(Debug)]
pub enum SecretStoreError {
    /// OS 키스토어(Credential Manager/libsecret) 접근 실패.
    Keystore(String),
    /// 암·복호화 관련 실패(Task 2~3에서 확장 사용).
    Crypto(String),
    /// 파일 입출력 실패(Task 2~3에서 확장 사용).
    Io(String),
    /// 직렬화/역직렬화 실패(Task 2~3에서 확장 사용).
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

/// 키스토어에 저장된 base64 문자열을 32바이트 앱 키로 디코드·검증한다(키스토어 비의존 순수 로직).
///
/// # 오류
/// - base64 STANDARD 디코드 실패 → `SecretStoreError::Keystore(...)`
/// - 디코드된 길이가 32가 아님 → `SecretStoreError::Keystore("stored key not 32 bytes")`
fn decode_app_key(b64: &str) -> Result<[u8; 32], SecretStoreError> {
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(b64.as_bytes())
        .map_err(|e| SecretStoreError::Keystore(e.to_string()))?;
    let arr: [u8; 32] = bytes
        .try_into()
        .map_err(|_| SecretStoreError::Keystore("stored key not 32 bytes".into()))?;
    Ok(arr)
}

/// OS 키스토어에서 앱 키를 로드하고, 없으면 32바이트를 새로 생성해 저장한 뒤 반환한다.
pub fn load_or_create_app_key() -> Result<[u8; 32], SecretStoreError> {
    let entry = keyring::Entry::new(KEYSTORE_SERVICE, KEYSTORE_USER)
        .map_err(|e| SecretStoreError::Keystore(e.to_string()))?;
    match entry.get_password() {
        Ok(b64) => decode_app_key(&b64),
        Err(keyring::Error::NoEntry) => {
            // 최초 실행: 새 32바이트 키를 생성해 키스토어에 저장한다.
            let mut key = [0u8; 32];
            rand::rngs::OsRng.fill_bytes(&mut key);
            let b64 = base64::engine::general_purpose::STANDARD.encode(key);
            entry
                .set_password(&b64)
                .map_err(|e| SecretStoreError::Keystore(e.to_string()))?;
            Ok(key)
        }
        Err(e) => Err(SecretStoreError::Keystore(e.to_string())),
    }
}

/// 세션별 재개 식별자(암호화 저장 대상).
///
/// `providerResumeToken`은 상위 설계에서 dead 필드로 확인되어 포함하지 않는다.
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

/// `ResumeKeys`를 JSON 직렬화 후 AES-256-GCM으로 암호화한다.
///
/// 출력 형식은 `nonce(12바이트) || ciphertext`이다. nonce는 매 호출마다
/// `rand::rngs::OsRng`로 새로 생성한다(앱 키 생성과 동일한 난수원 사용, Task 1과 일관).
///
/// # 오류
/// - JSON 직렬화 실패 → `SecretStoreError::Serde(...)`
/// - AES-GCM 암호화 실패 → `SecretStoreError::Crypto(...)`
pub fn encrypt_resume_keys(rk: &ResumeKeys, key: &[u8; 32]) -> Result<Vec<u8>, SecretStoreError> {
    let plaintext = serde_json::to_vec(rk).map_err(|e| SecretStoreError::Serde(e.to_string()))?;
    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(key));
    let mut nonce_bytes = [0u8; 12];
    rand::rngs::OsRng.fill_bytes(&mut nonce_bytes);
    let ct = cipher
        .encrypt(Nonce::from_slice(&nonce_bytes), plaintext.as_ref())
        .map_err(|e| SecretStoreError::Crypto(e.to_string()))?;
    let mut out = Vec::with_capacity(12 + ct.len());
    out.extend_from_slice(&nonce_bytes);
    out.extend_from_slice(&ct);
    Ok(out)
}

/// `nonce(12바이트) || ciphertext` 형식의 블롭을 복호화해 `ResumeKeys`로 역직렬화한다.
///
/// # 오류
/// - 블롭 길이가 12바이트 미만(nonce를 담을 수 없음) → `SecretStoreError::Crypto(...)`
/// - AES-GCM 복호화 실패(키 불일치·변조 등 무결성 위반) → `SecretStoreError::Crypto(...)`
/// - JSON 역직렬화 실패 → `SecretStoreError::Serde(...)`
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

#[cfg(test)]
mod tests {
    use super::*;

    // ===== 순수 decode_app_key 테스트 (키스토어 비의존) =====

    #[test]
    fn decode_valid_32byte_key() {
        // 유효한 32바이트 키의 base64 인코딩을 다시 디코드하면 원본과 일치한다.
        let mut original_key = [0u8; 32];
        rand::rngs::OsRng.fill_bytes(&mut original_key);
        let b64 = base64::engine::general_purpose::STANDARD.encode(original_key);

        let decoded = decode_app_key(&b64).expect("decode should succeed");
        assert_eq!(decoded, original_key);
    }

    #[test]
    fn decode_invalid_base64_fails() {
        // 유효하지 않은 base64 문자열은 Err을 반환한다.
        let invalid_b64 = "!!!invalid base64!!!";
        let result = decode_app_key(invalid_b64);
        assert!(result.is_err());
        match result {
            Err(SecretStoreError::Keystore(_)) => {} // 예상된 에러
            _ => panic!("Expected Keystore error"),
        }
    }

    #[test]
    fn decode_wrong_length_key_fails() {
        // 32바이트가 아닌 키(예: 16바이트)는 Err을 반환한다.
        let mut short_key = [0u8; 16];
        rand::rngs::OsRng.fill_bytes(&mut short_key);
        let b64 = base64::engine::general_purpose::STANDARD.encode(short_key);

        let result = decode_app_key(&b64);
        assert!(result.is_err());
        match result {
            Err(SecretStoreError::Keystore(msg)) if msg.contains("not 32 bytes") => {}
            _ => panic!("Expected 'not 32 bytes' error, got {:?}", result),
        }
    }

    // ===== OS 키스토어 테스트 (#[ignore]로 로컬에서만 실행) =====

    // 이 빌드 환경(Linux/WSL)에는 OS 키스토어 데몬(libsecret/Secret Service)이 없어
    // 실제 키스토어를 호출하는 아래 테스트는 여기서 통과할 수 없다.
    // 실제 OS 키스토어(Windows Credential Manager/libsecret)가 필요 — 로컬/Windows에서 검증.
    #[test]
    #[ignore]
    fn app_key_is_32_bytes_and_stable_across_calls() {
        // 동일 프로세스에서 두 번 호출하면 같은 키를 반환한다(생성 후 재로드).
        let k1 = load_or_create_app_key().expect("first");
        let k2 = load_or_create_app_key().expect("second");
        assert_eq!(k1.len(), 32);
        assert_eq!(k1, k2);
    }

    // ===== ResumeKeys 암·복호화 테스트 (고정 키, 키스토어 비의존) =====

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
}

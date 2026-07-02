//! Direct Agent Runtime — 재개 id 암호화 저장소(OQ-16).
//!
//! OS 키스토어(Windows Credential Manager/libsecret)에 **단일 앱 키 1개**를 두고,
//! 세션별 재개 id 파일을 AES-256-GCM으로 at-rest 암호화한다. 키/복호화 실패는
//! 상위에서 "복원 불가"로 낮추는 것이 정책이므로 여기서는 typed error를 반환한다.

use base64::Engine;
use rand::RngCore;

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

#[cfg(test)]
mod tests {
    use super::*;

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
}

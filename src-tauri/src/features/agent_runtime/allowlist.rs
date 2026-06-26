//! Direct Agent Runtime — provider별 allowlist 검증(07 §8.1, S1/R4).
//!
//! 정본: `07-tauri-process-runtime.md` §8.1, impl-log OQ-36/OQ-38.
//! renderer/adapter는 executable command를 넘기지 않는다(S1). backend가 provider로 신뢰 절대경로를
//! resolve(`resolver.rs`)한 뒤, args(정확 일치)·env key(allowlist)·shell 메타문자(방어용)를 재검증한다.
//! env 값은 non-secret 전용(C1) — secret은 argv 비경유로만 전달한다.

use super::types::AgentRuntimeStartParams;
use std::collections::HashMap;

/// Codex args 정본(ref-codex §1.1): 정확히 `["app-server", "--stdio"]`.
const CODEX_REQUIRED_ARGS: &[&str] = &["app-server", "--stdio"];

/// 공통 허용 env key(non-secret). OQ-38 확정값.
const COMMON_ALLOWED_ENV_KEYS: &[&str] = &["RUST_LOG", "RUST_BACKTRACE", "NO_COLOR"];
/// Codex 전용 추가 허용 env key.
const CODEX_EXTRA_ENV_KEYS: &[&str] = &["CODEX_DISABLE_UPDATE_CHECK"];
/// Claude 전용 추가 허용 env key.
const CLAUDE_EXTRA_ENV_KEYS: &[&str] =
    &["CLAUDE_CONFIG_DIR", "CLAUDE_CODE_EXECUTABLE", "NODE_OPTIONS"];

/// provider별 허용 env key 집합을 합쳐 돌려준다.
fn allowed_env_keys(provider: &str) -> Option<Vec<&'static str>> {
    let extra = match provider {
        "codex" => CODEX_EXTRA_ENV_KEYS,
        "claude" => CLAUDE_EXTRA_ENV_KEYS,
        _ => return None,
    };
    let mut keys: Vec<&'static str> = COMMON_ALLOWED_ENV_KEYS.to_vec();
    keys.extend_from_slice(extra);
    Some(keys)
}

/// POSIX env 이름 규칙 `^[A-Za-z_][A-Za-z0-9_]*$` 검증.
pub fn is_valid_env_key(key: &str) -> bool {
    let mut chars = key.chars();
    match chars.next() {
        Some(c) if c == '_' || c.is_ascii_alphabetic() => {}
        _ => return false,
    }
    chars.all(|c| c == '_' || c.is_ascii_alphanumeric())
}

/// args/env 값의 shell 메타문자 방어 검사(셸 비경유 직접 실행이지만 잔여 방어).
fn has_shell_metachar(s: &str) -> bool {
    s.chars()
        .any(|c| matches!(c, ';' | '|' | '&' | '`' | '>' | '<' | '\n' | '\r'))
        || s.contains("$(")
}

/// validate_and_extract 산출물. 검증을 모두 통과한 spawn 입력.
#[derive(Debug)]
pub struct ValidatedLaunch {
    pub provider: String,
    pub distro: String,
    pub work_dir: String,
    /// backend가 provider로 resolve한 신뢰 절대경로.
    pub executable: String,
    /// 정확 검증을 통과한 argv.
    pub argv: Vec<String>,
    /// non-secret env(argv `-e env KEY=VAL` 경로).
    pub non_secret_env: HashMap<String, String>,
    /// secret env(`Command::env()`+`WSLENV` 경로). v1 기본 빈 맵.
    pub secret_env: HashMap<String, String>,
}

/// resolve 함수 쌍을 주입받아 start params를 검증·추출한다.
/// `resolve_exe(provider, distro)` = 신뢰 executable 절대경로, `resolve_entry(provider, distro)` =
/// claude adapter entry 절대경로. 테스트는 이 둘을 mock으로 주입해 WSL 호출 없이 검증한다.
///
/// D-WSAUTH: 비-stdio variant(websocket)는 params를 디버그 출력하지 않고 정적 문자열만으로 거부한다.
pub fn validate_and_extract<FExe, FEntry>(
    params: &AgentRuntimeStartParams,
    resolve_exe: FExe,
    resolve_entry: FEntry,
) -> Result<ValidatedLaunch, String>
where
    FExe: Fn(&str, &str) -> Result<String, String>,
    FEntry: Fn(&str, &str) -> Result<String, String>,
{
    // websocket 등 비-stdio는 params(authToken 포함)를 절대 로깅하지 않고 정적 에러로 거부.
    let AgentRuntimeStartParams::JsonrpcStdio {
        provider,
        distro,
        work_dir,
        args,
        env,
    } = params
    else {
        return Err("only jsonrpc-stdio transport is supported in v1".into());
    };

    // 1) provider enum 검증 + 허용 env key 집합 확정.
    let allowed = allowed_env_keys(provider)
        .ok_or_else(|| format!("unknown provider: {provider}"))?;

    if distro.trim().is_empty() {
        return Err("distro is required".into());
    }

    // 2) executable = backend가 provider로 resolve한 신뢰 절대경로(S1, command 비수신).
    let executable = resolve_exe(provider, distro)?;
    if !executable.starts_with('/') {
        return Err(format!("resolved executable is not absolute: {executable}"));
    }

    // 3) args 정확 검증(provider별 exact match).
    match provider.as_str() {
        "codex" => {
            if args.as_slice() != CODEX_REQUIRED_ARGS {
                return Err(format!(
                    "codex args must be exactly {CODEX_REQUIRED_ARGS:?}, got {args:?}"
                ));
            }
        }
        "claude" => {
            // 1차 argv 검증: args.length == 1 && args[0] == 신뢰 adapterEntryPath(절대경로).
            if args.len() != 1 {
                return Err(format!(
                    "claude args must be exactly [adapterEntryPath], got {args:?}"
                ));
            }
            let entry = &args[0];
            let trusted_entry = resolve_entry(provider, distro)?;
            if !entry.starts_with('/') || entry != &trusted_entry {
                return Err(format!("claude adapterEntryPath not trusted: {entry}"));
            }
        }
        _ => unreachable!("provider already validated"),
    }

    // 3b) shell 메타문자 방어(정확 검증 통과 후에도 잔여 방어).
    for a in args {
        if has_shell_metachar(a) {
            return Err(format!("argument contains shell metacharacter: {a}"));
        }
    }

    // 4) work_dir 비어있지 않음(canonicalize는 process.rs에서 수행).
    if work_dir.trim().is_empty() {
        return Err("workDir is required".into());
    }

    // 5) env key allowlist + non-secret 값 검증.
    let env_map = env.clone().unwrap_or_default();
    for (k, v) in &env_map {
        if !is_valid_env_key(k) {
            return Err(format!("env key '{k}' violates ^[A-Za-z_][A-Za-z0-9_]*$"));
        }
        if !allowed.contains(&k.as_str()) {
            return Err(format!("env key '{k}' not allowed for provider '{provider}'"));
        }
        if has_shell_metachar(v) {
            return Err(format!("env value for '{k}' contains shell metacharacter"));
        }
    }

    // C1: env(15 §8.1)는 non-secret 전용 규약 → 전부 non_secret_env. secret_env는 빈 맵(v1 기본).
    Ok(ValidatedLaunch {
        provider: provider.clone(),
        distro: distro.clone(),
        work_dir: work_dir.clone(),
        executable,
        argv: args.clone(),
        non_secret_env: env_map,
        secret_env: HashMap::new(),
    })
}

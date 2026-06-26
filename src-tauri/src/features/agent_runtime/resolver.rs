//! Direct Agent Runtime — 신뢰 절대경로 resolve(OQ-36 owner).
//!
//! 정본: `07-tauri-process-runtime.md` §8.1, impl-log OQ-36.
//! backend가 provider로 신뢰 절대경로를 직접 resolve한다(renderer 비제어, S1). renderer가 동명 바이너리
//! (`/tmp/codex`·`/tmp/node`)를 지정할 경로 자체가 없으므로 우회 불가다.
//!
//! - `resolve_trusted_executable(provider, distro)`: codex→codex app-server 절대경로, claude→node 절대경로.
//! - `resolve_trusted_adapter_entry(provider, distro)`: claude `claude-agent-acp` `dist/index.js` 절대경로.
//! - 탐색: WSL distro 안에서 `command -v codex`/`command -v node`, adapterEntry는 node `require.resolve`.
//! - 캐시: `(provider, distro)` 키 in-memory(프로세스 수명; TTL 없음, miss 시 재resolve).

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

/// resolve 동작을 주입 가능하게 하는 trait. 테스트는 mock 구현으로 실제 WSL 호출 없이 검증한다.
/// 실제 본체는 `WslResolver`이며 `command -v`/`require.resolve`를 WSL distro에서 실행한다.
pub trait TrustedPathResolver: Send + Sync {
    /// provider executable 신뢰 절대경로. codex→codex, claude→node. 실패 시 Err.
    fn resolve_executable(&self, provider: &str, distro: &str) -> Result<String, String>;
    /// claude adapter entry(`dist/index.js`) 신뢰 절대경로. claude 외 provider는 Err.
    fn resolve_adapter_entry(&self, provider: &str, distro: &str) -> Result<String, String>;
}

/// `(provider, distro)` 키 in-memory 캐시. miss 시 inner resolver로 재탐색하고 결과를 캐싱한다.
/// 무효화 트리거는 후속 결정 사항(OQ-36)이라 v1은 `clear()`만 제공한다(테스트의 캐시 무효화 검증용).
pub struct CachingResolver {
    inner: Box<dyn TrustedPathResolver>,
    /// key = "<provider>\u{0}<distro>".
    exe_cache: Mutex<HashMap<String, String>>,
    entry_cache: Mutex<HashMap<String, String>>,
}

impl CachingResolver {
    /// inner resolver를 감싼 캐싱 resolver를 만든다.
    pub fn new(inner: Box<dyn TrustedPathResolver>) -> Self {
        Self {
            inner,
            exe_cache: Mutex::new(HashMap::new()),
            entry_cache: Mutex::new(HashMap::new()),
        }
    }

    fn cache_key(provider: &str, distro: &str) -> String {
        format!("{provider}\u{0}{distro}")
    }

    /// executable 신뢰 절대경로. 캐시 hit 시 즉시 반환, miss 시 inner resolve 후 캐싱.
    pub fn resolve_executable(&self, provider: &str, distro: &str) -> Result<String, String> {
        let key = Self::cache_key(provider, distro);
        if let Some(hit) = self.exe_cache.lock().map_err(|e| e.to_string())?.get(&key) {
            return Ok(hit.clone());
        }
        let resolved = self.inner.resolve_executable(provider, distro)?;
        // 신뢰 출처에서 온 값은 항상 절대경로여야 한다(동명 바이너리 우회 차단의 핵심 불변식).
        if !resolved.starts_with('/') {
            return Err(format!("resolved executable is not absolute: {resolved}"));
        }
        self.exe_cache
            .lock()
            .map_err(|e| e.to_string())?
            .insert(key, resolved.clone());
        Ok(resolved)
    }

    /// claude adapter entry 신뢰 절대경로. 캐시 hit 시 즉시 반환, miss 시 inner resolve 후 캐싱.
    pub fn resolve_adapter_entry(&self, provider: &str, distro: &str) -> Result<String, String> {
        let key = Self::cache_key(provider, distro);
        if let Some(hit) = self
            .entry_cache
            .lock()
            .map_err(|e| e.to_string())?
            .get(&key)
        {
            return Ok(hit.clone());
        }
        let resolved = self.inner.resolve_adapter_entry(provider, distro)?;
        if !resolved.starts_with('/') {
            return Err(format!("resolved adapter entry is not absolute: {resolved}"));
        }
        self.entry_cache
            .lock()
            .map_err(|e| e.to_string())?
            .insert(key, resolved.clone());
        Ok(resolved)
    }

    /// 캐시 전체 무효화. OQ-36의 cache clear 트리거 대용(v1은 명시 호출만).
    #[allow(dead_code)]
    pub fn clear(&self) {
        if let Ok(mut c) = self.exe_cache.lock() {
            c.clear();
        }
        if let Ok(mut c) = self.entry_cache.lock() {
            c.clear();
        }
    }
}

/// WSL distro 안에서 신뢰 절대경로를 탐색하는 실제 resolver 본체.
/// `wsl.exe -d <distro> -e bash --norc --noprofile -lc "<probe>"`로 `command -v`/`require.resolve`를 실행한다.
pub struct WslResolver;

impl WslResolver {
    /// distro 안에서 한 줄 출력 명령을 실행하고 첫 비어있지 않은 라인을 돌려준다.
    fn run_probe(distro: &str, probe: &str) -> Result<String, String> {
        use std::process::{Command, Stdio};
        #[cfg(windows)]
        use std::os::windows::process::CommandExt;

        let mut cmd = Command::new("wsl.exe");
        // 로그인 셸(`-lc`)로 PATH를 갖춘 상태에서 probe 실행. resolve 1회용이므로 셸 사용은 무방하다.
        cmd.args(["-d", distro, "-e", "bash", "--norc", "--noprofile", "-lc", probe])
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        #[cfg(windows)]
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW

        let output = cmd.output().map_err(|e| e.to_string())?;
        let stdout = String::from_utf8_lossy(&output.stdout);
        let line = stdout
            .lines()
            .map(|l| l.trim())
            .find(|l| !l.is_empty())
            .map(|l| l.to_string());
        line.ok_or_else(|| format!("probe produced no output in distro '{distro}': {probe}"))
    }
}

impl TrustedPathResolver for WslResolver {
    fn resolve_executable(&self, provider: &str, distro: &str) -> Result<String, String> {
        let bin = match provider {
            "codex" => "codex",
            "claude" => "node",
            other => return Err(format!("unknown provider: {other}")),
        };
        let path = Self::run_probe(distro, &format!("command -v {bin}"))
            .map_err(|_| format!("{bin} not found in WSL distro '{distro}'"))?;
        if !path.starts_with('/') {
            return Err(format!("{bin} resolved to non-absolute path: {path}"));
        }
        Ok(path)
    }

    fn resolve_adapter_entry(&self, provider: &str, distro: &str) -> Result<String, String> {
        if provider != "claude" {
            return Err(format!(
                "adapter entry resolve is claude-only, got provider '{provider}'"
            ));
        }
        // node로 claude-agent-acp 패키지의 dist/index.js를 require.resolve한다.
        let probe = "node -e \"process.stdout.write(require.resolve('@agentclientprotocol/claude-agent-acp/dist/index.js'))\"";
        let path = Self::run_probe(distro, probe)
            .map_err(|_| format!("claude-agent-acp entry not found in WSL distro '{distro}'"))?;
        if !path.starts_with('/') {
            return Err(format!("adapter entry resolved to non-absolute path: {path}"));
        }
        Ok(path)
    }
}

/// 프로세스 전역 캐싱 resolver. test-mode가 아닐 때 spawn 경로가 사용한다.
fn global_resolver() -> &'static CachingResolver {
    static RESOLVER: OnceLock<CachingResolver> = OnceLock::new();
    RESOLVER.get_or_init(|| CachingResolver::new(Box::new(WslResolver)))
}

/// provider executable 신뢰 절대경로(전역 캐시 경유).
pub fn resolve_trusted_executable(provider: &str, distro: &str) -> Result<String, String> {
    global_resolver().resolve_executable(provider, distro)
}

/// claude adapter entry 신뢰 절대경로(전역 캐시 경유).
pub fn resolve_trusted_adapter_entry(provider: &str, distro: &str) -> Result<String, String> {
    global_resolver().resolve_adapter_entry(provider, distro)
}

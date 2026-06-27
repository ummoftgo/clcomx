//! Direct Agent Runtime — 신뢰 절대경로 resolve(OQ-36 owner).
//!
//! 정본: `07-tauri-process-runtime.md` §8.1, impl-log OQ-36.
//! backend가 provider로 신뢰 절대경로를 직접 resolve한다(renderer 비제어, S1). renderer가 동명 바이너리
//! (`/tmp/codex`·`/tmp/node`)를 지정할 경로 자체가 없으므로 우회 불가다.
//!
//! - `resolve_trusted_executable(provider, distro)`: codex→codex app-server 절대경로, claude→node 절대경로.
//! - `resolve_trusted_adapter_entry(provider, distro)`: claude `claude-agent-acp` `dist/index.js` 절대경로.
//! - 탐색: 로그인 셸(`bash -lc`, 프로파일 로딩 → nvm 등 PATH 확보)에서 `command -v codex`/`command -v node`,
//!   adapterEntry는 `npm root -g` 기준 핀 패키지 정규 경로 + 존재/레이아웃 검증. probe는 센티넬·exit
//!   status·timeout으로 stdout 오염/hang을 방어한다(코덱스 리뷰 ②③).
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
/// probe가 신뢰 값을 표시하는 센티넬. 프로파일 배너/echo 오염과 신뢰 값을 분리한다(코덱스 리뷰 ②).
const PROBE_SENTINEL: &str = "CLCOMXR=";
/// probe 1회 최대 대기. 프로파일 초기화가 멈춰도 resolver 호출이 무기한 막히지 않게 한다.
const PROBE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(20);
/// 핀된 Claude ACP 어댑터 패키지의 전역 node_modules 기준 상대 entry 경로(ref-claude-agent-acp).
const ACP_PACKAGE_ENTRY: &str = "@agentclientprotocol/claude-agent-acp/dist/index.js";
/// resolve된 entry가 가져야 하는 정규 레이아웃 접미사(shim/엉뚱한 파일 캐시 방지).
const ACP_ENTRY_SUFFIX: &str = "node_modules/@agentclientprotocol/claude-agent-acp/dist/index.js";

/// `wsl.exe -d <distro> -e bash -lc "<probe>"`로 신뢰 경로 probe를 실행한다.
pub struct WslResolver;

impl WslResolver {
    /// distro 안에서 probe를 실행하고 `CLCOMXR=` 센티넬 뒤의 값만 신뢰해 돌려준다.
    ///
    /// 방어(코덱스 리뷰 ②): (1) 로그인 셸 `-lc`로 사용자 프로파일을 로딩해 PATH(nvm 등)를 확보하되
    /// `-i`(interactive)는 비-tty 부작용이 커서 쓰지 않는다. (2) exit status를 확인한다. (3) 센티넬
    /// 이후 값만 파싱해 프로파일 stdout 오염이 신뢰 경로로 캐시되지 못하게 한다. (4) bounded timeout으로
    /// 프로파일 hang을 차단한다. (5) 파이프 데드락 방지로 stdout/stderr를 리더 스레드로 비운다.
    fn run_probe(distro: &str, probe: &str) -> Result<String, String> {
        use std::io::Read;
        use std::process::{Command, Stdio};
        use std::thread;
        use std::time::{Duration, Instant};
        #[cfg(windows)]
        use std::os::windows::process::CommandExt;

        let mut cmd = Command::new("wsl.exe");
        cmd.args(["-d", distro, "-e", "bash", "-lc", probe])
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        #[cfg(windows)]
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW

        let mut child = cmd.spawn().map_err(|e| e.to_string())?;
        let mut stdout_pipe = child.stdout.take().ok_or("probe: no stdout pipe")?;
        let mut stderr_pipe = child.stderr.take().ok_or("probe: no stderr pipe")?;
        let out_handle = thread::spawn(move || {
            let mut s = String::new();
            let _ = stdout_pipe.read_to_string(&mut s);
            s
        });
        let err_handle = thread::spawn(move || {
            let mut s = String::new();
            let _ = stderr_pipe.read_to_string(&mut s);
            s
        });

        let start = Instant::now();
        let status = loop {
            match child.try_wait().map_err(|e| e.to_string())? {
                Some(status) => break status,
                None => {
                    if start.elapsed() > PROBE_TIMEOUT {
                        let _ = child.kill();
                        let _ = child.wait();
                        return Err(format!("probe timed out in distro '{distro}'"));
                    }
                    thread::sleep(Duration::from_millis(50));
                }
            }
        };

        let stdout = out_handle.join().unwrap_or_default();
        let stderr = err_handle.join().unwrap_or_default();

        if !status.success() {
            return Err(format!(
                "probe failed in distro '{distro}' (status {:?}): {}",
                status.code(),
                stderr.trim()
            ));
        }
        // 마지막 센티넬 이후 값만 신뢰한다(프로파일이 앞서 출력한 줄은 무시).
        match stdout.rsplit_once(PROBE_SENTINEL) {
            Some((_, value)) => {
                let value = value.trim().to_string();
                if value.is_empty() {
                    Err(format!("probe produced empty value in distro '{distro}'"))
                } else {
                    Ok(value)
                }
            }
            None => Err(format!("probe produced no sentinel output in distro '{distro}'")),
        }
    }
}

impl TrustedPathResolver for WslResolver {
    fn resolve_executable(&self, provider: &str, distro: &str) -> Result<String, String> {
        let bin = match provider {
            "codex" => "codex",
            "claude" => "node",
            other => return Err(format!("unknown provider: {other}")),
        };
        // 따옴표 없는 센티넬 probe(경로에 공백이 없다는 전제). 따옴표가 없어 Rust→wsl.exe 인자 인코딩에서
        // 깨지지 않는다. command -v 실패 시 `&&` 단락 → 센티넬 미출력 + 비정상 exit로 run_probe가 거부한다.
        let probe = format!("B=$(command -v {bin}) && printf {PROBE_SENTINEL}%s $B");
        let path = Self::run_probe(distro, &probe)
            .map_err(|e| format!("{bin} not found in WSL distro '{distro}': {e}"))?;
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
        // 전역 node_modules(`npm root -g`)에서 핀된 패키지의 정규 entry 경로를 직접 구성하고 존재를
        // 검증한다(코덱스 리뷰 ③). PATH의 동명 bin/shim을 readlink로 신뢰하지 않는다 — shim·구버전·
        // PATH 앞 동명 파일이 trusted entry로 캐시되는 것을 막기 위해 정규 경로만 받아들인다.
        // 따옴표 없는 센티넬 probe(경로 무공백 전제) + run_probe의 exit status/센티넬/timeout 방어.
        // 전제: WSL distro에 `@agentclientprotocol/claude-agent-acp`가 전역 설치되어 있어야 한다.
        let probe = format!(
            "R=$(npm root -g) && E=$R/{ACP_PACKAGE_ENTRY} && test -f $E && printf {PROBE_SENTINEL}%s $E"
        );
        let path = Self::run_probe(distro, &probe)
            .map_err(|e| format!("claude-agent-acp entry not found in WSL distro '{distro}': {e}"))?;
        if !path.starts_with('/') {
            return Err(format!("adapter entry resolved to non-absolute path: {path}"));
        }
        // 핀된 패키지 레이아웃 검증: 엉뚱한 파일을 trusted entry로 캐시하지 않는다.
        if !path.ends_with(ACP_ENTRY_SUFFIX) {
            return Err(format!(
                "adapter entry does not match pinned package layout: {path}"
            ));
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

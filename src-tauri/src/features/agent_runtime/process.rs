//! Direct Agent Runtime — WSL subprocess spawn + graceful shutdown(07 §5).
//!
//! 정본: `07-tauri-process-runtime.md` §5.1/§5.2/§5.3, §9.
//! launch 형태: `wsl.exe -d <distro> --cd <wslWorkDir> -e env KEY=VAL <executable> <argv...>`(셸 비경유).
//! secret env는 argv 비경유 — `Command::env()` + `WSLENV` passthrough(C1). v1 기본은 secret env 미전달.

use std::collections::HashMap;
use std::process::{Child, ChildStderr, ChildStdin, ChildStdout, Command, Stdio};
use std::time::{SystemTime, UNIX_EPOCH};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

/// epoch millis. snapshot started_at/exited_at에 쓴다.
pub fn now_millis() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// wait 전용 thread가 소유하는 child 핸들. blocking `wait()` 중 어떤 Mutex도 잡지 않는다(§5.3 정본).
pub struct ChildHandle {
    pub child: Child,
    pub pid: u32,
}

/// spawn된 child의 piped stdio 3종.
pub struct ChildStdio {
    pub stdin: ChildStdin,
    pub stdout: ChildStdout,
    pub stderr: ChildStderr,
}

/// kill 전용 식별자(§5.2). ChildHandle은 wait thread가 소유하므로 상태에는 이 최소 정보만 남긴다.
/// Windows는 강제 종료에 process handle이 필요할 수 있으나 v1은 pid 기반 kill로 충분하다.
#[derive(Clone)]
pub struct KillHandle {
    /// spawn 시 `child.id()`로 얻은 OS pid.
    pub pid: u32,
}

/// 저장된 pid로 OS kill 호출(§5.2 정본 — wait thread의 Child를 다시 잠그지 않는다).
/// Windows는 `taskkill /T /F`로 wsl.exe 트리를, Unix는 `kill -KILL`로 종료한다.
pub fn kill_by_stored_pid(handle: &KillHandle) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let _ = Command::new("taskkill")
            .args(["/PID", &handle.pid.to_string(), "/T", "/F"])
            .creation_flags(0x08000000) // CREATE_NO_WINDOW
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
    #[cfg(not(windows))]
    {
        let _ = Command::new("kill")
            .args(["-KILL", &handle.pid.to_string()])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
}

/// 정본 launch 커맨드 형태(셸 비경유 직접 실행):
///   `wsl.exe -d <distro> --cd <wslWorkDir> -e env KEY1=V1 KEY2=V2 <executable> <argv...>`
///
/// command/args/env는 allowlist(§8)를 통과한 검증된 값만 들어온다.
/// **secret env 금지(C1)**: `non_secret_env`(argv `-e env KEY=VAL`)는 non-secret 전용이다. secret은
/// `Command::env()` + `WSLENV` passthrough로만 전달한다(argv는 OS 관측면에 평문 노출됨).
pub fn spawn_wsl_process(
    distro: &str,
    executable: &str,
    argv: &[String],
    work_dir: &str,
    non_secret_env: &HashMap<String, String>,
    secret_env: &HashMap<String, String>,
) -> Result<(ChildHandle, ChildStdio), String> {
    let mut cmd = build_wsl_command(
        distro,
        executable,
        argv,
        work_dir,
        non_secret_env,
        secret_env,
    );
    cmd.stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    #[cfg(windows)]
    cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW

    let mut child = cmd.spawn().map_err(|e| e.to_string())?;
    let pid = child.id();
    let stdin = child.stdin.take().ok_or("failed to open stdin")?;
    let stdout = child.stdout.take().ok_or("failed to open stdout")?;
    let stderr = child.stderr.take().ok_or("failed to open stderr")?;

    Ok((
        ChildHandle { child, pid },
        ChildStdio {
            stdin,
            stdout,
            stderr,
        },
    ))
}

/// launch `Command`를 조립한다(spawn 분리 — argv 조립을 테스트로 검증하기 위함, AC-10b).
/// secret env는 argv에 들어가지 않고 `Command::env()` + `WSLENV`로만 전달됨을 단위 테스트로 잠근다.
pub fn build_wsl_command(
    distro: &str,
    executable: &str,
    argv: &[String],
    work_dir: &str,
    non_secret_env: &HashMap<String, String>,
    secret_env: &HashMap<String, String>,
) -> Command {
    let mut cmd = Command::new("wsl.exe");
    // -d <distro> --cd <wslWorkDir>: cwd를 WSL 내부 경로로 직접 설정.
    cmd.arg("-d").arg(distro).arg("--cd").arg(work_dir);
    // -e env KEY=VAL ... <executable> <argv...>: 셸 비경유로 env 바이너리에 직접 주입(rc stdout 오염 없음).
    cmd.arg("-e").arg("env");
    // 결정론적 argv 순서를 위해 key 정렬(테스트 안정성).
    let mut sorted: Vec<(&String, &String)> = non_secret_env.iter().collect();
    sorted.sort_by(|a, b| a.0.cmp(b.0));
    for (k, v) in sorted {
        // non-secret만 — secret은 아래 Command::env()+WSLENV 경로로만 전달한다.
        cmd.arg(format!("{k}={v}"));
    }
    cmd.arg(executable);
    for a in argv {
        cmd.arg(a);
    }
    // C1 secret env 정본: argv 비경유. wsl.exe 프로세스 환경에 설정 + WSLENV passthrough.
    if !secret_env.is_empty() {
        for (k, v) in secret_env {
            cmd.env(k, v);
        }
        let mut keys: Vec<&String> = secret_env.keys().collect();
        keys.sort();
        let passthrough = keys
            .iter()
            .map(|k| format!("{k}/u"))
            .collect::<Vec<_>>()
            .join(":");
        cmd.env("WSLENV", passthrough);
    }
    cmd
}

/// WSL absolute POSIX path 검증·정규화(§9). Windows path·relative·`~` 거부.
pub fn canonicalize_wsl_path(work_dir: &str) -> Result<String, String> {
    let p = work_dir.trim();
    if p.is_empty() {
        return Err("workDir is required".into());
    }
    // Windows drive path 차단(C:\ 등).
    if p.len() >= 2 && p.as_bytes()[1] == b':' {
        return Err(format!("expected WSL path, got Windows path: {p}"));
    }
    if !p.starts_with('/') {
        return Err(format!("workDir must be a WSL absolute path: {p}"));
    }
    Ok(normalize_posix(p))
}

/// 문자열 레벨 POSIX 정규화: `//`→`/`, `.`/`..` 해소, trailing `/` 제거(루트 제외).
/// Windows에서 WSL fs를 직접 stat할 수 없으므로 symlink resolve 같은 진짜 canonicalize는 하지 않는다.
fn normalize_posix(p: &str) -> String {
    let mut stack: Vec<&str> = Vec::new();
    for seg in p.split('/') {
        match seg {
            "" | "." => continue,
            ".." => {
                stack.pop();
            }
            other => stack.push(other),
        }
    }
    let mut out = String::from("/");
    out.push_str(&stack.join("/"));
    out
}

#[cfg(test)]
mod path_tests {
    use super::*;

    #[test]
    fn normalizes_redundant_slashes_and_dots() {
        assert_eq!(normalize_posix("/a//b/./c/"), "/a/b/c");
        assert_eq!(normalize_posix("/a/b/../c"), "/a/c");
        assert_eq!(normalize_posix("/"), "/");
    }

    #[test]
    fn rejects_windows_and_relative_paths() {
        assert!(canonicalize_wsl_path("C:\\Users").is_err());
        assert!(canonicalize_wsl_path("relative/path").is_err());
        assert!(canonicalize_wsl_path("~/home").is_err());
        assert!(canonicalize_wsl_path("").is_err());
        assert_eq!(
            canonicalize_wsl_path("/home/tester//work/").unwrap(),
            "/home/tester/work"
        );
    }
}

# Tauri Process Runtime

> 이 문서는 CLCOMX "Direct Agent Runtime"의 **Rust/Tauri backend process·transport 레이어** 설계 정본이다. 다운스트림 Rust 구현 에이전트가 이 문서만 읽고 `features/agent_runtime/` 모듈과 `commands/agent_runtime.rs`를 작성할 수 있도록, 파일 경로·구조체·함수 시그니처·의사코드·체크리스트·수용 기준을 담는다.
>
> **역할·권위 분리 (엄수)**:
> - **타입 정본은 [`15-data-contracts.md`](15-data-contracts.md) §8**이다. `RuntimeId`/`JsonRpcMessage`/`JsonRpcError`/`AgentRuntimeStartParams`/`AgentRuntimeCancelTarget`/`AgentRuntimeSnapshot`/`AgentRuntimeEvent`의 TS·Rust 정의는 거기 있고, 이 문서는 **재정의하지 않고 인용**한다. 이 문서에 나오는 Rust struct/enum은 15 §8.2/§8.3을 **미러**하는 참조이며, 충돌하면 15가 권위다.
> - **normalized model 규칙(상태 전이·approval cleanup·pending request 정리)은 [`04-normalized-agent-model.md`](04-normalized-agent-model.md)**가 권위다. backend는 protocol 의미를 해석하지 않지만(framing only), process exit·cancel 시 pending 정리의 *불변식*은 04 §4.2/§5를 따른다.
> - **wire 사실**은 protocol ref가 권위다: Codex는 [`ref-codex-app-server-protocol.md`](ref-codex-app-server-protocol.md), ACP는 [`ref-acp-protocol.md`](ref-acp-protocol.md), Claude 구현체는 [`ref-claude-agent-acp.md`](ref-claude-agent-acp.md).
> - **코드 현실**은 [`research/codebase-backend.md`](research/codebase-backend.md)가 권위다(§번호 인용).
>
> 조사 시점 정합 기준: 브랜치 `feat/claude-tui-fullscreen-option`. backend 컨벤션 출처: `src-tauri/src/features/terminal/mod.rs`, `commands/wsl.rs`, `features/terminal/parsing.rs`, `lib.rs`, `app_env.rs`.

---

## 0. 설계 원칙 (이 레이어가 책임지는 것 / 책임지지 않는 것)

backend `agent_runtime` 레이어는 **transport·process lifecycle만** 책임진다.

**책임진다 (backend):**
- `wsl.exe`를 통한 provider child process spawn/kill (§3, §5).
- stdout newline-delimited JSON-RPC framing → `agent-runtime-message` emit (§4).
- stdin write (`agent_runtime_send`) (§6.2).
- stderr 라인 캡처 → `agent-runtime-stderr` emit (§4.3).
- process exit 감지 → `agent-runtime-exit` emit + pending 정리 신호 (§5.3).
- framing/transport 에러 → `agent-runtime-error` emit (§4.4).
- bounded queue / backpressure → `agent-runtime-backpressure` emit (§7).
- provider별 executable allowlist 검증 (§8).
- WSL/Windows path canonicalize (§9).
- graceful shutdown (stdin EOF → timeout → kill) (§5.2).
- test-mode mock JSON-RPC 스트림 (§10).
- redacted debug logging (§11).

**책임지지 않는다 (frontend adapter가 함):**
- provider wire(Codex notification / ACP `session/update`) → `AgentEvent`(15 §3) **변환**. backend는 raw JSON-RPC를 그대로 올린다 (15 §8.3 주석, [`03-target-architecture.md`](03-target-architecture.md) §Provider Adapter).
- 상태 머신 전이·upsert/reconcile·approval 매칭 (04 전체). backend는 pending request **id 집합**만 진단용으로 추적(§6.4)하고, 의미 해석은 안 한다.
- JSON-RPC `id` 발급·request/response 매칭. adapter가 `id`를 만들고 `agent_runtime_send`로 내려보낸다. backend는 envelope를 검사하지 않고 그대로 전달한다.

이 경계는 PTY 레이어와 동형이다: PTY backend도 byte stream framing만 하고 ANSI/transcript 의미는 frontend가 해석한다 (research/codebase-backend.md §10 권고 3).

---

## 1. Runtime 종류와 축 구분

| runtime / 축 | 값 | 정의 위치 | 비고 |
|---|---|---|---|
| `transportKind` (process 실행 방식) | `jsonrpc-stdio` \| `websocket` | 15 §8.1 `AgentRuntimeStartParams` | backend가 어떻게 process/socket을 띄우는가 |
| `SessionRuntimeKind` (persistence) | `pty` \| `direct-codex` \| `direct-claude` | 15 §7.1 | 세션이 어떤 runtime으로 복원되는가 |
| `AgentProvider` (normalized) | `codex` \| `claude` \| `legacy-pty` | 15 §1 | adapter 선택 키 |

**`transportKind`와 `SessionRuntimeKind`는 별개 축이다.** 한 `direct-codex` 세션은 `jsonrpc-stdio` 또는 (검증 후) `websocket` transport로 구동될 수 있다. backend `AgentRuntime`는 `transportKind` + `provider`만 알면 되고, `SessionRuntimeKind`는 persistence(10) 관심사다.

기존 PTY runtime(`pty`)은 현재 `pty_*` command를 그대로 쓴다. `agent_runtime_*`은 direct runtime 전용 네임스페이스다 (research/codebase-backend.md §10 권고 2).

**v1 범위 (확정 기본값, 13 참조)**: `jsonrpc-stdio`만 구현한다. `websocket`은 backend에 websocket 클라이언트 코드/의존성이 전무하므로(`Cargo.toml` 확인, research/codebase-backend.md §11) 1차 미구현이고 **enum variant만 미리 둔다**. 결정 필요 항목은 [13](13-risks-open-questions.md) "Codex websocket transport" 참조.

---

## 2. 모듈 구조와 등록 (정확한 신설 위치)

research/codebase-backend.md §9 표를 그대로 따른다. `commands/<x>.rs`는 얇은 wrapper, 로직·상태는 `features/<x>/`에 둔다(같은 문서 §3.1 컨벤션).

```
src-tauri/src/
├── lib.rs                         # ← 3곳 수정 (§2.2)
├── commands/
│   ├── mod.rs                     # ← "pub mod agent_runtime;" 1줄 추가
│   └── agent_runtime.rs           # 얇은 #[tauri::command] 래퍼 5종 + re-export
└── features/
    └── agent_runtime/
        ├── mod.rs                 # AgentRuntimeState, AgentRuntime, core fn (spawn/send/cancel/shutdown/snapshot)
        ├── transport.rs           # newline-delimited JSON-RPC framer, reader/stderr thread, writer
        ├── process.rs             # wsl.exe child spawn, graceful shutdown, allowlist, path canonicalize
        ├── types.rs               # 15 §8 Rust struct 미러 (RuntimeId, JsonRpc*, AgentRuntime*, Event payload)
        └── tests.rs               # #[cfg(test)] mod tests; (framing/snapshot/mock 단위 테스트)
```

`features/agent_runtime/mod.rs` 상단:

```rust
mod process;
mod transport;
pub mod types;

#[cfg(test)]
mod tests;

pub use types::*; // RuntimeId 등을 commands/agent_runtime.rs에서 재export
```

> **공용 util 추출 (확인 필요, research §2.6·§11)**: `decode_utf8_stream_chunk`(`features/terminal/parsing.rs:101`)는 현재 `pub(super)`다. transport.rs가 재사용하려면 (a) `pub(crate)`로 가시성 상향 후 `features/terminal/parsing.rs`를 그대로 참조하거나, (b) `features/io_util.rs`로 추출한다. **권고: (a) 최소 변경**. 단 `features/terminal/tests.rs`가 `use super::parsing::...`로 의존하므로, 추출(b) 선택 시 terminal 테스트 import를 함께 갱신해야 한다. 결정은 [13](13-risks-open-questions.md) "decode_utf8_stream_chunk 공용화" 참조.

### 2.1 `commands/agent_runtime.rs` (얇은 wrapper)

`commands/pty.rs`(re-export)와 `commands/workspace.rs`(wrapper) 패턴 혼합. command는 모두 `Result<T, String>` 반환(전역 에러 컨벤션, research §2.1·§7).

```rust
// src-tauri/src/commands/agent_runtime.rs
pub use crate::features::agent_runtime::types::{
    AgentRuntimeCancelTarget, AgentRuntimeSnapshot, AgentRuntimeStartParams, JsonRpcMessage,
    RuntimeId,
};
use crate::features::agent_runtime::{self, AgentRuntimeState};
use tauri::AppHandle;

#[tauri::command]
pub fn agent_runtime_start(
    app: AppHandle,
    state: tauri::State<'_, AgentRuntimeState>,
    params: AgentRuntimeStartParams,
) -> Result<RuntimeId, String> {
    agent_runtime::start(state.inner(), &app, params)
}

#[tauri::command]
pub fn agent_runtime_send(
    state: tauri::State<'_, AgentRuntimeState>,
    runtime_id: u32,
    message: JsonRpcMessage,
) -> Result<(), String> {
    agent_runtime::send(state.inner(), runtime_id, message)
}

#[tauri::command]
pub fn agent_runtime_cancel(
    app: AppHandle,
    state: tauri::State<'_, AgentRuntimeState>,
    runtime_id: u32,
    target: AgentRuntimeCancelTarget,
) -> Result<(), String> {
    agent_runtime::cancel(state.inner(), &app, runtime_id, target)
}

#[tauri::command]
pub fn agent_runtime_shutdown(
    state: tauri::State<'_, AgentRuntimeState>,
    runtime_id: u32,
) -> Result<(), String> {
    agent_runtime::shutdown(state.inner(), runtime_id)
}

#[tauri::command]
pub fn agent_runtime_get_snapshot(
    state: tauri::State<'_, AgentRuntimeState>,
    runtime_id: u32,
) -> Result<AgentRuntimeSnapshot, String> {
    agent_runtime::get_snapshot(state.inner(), runtime_id)
}
```

> command 인자명은 camelCase로 들어온다(`runtimeId`→`runtime_id`는 tauri가 자동 변환). PTY가 `state: tauri::State<'_, PtyState>` + `state.inner()`를 core fn에 넘기는 패턴과 동일(research §3.2). 한 command가 여러 State를 받을 수 있으므로(예: 종료 시 workspace resume token 갱신), 후속 단계에서 `WorkspaceState`를 추가 주입하는 것도 가능하다(research §3.2, `close_session` 선례).

### 2.2 `lib.rs` 등록 (정확히 3곳)

research §3.2의 3곳 규칙:

```rust
// 1) lib.rs 상단 use (commands/*에서 import; lib.rs:5-33 패턴)
use commands::agent_runtime::{
    agent_runtime_cancel, agent_runtime_get_snapshot, agent_runtime_send, agent_runtime_shutdown,
    agent_runtime_start,
};
use features::agent_runtime::AgentRuntimeState;

// 2) Builder.manage (lib.rs:62-65, PtyState 옆)
tauri::Builder::default()
    .plugin(tauri_plugin_shell::init())
    .manage(PtyState::default())
    .manage(AgentRuntimeState::default())   // ← 추가
    .manage(WslState::default())
    // ...

// 3) generate_handler! 목록 (lib.rs:159 부근, pty_* 옆)
    .invoke_handler(tauri::generate_handler![
        // ... 기존 ...
        pty_spawn, pty_write, pty_resize, pty_kill,
        agent_runtime_start, agent_runtime_send, agent_runtime_cancel,
        agent_runtime_shutdown, agent_runtime_get_snapshot,   // ← 추가
        // ...
    ])
```

그리고 `commands/mod.rs`에 `pub mod agent_runtime;` 1줄 추가 (mod.rs:1-9 나열 패턴).

**체크리스트 (등록 완료 기준):**
- [ ] `commands/mod.rs`에 `pub mod agent_runtime;`
- [ ] `lib.rs`에 `use commands::agent_runtime::{...}` + `use features::agent_runtime::AgentRuntimeState;`
- [ ] `lib.rs`에 `.manage(AgentRuntimeState::default())`
- [ ] `lib.rs` `generate_handler![]`에 5개 함수명
- [ ] `cargo check --manifest-path src-tauri/Cargo.toml` 통과

---

## 3. 상태 모델 (`AgentRuntimeState` / `AgentRuntime`)

PTY `PtyState`(research §2.1)와 **별도**로 둔다 — RuntimeId 공간을 PTY `u32` 세션 ID와 섞지 않는다(research §10 권고 1). 동시성은 기존 컨벤션(`std::sync::{Mutex, Arc, AtomicU64, AtomicBool}`)을 따른다(같은 문서 §7). **tokio·channel은 도입하지 않는다** (v1 결정, §7.4·[13](13-risks-open-questions.md) "tokio 도입 여부").

```rust
// features/agent_runtime/mod.rs
use crate::features::agent_runtime::types::*;
use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicBool, AtomicU64};
use std::sync::{Arc, Mutex};

pub type RuntimeId = u32; // 15 §8.1과 동일

/// 한 direct agent process의 backend 핸들. PtySession과 동형.
struct AgentRuntime {
    provider: String,          // "codex" | "claude"  (allowlist·로깅용)
    transport_kind: String,    // "jsonrpc-stdio" (v1)
    /// child process handle. graceful shutdown/kill에 직접 사용(PTY의 Drop 의존과 다름, §5).
    child: Arc<Mutex<Option<ChildHandle>>>,
    /// stdin writer. agent_runtime_send가 잠가 write(§6.2).
    stdin: Arc<Mutex<Option<Box<dyn std::io::Write + Send>>>>,
    /// late-attach용 message log (snapshot/delta-since 후속 단계 — §4.5).
    message_log: Arc<Mutex<VecDeque<RuntimeMessageRecord>>>,
    /// 단조 증가 message seq(1-based). PTY output_seq와 동형(research §2.3).
    message_seq: Arc<AtomicU64>,
    /// 진단용 pending request id 집합(의미 해석 없음, §6.4).
    pending_request_ids: Arc<Mutex<Vec<String>>>,
    /// status: "starting" | "running" | "exited" | "failed" (snapshot용, 15 §8.1).
    status: Arc<Mutex<String>>,
    started_at: i64,
    exited_at: Arc<Mutex<Option<i64>>>,
    exited: Arc<AtomicBool>,
    /// bounded queue 누적 drop 카운트(backpressure event용, §7).
    dropped_messages: Arc<AtomicU64>,
}

/// 영속 message 한 건(late-attach snapshot용). PtyOutputChunkRecord와 동형.
struct RuntimeMessageRecord {
    seq: u64,
    /// raw JSON-RPC line(개행 제거 후 1메시지). frontend가 파싱.
    line: String,
}

#[derive(Default)]
pub struct AgentRuntimeState {
    runtimes: Mutex<HashMap<RuntimeId, AgentRuntime>>,
    next_id: Mutex<RuntimeId>,
}
```

`ChildHandle`은 §5.1에서 정의. `next_id`는 PTY `next_session_id`(research §2.1, terminal/mod.rs:237-242)와 동일하게 lock 후 `+= 1`로 발급:

```rust
fn next_runtime_id(state: &AgentRuntimeState) -> Result<RuntimeId, String> {
    let mut id = state.next_id.lock().map_err(|e| e.to_string())?;
    *id += 1;
    Ok(*id)
}
```

> `message_log`/`message_seq`/snapshot/delta-since는 PTY의 late-attach 신뢰성 메커니즘(research §2.3, §10 권고 3)을 그대로 옮긴 것이다. v1 command 계약(15 §8.2)에는 `agent_runtime_get_snapshot`만 있고 delta-since는 **후속 단계**다(§4.5). v1에서는 `message_log`에 기록만 하고 snapshot에 `pendingRequestIds`/status만 노출하면 된다.

---

## 4. Transport — newline-delimited JSON-RPC framing (`transport.rs`)

### 4.1 framing 규칙 (정본)

stdio JSON-RPC runtime의 framing 규칙. 두 provider 공통(Codex는 `jsonrpc` 필드 생략, ACP는 정식 — adapter가 envelope를 맞춤; ref-codex §1.2, ref-acp §1):

1. **stdout purity**: stdout은 UTF-8 newline(`\n`)-delimited JSON-RPC만 허용한다. 한 줄 = 한 JSON-RPC 메시지.
2. **embedded newline = error**: 한 메시지 JSON에 raw 개행이 포함될 수 없다(JSON 인코딩상 문자열 내부 개행은 `\n`으로 escape됨). framer는 `\n`을 메시지 경계로만 본다. 메시지 자체가 multi-line일 수 없다는 가정이 깨지는 케이스(provider가 pretty-print)는 **invalid framing → `agent-runtime-error{recoverable:false}`** 로 분류한다.
3. **stderr 분리**: stderr는 별도 reader thread로 라인 단위 캡처해 `agent-runtime-stderr`로 emit. transcript 기본 표시 안 함(§4.3).
4. **invalid JSON = runtime error**: 한 라인이 valid JSON이 아니면 provider adapter까지 올리지 않고 `agent-runtime-error{recoverable:true}`로 분류한다(한 메시지 손상은 복구 가능). 단, 연속 N회(예: 5회) invalid면 `recoverable:false`로 격상.
5. **UTF-8 경계 보존**: stdout byte chunk는 UTF-8 multibyte 경계에서 잘릴 수 있으므로 `decode_utf8_stream_chunk`(parsing.rs:101)로 incomplete 경계를 carry over한다(§2 가시성 노트).

### 4.2 stdout reader thread

PTY reader 루프(terminal/mod.rs:513-582, research §2.2)를 newline framer로 치환한다. 4096-byte buffer + `decode_utf8_stream_chunk` + line accumulator.

```rust
// transport.rs (의사코드 — 실제는 std::thread + Arc 캡처)
fn spawn_stdout_reader(
    app: AppHandle,
    runtime_id: RuntimeId,
    mut reader: Box<dyn std::io::Read + Send>,
    message_log: Arc<Mutex<VecDeque<RuntimeMessageRecord>>>,
    message_seq: Arc<AtomicU64>,
    dropped_messages: Arc<AtomicU64>,
    exited: Arc<AtomicBool>,
) {
    std::thread::spawn(move || {
        let mut pending_bytes: Vec<u8> = Vec::new(); // UTF-8 carry over
        let mut line_buf = String::new();            // 미완성 라인 carry over
        let mut buf = [0u8; 4096];
        let mut invalid_streak = 0u32;

        loop {
            match reader.read(&mut buf) {
                Ok(0) => {
                    // EOF: 마지막 flush(incomplete UTF-8 강제 디코드)
                    let tail = decode_utf8_stream_chunk(&mut pending_bytes, &[], true);
                    line_buf.push_str(&tail);
                    flush_complete_lines(&mut line_buf, /*final=*/true, &app, runtime_id,
                                         &message_log, &message_seq, &dropped_messages,
                                         &mut invalid_streak);
                    break;
                }
                Ok(n) => {
                    let decoded = decode_utf8_stream_chunk(&mut pending_bytes, &buf[..n], false);
                    line_buf.push_str(&decoded);
                    flush_complete_lines(&mut line_buf, false, &app, runtime_id,
                                         &message_log, &message_seq, &dropped_messages,
                                         &mut invalid_streak);
                }
                Err(_) => break,
            }
            if exited.load(Ordering::SeqCst) { break; }
        }
    });
}

/// line_buf에서 '\n'으로 끝나는 완성 라인을 모두 뽑아 처리. 마지막 미완성 조각은 남긴다.
fn flush_complete_lines(line_buf: &mut String, is_final: bool, app: &AppHandle,
                        runtime_id: RuntimeId, message_log: &Arc<Mutex<VecDeque<RuntimeMessageRecord>>>,
                        message_seq: &Arc<AtomicU64>, dropped: &Arc<AtomicU64>,
                        invalid_streak: &mut u32) {
    loop {
        let Some(idx) = line_buf.find('\n') else { break; };
        let line: String = line_buf.drain(..=idx).collect();
        let line = line.trim_end_matches(['\n', '\r']).to_string();
        if line.is_empty() { continue; }
        handle_line(line, app, runtime_id, message_log, message_seq, dropped, invalid_streak);
    }
    if is_final && !line_buf.trim().is_empty() {
        // EOF 후 남은 개행 없는 마지막 조각도 한 메시지로 시도
        let line = std::mem::take(line_buf).trim().to_string();
        handle_line(line, app, runtime_id, message_log, message_seq, dropped, invalid_streak);
    }
}

fn handle_line(line: String, app: &AppHandle, runtime_id: RuntimeId,
               message_log: &Arc<Mutex<VecDeque<RuntimeMessageRecord>>>,
               message_seq: &Arc<AtomicU64>, dropped: &Arc<AtomicU64>,
               invalid_streak: &mut u32) {
    match serde_json::from_str::<serde_json::Value>(&line) {
        Ok(value) => {
            *invalid_streak = 0;
            let seq = message_seq.fetch_add(1, Ordering::SeqCst) + 1; // 1-based
            record_and_emit_message(app, runtime_id, seq, line, value, message_log, dropped);
        }
        Err(e) => {
            *invalid_streak += 1;
            let recoverable = *invalid_streak < 5;
            let _ = app.emit("agent-runtime-error", AgentRuntimeEvent::Error {
                runtime_id,
                message: format!("invalid json-rpc line: {e}"),
                recoverable,
            });
        }
    }
}
```

> `serde_json::from_str::<JsonRpcMessage>`로 바로 디코드하지 않고 **`serde_json::Value`로 1차 검증**한 뒤 emit 시 `JsonRpcMessage`로 직렬화하는 이유: backend는 protocol 의미를 해석하지 않으므로(§0), `JsonRpcMessage` untagged enum이 어느 variant인지 판정하는 비용을 frontend로 미룬다. emit payload는 15 §8.3대로 `message: JsonRpcMessage`이지만, 실제로는 `Value`를 그대로 실어 보내도 wire-compat하다(`JsonRpcMessage`가 untagged이므로 frontend에서 동일 JSON으로 수신). **권고: emit 시 `serde_json::Value`를 그대로 message 필드에 담아 round-trip 손실을 없앤다** — 이때 Rust emit struct는 `message: serde_json::Value`로 두고, TS 측은 `JsonRpcMessage`로 받는다(둘 다 같은 JSON).

### 4.3 stderr reader thread

별도 thread로 `BufReader::lines()` 패턴(`commands/wsl.rs:60` `read_line` 선례) 또는 위 framer와 동일하게 라인 단위 캡처. emit:

```rust
fn spawn_stderr_reader(app: AppHandle, runtime_id: RuntimeId, stderr: ChildStderr) {
    std::thread::spawn(move || {
        let mut reader = std::io::BufReader::new(stderr);
        let mut line = String::new();
        loop {
            line.clear();
            match reader.read_line(&mut line) {
                Ok(0) => break,
                Ok(_) => {
                    let trimmed = line.trim_end_matches(['\n', '\r']).to_string();
                    if trimmed.is_empty() { continue; }
                    let _ = app.emit("agent-runtime-stderr", AgentRuntimeEvent::Stderr {
                        runtime_id, line: redact(&trimmed), // §11
                    });
                }
                Err(_) => break,
            }
        }
    });
}
```

stderr는 session diagnostic panel에서 opt-in으로만 표시한다(§11, [09](09-permissions-security.md)).

### 4.4 framing 에러 분류 (정본)

| 상황 | 분류 | emit | recoverable |
|---|---|---|---|
| 한 라인 invalid JSON (< 5 연속) | runtime error | `agent-runtime-error` | `true` |
| 5회 연속 invalid JSON | framing 붕괴 | `agent-runtime-error` | `false` |
| stdout에 raw 개행 포함된 message (pretty-print) | invalid framing | `agent-runtime-error` | `false` |
| stdin write 실패(broken pipe) | transport error | `agent-runtime-error` | `false` (process 사망 추정) |
| child wait → exit | 정상/비정상 종료 | `agent-runtime-exit` | — (별도 event) |

`recoverable:false` 에러 후에는 frontend adapter가 세션을 `failed`로 전이(04 §2.1 규칙 6)하고 process shutdown을 호출할 수 있다. backend는 자동 kill하지 않는다(명시적 shutdown 대기).

### 4.5 message seq / snapshot / delta-since (late-attach, 후속 단계)

PTY의 seq + delta + complete 3요소(research §2.3, §10 권고 3)를 동일 원리로 적용한다. **v1 command 계약(15 §8.2)에는 delta-since가 없다** — v1은 `message_log`에 기록만 하고 `agent_runtime_get_snapshot`은 status·pending만 반환(§6.5). 후속 단계에서 다음을 추가한다(15 §8.3 주석이 "seq는 후속 단계에서 message payload에 추가"라고 명시):

- `agent-runtime-message` payload에 `seq: u64` 추가.
- `agent_runtime_get_message_delta_since(runtime_id, after_seq) -> { messages, complete }` command 추가. PTY `get_output_delta_since`(terminal/mod.rs:675)의 `complete` 플래그 휴리스틱(trim된 경우 false → full replay) 그대로.
- `message_log` cap (예: 4MB 또는 N메시지)과 `trim` 로직. PTY `trim_output_chunks` 본뜸.

이는 04 §3.4가 권고하는 transcript late-attach 신뢰성과 직접 대응한다. 결정 필요 항목은 [13](13-risks-open-questions.md) "message seq/delta 후속 단계 범위".

---

## 5. Process lifecycle (`process.rs`)

### 5.1 child spawn — `wsl.exe`를 통한 stdio process

PTY는 `portable_pty`로 띄우지만, direct runtime은 **stdio piped child**가 필요하다. 따라서 `commands/wsl.rs:WslShell::spawn`(research §5.1)을 선례로 `std::process::Command`를 직접 쓴다 — `stdin(piped)`, `stdout(piped)`, `stderr(piped)`, Windows에서 `CREATE_NO_WINDOW(0x08000000)`.

```rust
// process.rs
use std::process::{Child, Command, Stdio};
#[cfg(windows)]
use std::os::windows::process::CommandExt;

pub struct ChildHandle {
    pub child: Child,
    pub pid: u32,
}

/// 정본 launch 커맨드 형태(셸 비경유 직접 실행):
///   wsl.exe -d <distro> --cd <wslWorkDir> -e env KEY1=V1 KEY2=V2 <executable> <argv...>
/// command/args/env는 §8 allowlist를 통과한 검증된 값만 들어온다.
pub fn spawn_wsl_process(
    distro: &str,
    executable: &str,
    argv: &[String],
    work_dir: &str,                 // WSL absolute path (§9 canonicalize 완료)
    env: &std::collections::HashMap<String, String>,
) -> Result<(ChildHandle, ChildStdio), String> {
    let mut cmd = Command::new("wsl.exe");
    // -d <distro> --cd <wslWorkDir>: cwd를 WSL 내부 경로로 직접 설정(OQ-27 해소).
    cmd.arg("-d").arg(distro).arg("--cd").arg(work_dir);
    // -e env KEY=VAL ... <executable> <argv...>:
    //   로그인 셸(`bash -lic …`)을 거치지 않고 WSL 실제 `env` 바이너리로 환경변수를 주입한 뒤
    //   executable을 직접 exec한다(OQ-28 해소). 셸을 끼지 않으므로 rc 파일 stdout 오염이 없다.
    cmd.arg("-e").arg("env");
    for (k, v) in env {
        // KEY=VALUE 형태. `env` 바이너리에 직접 전달되므로 셸 메타문자 해석/확장이 없다.
        cmd.arg(format!("{k}={v}"));
    }
    cmd.arg(executable);
    for a in argv {
        cmd.arg(a);
    }
    cmd.stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    #[cfg(windows)]
    cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW (wsl.rs:38 동일)

    let mut child = cmd.spawn().map_err(|e| e.to_string())?;
    let pid = child.id();
    let stdin = child.stdin.take().ok_or("failed to open stdin")?;
    let stdout = child.stdout.take().ok_or("failed to open stdout")?;
    let stderr = child.stderr.take().ok_or("failed to open stderr")?;

    Ok((ChildHandle { child, pid }, ChildStdio { stdin, stdout, stderr }))
}
```

> **launch 커맨드 정본 (cwd·env 일괄 해소)**: 정확한 형태는
> ```text
> wsl.exe -d <distro> --cd <wslWorkDir> -e env KEY1=V1 KEY2=V2 <executable> <argv...>
> ```
> 이다. 핵심은 **로그인 셸 비경유 직접 실행**이다.
> - **cwd = `--cd <wslWorkDir>` (OQ-27 해소)**: WSL 내부 cwd는 Windows `Command::current_dir`로 줄 수 없다(research §5.1: PTY는 `cwd: null`로 넘기고 스크립트 내부 `cd '<workDir>'`로 진입). direct runtime은 셸 스크립트를 끼지 않으므로 `wsl.exe --cd <wslPath>`로 cwd를 설정한다(provider 무관). provider CLI의 cwd 플래그(Codex `--cd`, Claude ACP launch param)는 fallback이다.
> - **env = `-e env KEY=VAL` 바이너리 주입 (OQ-28 해소)**: PTY는 셸 스크립트 prefix(`<env>claude`, research §6)로 export했지만, direct runtime은 WSL 실제 `env` 바이너리에 `KEY=VALUE`를 직접 인자로 넘긴다. `env`는 WSL 내부 실제 바이너리이므로 셸 메타문자 해석/확장 없이 환경변수를 주입하고 그 자리에서 `<executable>`을 exec한다. 즉 06 §2.3가 우려한 `bash -lic … exec <node> <entry>` 형태의 **bash rc stdout 오염**(rc 파일이 stdout으로 무언가를 출력해 JSON-RPC framing을 깨뜨림)이 **셸 비경유로 원천 해소**된다(06 §2.3와 일치).
> - **API key/token은 §11 redaction 대상이고 평문 영속화 금지**(10 §7.3 보안 경계). env 인자는 process argv에 노출되므로 로그·snapshot·persistence 어디에도 평문으로 남기지 않는다.
>
> 배포 대상 WSL 버전의 `--cd` 지원 여부 확인 및 미지원 시 provider flag fallback 경로는 [13](13-risks-open-questions.md) OQ-27 참조.

`start` core fn 흐름 (`agent_runtime_start`가 호출):

```rust
pub fn start(state: &AgentRuntimeState, app: &AppHandle, params: AgentRuntimeStartParams)
    -> Result<RuntimeId, String>
{
    // 1) test-mode 분기 (§10)
    if is_test_mode() {
        return start_mock(state, app, params);
    }
    // 2) allowlist 검증 (§8) — provider별 executable/args 화이트리스트
    let (provider, distro, work_dir, executable, argv, env) = validate_and_extract(&params)?;
    // 3) path canonicalize (§9)
    let work_dir = canonicalize_wsl_path(&work_dir)?;
    // 4) spawn
    let (child, stdio) = spawn_wsl_process(&distro, &executable, &argv, &work_dir, &env)?;
    // 5) RuntimeId 발급 + AgentRuntime 구성 + HashMap insert
    let id = next_runtime_id(state)?;
    let runtime = build_runtime(provider, child, &stdio); // stdin handle 보관 등
    // 6) reader/stderr/child-wait thread 3개 spawn (§4.2, §4.3, §5.3)
    spawn_stdout_reader(app.clone(), id, stdio.stdout, /* ... */);
    spawn_stderr_reader(app.clone(), id, stdio.stderr);
    spawn_child_wait(app.clone(), id, /* child wait handle, exited flag, ... */);
    // 7) status = "running" (process는 떴음; protocol initialize는 frontend adapter가 별도로 함)
    insert_runtime(state, id, runtime)?;
    Ok(id)
}
```

> **process start ≠ protocol initialize (정본)**: `agent_runtime_start`는 process를 띄우고 status를 `"running"`(backend transport 관점)으로만 둔다. normalized 세션 상태(15 §2)의 `starting`→`ready` 전이(initialize/session 생성 완료)는 **frontend adapter**가 `agent_runtime_send`로 initialize를 보내고 응답을 받아 합성한다(04 §2.1 규칙 1). backend `AgentRuntimeSnapshot.status`(15 §8.1: `starting`/`running`/`exited`/`failed`)는 transport-level 상태이지 normalized session status가 아니다 — 둘을 혼동하지 말 것.

### 5.2 graceful shutdown (정본 — PTY Drop 의존과 다름)

PTY는 `HashMap::remove` + Drop에 의존하지만(research §2.4, §10 권고 5), direct runtime은 protocol상 graceful shutdown이 필요하다. 순서:

```text
shutdown(runtime_id):
  1. stdin handle을 drop하여 EOF 신호 (provider가 stdin EOF에 정상 종료하도록)
  2. child.wait를 별도 thread에서 감시 (이미 spawn_child_wait가 돌고 있음)
  3. SHUTDOWN_GRACE_MS(예: 2000ms) 동안 exited 플래그 polling
  4. 여전히 살아있으면 child.kill() (강제 종료)
  5. HashMap에서 runtime 제거
  6. pending_request_ids가 비어있지 않으면, exit event에 의존해 frontend가 모든 pending을 실패로 닫음(04 §5, §6.4)
```

```rust
pub fn shutdown(state: &AgentRuntimeState, runtime_id: RuntimeId) -> Result<(), String> {
    const SHUTDOWN_GRACE_MS: u64 = 2000;
    const POLL_MS: u64 = 50;

    let (stdin, child, exited) = {
        let mut runtimes = state.runtimes.lock().map_err(|e| e.to_string())?;
        let rt = runtimes.get(&runtime_id).ok_or("runtime not found")?;
        (rt.stdin.clone(), rt.child.clone(), rt.exited.clone())
    };

    // 1) stdin drop → EOF
    if let Ok(mut guard) = stdin.lock() {
        guard.take(); // Box<dyn Write> drop → pipe close
    }

    // 2~4) grace polling then kill
    let mut waited = 0u64;
    while waited < SHUTDOWN_GRACE_MS {
        if exited.load(Ordering::SeqCst) { break; }
        std::thread::sleep(std::time::Duration::from_millis(POLL_MS));
        waited += POLL_MS;
    }
    if !exited.load(Ordering::SeqCst) {
        // §5.3 정본 패턴: Child 자체는 wait 전용 thread가 소유하므로 여기서 다시 잠그지 않는다.
        // 강제 종료는 spawn 시 저장해 둔 OS pid/handle로 수행한다(wait thread와 lock 경쟁 없음).
        kill_by_stored_pid(&child); // 저장된 pid/handle로 OS kill (deadlock 회피, §5.3 note)
    }

    // 5) remove
    state.runtimes.lock().map_err(|e| e.to_string())?.remove(&runtime_id);
    Ok(())
}
```

> `std::thread::sleep` polling은 PTY child-wait thread의 200ms sleep(research §2.2, terminal/mod.rs:498)과 동일한 std-thread 컨벤션이다. tokio timeout을 쓰지 않는다(§7.4).

### 5.3 child wait thread + exit event

PTY thread1(child wait, terminal/mod.rs:491-502)을 본뜬다. exit 시 `exited.store(true)` + `agent-runtime-exit` emit. **process exit은 모든 pending request를 실패로 닫는다** — 단, backend는 frontend에 exit event를 알릴 뿐이고, 실제 pending 정리(approval cancelled/failed)는 frontend adapter가 04 §5 규칙에 따라 수행한다.

```rust
fn spawn_child_wait(
    app: AppHandle, runtime_id: RuntimeId,
    child: Arc<Mutex<Option<ChildHandle>>>,
    exited: Arc<AtomicBool>, exited_at: Arc<Mutex<Option<i64>>>,
    status: Arc<Mutex<String>>,
) {
    std::thread::spawn(move || {
        // 정본 패턴(아래 note): Child는 이 wait 전용 thread로 move되어 blocking wait 중
        // Mutex를 보유하지 않는다. kill은 §5.2가 별도로 저장한 OS pid/handle로 수행한다.
        // 여기서는 move된 child 소유권으로 직접 wait한다(terminal/mod.rs Thread 1 선례).
        let exit_status = {
            let mut guard = child.lock().unwrap();
            guard.as_mut().map(|h| h.child.wait())
        };
        exited.store(true, Ordering::SeqCst);
        *exited_at.lock().unwrap() = Some(now_millis());
        *status.lock().unwrap() = "exited".to_string();

        let (code, signal) = match exit_status {
            Some(Ok(st)) => (st.code(), unix_signal(&st)),
            _ => (None, None),
        };
        let _ = app.emit("agent-runtime-exit",
            AgentRuntimeEvent::Exit { runtime_id, code, signal });
    });
}
```

> **child wait/kill 동시성 — 정본 패턴**: `child.wait()`는 blocking이고 `&mut`가 필요하다. `Mutex` lock을 wait 내내 잡으면 `kill()`(§5.2)이 같은 lock을 기다리다 deadlock한다.
>
> **정본 패턴**: spawn 직후 `Child`를 **wait 전용 thread로 `move`**하고, 그 thread가 소유권으로 `child.wait()`를 호출한다(blocking wait 중 Mutex 미보유). `kill`은 spawn 시점에 **저장해 둔 OS pid/handle**로 수행한다 — `ChildHandle.pid`(§5.1, Windows는 `child.id()`로 얻은 PID, Unix는 동일)를 별도로 보관하고, §5.2의 강제 종료는 이 저장된 pid/handle로 OS kill을 호출한다(wait thread가 가진 `Child`를 다시 잠그지 않는다). 이는 `terminal/mod.rs`의 **2-thread 선례**(Thread 1이 `child`를 move해 `child.wait()`만 하고, kill은 `portable_pty`의 killer handle로 분리; terminal/mod.rs:491-502)와 동형이다. PTY는 child를 reader/wait가 공유하지 않아 이 문제가 없었고, direct runtime도 동일하게 wait 소유권과 kill 경로를 분리해 회피한다.
>
> 위 `spawn_child_wait` 의사코드의 `Arc<Mutex<Option<ChildHandle>>>` 공유는 가독성용 골격이다. 실제 구현은 `Child`를 wait thread로 move하고 kill용 pid/handle만 `AgentRuntime`에 남긴다. 구현 시 wait-중-kill deadlock 미발생을 반드시 테스트한다(§13 AC-5).

---

## 6. Command core 구현

### 6.1 `start` — §5.1 참조.

### 6.2 `send` — stdin write

`agent_runtime_send(runtime_id, message: JsonRpcMessage)`. message를 직렬화 → newline append → stdin write + flush. embedded newline 방어(§4.1 규칙 2): 직렬화된 JSON에 raw `\n`이 없도록 `serde_json::to_string`(compact, pretty 아님)을 쓴다.

```rust
pub fn send(state: &AgentRuntimeState, runtime_id: RuntimeId, message: JsonRpcMessage)
    -> Result<(), String>
{
    let line = serde_json::to_string(&message).map_err(|e| e.to_string())?;
    debug_assert!(!line.contains('\n'), "compact json must not contain raw newline");
    let stdin = {
        let runtimes = state.runtimes.lock().map_err(|e| e.to_string())?;
        let rt = runtimes.get(&runtime_id).ok_or("runtime not found")?;
        rt.stdin.clone()
    };
    let mut guard = stdin.lock().map_err(|e| e.to_string())?;
    let writer = guard.as_mut().ok_or("stdin closed")?;
    writer.write_all(line.as_bytes()).map_err(|e| e.to_string())?;
    writer.write_all(b"\n").map_err(|e| e.to_string())?;
    writer.flush().map_err(|e| e.to_string())?;
    Ok(())
}
```

> backend는 message가 request/notification/response인지 **검사하지 않는다**(§0). request `id` 발급·pending 추적은 frontend adapter 책임. 단, 진단을 위해 §6.4의 pending id 추적을 *선택적으로* 할 수 있으나, 1차에서는 frontend가 pending을 관리하고 backend는 byte만 흘려보내는 것을 권고한다.

### 6.3 `cancel` — target별 처리

`AgentRuntimeCancelTarget`(15 §8.1): `request{requestId}` | `turn{turnId}` | `process`.

**cancel wire 전송 주체 정본**: backend는 protocol cancel 메시지를 **만들지 않는다**(provider별 cancel wire가 다름 — Codex `turn/interrupt`(ref-codex §3.2 `TurnInterruptParams {threadId, turnId}`), ACP `session/cancel`; adapter가 안다). turn/request cancel은 **frontend adapter가 `agentRuntimeSend`로 직접 wire를 보내고**, backend `agent_runtime_cancel`은 `{type:"process"}`만 처리한다(이 경계는 14 §5 시퀀스가 정본: adapter가 `turn/interrupt`/`session/cancel`을 send, Transport는 framing만). 따라서:

- `target == process`: `shutdown(runtime_id)`을 호출(§5.2). 이것만 backend가 직접 한다.
- `target == request | turn`: backend는 **할 일이 없다(no-op)**. frontend adapter가 적절한 cancel JSON-RPC(Codex `turn/interrupt` 등)를 `agent_runtime_send`로 보낸다. backend `cancel` core fn은 `request`/`turn`에 대해 no-op(또는 진단용 pending id 정리만)으로 둔다.

```rust
pub fn cancel(state: &AgentRuntimeState, _app: &AppHandle, runtime_id: RuntimeId,
              target: AgentRuntimeCancelTarget) -> Result<(), String> {
    match target {
        AgentRuntimeCancelTarget::Process => shutdown(state, runtime_id),
        AgentRuntimeCancelTarget::Request { request_id } => {
            // 진단용: pending 집합에서 제거(선택). 실제 cancel wire는 frontend가 send.
            remove_pending(state, runtime_id, &request_id)?;
            Ok(())
        }
        AgentRuntimeCancelTarget::Turn { .. } => Ok(()), // frontend adapter가 cancel 전송
    }
}
```

> **설계 결정 (확인 필요)**: `cancel(request|turn)`을 backend no-op으로 두면 command가 사실상 `process`만 의미 있다. 대안: `agent_runtime_cancel`을 v1에서 제거하고 `process` cancel은 `shutdown`이 흡수. **권고: command는 15 §8.2 계약대로 유지하되 backend는 process만 처리**(계약 안정성). 결정 필요 항목 [13](13-risks-open-questions.md) "agent_runtime_cancel 의미 범위".

### 6.4 pending request id 추적 (진단 전용, 선택)

backend가 pending을 추적한다면, `send`에서 message가 `request`(id+method 둘 다 존재)면 `pending_request_ids`에 push, response/error 수신(reader)에서 매칭 id pop. **단 이는 의미 해석이 아니라 단순 id bookkeeping**이고, snapshot 진단용일 뿐이다. authoritative pending 정리는 frontend(04 §5). 1차에서는 backend pending 추적을 **생략**하고 `pendingRequestIds`를 항상 빈 배열로 둬도 무방하다(15 §8.1).

### 6.5 `get_snapshot`

```rust
pub fn get_snapshot(state: &AgentRuntimeState, runtime_id: RuntimeId)
    -> Result<AgentRuntimeSnapshot, String>
{
    let runtimes = state.runtimes.lock().map_err(|e| e.to_string())?;
    let rt = runtimes.get(&runtime_id).ok_or("runtime not found")?;
    Ok(AgentRuntimeSnapshot {
        runtime_id,
        provider: rt.provider.clone(),
        status: rt.status.lock().map_err(|e| e.to_string())?.clone(),
        started_at: rt.started_at,
        exited_at: *rt.exited_at.lock().map_err(|e| e.to_string())?,
        pending_request_ids: rt.pending_request_ids.lock().map_err(|e| e.to_string())?.clone(),
    })
}
```

late-attach 진단·재접속에 쓴다. message replay(delta-since)는 §4.5 후속 단계.

---

## 7. Bounded queue / backpressure

### 7.1 문제

reader thread가 `app.emit("agent-runtime-message", ...)`로 메시지를 올린다. provider가 폭주(대용량 output, 빠른 delta)하면 frontend 소비가 못 따라잡을 수 있다. PTY는 `output_log`/`output_chunks`에 4MB cap을 두고 trim했다(research §2.3).

### 7.2 정책 (정본)

backend의 `app.emit`은 Tauri IPC 큐로 들어간다. 이를 무한히 쌓지 않도록 **message_log를 bounded**로 둔다:

- `message_log`(VecDeque) cap = `MAX_MESSAGE_LOG_BYTES`(예: 4MB) 또는 `MAX_MESSAGE_COUNT`(예: 10000). 초과 시 oldest pop(trim) → `dropped_messages.fetch_add(1)`.
- emit 자체는 막지 않는다(frontend는 실시간 stream을 받음). trim은 **late-attach용 log**에만 적용된다.
- 단, emit rate가 위험 수준이면(예: 100ms 내 1000+ message), backend가 `agent-runtime-backpressure{droppedMessages}`를 주기적으로 emit해 frontend가 throttle/coalesce하도록 신호한다.

```rust
fn record_and_emit_message(app: &AppHandle, runtime_id: RuntimeId, seq: u64,
                           line: String, value: serde_json::Value,
                           message_log: &Arc<Mutex<VecDeque<RuntimeMessageRecord>>>,
                           dropped: &Arc<AtomicU64>) {
    // 1) late-attach log 기록 + bounded trim
    {
        let mut log = message_log.lock().unwrap();
        log.push_back(RuntimeMessageRecord { seq, line });
        let mut total: usize = log.iter().map(|r| r.line.len()).sum();
        while total > MAX_MESSAGE_LOG_BYTES && log.len() > 1 {
            if let Some(old) = log.pop_front() {
                total -= old.line.len();
                let n = dropped.fetch_add(1, Ordering::SeqCst) + 1;
                if n % BACKPRESSURE_NOTIFY_INTERVAL == 0 {
                    let _ = app.emit("agent-runtime-backpressure",
                        AgentRuntimeEvent::Backpressure { runtime_id, dropped_messages: n });
                }
            }
        }
    }
    // 2) 실시간 emit (raw value 그대로 — §4.2 note)
    let _ = app.emit("agent-runtime-message",
        AgentRuntimeMessageEmit { type_: "message", runtime_id, message: value });
}
```

> trim은 **late-attach log 신뢰성**에만 영향을 준다(delta-since complete=false → full replay 불가 구간). v1에서 delta-since가 없으면(§4.5), trim은 메모리 보호만 하면 되고 backpressure event는 진단 신호로만 쓴다. `MAX_MESSAGE_LOG_BYTES`/`BACKPRESSURE_NOTIFY_INTERVAL` 상수값은 [13](13-risks-open-questions.md) "backpressure 임계값" 참조.

### 7.3 emit overflow 명시 에러

07의 기존 계약("queue는 bounded로 두고 overflow 시 명시적인 error event")을 위 backpressure event로 구현한다. drop이 발생하면 침묵하지 않고 누적 카운트를 알린다.

### 7.4 tokio 미도입 (결정)

research §7·§11이 두 옵션(std::thread vs tokio)을 제시한다. **v1은 옵션 1(std::thread + Arc<Mutex>)로 확정**한다 — 이유: (a) 현 backend는 tokio import 0건이고 모든 command가 동기 `fn`(research §7), (b) PTY 패턴·테스트 모델과 가장 자연스럽게 공존(같은 문서 §10), (c) backpressure/timeout 요구가 polling으로 충족 가능(§5.2, §7.2). tokio 도입은 ADR 결정 사항이며 v1 범위 밖이다([`adr-001-direct-agent-runtime.md`](adr-001-direct-agent-runtime.md), [13](13-risks-open-questions.md) "tokio 도입 여부").

---

## 8. Allowlist 검증 (provider별, 신규 강화 지점)

PTY는 frontend가 임의 shell 문자열을 `pty_spawn`에 넘기고 backend에 executable allowlist가 **없다**(research §6, §10 권고 6). direct runtime은 이를 의도적으로 강화한다: renderer가 임의 executable/shell string을 넘길 수 없게 backend가 provider별로 검증한다(07 기존 계약, 15 §8.1 주석).

### 8.1 검증 규칙

`AgentRuntimeStartParams::JsonrpcStdio { provider, command, args, .. }`에 대해:

1. **provider enum 검증**: `provider`는 `"codex"` 또는 `"claude"`만 허용. 그 외는 `Err`.
2. **executable allowlist**: `command`의 basename이 provider별 화이트리스트에 있어야 한다.
   - `codex` → `{"codex"}` (+ 후속에 절대경로 변형 허용 여부 결정)
   - `claude` → `{"node"}` 1차 정본. Claude ACP를 `node`(절대경로) + adapterEntryPath(06 §2.2 1차 권고)로 직접 실행한다. `npx`는 1차에서 제거하고 후속(optional)으로만 검토한다. 정확한 launch executable은 [`06-claude-acp-adapter.md`](06-claude-acp-adapter.md)·ref-claude-agent-acp §2가 권위.
3. **args 검증**: shell 메타문자(`;`, `|`, `&`, `` ` ``, `$(`, `>`, `<`, 개행) 포함 args 거부 — `wsl.exe -e`는 shell을 거치지 않지만(executable + argv 직접 실행, research §2.2와 동일 원칙) 방어적으로 검증. provider별 허용 flag prefix(예: codex `--`, claude `--acp`)만 통과시키는 화이트리스트가 더 안전(결정 필요).
4. **command/args 출처**: adapter가 생성한 검증된 값만 허용. frontend가 자유 입력을 넣는 경로를 차단(§0).

```rust
const CODEX_ALLOWED_EXE: &[&str] = &["codex"];
// 1차 정본: node(절대경로) + adapterEntryPath만 허용(06 §2.2). npx는 후속(optional).
const CLAUDE_ALLOWED_EXE: &[&str] = &["node"];

fn validate_and_extract(params: &AgentRuntimeStartParams)
    -> Result<(String, String, String, String, Vec<String>, HashMap<String,String>), String>
{
    let AgentRuntimeStartParams::JsonrpcStdio { provider, distro, work_dir, command, args, env }
        = params else {
        return Err("only jsonrpc-stdio transport is supported in v1".into());
    };
    let allowed = match provider.as_str() {
        "codex" => CODEX_ALLOWED_EXE,
        "claude" => CLAUDE_ALLOWED_EXE,
        other => return Err(format!("unknown provider: {other}")),
    };
    let exe_base = command.rsplit('/').next().unwrap_or(command);
    if !allowed.contains(&exe_base) {
        return Err(format!("executable '{command}' not allowed for provider '{provider}'"));
    }
    for a in args {
        if a.chars().any(|c| matches!(c, ';' | '|' | '&' | '`' | '>' | '<' | '\n' | '\r'))
            || a.contains("$(")
        {
            return Err(format!("argument contains shell metacharacter: {a}"));
        }
    }
    if distro.trim().is_empty() { return Err("distro is required".into()); }
    Ok((provider.clone(), distro.clone(), work_dir.clone(), command.clone(),
        args.clone(), env.clone().unwrap_or_default()))
}
```

> allowlist 상수의 정확한 값(특히 Claude launch executable)은 [`06-claude-acp-adapter.md`](06-claude-acp-adapter.md)·[`05-codex-app-server-adapter.md`](05-codex-app-server-adapter.md)와 동기화해야 한다. distro 자체도 `list_wsl_distros`(wsl.rs:297) 결과 집합으로 검증할지 결정 필요([13](13-risks-open-questions.md) "distro allowlist 검증 여부").

---

## 9. WSL/Windows path 경계

07 기존 계약을 따른다. Windows backend가 `wsl.exe -d <distro> --cd <wslWorkDir> -e env … <exe> …`(§5.1 정본)로 WSL 안에서 provider process를 띄우고, cwd(`--cd`)·file path는 WSL path를 쓴다.

- **WSL absolute path 요구**: ACP는 absolute path를 요구한다(ref-acp, 15 §6 `StartSessionParams.workDir` 주석 "ACP는 absolute 필수"). adapter 입력 직전 canonicalize.
- **canonicalize 시점**: `start` core fn에서 spawn 직전 `canonicalize_wsl_path`(§5.1 흐름 step 3). relative path/`~`/Windows path가 들어오면 거부 또는 변환.

```rust
/// WSL absolute POSIX path 검증·정규화. Windows path·relative·~ 거부.
fn canonicalize_wsl_path(work_dir: &str) -> Result<String, String> {
    let p = work_dir.trim();
    if p.is_empty() { return Err("workDir is required".into()); }
    // Windows drive path 차단 (C:\ 등)
    if p.len() >= 2 && p.as_bytes()[1] == b':' {
        return Err(format!("expected WSL path, got Windows path: {p}"));
    }
    if !p.starts_with('/') {
        return Err(format!("workDir must be a WSL absolute path: {p}"));
    }
    // 중복 슬래시 정리, trailing slash 정리 등 가벼운 정규화(실제 fs canonicalize는
    // Windows에서 WSL fs에 접근 불가하므로 문자열 정규화에 한정)
    Ok(normalize_posix(p))
}
```

> **정규화 한계 (확인 필요)**: Windows backend는 WSL fs를 직접 stat할 수 없으므로(혹은 `\\wsl$\` 경유 가능성), symlink resolve 같은 진짜 canonicalize는 불가. 문자열 레벨 정규화(`//`→`/`, trailing `/` 제거, `.`/`..` 해소)에 한정하고, 실제 디렉터리 존재 검증은 `WslShell::exec`로 `test -d` 확인하는 옵션이 있다(wsl.rs 선례). 결정 필요 항목 [13](13-risks-open-questions.md) "WSL path 존재 검증 여부". Windows UI에 보여주는 file path 변환은 기존 `src/lib/features/editor/navigation/wsl-path-utils.ts`를 그대로 재사용(research §5.2).

---

## 10. test-mode mock 경로 (`is_test_mode()`)

PTY는 `is_test_mode()`가 true면 `PtyRuntime::Mock`을 만들어 실제 WSL 없이 배너/스트림을 흉내낸다(research §2.1, §8, terminal/mod.rs:290-353 `create_mock_session`). direct runtime도 **동일하게 1급 mock 경로**를 제공해야 E2E·단위 테스트가 WSL/실제 CLI 없이 돈다(research §10 권고 8).

### 10.1 mock 설계

`start_mock`은 실제 process 대신:
- `AgentRuntime`를 만들되 `child=None`, `stdin`은 in-memory sink(또는 mock writer).
- 별도 thread가 **provider별 가짜 JSON-RPC 응답 스트림**을 시간차로 `agent-runtime-message`로 emit한다(PTY `append_mock_output`의 delayed chunks 패턴, terminal/mod.rs:411-447).
- mock 스트림은 fixture에서 읽는다: `agent_runtime_start` params의 mock 힌트(예: `options.mockScenario`) 또는 fixture 파일.

```rust
fn start_mock(state: &AgentRuntimeState, app: &AppHandle, params: AgentRuntimeStartParams)
    -> Result<RuntimeId, String>
{
    let id = next_runtime_id(state)?;
    let runtime = build_mock_runtime(&params);
    insert_runtime(state, id, runtime)?;

    // 시나리오별 가짜 JSON-RPC 라인을 시간차 emit
    let app2 = app.clone();
    std::thread::spawn(move || {
        for (line, delay_ms) in mock_jsonrpc_script(&params) {
            std::thread::sleep(std::time::Duration::from_millis(delay_ms));
            let value: serde_json::Value = serde_json::from_str(&line).unwrap();
            let _ = app2.emit("agent-runtime-message",
                AgentRuntimeMessageEmit { type_: "message", runtime_id: id, message: value });
        }
        let _ = app2.emit("agent-runtime-exit",
            AgentRuntimeEvent::Exit { runtime_id: id, code: Some(0), signal: None });
    });
    Ok(id)
}
```

`mock_jsonrpc_script`는 provider별로 `initialize` 응답 → `session/new` 응답 → `session/update` notification 몇 개 → `session/prompt` 응답을 흉내낸 라인 시퀀스를 돌려준다. 정확한 wire shape는 ref-codex/ref-acp fixture를 따른다(05/06 adapter 테스트가 같은 fixture 공유 권고).

### 10.2 test fixture state 생성기

PTY `test_state_with_session`(terminal/mod.rs:45-83, `#[cfg(test)] pub(crate) fn`)처럼 mock runtime state 생성기를 `#[cfg(test)]`로 노출해 framing/snapshot 단위 테스트가 가능하게 한다(research §8.1).

```rust
#[cfg(test)]
pub(crate) fn test_state_with_runtime(provider: &str) -> (AgentRuntimeState, RuntimeId) { /* ... */ }
```

디스크 영속화가 얽히면 `crate::app_env::test_support::set_state_dir_env(&tmp)` guard 재사용(research §4.1, §8.1).

---

## 11. Logging / redaction

07 기존 계약:
- protocol message raw log는 **기본 비활성화**. debug 모드(예: `CLCOMX_AGENT_DEBUG_LOG` env)에서만 **redacted** raw log 저장.
- redaction 대상: API key, auth token, command env, file contents.
- stderr는 session diagnostic panel에서 **opt-in** 확인(§4.3).

```rust
/// 민감 정보 redaction. emit/log 직전 적용.
fn redact(s: &str) -> String {
    // 1) sk-/ghp_/Bearer 등 토큰 패턴 마스킹
    // 2) env에 등록된 비밀 값 마스킹
    // 3) 길이 제한(과도 로그 방지)
    // 구현은 09 §감사·redaction 정책과 동기화
    apply_redaction_rules(s)
}
```

- `agent_runtime_start`의 `env`(API key 등)는 로그·snapshot·persistence 어디에도 평문으로 남기지 않는다(10 §7.3 scrub 경계).
- raw protocol log 활성화 시에도 `redact`를 거친 라인만 파일에 쓴다. 저장 위치는 `app_env::state_path("agent-runtime-debug.log")`(research §4.1).

정책 정본은 [09](09-permissions-security.md)다. 이 절은 backend 구현 hook만 명시한다.

---

## 12. 구현 체크리스트 (다운스트림 에이전트용)

**모듈 골격**
- [ ] `features/agent_runtime/{mod,transport,process,types,tests}.rs` 생성, `mod.rs`에 서브모듈 선언.
- [ ] `commands/agent_runtime.rs` 5개 wrapper 작성, `commands/mod.rs`에 `pub mod` 추가.
- [ ] `lib.rs` 3곳(use / manage / generate_handler) 수정 (§2.2).

**타입 (15 §8 미러)**
- [ ] `types.rs`에 `RuntimeId`/`JsonRpcMessage`/`JsonRpcError`/`AgentRuntimeStartParams`/`AgentRuntimeCancelTarget`/`AgentRuntimeSnapshot`/`AgentRuntimeEvent` — 15 §8.2/§8.3 그대로, `#[serde(rename_all="camelCase")]`/`untagged`/`tag` 속성 일치.
- [ ] emit message payload는 `message: serde_json::Value`로 두어 round-trip 손실 제거(§4.2 note).

**transport**
- [ ] `decode_utf8_stream_chunk` 가시성 처리(§2 note) 후 newline framer 구현(§4.2).
- [ ] stdout reader / stderr reader / child wait thread 3개 (§4.2, §4.3, §5.3).
- [ ] invalid JSON / embedded newline 에러 분류 (§4.4).

**process**
- [ ] `spawn_wsl_process`(`wsl.exe -d -e`, piped stdio, CREATE_NO_WINDOW) (§5.1).
- [ ] launch 커맨드 정본(`wsl.exe -d <distro> --cd <wslWorkDir> -e env KEY=VAL … <exe> <argv>`, 셸 비경유)(§5.1).
- [ ] graceful shutdown(stdin drop → grace poll → kill) (§5.2).
- [ ] child wait/kill 동시성 정본 패턴: Child를 wait 전용 thread로 move + 저장한 pid/handle로 kill(§5.3, terminal/mod.rs 2-thread 선례).

**보안·경계**
- [ ] provider별 allowlist 검증(§8).
- [ ] WSL absolute path canonicalize(§9).
- [ ] redaction hook(§11), env 평문 미저장(10 §7.3).

**backpressure / late-attach**
- [ ] bounded message_log + trim + backpressure event(§7).
- [ ] (후속) message seq + delta-since command(§4.5).

**test**
- [ ] `is_test_mode()` mock 경로 + `mock_jsonrpc_script`(§10.1).
- [ ] `#[cfg(test)] test_state_with_runtime` 생성기(§10.2).
- [ ] tests.rs: framing(완성/미완성/UTF-8 경계/invalid JSON), shutdown grace, allowlist 거부, path 검증.

---

## 13. 수용 기준 (Acceptance Criteria)

| # | 기준 | 검증 방법 |
|---|---|---|
| AC-1 | `cargo check`/`cargo test --manifest-path src-tauri/Cargo.toml` 통과 | `npm run test:rust` |
| AC-2 | `agent_runtime_*` 5 command가 `generate_handler!`에 등록되어 invoke 가능 | E2E mock 시나리오에서 `invoke("agent_runtime_start", ...)` 성공 |
| AC-3 | newline framer가 multi-chunk·UTF-8 경계 분할 stdout에서 정확히 메시지 경계 복원 | tests.rs: 한 JSON을 byte 단위로 쪼개 reader에 주입, 1메시지로 복원 검증 |
| AC-4 | invalid JSON 라인이 `agent-runtime-error{recoverable:true}` emit, 5연속 시 `false` | tests.rs |
| AC-5 | `shutdown`이 stdin EOF → grace(2s) → kill 순으로 동작, 정상 종료 시 kill 미발생 | tests.rs(mock child) + 수동 확인 |
| AC-6 | process exit 시 `agent-runtime-exit` emit, frontend가 pending 정리 가능(04 §5) | E2E |
| AC-7 | allowlist 외 executable/shell 메타문자 args 거부(`Err`) | tests.rs(§8) |
| AC-8 | Windows path·relative path workDir 거부, WSL absolute만 통과 | tests.rs(§9) |
| AC-9 | `is_test_mode()`에서 실제 WSL 없이 mock JSON-RPC 스트림 emit | E2E mock 시나리오 |
| AC-10 | API key/token이 stderr 로그·snapshot·persistence에 평문 노출 안 됨 | redact 단위 테스트 + persistence scrub 테스트(10 §7.3) |
| AC-11 | 기존 PTY E2E(smoke/terminal-*) 회귀 없음(공존) | `scripts/run-e2e-project.mjs` |

---

## 14. 교차 참조

| 대상 | 문서 | 절 |
|---|---|---|
| backend 타입 정본(RuntimeId/JsonRpc*/AgentRuntime*/Event) | [`15-data-contracts.md`](15-data-contracts.md) | §8 |
| 상태 전이·approval cleanup·pending 정리 불변식 | [`04-normalized-agent-model.md`](04-normalized-agent-model.md) | §2, §4, §5 |
| Codex wire(initialize/cancel/approval) | [`ref-codex-app-server-protocol.md`](ref-codex-app-server-protocol.md) | §1, §4 |
| ACP wire(launch/cancel/permission) | [`ref-acp-protocol.md`](ref-acp-protocol.md) | §1, §3, §6 |
| Claude ACP launch executable·auth | [`ref-claude-agent-acp.md`](ref-claude-agent-acp.md) | §2, §3 |
| 코드 현실(PTY 해부·등록·scrub·allowlist·test) | [`research/codebase-backend.md`](research/codebase-backend.md) | §2, §3, §4, §5, §6, §7, §8, §9, §10 |
| Codex adapter(executable/initialize 시퀀스) | [`05-codex-app-server-adapter.md`](05-codex-app-server-adapter.md) | 전체 |
| Claude adapter(launch param/auth) | [`06-claude-acp-adapter.md`](06-claude-acp-adapter.md) | 전체 |
| permission·redaction·감사 정책 정본 | [`09-permissions-security.md`](09-permissions-security.md) | 전체 |
| persistence scrub 경계·migration | [`10-persistence-migration.md`](10-persistence-migration.md) | §7 |
| 위험·결정 필요 항목 | [`13-risks-open-questions.md`](13-risks-open-questions.md) | 전체 |
| sequence/state 다이어그램 | [`14-sequence-and-state.md`](14-sequence-and-state.md) | 전체 |

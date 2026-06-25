# Tauri Process Runtime

> 이 문서는 CLCOMX "Direct Agent Runtime"의 **Rust/Tauri backend process·transport 레이어** 설계 정본이다. 다운스트림 Rust 구현 에이전트가 이 문서만 읽고 `features/agent_runtime/` 모듈과 `commands/agent_runtime.rs`를 작성할 수 있도록, 파일 경로·구조체·함수 시그니처·의사코드·체크리스트·수용 기준을 담는다.
>
> **역할·권위 분리 (엄수)**:
> - **타입 정본은 [`15-data-contracts.md`](15-data-contracts.md) §8**이다. `RuntimeId`/`JsonRpcMessage`/`JsonRpcError`/`AgentRuntimeStartParams`/`AgentRuntimeCancelTarget`/`AgentRuntimeSnapshot`/`AgentRuntimeEvent`의 TS·Rust 정의는 거기 있고, 이 문서는 **재정의하지 않고 인용**한다. 이 문서에 나오는 Rust struct/enum은 15 §8.2/§8.3을 **미러**하는 참조이며, 충돌하면 15가 권위다.
> - **normalized model 규칙(상태 전이·approval cleanup·pending request 정리)은 [`04-normalized-agent-model.md`](04-normalized-agent-model.md)**가 권위다. backend는 protocol 의미를 해석하지 않지만(framing only), process exit·cancel 시 pending 정리의 *불변식*은 04 §4.2/§5를 따른다.
> - **wire 사실**은 protocol ref가 권위다: Codex는 [`ref-codex-app-server-protocol.md`](ref-codex-app-server-protocol.md), ACP는 [`ref-acp-protocol.md`](ref-acp-protocol.md), Claude 구현체는 [`ref-claude-agent-acp.md`](ref-claude-agent-acp.md).
> - **코드 현실**은 [`research/codebase-backend.md`](research/codebase-backend.md)가 권위다(§번호 인용).
>
> 조사 시점 정합 기준: commit `e7a5f9e`; 구현 전 현재 작업트리와 대조. backend 컨벤션 출처: `src-tauri/src/features/terminal/mod.rs`, `commands/wsl.rs`, `features/terminal/parsing.rs`, `lib.rs`, `app_env.rs`.

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
- provider별 allowlist 검증 (§8): command은 **renderer가 넘기지 않고 backend가 provider로 신뢰 절대경로를 resolve**(codex→resolve된 codex 절대경로, claude→resolve된 node 절대경로)하며, args(정확 일치)·env key(allowlist)를 재검증한다. 동명 바이너리(`/tmp/codex`, `/tmp/node`) 우회 불가.
- WSL/Windows path canonicalize (§9).
- graceful shutdown (stdin EOF → timeout → kill → child reap) — authoritative cleanup 경계: reap 후 반환, teardown은 최종 exit 반영 후, exit/shutdown pending 종료는 멱등·정확히 한 번 (§5.2, §5.3, 04 §5).
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

research/codebase-backend.md §9 표를 그대로 따른다. `commands/<x>.rs`는 얇은 wrapper, 로직·상태는 `features/<x>/`에 둔다(같은 문서 §3.1 컨벤션). 아래 `features/agent_runtime/{mod,transport,process,types,tests}.rs` 배치는 transport·process·types를 도메인 단위로 나눈 것으로, 파일/디렉토리 분리 규약([`17-coding-conventions.md`](17-coding-conventions.md) §A)을 따른다.

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

> 아래 struct/함수의 doc-comment는 rustdoc(`///`) 한글 보고서체 규약([`17-coding-conventions.md`](17-coding-conventions.md) §B)을 따른다. framing·shutdown·reconcile 등 핵심 로직에는 한 줄 한글 주석을 단다(17 §B.2).

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
    /// kill 전용 식별자. `ChildHandle` 자체는 상태에 보관하지 않고 wait 전용 thread가 소유한다
    /// (§5.3 정본; terminal/mod.rs 2-thread 선례). graceful shutdown/kill(§5.2)은 이 저장된
    /// pid/handle로만 OS kill을 호출하므로 wait thread의 `Child`와 lock 경쟁이 없다.
    /// Windows는 강제 종료에 process handle이 필요할 수 있어 `KillHandle`에 함께 담는다.
    kill_handle: KillHandle,
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

/// kill 전용 식별자(§5.2 강제 종료에서만 사용). `ChildHandle`은 wait thread가 소유하므로
/// 상태에는 OS-level kill에 필요한 최소 정보만 둔다(§5.3 정본 패턴).
/// pid만 담는 v1에서는 `Clone`(Windows handle 추가 시에도 Arc로 감싸 `Clone` 유지)이므로
/// wait thread로 `ChildHandle`을 move하기 전에 복제해 상태에 보관한다.
#[derive(Clone)]
struct KillHandle {
    /// spawn 시 `child.id()`로 얻은 OS pid. Unix는 이 pid로 signal kill.
    pid: u32,
    // Windows는 강제 종료에 process handle이 필요할 수 있다(예: OpenProcess/TerminateProcess
    // 또는 taskkill /PID). 구현 시 raw HANDLE 보관은 `unsafe`/`Send` 경계를 검토한다.
    // #[cfg(windows)] win_handle: ...,
}

#[derive(Default)]
pub struct AgentRuntimeState {
    runtimes: Mutex<HashMap<RuntimeId, AgentRuntime>>,
    next_id: Mutex<RuntimeId>,
}
```

`ChildHandle`은 §5.1에서 정의. `ChildHandle` 자체는 `AgentRuntime`에 보관하지 않고 wait 전용 thread가 소유하며(§5.3 정본), 상태에는 위 `KillHandle`(kill 전용 pid/handle)만 남긴다. `next_id`는 PTY `next_session_id`(research §2.1, terminal/mod.rs:237-242)와 동일하게 lock 후 `+= 1`로 발급:

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
        let mut framing_failed = false; // §4.4 latch: recoverable:false emit 후 true(이후 라인 drop)

        loop {
            match reader.read(&mut buf) {
                Ok(0) => {
                    // EOF: 마지막 flush(incomplete UTF-8 강제 디코드)
                    let tail = decode_utf8_stream_chunk(&mut pending_bytes, &[], true);
                    line_buf.push_str(&tail);
                    flush_complete_lines(&mut line_buf, /*final=*/true, &app, runtime_id,
                                         &message_log, &message_seq, &dropped_messages,
                                         &mut invalid_streak, &mut framing_failed);
                    break;
                }
                Ok(n) => {
                    let decoded = decode_utf8_stream_chunk(&mut pending_bytes, &buf[..n], false);
                    line_buf.push_str(&decoded);
                    flush_complete_lines(&mut line_buf, false, &app, runtime_id,
                                         &message_log, &message_seq, &dropped_messages,
                                         &mut invalid_streak, &mut framing_failed);
                }
                Err(_) => break,
            }
            if exited.load(Ordering::SeqCst) { break; }
            // §4.4 latch: framing 붕괴 후에는 read 자체는 계속하되(EOF/shutdown 감지를 위해)
            // 파싱·emit은 flush_complete_lines/handle_line 진입부에서 drop된다.
        }
    });
}

/// line_buf에서 '\n'으로 끝나는 완성 라인을 모두 뽑아 처리. 마지막 미완성 조각은 남긴다.
fn flush_complete_lines(line_buf: &mut String, is_final: bool, app: &AppHandle,
                        runtime_id: RuntimeId, message_log: &Arc<Mutex<VecDeque<RuntimeMessageRecord>>>,
                        message_seq: &Arc<AtomicU64>, dropped: &Arc<AtomicU64>,
                        invalid_streak: &mut u32, framing_failed: &mut bool) {
    loop {
        let Some(idx) = line_buf.find('\n') else { break; };
        let line: String = line_buf.drain(..=idx).collect();
        // §4.4 latch: framing 붕괴 후에는 라인을 경계로만 소거하고 파싱·emit하지 않는다(drop).
        if *framing_failed { continue; }
        let line = line.trim_end_matches(['\n', '\r']).to_string();
        if line.is_empty() { continue; }
        handle_line(line, app, runtime_id, message_log, message_seq, dropped, invalid_streak, framing_failed);
    }
    if is_final && !*framing_failed && !line_buf.trim().is_empty() {
        // EOF 후 남은 개행 없는 마지막 조각도 한 메시지로 시도(latch면 시도 안 함)
        let line = std::mem::take(line_buf).trim().to_string();
        handle_line(line, app, runtime_id, message_log, message_seq, dropped, invalid_streak, framing_failed);
    }
}

fn handle_line(line: String, app: &AppHandle, runtime_id: RuntimeId,
               message_log: &Arc<Mutex<VecDeque<RuntimeMessageRecord>>>,
               message_seq: &Arc<AtomicU64>, dropped: &Arc<AtomicU64>,
               invalid_streak: &mut u32, framing_failed: &mut bool) {
    // §4.4 latch: 이미 framing 붕괴를 한 번 알렸으면 추가 파싱·emit·에러 suppress(명시적 shutdown 대기).
    if *framing_failed { return; }
    match serde_json::from_str::<serde_json::Value>(&line) {
        Ok(value) => {
            *invalid_streak = 0; // latch 진입 전에만 유효(진입 후엔 위 가드로 도달 안 함)
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
            // §4.4 latch 진입: recoverable:false를 올린 직후 latch를 set한다.
            // 이후 라인은 flush_complete_lines/handle_line 진입부에서 drop되어
            // 추가 framing 에러가 frontend로 중복 emit되지 않는다(명시적 shutdown까지 유지).
            if !recoverable {
                *framing_failed = true;
            }
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

**latched-failed 규칙 (정본 — framing 붕괴 후 reader 상태)**: `recoverable:false`(framing 붕괴: 5회 연속 invalid 또는 embedded newline)를 **한 번 emit한 뒤에는 reader thread를 latched-failed 상태로 전환**한다. latch 진입 후 reader는 **이후 stdout 라인을 모두 drop(파싱·emit 안 함)하고 추가 framing 에러를 suppress**한다 — 즉 `recoverable:false`는 runtime당 정확히 한 번만 올라가고, 깨진 framing에서 쏟아지는 후속 invalid 라인이 frontend를 추가 에러로 도배하지 않는다. latch는 frontend의 **명시적 shutdown(§5.2)** 까지 유지되며(그 시점에 stdin EOF→kill→exit로 reader가 EOF로 종료), backend는 자동 kill하지 않는다. 이 latch가 없으면 backend는 라인을 계속 파싱·재시도하나 frontend는 이미 세션을 `failed`로 본 상태라 둘이 어긋난다 — latch로 "framing 붕괴 후 backend도 새 메시지를 올리지 않는다"는 불변식을 맞춘다.

§4.2 의사코드와의 정합: `handle_line`/reader는 latch 플래그(예: `AtomicBool` `framing_failed` 또는 reader thread 로컬 `bool`)를 둔다. valid 라인에서 `invalid_streak=0`으로 리셋하는 것은 **latch 진입 전에만** 유효하고, latch 진입 후에는 valid/invalid 구분 없이 라인을 drop한다(리셋·재진입 없음). `recoverable:false`를 emit하는 분기(5연속 invalid 도달, embedded newline 감지)에서 이 latch 플래그를 set하고, 이후 `flush_complete_lines`/`handle_line` 진입부에서 latch가 set이면 즉시 return한다. 결정 필요 항목(latch 플래그를 reader-local로 둘지 `AgentRuntime` 공유 상태로 노출해 snapshot에 반영할지)은 [13](13-risks-open-questions.md) "framing 붕괴 latch 노출 범위" 참조.

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
///
/// **secret env 금지 (C1 보안 경계, §5.1 note)**: `non_secret_env`로 들어오는 `-e env KEY=VAL`
/// argv는 **non-secret 전용**이다(비민감 플래그 등). API key / OAuth token / gateway header /
/// session cookie 등 secret은 argv로 절대 넘기지 않는다 — argv는 OS 관측면(ps,
/// /proc/<pid>/cmdline, WSL process 목록)에 평문 노출되어 redaction(§11)으로 막을 수 없다.
/// secret이 필요한 경우 `Command::env()` + `WSLENV` passthrough로 전달한다(아래 §5.1 note).
pub fn spawn_wsl_process(
    distro: &str,
    executable: &str,
    argv: &[String],
    work_dir: &str,                 // WSL absolute path (§9 canonicalize 완료)
    non_secret_env: &std::collections::HashMap<String, String>,  // C1: non-secret 전용
    secret_env: &std::collections::HashMap<String, String>,      // C1: argv 비경유, Command::env()+WSLENV
) -> Result<(ChildHandle, ChildStdio), String> {
    let mut cmd = Command::new("wsl.exe");
    // -d <distro> --cd <wslWorkDir>: cwd를 WSL 내부 경로로 직접 설정(OQ-27 해소).
    cmd.arg("-d").arg(distro).arg("--cd").arg(work_dir);
    // -e env KEY=VAL ... <executable> <argv...>:
    //   로그인 셸(`bash -lic …`)을 거치지 않고 WSL 실제 `env` 바이너리로 환경변수를 주입한 뒤
    //   executable을 직접 exec한다(OQ-28 해소). 셸을 끼지 않으므로 rc 파일 stdout 오염이 없다.
    //   주의(C1): 여기에 들어가는 env는 **non-secret 전용**이다(argv 노출).
    cmd.arg("-e").arg("env");
    for (k, v) in non_secret_env {
        // KEY=VALUE 형태. `env` 바이너리에 직접 전달되므로 셸 메타문자 해석/확장이 없다.
        // non-secret만 허용 — secret은 아래 Command::env()+WSLENV 경로로만 전달한다.
        cmd.arg(format!("{k}={v}"));
    }
    cmd.arg(executable);
    for a in argv {
        cmd.arg(a);
    }
    // C1 secret env 정본: argv 비경유. wsl.exe 프로세스 환경에 secret을 설정하고
    // WSLENV로 WSL 측에 passthrough한다(예: WSLENV=ANTHROPIC_API_KEY/u).
    // 이렇게 하면 secret 값이 ps/cmdline/process 목록에 평문으로 남지 않는다.
    if !secret_env.is_empty() {
        for (k, v) in secret_env {
            cmd.env(k, v); // wsl.exe 프로세스 환경(argv 아님)
        }
        let passthrough = secret_env.keys().map(|k| format!("{k}/u")).collect::<Vec<_>>().join(":");
        // 기존 WSLENV가 있으면 보존하며 append(여기서는 단순화).
        cmd.env("WSLENV", passthrough);
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
> - **env = `-e env KEY=VAL` 바이너리 주입 (OQ-28 해소, non-secret 전용)**: PTY는 셸 스크립트 prefix(`<env>claude`, research §6)로 export했지만, direct runtime은 WSL 실제 `env` 바이너리에 `KEY=VALUE`를 직접 인자로 넘긴다. `env`는 WSL 내부 실제 바이너리이므로 셸 메타문자 해석/확장 없이 환경변수를 주입하고 그 자리에서 `<executable>`을 exec한다. 즉 06 §2.3가 우려한 `bash -lic … exec <node> <entry>` 형태의 **bash rc stdout 오염**(rc 파일이 stdout으로 무언가를 출력해 JSON-RPC framing을 깨뜨림)이 **셸 비경유로 원천 해소**된다(06 §2.3와 일치). 단 이 `-e env KEY=VAL` argv 경로는 **non-secret env 전용**이다(C1 보안 경계, 아래 별도 항목).
> - **secret env는 argv 비경유 — `Command::env()` + `WSLENV` passthrough (C1 정본, OQ-28 보안 갱신)**: secret(API key / OAuth token / gateway header / session cookie 등)을 `-e env KEY=VAL` argv로 넘기면 OS 관측면(`ps`, `/proc/<pid>/cmdline`, WSL process 목록)에 **평문 노출**되어 §11 redaction으로 막을 수 없다. 따라서 launch 커맨드의 `-e env KEY=VAL …` argv 형태는 **non-secret env 전용**(비민감 플래그 등)으로 한정하고, secret env는 절대 argv에 싣지 않는다.
>   - **v1 기본값 (정본)**: provider 인증은 각 CLI의 WSL 측 자체 로그인/config(`claude login`, `codex auth`)에 의존하고, CLCOMX는 **secret env를 런타임으로 넘기지 않는다**(secret env 미전달이 기본).
>   - **secret env를 꼭 넘겨야 하는 경우(gateway 등)의 정본 메커니즘**: Rust `std::process::Command::env()`로 `wsl.exe` 프로세스 환경에 secret을 설정하고, `WSLENV`(예: `WSLENV=ANTHROPIC_API_KEY/u`)로 WSL 측에 passthrough한다. argv를 경유하지 않으므로 process 목록에 평문이 남지 않는다(§5.1 `spawn_wsl_process`의 `secret_env` 경로).
>   - `AgentRuntimeStartParams.env`(15 §8.1)는 이 결정에 따라 **non-secret 전용 규약**이다(15 §8.1 타입 자체는 재정의하지 않고 07/09를 인용; 신뢰 경계 정본은 [09](09-permissions-security.md)). 관련 OQ-28은 이 결정으로 해소된다([13](13-risks-open-questions.md)).
> - **API key/token은 §11 redaction 대상이고 평문 영속화 금지**(10 §7.3 보안 경계). secret은 argv·로그·snapshot·persistence 어디에도 평문으로 남기지 않는다.
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
    // 2) allowlist 검증 (§8) — provider별 executable/args 화이트리스트.
    //    env는 non-secret 전용(C1). secret env는 별도 secret 채널로만 들어온다(아래 note).
    let (provider, distro, work_dir, executable, argv, non_secret_env, secret_env) =
        validate_and_extract(&params)?;
    // 3) path canonicalize (§9)
    let work_dir = canonicalize_wsl_path(&work_dir)?;
    // 4) spawn — non-secret은 argv(`-e env`), secret은 Command::env()+WSLENV(C1)
    let (child, stdio) =
        spawn_wsl_process(&distro, &executable, &argv, &work_dir, &non_secret_env, &secret_env)?;
    // 5) RuntimeId 발급 + AgentRuntime 구성 + HashMap insert
    let id = next_runtime_id(state)?;
    // kill 전용 식별자만 상태에 남긴다(§3 kill_handle). ChildHandle은 아래 wait thread로 move(소유).
    let kill_handle = KillHandle { pid: child.pid /* , #[cfg(windows)] win_handle: ... */ };
    let runtime = build_runtime(provider, kill_handle, &stdio); // stdin handle·kill_handle 보관 등
    // 6) reader/stderr/child-wait thread 3개 spawn (§4.2, §4.3, §5.3)
    spawn_stdout_reader(app.clone(), id, stdio.stdout, /* ... */);
    spawn_stderr_reader(app.clone(), id, stdio.stderr);
    spawn_child_wait(app.clone(), id, child, /* exited flag, exited_at, status */); // child(ChildHandle) move
    // 7) status = "running" (process는 떴음; protocol initialize는 frontend adapter가 별도로 함)
    insert_runtime(state, id, runtime)?;
    Ok(id)
}
```

> **process start ≠ protocol initialize (정본)**: `agent_runtime_start`는 process를 띄우고 status를 `"running"`(backend transport 관점)으로만 둔다. normalized 세션 상태(15 §2)의 `starting`→`ready` 전이(initialize/session 생성 완료)는 **frontend adapter**가 `agent_runtime_send`로 initialize를 보내고 응답을 받아 합성한다(04 §2.1 규칙 1). backend `AgentRuntimeSnapshot.status`(15 §8.1: `starting`/`running`/`exited`/`failed`)는 transport-level 상태이지 normalized session status가 아니다 — 둘을 혼동하지 말 것.

### 5.2 graceful shutdown (정본 — authoritative cleanup 경계)

PTY는 `HashMap::remove` + Drop에 의존하지만(research §2.4, §10 권고 5), direct runtime은 protocol상 graceful shutdown이 필요하다. **S3 정본: `agent_runtime_shutdown`을 authoritative cleanup 경계로 정의한다.** backend shutdown은 graceful stdin close → timeout → kill → **child reap(`wait` 완료)** 까지 끝낸 뒤 반환하며, runtime teardown(HashMap 제거)은 **최종 exit이 반영·계상된 후에만** 일어난다. 늦은 exit으로 pending 종료가 누락되지 않도록, exit·shutdown 어느 경로로 트리거되든 pending 종료는 **멱등하며 정확히 한 번** 수행된다(아래 §5.3 정본 + 04 §5 규칙 인용).

순서:

```text
shutdown(runtime_id):
  1. stdin handle을 drop하여 EOF 신호 (provider가 stdin EOF에 정상 종료하도록)
  2. child.wait는 spawn_child_wait thread가 이미 감시 중 (§5.3); 이 thread가 reap + exit event를 책임진다
  3. SHUTDOWN_GRACE_MS(예: 2000ms) 동안 exited 플래그 polling
  4. 여전히 살아있으면 저장된 pid/handle로 강제 종료(kill) (§5.3 정본 패턴)
  5. child reap 보장: exited 플래그가 set될 때까지(=wait thread가 reap + exit event emit 완료) 대기 후 반환.
     teardown(HashMap 제거)은 이 최종 exit 반영 이후에만 수행한다 — 늦은 exit가 pending 정리를
     누락시키지 않도록 reap 후 반환이 정본이다.
  6. exit/shutdown으로 인한 pending 종료는 멱등·정확히 한 번이다(§5.3, 04 §5). backend는 exit event를
     올릴 뿐이고, 실제 pending approval cancelled/ pending RPC reject는 frontend adapter가 04 §5 규칙에
     따라 정확히 한 번 수행한다(§6.4, 05/06 adapter shutdown이 unlisten/세션 삭제 *전에* pending을 닫는다).
```

```rust
pub fn shutdown(state: &AgentRuntimeState, runtime_id: RuntimeId) -> Result<(), String> {
    const SHUTDOWN_GRACE_MS: u64 = 2000;
    const POLL_MS: u64 = 50;
    const REAP_GRACE_MS: u64 = 1000; // S3: kill 후 wait thread reap 반영 대기 상한

    // kill_handle은 kill 전용 식별자(pid/handle)다. ChildHandle 자체는 wait thread가 소유하므로
    // 여기서 Child를 다시 잠그지 않는다(§3·§5.3 정본).
    let (stdin, kill_handle, exited) = {
        let mut runtimes = state.runtimes.lock().map_err(|e| e.to_string())?;
        let rt = runtimes.get(&runtime_id).ok_or("runtime not found")?;
        (rt.stdin.clone(), rt.kill_handle.clone(), rt.exited.clone())
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
        // 강제 종료는 spawn 시 저장해 둔 OS pid/handle(kill_handle)로 수행한다(wait thread와 lock 경쟁 없음).
        kill_by_stored_pid(&kill_handle); // 저장된 pid/handle로 OS kill (deadlock 회피, §5.3 note)
    }

    // 5) S3: child reap 보장 — kill 후 wait thread가 reap + exit event emit을 끝내(exited=true)도록
    //    최종 exit이 반영될 때까지 짧게 대기한 뒤 반환한다. teardown은 그 이후에만 한다.
    let mut reap_waited = 0u64;
    while !exited.load(Ordering::SeqCst) && reap_waited < REAP_GRACE_MS {
        std::thread::sleep(std::time::Duration::from_millis(POLL_MS));
        reap_waited += POLL_MS;
    }

    // 6) teardown — reap 확인 후에만 HashMap 제거·Ok 반환. REAP_GRACE_MS 내 reap 실패(exited=false)면
    //    runtime을 제거하지 않고 Err를 반환한다(teardown이 늦은 exit 계상보다 앞서는 것을 금지, S3 정본).
    //    exit/shutdown pending 종료는 멱등·정확히 한 번(04 §5): backend는 exit event를 한 번만 올리고,
    //    frontend adapter가 pending을 정확히 한 번 닫는다.
    if !exited.load(Ordering::SeqCst) {
        return Err("shutdown: child not reaped within REAP_GRACE_MS".into());
    }
    state.runtimes.lock().map_err(|e| e.to_string())?.remove(&runtime_id);
    Ok(())
}
```

> `std::thread::sleep` polling은 PTY child-wait thread의 200ms sleep(research §2.2, terminal/mod.rs:498)과 동일한 std-thread 컨벤션이다. tokio timeout을 쓰지 않는다(§7.4).

### 5.3 child wait thread + exit event

PTY thread1(child wait, terminal/mod.rs:491-502)을 본뜬다. 이 thread가 **child reap(`child.wait()`)의 단일 책임자**다 — `child.wait()`가 반환하면 `exited.store(true)` + `exited_at`/`status` 기록 + `agent-runtime-exit`를 **정확히 한 번** emit한다. shutdown(§5.2)의 kill도 이 thread의 wait를 풀어 reap을 완료시키며, shutdown은 이 `exited` 플래그를 보고 reap 완료를 확인한 뒤 teardown한다(S3 reap-후-반환).

**S3 정본 (exit/shutdown pending 종료는 멱등·정확히 한 번)**: `agent-runtime-exit`은 exit 경로와 shutdown 경로가 동시에 트리거되어도 **정확히 한 번만** emit된다(`exited` 플래그로 이중 emit 차단). **process exit은 모든 pending request(approval 포함)를 실패로 닫는다** — 단, backend는 frontend에 exit event를 알릴 뿐이고, 실제 pending 정리는 frontend adapter가 04 §5 규칙에 따라 **멱등하게 정확히 한 번** 수행한다: **process exit 경로**(process 사망)에서는 pending approval을 `failed`(client 내부 전용, wire 미전송)로, **shutdown 경로**(process 살아 있음)에서는 `cancelled`(wire 전송)로 닫고(04 §4.2·§5.0), 두 경로 모두 pending RPC를 로컬에서 failed로 reject한 **뒤에** listener 해제·세션 삭제를 한다(05/06 adapter shutdown 순서; unlisten/삭제가 pending 종료보다 앞서면 늦은 exit로 pending이 누락된다). 이중 종료·누락 없이 정확히 한 번이라는 불변식의 정본은 04 §5다.

```rust
fn spawn_child_wait(
    app: AppHandle, runtime_id: RuntimeId,
    mut child: ChildHandle,                 // Child를 이 wait 전용 thread로 move(소유) — wait 중 Mutex 미보유
    exited: Arc<AtomicBool>, exited_at: Arc<Mutex<Option<i64>>>,
    status: Arc<Mutex<String>>,
) {
    std::thread::spawn(move || {
        // 정본 패턴: Child는 이 thread가 소유하므로 blocking wait 중 어떤 Mutex도 잡지 않는다.
        // kill은 §5.2가 별도로 저장한 OS pid/handle로 수행한다(이 thread와 lock 경쟁 없음;
        // terminal/mod.rs Thread 1 선례).
        let exit_status = child.child.wait(); // reap: 이 thread가 child를 거둔다(zombie 방지)
        // S3: exit event는 정확히 한 번. compare_exchange로 최초 1회만 통과시켜
        // exit/shutdown 동시 트리거 시 이중 emit을 막는다.
        let first = exited
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .is_ok();
        if !first { return; } // 이미 종료 반영됨 — 멱등 무시
        *exited_at.lock().unwrap() = Some(now_millis());
        *status.lock().unwrap() = "exited".to_string();

        let (code, signal) = match exit_status {
            Ok(st) => (st.code(), unix_signal(&st)),
            Err(_) => (None, None),
        };
        let _ = app.emit("agent-runtime-exit",
            AgentRuntimeEvent::Exit { runtime_id, code, signal });
    });
}
```

> **child wait/kill 동시성 — 정본 패턴**: `child.wait()`는 blocking이고 `&mut`가 필요하다. `Mutex` lock을 wait 내내 잡으면 `kill()`(§5.2)이 같은 lock을 기다리다 deadlock한다.
>
> **정본 패턴**: spawn 직후 `Child`(`ChildHandle`)를 **wait 전용 thread로 `move`**하고, 그 thread가 소유권으로 `child.wait()`를 호출한다(blocking wait 중 Mutex 미보유). `ChildHandle` 자체는 `AgentRuntime`에 **보관하지 않는다**(§3에서 `child` 필드 제거). `kill`은 spawn 시점에 **저장해 둔 kill 전용 식별자(`KillHandle`)**로 수행한다 — `ChildHandle.pid`(§5.1, Windows는 `child.id()`로 얻은 PID, Unix는 동일)를 `move` 전에 `KillHandle`로 복제해 `AgentRuntime.kill_handle`(§3)에 보관하고, §5.2의 강제 종료 `kill_by_stored_pid(&KillHandle)`는 이 저장된 pid/handle로 OS kill을 호출한다(wait thread가 가진 `Child`를 다시 잠그지 않는다 — `Arc<Mutex<Option<ChildHandle>>>` 같은 공유 슬롯이 없으므로 move-후-None 모순이 발생하지 않는다). 이는 `terminal/mod.rs`의 **2-thread 선례**(Thread 1이 `child`를 move해 `child.wait()`만 하고, kill은 `portable_pty`의 killer handle로 분리; terminal/mod.rs:491-502)와 동형이다. PTY는 child를 reader/wait가 공유하지 않아 이 문제가 없었고, direct runtime도 동일하게 wait 소유권과 kill 경로를 분리해 회피한다.
>
> 위 `spawn_child_wait` 의사코드는 `Child`(`ChildHandle`)를 wait 전용 thread로 **move**해 소유하므로 blocking wait 중 어떤 lock도 잡지 않는다(forbidden한 wait-중-lock 패턴을 보이지 않는다). kill용 pid/handle만 `AgentRuntime`에 남긴다(§5.2). 구현 시 wait-중-kill deadlock 미발생을 반드시 테스트한다(§13 AC-5).

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

**cancel wire 전송 주체 정본**: backend는 protocol cancel 메시지를 **만들지 않는다**(provider별 cancel wire가 다름 — Codex `turn/interrupt`(ref-codex §3.2 `TurnInterruptParams {threadId, turnId}`), ACP `session/cancel`; adapter가 안다). turn/request cancel은 **frontend adapter가 `agentRuntimeSend`로 직접 wire를 보내고**, backend `agent_runtime_cancel`은 `{type:"process"}`만 처리한다. cancel cleanup 순서(pending approval을 먼저 `closing`으로 표시 → approval에 cancelled 응답 wire 전송 + `approval_resolved{outcome:"cancelled"}` emit → provider turn cancel 전송 → 늦은 응답 멱등 무시)의 **규칙 정본은 04 §4.2**이고, 시퀀스는 14 §5다. backend Transport는 이 순서에 관여하지 않고 adapter가 보내는 wire를 framing만 한다(C4). 따라서:

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

PTY는 frontend가 임의 shell 문자열을 `pty_spawn`에 넘기고 backend에 executable allowlist가 **없다**(research §6, §10 권고 6). direct runtime은 이를 의도적으로 강화한다: renderer를 untrusted로 간주하고, **renderer/adapter는 실행 파일 command를 아예 넘기지 않으며**, backend가 provider로 **신뢰 절대경로(executable)를 직접 resolve**한 뒤 **args(정확 일치)·env key(allowlist)**를 재검증한다(S1 정본; R4 정본; 15 §8.1 주석, 신뢰 경계 정본은 [09](09-permissions-security.md)). basename만 비교하던 1차 안은 폐지하고, command 자체를 renderer 비제어로 만든다 — 동명 바이너리(`/tmp/codex`, `/tmp/node` 등) 우회를 원천 차단한다.

> **S1 정본 (renderer 비제어 command)**: `AgentRuntimeStartParams::JsonrpcStdio`에서 **`command` 필드는 제거**되었다(15 §8.1). adapter는 `provider`·`distro`·`work_dir`·`args`(검증 대상)·`env`(non-secret)만 넘긴다. backend는 `provider`로 신뢰 절대경로를 resolve한다: `codex` → resolve된 `codex` app-server 절대경로, `claude` → resolve된 `node` 절대경로. resolve 주체·캐시 무효화·`adapterEntryPath` 탐색 방식은 [13](13-risks-open-questions.md) "command/entry resolve 주체" 결정 필요 항목이다.

### 8.1 검증 규칙

`AgentRuntimeStartParams::JsonrpcStdio { provider, distro, work_dir, args, env }`에 대해 (S1 정본 — command는 renderer가 넘기지 않고 backend가 provider로 resolve; basename 비교 제거, 절대경로·정확 args·env key allowlist로 강화):

1. **provider enum 검증**: `provider`는 `"codex"` 또는 `"claude"`만 허용. 그 외는 `Err`.
2. **executable = backend가 provider로 resolve한 신뢰 절대경로 (S1; command 파라미터 비수신)**: backend는 **renderer가 넘긴 command를 받지 않는다**(필드 자체가 제거됨, 15 §8.1). 대신 `provider`로 executable을 직접 resolve한다 — (a) **backend가 resolve한 신뢰 절대경로**(예: `which codex` / `node` resolve 결과를 backend가 직접 구해 캐시; 06 §2.2 node/entry resolve 방식 3) 또는 (b) **사전 등록된 절대경로 화이트리스트**에서 가져온다. resolve 결과는 항상 절대경로(`/`로 시작)이며, 임의 디렉터리의 동명 바이너리(`/tmp/codex`, `/tmp/node` 등)는 renderer가 지정할 경로 자체가 없으므로 우회 불가다.
   - `codex` → backend가 신뢰 절대경로로 resolve한 `codex` app-server 바이너리. 셸 비경유 직접 실행 `wsl.exe -d <distro> --cd <wslWorkDir> -e env … <codexAbsPath> app-server --stdio`로 띄운다(05가 이 형태를 따른다, ref-codex §1.1: app-server 기본 stdio, 전역 experimental 플래그 불필요).
   - `claude` → backend가 신뢰 절대경로로 resolve한 `node`. **1차 argv 검증의 핵심은 `args[0]` = backend가 검증한 `adapterEntryPath`(절대경로) 일치**다(아래 3-claude). `adapterEntryPath`는 renderer 자유 입력이 아니라 backend가 고정 npm 의존 위치(`claude-agent-acp` `dist/index.js`)에서 resolve하거나 사전 등록된 절대경로다. `npx`는 1차에서 제거하고 후속(optional)으로만 검토한다(06 §2.2 D9). 정확한 launch executable·entry resolve는 [`06-claude-acp-adapter.md`](06-claude-acp-adapter.md)·ref-acp §1·ref-claude-agent-acp §5가 권위.
3. **args 정확 검증 (provider별 exact match)**: shell 메타문자(`;`, `|`, `&`, `` ` ``, `$(`, `>`, `<`, 개행) 검사는 방어용으로 유지하되, 1차 게이트는 **provider별 정확 일치**다.
   - `codex` → `args`가 **정확히** `["app-server", "--stdio"]`일 것(ref-codex §1.1). 그 외 길이/값은 거부.
   - `claude` → `args.length == 1` 이고 `args[0]`이 **backend가 검증한 `adapterEntryPath`(WSL 절대경로, `claude-agent-acp` `dist/index.js` 패턴)**일 것. 임의 `.js`·임의 바이너리·복수 인자는 거부(06 §2.2: bin은 `dist/index.js` 하나, args = `[adapterEntryPath]`). **이 `adapterEntryPath` 절대경로 검증이 Claude의 1차 argv 검증이다** — executable(node)은 backend가 provider로 resolve한 신뢰 절대경로로 고정되고, `adapterEntryPath`도 backend가 고정 npm 의존 위치에서 resolve(또는 사전 등록)하므로, renderer는 실행 대상 어느 쪽도 제어하지 못한다. backend는 `args[0]`이 그 신뢰 출처와 정확히 일치하는지 재검증한다.
4. **executable·args 출처 (S1)**: executable은 renderer가 넘기지 않고 backend가 provider로 resolve한다(위 2). `args`는 adapter가 생성한 검증된 값만 허용하되 backend가 provider별 정확 일치로 재검증한다. frontend가 executable 경로 또는 임의 argv를 자유 입력으로 주입하는 경로를 차단(§0). renderer는 untrusted로 간주하며, backend는 resolve된 executable(절대경로)·args(정확 일치)·env key를 재검증한다(09 위협모델, 11 테스트).
5. **env key allowlist + non-secret 값 (C1)**: `env` 각 key는 `^[A-Za-z_][A-Za-z0-9_]*$`(POSIX env 이름 규칙)를 만족하고 **OQ-38에서 확정한 provider별 허용 key 집합**에 속해야 한다. 값은 **non-secret 전용**(§5.1 `-e env KEY=VAL` argv 경로). secret(API key/token/gateway header/cookie)은 이 argv 경로로 넘기지 않으며, 필요 시 `Command::env()`+`WSLENV` passthrough로만 전달한다(§5.1 note). v1 기본값은 secret env 미전달(provider 자체 WSL 인증 의존). shell 메타문자 검사는 값에 대한 방어용으로 유지한다.

```rust
// S1: executable은 renderer가 넘기지 않는다. backend가 provider로 신뢰 절대경로를 resolve한다.
//  - (a) backend가 resolve한 신뢰 절대경로(권고; 06 §2.2 resolve 방식 3 + 캐시), 또는
//  - (b) 사전 등록된 절대경로 화이트리스트.
// 반환값은 항상 절대경로(`/`로 시작)이며 신뢰 출처에서만 온다. renderer가 동명 바이너리
// (/tmp/codex, /tmp/node)를 지정할 경로가 애초에 없다(command 파라미터 비수신).
// resolve 주체·캐시 무효화는 13 "command/entry resolve 주체" 결정 필요.
fn resolve_trusted_executable(provider: &str) -> Result<String, String> {
    // codex  → resolve된 codex app-server 절대경로
    // claude → resolve된 node 절대경로
    // resolve 실패(미설치 등) 시 Err.
    trusted_executable_for(provider).ok_or_else(|| {
        format!("failed to resolve trusted executable for provider '{provider}'")
    })
}

// Claude adapterEntryPath: backend가 고정 npm 의존 위치(claude-agent-acp dist/index.js)에서
// resolve하거나 사전 등록한 신뢰 절대경로. args[0]이 이 값과 정확히 일치해야 통과.
fn is_trusted_adapter_entry_path(entry: &str) -> bool {
    entry.starts_with('/') && trusted_adapter_entry_set().contains(entry)
}

// Codex args 정본(ref-codex §1.1): 정확히 ["app-server", "--stdio"].
const CODEX_REQUIRED_ARGS: &[&str] = &["app-server", "--stdio"];

// provider별 env key allowlist. POSIX env 이름 규칙 + OQ-38에서 확정한 허용 key 집합.
// OQ-38 확정 전 T2.4 구현 금지. 값은 non-secret 전용, secret은 별도 채널 §5.1.
const CODEX_ALLOWED_ENV_KEYS: &[&str] = &[/* 05/09와 동기화: 비민감 플래그 key만 */];
const CLAUDE_ALLOWED_ENV_KEYS: &[&str] = &[/* 06/09와 동기화: 비민감 플래그 key만 */];

fn is_valid_env_key(key: &str) -> bool {
    // ^[A-Za-z_][A-Za-z0-9_]*$
    let mut chars = key.chars();
    match chars.next() {
        Some(c) if c == '_' || c.is_ascii_alphabetic() => {}
        _ => return false,
    }
    chars.all(|c| c == '_' || c.is_ascii_alphanumeric())
}

// 반환 tuple: (provider, distro, work_dir, executable, argv, non_secret_env, secret_env).
// S1: executable은 params에서 받지 않고 backend가 provider로 resolve한 신뢰 절대경로다.
// C1: env는 non-secret만 argv(`-e env`)로 흐른다. secret_env는 Command::env()+WSLENV 경로(§5.1).
// v1 기본값은 secret_env 빈 맵(provider 자체 WSL 인증 의존). AgentRuntimeStartParams.env(15 §8.1)는
// non-secret 전용 규약이므로 여기서는 전부 non_secret_env로 분류한다(secret 주입 경로는 별도 채널).
fn validate_and_extract(params: &AgentRuntimeStartParams)
    -> Result<(String, String, String, String, Vec<String>,
               HashMap<String,String>, HashMap<String,String>), String>
{
    // S1: command 필드는 제거되었다(15 §8.1). renderer는 executable을 넘기지 않는다.
    let AgentRuntimeStartParams::JsonrpcStdio { provider, distro, work_dir, args, env }
        = params else {
        return Err("only jsonrpc-stdio transport is supported in v1".into());
    };
    // 1) provider enum
    let allowed_env_keys: &[&str] = match provider.as_str() {
        "codex" => CODEX_ALLOWED_ENV_KEYS,
        "claude" => CLAUDE_ALLOWED_ENV_KEYS,
        other => return Err(format!("unknown provider: {other}")),
    };
    // 2) executable = backend가 provider로 resolve한 신뢰 절대경로 (S1; command 비수신)
    let executable = resolve_trusted_executable(provider)?;
    // 3) args 정확 검증 (provider별 exact match)
    match provider.as_str() {
        "codex" => {
            if args.as_slice() != CODEX_REQUIRED_ARGS {
                return Err(format!(
                    "codex args must be exactly {CODEX_REQUIRED_ARGS:?}, got {args:?}"
                ));
            }
        }
        "claude" => {
            // 1차 argv 검증: args.length == 1 && args[0] == 검증된 adapterEntryPath(절대경로).
            if args.len() != 1 {
                return Err(format!("claude args must be exactly [adapterEntryPath], got {args:?}"));
            }
            let entry = &args[0];
            // adapterEntryPath는 WSL 절대경로 + claude-agent-acp dist/index.js 패턴.
            // 신뢰 출처(backend resolve/사전 등록 화이트리스트)와 정확 일치해야 한다(06 §2.2).
            if !entry.starts_with('/') || !is_trusted_adapter_entry_path(entry) {
                return Err(format!("claude adapterEntryPath not trusted: {entry}"));
            }
        }
        _ => unreachable!("provider already validated"),
    }
    // 3b) shell 메타문자 방어(정확 검증 통과 후에도 잔여 방어용)
    for a in args {
        if a.chars().any(|c| matches!(c, ';' | '|' | '&' | '`' | '>' | '<' | '\n' | '\r'))
            || a.contains("$(")
        {
            return Err(format!("argument contains shell metacharacter: {a}"));
        }
    }
    if distro.trim().is_empty() { return Err("distro is required".into()); }
    // 5) env key allowlist + non-secret 값.
    //    key: ^[A-Za-z_][A-Za-z0-9_]*$ + provider별 허용 key 집합. 값: non-secret + 메타문자 방어.
    let env_map = env.clone().unwrap_or_default();
    for (k, v) in &env_map {
        if !is_valid_env_key(k) {
            return Err(format!("env key '{k}' violates ^[A-Za-z_][A-Za-z0-9_]*$"));
        }
        if !allowed_env_keys.contains(&k.as_str()) {
            return Err(format!("env key '{k}' not allowed for provider '{provider}'"));
        }
        if v.chars().any(|c| matches!(c, '`' | '\n' | '\r')) || v.contains("$(") {
            return Err(format!("env value for '{k}' contains shell metacharacter"));
        }
    }
    // C1: env(15 §8.1)는 non-secret 전용 규약 → 전부 non_secret_env로 분류.
    // secret_env는 빈 맵(v1 기본값: provider 자체 WSL 인증 의존). gateway 등 secret 주입이
    // 필요하면 별도 secret 채널에서 secret_env를 채워 Command::env()+WSLENV로 전달한다(§5.1).
    let non_secret_env = env_map;
    let secret_env: HashMap<String, String> = HashMap::new();
    // S1: executable은 위에서 backend가 resolve한 신뢰 절대경로(renderer 비제어).
    Ok((provider.clone(), distro.clone(), work_dir.clone(), executable,
        args.clone(), non_secret_env, secret_env))
}
```

> **executable/adapterEntryPath 신뢰 출처 (S1 정본)**: `resolve_trusted_executable`이 돌려주는 executable 절대경로와 `is_trusted_adapter_entry_path`가 비교하는 `adapterEntryPath`는 모두 **OQ-36에서 확정한 방식으로 backend가 resolve해 캐시한 값**(예: 06 §2.2 resolve 방식 3: `wsl.exe -e bash -lc "command -v node"` / `node -e require.resolve(...)` 1회 resolve 후 캐시) 또는 **사전 등록 절대경로 화이트리스트**에서 온다 — **renderer가 넘긴 command를 검증하는 게 아니라 backend가 직접 resolve**한다(command 필드 제거, 15 §8.1). 정확한 resolve 주체·캐시 무효화·`adapterEntryPath` 탐색 방식·distro 검증(`list_wsl_distros` wsl.rs:297 결과 집합) 여부와 `*_ALLOWED_ENV_KEYS` 정확 집합은 [`06-claude-acp-adapter.md`](06-claude-acp-adapter.md)·[`05-codex-app-server-adapter.md`](05-codex-app-server-adapter.md)·[`09-permissions-security.md`](09-permissions-security.md)와 동기화해야 한다(결정 필요 항목 [13](13-risks-open-questions.md) "command/entry resolve 주체", "distro allowlist 검증 여부", "provider env key allowlist 집합"). OQ-36/OQ-38 확정 전에는 T2.2/T2.4 구현을 시작하지 않는다.

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

- **secret env 경계 (C1)**: `agent_runtime_start`의 `env`(15 §8.1)는 **non-secret 전용 규약**이다(§5.1·§8.1). secret(API key/OAuth token/gateway header/session cookie)은 argv(`-e env KEY=VAL`)로 넘기지 않고, 필요 시 `Command::env()`+`WSLENV` passthrough로만 전달한다(§5.1 note) — argv 경유 시 OS 관측면(`ps`/`/proc/<pid>/cmdline`/WSL process 목록)에 평문 노출되어 redaction으로 막을 수 없기 때문이다. v1 기본값은 secret env 미전달(provider 자체 WSL 인증 의존). secret은 로그·snapshot·persistence 어디에도 평문으로 남기지 않는다(10 §7.3 scrub 경계, 신뢰 경계 정본은 [09](09-permissions-security.md)).
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
- [ ] framing 붕괴 latched-failed: `recoverable:false` 1회 emit 후 reader latch(이후 라인 drop, 추가 framing 에러 suppress), 명시적 shutdown까지 자동 kill 없음 (§4.4).

**process**
- [ ] `spawn_wsl_process`(`wsl.exe -d -e`, piped stdio, CREATE_NO_WINDOW) (§5.1).
- [ ] launch 커맨드 정본(`wsl.exe -d <distro> --cd <wslWorkDir> -e env KEY=VAL … <exe> <argv>`, 셸 비경유)(§5.1).
- [ ] C1 secret env 경계: `-e env KEY=VAL` argv는 non-secret 전용. secret은 `Command::env()`+`WSLENV` passthrough(argv 금지), v1 기본은 secret env 미전달(§5.1·§8.1·§11).
- [ ] graceful shutdown(stdin drop → grace poll → kill → child reap; reap 후 반환, teardown은 최종 exit 반영 후, exit/shutdown pending 종료 멱등·정확히 한 번) (§5.2, §5.3, 04 §5).
- [ ] child wait/kill 동시성 정본 패턴: `ChildHandle`은 상태에 보관하지 않고(§3 `child` 필드 제거, `kill_handle: KillHandle`로 교체) wait 전용 thread로 move + 저장한 `KillHandle`(pid/handle)로 kill(§3·§5.2·§5.3, terminal/mod.rs 2-thread 선례).

**보안·경계**
- [ ] provider별 allowlist 검증(§8, S1/R4): executable=**backend가 provider로 resolve한 신뢰 절대경로**(command 파라미터 비수신, basename 비교 폐지), args 정확 일치(Codex `["app-server","--stdio"]`, Claude `[backend가 검증한 adapterEntryPath]` 절대경로), env key allowlist(`^[A-Za-z_][A-Za-z0-9_]*$` + provider 허용 key) + 값 non-secret.
- [ ] WSL absolute path canonicalize(§9).
- [ ] redaction hook(§11), env 평문 미저장(10 §7.3).

**backpressure / late-attach**
- [ ] bounded message_log + trim + backpressure event(§7).
- [ ] (후속) message seq + delta-since command(§4.5).

**test**
- [ ] `is_test_mode()` mock 경로 + `mock_jsonrpc_script`(§10.1).
- [ ] `#[cfg(test)] test_state_with_runtime` 생성기(§10.2).
- [ ] tests.rs: framing(완성/미완성/UTF-8 경계/invalid JSON), framing 붕괴 후 latched-failed(§4.4: `recoverable:false` 1회·후속 라인 drop), shutdown grace, allowlist 거부, path 검증.

---

## 13. 수용 기준 (Acceptance Criteria)

| # | 기준 | 검증 방법 |
|---|---|---|
| AC-1 | `cargo check`/`cargo test --manifest-path src-tauri/Cargo.toml` 통과 | `npm run test:rust` |
| AC-2 | `agent_runtime_*` 5 command가 `generate_handler!`에 등록되어 invoke 가능 | E2E mock 시나리오에서 `invoke("agent_runtime_start", ...)` 성공 |
| AC-3 | newline framer가 multi-chunk·UTF-8 경계 분할 stdout에서 정확히 메시지 경계 복원 | tests.rs: 한 JSON을 byte 단위로 쪼개 reader에 주입, 1메시지로 복원 검증 |
| AC-4 | invalid JSON 라인이 `agent-runtime-error{recoverable:true}` emit, 5연속 시 `false` | tests.rs |
| AC-4b | `recoverable:false`(framing 붕괴) emit 후 latched-failed: `recoverable:false`는 runtime당 정확히 한 번만 emit되고, 이후 stdout 라인은 drop되어 추가 framing 에러를 올리지 않음(§4.4 latch). 명시적 shutdown까지 reader는 자동 kill하지 않음 | tests.rs: invalid 라인 다수를 주입해도 `recoverable:false` 1회·후속 라인 emit 0건 검증 |
| AC-5 | `shutdown`이 stdin EOF → grace(2s) → kill → **child reap** 순으로 동작, 정상 종료 시 kill 미발생, reap 완료(`exited`) 후 반환·teardown(S3) | tests.rs(mock child) + 수동 확인 |
| AC-6 | process exit 시 `agent-runtime-exit`가 **정확히 한 번** emit(exit/shutdown 동시 트리거에도 이중 emit 없음, S3), frontend가 pending을 멱등하게 한 번 정리 가능(04 §5) | E2E + tests.rs(compare_exchange exactly-once) |
| AC-7 | allowlist 검증(S1/R4) 거부: command는 renderer가 넘길 수 없고 backend가 provider로 resolve(executable resolve 실패 시 Err), Claude `args=[/tmp/x.js]`(신뢰 adapterEntryPath 아님) 거부, Codex args≠`["app-server","--stdio"]` 거부, Claude args≠`[검증된 adapterEntryPath]` 거부, env key allowlist 위반·`^[A-Za-z_][A-Za-z0-9_]*$` 위반 거부, shell 메타문자 args/값 거부. backend resolve된 executable·정확 args·허용 env key만 통과 | tests.rs(§8) |
| AC-8 | Windows path·relative path workDir 거부, WSL absolute만 통과 | tests.rs(§9) |
| AC-9 | `is_test_mode()`에서 실제 WSL 없이 mock JSON-RPC 스트림 emit | E2E mock 시나리오 |
| AC-10 | API key/token이 stderr 로그·snapshot·persistence에 평문 노출 안 됨 | redact 단위 테스트 + persistence scrub 테스트(10 §7.3) |
| AC-10b | secret env가 child argv(`-e env KEY=VAL`)에 실리지 않고 `Command::env()`+`WSLENV`로만 전달됨(C1). non-secret env만 argv 경유 | tests.rs: `spawn_wsl_process` argv 조립 검증(secret_env 키가 argv에 부재, WSLENV에 등재) |
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
| 파일 분리·rustdoc 한글 주석 규약 | [`17-coding-conventions.md`](17-coding-conventions.md) | §A, §B |

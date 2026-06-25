# Codebase Backend Research: Direct Agent Runtime

> **⚠️ 스냅샷 — 코드 현실의 *시점* 매핑**: 이 문서는 아래 git ref 시점의 backend 코드 구조를 박제한 조사 스냅샷이다. 코드가 바뀌면 낡을 수 있으므로 **충돌 시 실제 코드(`src-tauri/`)가 정본이고 이 문서가 아니다.** 인용된 경로·심볼·줄번호는 실제 코드와 대조한 뒤 사용한다.

조사일: 2026-06-25
대상 git ref: 브랜치 `codex/direct-agent-runtime-docs`, commit `e7a5f9e4291bf24b9109948063f1581fc01f8208` (태그 없음)
저장소: `/home/melbin/work/clcomx`
스택: Tauri v2, Svelte 5, Rust PTY backend (`portable-pty` 0.9.0 vendored), `serde`/`serde_json`, `tauri-plugin-shell`

> 본 문서는 "Direct Agent Runtime"(`codex app-server` / Claude ACP와 JSON-RPC로 직접 통신하는 새 런타임)을 추가하기 전에, 새 런타임이 공존/연동해야 할 백엔드 측 현실을 코드 사실에 근거하여 매핑한다. 모든 경로/함수명/타입은 위 commit에서 직접 읽고 확인한 것이다. 외부 protocol 근거는 [`01-source-map.md`](../01-source-map.md)에, 목표 command 계약은 [`07-tauri-process-runtime.md`](../07-tauri-process-runtime.md)에 정의되어 있으며 본 문서는 그것이 현재 코드와 어떻게 들어맞는지를 다룬다.

---

## 1. 요약 (Executive Summary)

CLCOMX 백엔드는 Rust(`src-tauri/src`)에서 단일 PTY runtime을 운영한다. `pty_spawn`이 Windows `wsl.exe`를 통해 WSL 안에서 `bash -li -c <command>`를 실행하고, `portable_pty::NativePtySystem`으로 stdout/stderr를 한 byte stream으로 읽어 `pty-output` 이벤트로 emit한다. 세션 상태(output log, chunk log, seq counter, home_dir, size)는 `PtyState`라는 `tauri::manage` 상태에 `Mutex<HashMap<u32, PtySession>>` 형태로 보관되며, 모든 I/O는 `std::thread` 두 개(child wait, reader loop)로 처리된다. tokio는 `Cargo.toml`에 의존성으로 있으나 `src-tauri/src` 어디에서도 import되지 않는다(grep 결과 0건). 즉 backend의 async/concurrency 컨벤션은 **현재 100% `std::thread` + `Arc<Mutex<...>>` + `AtomicU64/AtomicBool` 기반**이다.

영속화는 별도 feature 모듈(`workspace`, `settings`, `history`)이 담당한다. 세 모듈 모두 `app_env::state_path(name)`이 가리키는 JSON 파일(`workspace.json`, `setting.json`, `tab_history.json`)에 `serde_json::to_string_pretty`로 직렬화한다. 세션/탭 모델(`WorkspaceTabSnapshot`)에는 `agent_id`, `distro`, `work_dir`, `resume_token`, `pty_id`, `view_mode` 등이 들어 있으나 **runtime handle(`pty_id`)과 `resume_token`은 디스크 저장 시 항상 scrub된다**(보안 경계).

Direct runtime은 기존 PTY를 대체하지 않고 **새 runtime family**로 추가하는 것이 계획이며([`02-current-state.md`](../02-current-state.md), [`07-tauri-process-runtime.md`](../07-tauri-process-runtime.md)), 코드 구조도 이를 그대로 수용한다. `commands/` 아래에 `agent_runtime.rs`를 신설하고, `features/` 아래에 `agent_runtime/` feature 모듈을 신설하면, 기존 `pty.rs`/`terminal` 모듈과 동일한 패턴(별도 `*State` + `tauri::manage` + `invoke_handler` 등록)으로 깔끔하게 공존시킬 수 있다.

---

## 2. PTY runtime 해부 (`features/terminal/mod.rs`)

`src-tauri/src/commands/pty.rs`는 한 줄짜리 re-export(`pub use crate::features::terminal::*;`)이므로 실제 구현은 전부 `src-tauri/src/features/terminal/mod.rs`에 있다.

### 2.1 상태 모델

```rust
// features/terminal/mod.rs:18-43
enum PtyRuntime {
    Native { master: Box<dyn MasterPty + Send>, writer: Box<dyn Write + Send> },
    Mock,
}

struct PtySession {
    runtime: PtyRuntime,
    initial_output: Arc<Mutex<String>>,
    output_log: Arc<Mutex<String>>,
    output_chunks: Arc<Mutex<VecDeque<PtyOutputChunkRecord>>>,
    home_dir: Arc<Mutex<Option<String>>>,
    home_dir_osc_remainder: Arc<Mutex<String>>,
    size: Arc<Mutex<PtyDimensions>>,
    output_seq: Arc<AtomicU64>,
    buffer_initial_output: Arc<AtomicBool>,
    exited: Arc<AtomicBool>,
}

#[derive(Default)]
pub struct PtyState {
    sessions: Mutex<HashMap<u32, PtySession>>,
    next_id: Mutex<u32>,
}
```

확인된 사실:

- 세션 ID는 `u32`, `PtyState.next_id`를 잠가 단조 증가시킨다(`next_session_id`, mod.rs:237-242).
- 동시성은 전부 `std::sync::{Mutex, Arc, AtomicU64, AtomicBool}`. 채널 없음. (mod.rs:10-13)
- 모든 lock 실패는 `.map_err(|e| e.to_string())?`로 `Result<T, String>`에 흘려보낸다. 이것이 **backend 전역 에러 컨벤션**이다(Rust command는 거의 모두 `Result<_, String>` 반환).
- `is_test_mode()`가 true이면 native PTY 대신 `PtyRuntime::Mock`을 만든다(mod.rs:369-450). 이는 E2E/단위 테스트에서 실제 WSL 없이 배너/스트림을 흉내내는 경로다. Direct runtime도 동일한 test-mode mock 경로를 반드시 마련해야 E2E 회귀가 가능하다.

### 2.2 spawn / I/O 스레드 모델 (`pty_spawn`, mod.rs:355-607)

native 경로의 핵심 흐름:

1. `NativePtySystem::default().openpty(PtySize { rows, cols, .. })`로 PTY pair 생성 (mod.rs:452-461).
2. `command`(기본값 `wsl.exe`) + `args` + `cwd`로 `CommandBuilder`를 만들고 `pair.slave.spawn_command(cmd)`로 child 실행 (mod.rs:463-475). **shell string이 아니라 executable + argv 배열**을 받는다 — 이는 direct runtime이 따라야 할 [`07-tauri-process-runtime.md`](../07-tauri-process-runtime.md) §Process lifecycle의 "executable + argv" 규칙과 정확히 일치한다.
3. `pair.master.try_clone_reader()`로 reader, `take_writer()`로 writer 확보 (mod.rs:479-480).
4. **Thread 1 (child wait)**: `child.wait()` → `exited.store(true)` → 200ms sleep → `app.emit("pty-exit", session_id)` (mod.rs:491-502).
5. **Thread 2 (reader loop)**: 4096-byte buffer로 `reader.read()` 루프. `decode_utf8_stream_chunk`로 incomplete UTF-8 경계를 보존하며 디코딩 후 `record_output_chunk`로 흘려보낸다 (mod.rs:513-582).
6. 두 스레드의 핸들은 join하지 않고 detach한다. 세션을 `HashMap`에 insert (mod.rs:584-604).

### 2.3 output buffering / seq / snapshot / delta

`record_output_chunk`(mod.rs:184-229)가 출력 한 chunk를 처리하는 단일 진입점이다:

- `buffer_initial_output`이 true면 `initial_output`에 누적(첫 attach 전 버퍼링용).
- `update_home_dir_cache`로 OSC 633 `CLCOMX_HOME` 시퀀스를 소비(§5 참조).
- `output_seq.fetch_add(1) + 1`로 **1-based 단조 증가 seq** 발급.
- `output_log`(전체 텍스트, 4MB cap, `trim_output_log`)와 `output_chunks`(seq별 chunk, 4MB cap, `trim_output_chunks`)에 동시 기록.
- `app.emit("pty-output", PtyOutput { id, seq, data })` (mod.rs:220-228).

snapshot/delta API (모두 `pub fn` core 함수 + `#[tauri::command]` 래퍼 쌍):

| 목적 | core fn | command | 반환 타입 |
| --- | --- | --- | --- |
| 전체 출력 + seq + home | `get_output_snapshot` (mod.rs:622) | `pty_get_output_snapshot` | `PtyOutputSnapshot { data, seq, home_dir }` |
| 위 + cols/rows | `get_runtime_snapshot` (mod.rs:647) | `pty_get_runtime_snapshot` | `PtyRuntimeSnapshot { data, seq, cols, rows, home_dir }` (camelCase) |
| seq 이후 증분 | `get_output_delta_since` (mod.rs:675) | `pty_get_output_delta_since` | `PtyOutputDelta { data, seq, complete }` |
| 첫 버퍼 take | — | `pty_take_initial_output` (mod.rs:609) | `String` (mem::take, buffer off) |

`get_output_delta_since`의 `complete` 플래그가 late-attach 신뢰성의 핵심이다: chunk log가 trim되어 `after_seq+1`이 가장 오래된 보존 chunk보다 앞서면 `complete=false`를 돌려주고, frontend는 full snapshot으로 fallback한다 (mod.rs:684-709). **Direct runtime도 동일한 seq + delta + complete 3요소를 normalized event stream에 적용해야 transcript late-attach가 PTY와 같은 신뢰성을 갖는다.**

### 2.4 write / resize / kill

```rust
// features/terminal/mod.rs
pty_write  (721-748): Native면 writer.write_all + flush; Mock이면 가짜 응답 append
pty_resize (750-775): Native면 master.resize(PtySize{..}); size 캐시 갱신
pty_kill   (777-780): kill_pty_session → sessions.remove(&id) (Drop이 프로세스 정리)
```

`kill_pty_session`(mod.rs:231-235)은 `HashMap`에서 제거만 한다 — `PtyRuntime::Native`의 `MasterPty`/`Child`가 Drop되면서 OS가 프로세스를 정리하는 데 의존한다. Direct runtime은 protocol상 graceful shutdown(stdin close → timeout → kill)이 필요하므로([`07-tauri-process-runtime.md`](../07-tauri-process-runtime.md) §Process lifecycle), 단순 `HashMap::remove`에 의존하지 말고 명시적 child handle/kill 로직을 가져야 한다.

### 2.5 resume token 캡처 (`pty_close_and_capture_resume`, mod.rs:788-887)

PTY-특유의 휴리스틱이다. 종료 시 `exit\r`(claude) 또는 `0x03`(codex Ctrl-C)를 writer에 쓰고, output_log를 폴링하며 `extract_resume_token`으로 resume 토큰 문자열을 추출한다. EOF fallback(`0x04`), 타임아웃(`RESUME_CAPTURE_TIMEOUT_MS=2200`), exit grace 등 타이밍 상수가 박혀 있다. **이것은 terminal byte stream에서 resume 명령 문자열을 긁어내는 회귀 위험이 큰 경로이며, direct runtime이 protocol 레벨 session id로 대체하려는 바로 그 한계**다([`02-current-state.md`](../02-current-state.md) §현재 한계). direct runtime에서는 이 휴리스틱을 재사용하지 않고, ACP `session/new` 응답이나 Codex thread id를 그대로 영속화한다.

### 2.6 terminal parsing 유틸 (`features/terminal/parsing.rs`) — 재사용 가능 자산

| 함수 | 시그니처 | direct runtime 재사용성 |
| --- | --- | --- |
| `decode_utf8_stream_chunk(pending, chunk, flush)` | `&mut Vec<u8>, &[u8], bool -> String` | **높음.** stdio JSON-RPC도 UTF-8 byte stream을 chunk로 읽으므로 incomplete UTF-8 경계 보존 로직이 그대로 필요하다. `pub(super)`이므로 공유하려면 가시성 상향 또는 공용 util 모듈로 추출 필요. |
| `strip_ansi_sequences(input)` | `&str -> String` | 낮음(transcript는 ANSI 없음). stderr 로그 정리용으로만 선택 사용. |
| `consume_home_dir_osc(source, remainder)` | `&str, &str -> (Option<String>, String)` | 중간. PTY 보조 셸 메타데이터 전용. direct runtime은 protocol metadata로 cwd/home을 받으므로 직접 재사용 불필요. |
| `extract_resume_token(output, agent_id)` | `&str, &str -> Option<String>` | 낮음. PTY fallback 전용. |

권고: `decode_utf8_stream_chunk`는 newline-delimited JSON-RPC framer가 byte → str 변환에 그대로 쓸 수 있다. 이 함수를 `features/terminal`에 가둬두지 말고 `features/agent_runtime`에서도 접근 가능한 공용 위치(예: `features/io_util.rs` 또는 `app_env` 옆)로 빼는 것을 고려할 만하다. 단, terminal 테스트(`features/terminal/tests.rs`)가 `use super::parsing::...`로 의존하므로 이동 시 함께 갱신해야 한다.

---

## 3. Command 등록 / invoke_handler 패턴

### 3.1 모듈 트리

```
src-tauri/src/
├── main.rs           # clcomx_lib::run() 호출만 (windows_subsystem 설정)
├── lib.rs            # run(): Builder 구성 + manage + invoke_handler
├── app_env.rs        # 상태 디렉터리/test-mode/env helper
├── commands/
│   ├── mod.rs        # pub mod 선언 나열 (clipboard, editors, ..., pty, settings, window_runtime, workspace, wsl)
│   ├── pty.rs        # = features::terminal re-export
│   ├── workspace.rs  # 세션/탭 영속화 command
│   ├── settings.rs   # 설정/히스토리 command
│   ├── window_runtime.rs
│   └── wsl.rs
└── features/
    ├── terminal/     # PTY 구현 본체
    ├── workspace/    # 세션/탭/창 영속화 본체
    ├── settings/     # 설정 직렬화 본체
    ├── history/      # tab history 본체
    ├── bootstrap/    # 앱 부트스트랩 집계
    └── ...
```

확인된 컨벤션: **`commands/<x>.rs`는 얇은 `#[tauri::command]` 래퍼이고, 실제 로직과 상태 타입은 `features/<x>/`에 둔다.** `pty.rs`/`workspace.rs`/`settings.rs` 모두 이 패턴을 따른다.

### 3.2 `lib.rs::run()` (lib.rs:56-127) — 새 command 추가 위치

```rust
tauri::Builder::default()
    .plugin(tauri_plugin_shell::init())
    .manage(PtyState::default())        // ← 여기에 .manage(AgentRuntimeState::default()) 추가
    .manage(WslState::default())
    .manage(WorkspaceState::new(initial_workspace))
    .manage(WindowReadyState::default())
    .setup(|app| { /* restore windows */ })
    .invoke_handler(tauri::generate_handler![
        bootstrap_app, window_ready, ...,
        pty_spawn, pty_write, pty_resize, pty_kill, ...,   // ← 여기에 agent_runtime_* 추가
        ...
    ])
    .run(tauri::generate_context!())
```

새 command를 추가하려면 정확히 3곳을 손대야 한다:

1. `commands/mod.rs`에 `pub mod agent_runtime;` 추가 (mod.rs:1-9 패턴).
2. `lib.rs` 상단 `use commands::agent_runtime::{agent_runtime_start, ..., AgentRuntimeState};` (lib.rs:5-33 패턴, 상태 타입도 함께 import).
3. `lib.rs`의 `.manage(AgentRuntimeState::default())`와 `generate_handler![]` 목록에 함수명 등록.

State 주입은 `state: tauri::State<'_, AgentRuntimeState>`로 받고 내부 로직에는 `state.inner()`을 넘긴다(예: `pty_get_output_snapshot` → `get_output_snapshot(state.inner(), id)`, mod.rs:639-645). 한 command가 여러 State를 받는 사례도 있다(`close_session`이 `WorkspaceState` + `PtyState`를 동시에, workspace.rs:121-142). **direct runtime command가 종료 시 workspace의 `set_session_resume_token`을 갱신하거나 PTY fallback과 연동하려면 동일하게 복수 State 주입이 가능하다.**

### 3.3 이벤트 emit / listen 규칙

- emit: `AppHandle`을 command 인자로 받아 `app.emit("<event-name>", payload)` 호출. `use tauri::Emitter` 필요(terminal/mod.rs:14, commands/workspace.rs:7). payload는 `#[derive(Clone, Serialize)]` 구조체.
- event 이름은 kebab-case 문자열 리터럴: `"pty-output"`, `"pty-exit"`, `"workspace-updated"`, `"window-frontend-ready"`.
- listen(frontend): `@tauri-apps/api/event`의 `listen<T>("pty-output", cb)` (src/lib/components/Terminal.svelte:867, src/lib/terminal/canonical-screen-authority.ts:263). `WorkspaceSnapshot`는 `App.svelte:588`에서 `workspace-updated` listen.
- **payload 직렬화 규칙**: 일부 payload는 `#[serde(rename_all = "camelCase")]` (예: `PtyRuntimeSnapshot`, `PtyOutputDelta`), 일부는 그대로 (예: `PtyOutput`은 `id/seq/data` 단어가 1음절이라 차이 없음). 새 event payload는 frontend TS interface와 맞추기 위해 **camelCase rename을 명시**하는 것이 안전하다(예: `PtyRuntimeSnapshot.home_dir` → `homeDir`).

[`07-tauri-process-runtime.md`](../07-tauri-process-runtime.md)가 정의한 `agent-runtime-message`/`-stderr`/`-exit`/`-error`/`-backpressure` 이벤트와 `agent_runtime_start/send/cancel/shutdown/get_snapshot` command는 위 패턴에 그대로 들어맞는다.

---

## 4. 영속화 계층 (workspace / settings / history)

### 4.1 공통 저장 메커니즘 (`app_env.rs`)

```rust
// app_env.rs:46-67
state_root_dir() -> CLCOMX_STATE_DIR env가 있으면 그 경로, 없으면 current_dir()
state_path(name) -> state_root_dir().join(name)
ensure_parent_dir(path) -> 부모 디렉터리 mkdir -p
```

세 영속화 모듈 모두 `state_path("<file>.json")` + `fs::read_to_string` / `fs::write` + `serde_json` 패턴을 공유한다. 테스트는 `app_env::test_support::set_state_dir_env(&path)`로 `CLCOMX_STATE_DIR`을 일시 override하는 RAII guard를 쓴다(app_env.rs:83-119). **direct runtime이 별도 상태 파일(예: transcript 영속화)을 추가한다면 동일하게 `state_path`를 쓰고, 테스트에서 `set_state_dir_env`를 재사용해야 한다.**

### 4.2 workspace 세션/탭 모델 (`features/workspace/types.rs`)

```rust
// types.rs:19-49 (#[serde(rename_all = "camelCase")])
pub struct WorkspaceTabSnapshot {
    pub session_id: String,
    #[serde(default = "default_workspace_agent_id")] pub agent_id: String,  // 기본 "claude"
    pub distro: String,
    pub work_dir: String,
    pub title: String,
    pub pinned: bool,
    pub locked: bool,
    #[serde(default, alias = "claudeResumeId", alias = "claude_resume_id")]
    pub resume_token: Option<String>,   // ← 디스크 저장 시 항상 scrub
    pub pty_id: Option<u32>,            // ← 디스크 저장 시 항상 None으로 scrub
    pub aux_pty_id: Option<u32>,
    pub aux_visible: bool,
    pub aux_height_percent: Option<u16>,
    #[serde(default = "default_view_mode")] pub view_mode: String,  // "terminal" | "editor"
    pub editor_root_dir: String,
    pub open_editor_tabs: Vec<EditorTabRef>,
    pub active_editor_path: Option<String>,
}
// WindowSnapshot { label, name, role, tabs, active_session_id, x,y,width,height,maximized }
// WorkspaceSnapshot { windows: Vec<WindowSnapshot> }
```

직렬화/영속화 규칙(`features/workspace/store.rs`):

- 메모리 상태는 `WorkspaceState { snapshot: Mutex<WorkspaceSnapshot> }` (state.rs:4-14). `snapshot_from_state`(clone), `write_snapshot_to_state`(replace)가 접근자.
- 디스크 저장 직전 `sanitize_workspace_for_persist`(store.rs:140-149)가 **모든 탭의 `pty_id = None`, `resume_token` 제거**. 즉 runtime handle과 비밀은 디스크에 절대 남지 않는다.
- 읽을 때 `read_workspace`(store.rs:151-169)가 `scrub_workspace_resume_tokens`로 legacy 토큰을 한 번 더 청소하고, 변경되면 즉시 재기록한다.
- `normalize_*`(store.rs:47-118)가 빈 값/잘못된 값에 기본값을 채운다. **알 수 없는 필드는 `#[serde(default)]` 덕에 무시·기본값 처리**되므로, 새 필드(예: `runtime_kind`) 추가 시 기존 `workspace.json`과 호환된다.

**Direct runtime persistence migration의 사실 기반 함의**(상세 설계는 [`10-persistence-migration.md`](../10-persistence-migration.md)):

- `WorkspaceTabSnapshot`에 `runtime_kind: String`(기본 `"pty"`) 같은 필드를 `#[serde(default = "...")]`로 추가하면 기존 파일과 forward/backward 호환된다.
- resume용 protocol session id 역시 `resume_token`과 동일하게 **scrub 대상으로 다뤄야** 일관성이 유지된다. 새 토큰 종류를 평문 영속화하면 위 보안 경계가 깨진다.
- `view_mode`가 `"terminal"|"editor"` 2값이듯, transcript view를 추가하려면 `normalize_window_snapshot`(store.rs:47-104)의 view_mode 분기를 확장해야 한다.

### 4.3 settings (`features/settings/mod.rs`)

`SettingsPayload`(mod.rs:190-214)는 `language`/`interface`/`workspace`/`terminal`/`editor`/`history`/`main_window` 하위 섹션 구조다. 특이점:

- 읽기는 `parse_settings_value`(mod.rs:431-604)가 `serde_json::Value`를 직접 탐색하며 **legacy flat 필드까지 다중 경로(`&[&["terminal","fontSize"], &["fontSize"]]`)로 마이그레이션**한다. 단순 `serde::Deserialize`가 아니라 수동 path lookup이다.
- `workspace.default_agent_id`(기본 `"claude"`), `terminal.claude_cli_flags.enable_auto_mode`, `terminal.claude_tui`(`auto|fullscreen|default`) 등 **에이전트별 기동 옵션이 이미 settings에 존재**한다. direct runtime의 transport 선택 토글(예: `agentRuntime.mode = "direct"|"terminal"`)을 추가하려면 `parse_settings_value`/`normalize_settings_payload`에 normalize 분기를 추가하는 것이 컨벤션이다.
- 모든 수치는 `clamp_*`로 범위 제한, 문자열은 `normalize_*`로 정규화한다.

### 4.4 history (`features/history/mod.rs`)

`TabHistoryEntry { agent_id, distro, work_dir, title, resume_token, last_opened_at }`. 핵심: `resume_token`은 read/write/upsert 모든 경로에서 **항상 `None`으로 강제**된다(`read_tab_history` mod.rs:108-110, `sanitize_tab_history_entries` mod.rs:115-124, `upsert_tab_history_entry`가 인자 `_resume_token`을 무시 mod.rs:170-196). direct runtime의 새 식별자도 history에는 저장하지 않는 것이 일관적이다.

---

## 5. WSL 경계 / cwd·home 메타데이터 / resume fallback marker

### 5.1 WSL 실행 경계 (`src/lib/pty.ts`)

frontend `spawnPty`(pty.ts:52-90)가 command를 조립해 `pty_spawn` invoke로 넘긴다. 실제 wire 형태:

```ts
invoke("pty_spawn", {
  cols, rows,
  command: "wsl.exe",
  args: ["-d", distro, "-e", "bash", "-li", "-c",
         `${homeMetadataCommand}\ncd '${safeWorkDir}' && ${startCommand}`],
  cwd: null,
  mockAgentId, mockDistro, mockWorkDir, mockResumeToken,   // test-mode mock 힌트
});
```

확인된 경계 사실:

- Windows 측 backend가 `wsl.exe -d <distro> -e bash -li -c <script>`로 WSL 안에서 실행한다. cwd는 backend `cwd`가 아니라 **스크립트 내부 `cd '<workDir>'`로 진입**한다(`cwd: null`로 넘김).
- `startCommand`는 `agents/registry.ts`의 `buildStartCommand`/`buildResumeCommand`로 생성한 **shell 문자열**이다(아래 §6).
- resume 시 fallback 패턴(pty.ts:63-64):
  ```sh
  if ! <resumeCommand>; then printf '__CLCOMX_RESUME_FAILED__\r\n'; <startCommand>; fi
  ```
  resume 실패 시 `__CLCOMX_RESUME_FAILED__` marker를 stdout에 찍고 새 세션으로 폴백한다. frontend `main-terminal-runtime-controller.ts:16,376,497`가 이 marker를 감지해 transcript에서 제거한다(`RESUME_FAILED_MARKER`).
- 보조 셸은 `spawnShellPty`(pty.ts:118-163)가 별도 rcfile heredoc으로 `PROMPT_COMMAND`에 `CLCOMX_CWD` OSC emit을 심는다.

`wsl.rs`의 `WslState`(wsl.rs:76-94)는 PTY와 **별개**의 영속 bash 프로세스 풀(`Mutex<HashMap<distro, WslShell>>`)을 distro당 하나 유지해 빠른 디렉터리 listing/검색을 한다. `std::process::Command`(`stdin/stdout piped`, `CREATE_NO_WINDOW`)를 직접 쓴다 — **direct runtime이 `wsl.exe`를 통해 process를 띄울 때 참고할 수 있는 비-PTY 프로세스 spawn 레퍼런스**다.

### 5.2 OSC 633 메타데이터 시퀀스

| 시퀀스 | 의미 | emit 위치 | parse 위치 |
| --- | --- | --- | --- |
| `\033]633;CLCOMX_HOME;<base64>\007` | $HOME 디렉터리 | pty.ts:66-69 (spawn 직후 1회) | Rust `consume_home_dir_osc` (parsing.rs:228); frontend `aux-shell-metadata.ts:3` |
| `\033]633;CLCOMX_CWD;<base64>\007` | 보조 셸 현재 cwd | pty.ts:133 (PROMPT_COMMAND마다) | frontend `aux-shell-metadata.ts:2` |

prefix 상수: Rust `HOME_DIR_OSC_PREFIX = "\u{1b}]633;CLCOMX_HOME;"` (parsing.rs:1), terminator는 BEL(``) 또는 ST(`\\`). base64 payload는 `decode_base64_utf8`로 디코딩(parsing.rs:151-199, 표준 라이브러리 외부 의존 없이 직접 구현). 부분 시퀀스는 `home_dir_osc_remainder`에 carry over한다.

**direct runtime 함의**: ACP/Codex protocol은 cwd/home을 protocol metadata로 전달하므로 OSC 시퀀스가 불필요하다. 단, [`07-tauri-process-runtime.md`](../07-tauri-process-runtime.md) §WSL/Windows 경계가 명시하듯 direct runtime도 우선 동일 `wsl.exe -d <distro> -e ...` 경계를 유지하고, ACP의 absolute path 요구를 위해 adapter 입력 직전 path canonicalization을 해야 한다. frontend file-link 변환(`src/lib/features/editor/navigation/wsl-path-utils.ts`)은 그대로 재사용한다.

---

## 6. Agent 정의 / command 생성 / allowlist (`src/lib/agents/`)

```ts
// agents/types.ts
type AgentId = string;
interface AgentDefinition {
  id, label, shortLabel, supportsResume, resumeTokenLabel, icon;
  buildStartCommand(options?: AgentCommandOptions): string;       // shell 문자열 반환
  buildResumeCommand(token, options?): string;
}
interface AgentCommandOptions { extraArgs?: readonly string[]; envVars?: Record<string,string>; }
```

`registry.ts`의 `BUILTIN_AGENTS`:

| id | start command | resume command |
| --- | --- | --- |
| `claude` | `<env>claude <extraArgs>` | `<env>claude --resume <token> <extraArgs>` |
| `codex` | `codex <extraArgs>` | `codex resume <token> <extraArgs>` |

확인된 안전 장치:

- `shellQuote`/`escapeShellSingleQuoted`(registry.ts:4-14)로 모든 인자를 single-quote 이스케이프.
- `assertValidEnvKey`(registry.ts:16-20)가 env key를 `^[A-Za-z_][A-Za-z0-9_]*$`로 검증 — 잘못된 키는 throw.
- claude 전용 옵션은 `pty.ts:getAgentCommandOptions`(pty.ts:92-116)가 settings에서 `claudeCliFlags`(`buildClaudeCliFlags`)와 `claudeTui`(`CLAUDE_CODE_NO_FLICKER` env)로 생성.

**allowlist 관점(direct runtime 핵심)**: 현재는 frontend가 자유롭게 shell 문자열을 만들어 backend `pty_spawn`에 넘긴다 — backend에는 **executable allowlist 검증이 없다**. [`07-tauri-process-runtime.md`](../07-tauri-process-runtime.md) §Tauri command v1 계약은 direct runtime에서는 "provider별 allowlist를 Rust command handler가 검증하고, renderer가 임의 executable/shell string을 넘길 수 없게 한다"고 명시한다. 즉 **direct runtime은 PTY의 자유 shell 모델을 따르지 말고**, `AgentRuntimeStartParams`의 `provider` enum(`codex`|`claude`)에 따라 backend가 `command`/`args`를 검증·제한해야 한다. 이는 PTY 대비 의도적인 강화 지점이며, 현재 코드에 선례가 없으므로 새로 구현해야 한다.

---

## 7. Rust 비동기/스레드/채널/에러 컨벤션 (확인된 사실)

| 항목 | 현재 코드 사실 | 출처 |
| --- | --- | --- |
| async runtime | tokio는 `Cargo.toml`에 `features=["sync","macros"]`로 선언되어 있으나 `src-tauri/src` 전체에서 import 0건. **Tauri command는 모두 동기 `fn`.** | grep `tokio` → NONE; Cargo.toml:21 |
| 동시성 primitive | `std::thread::spawn` + `Arc<Mutex<T>>` + `AtomicU64`/`AtomicBool`. mpsc/crossbeam 채널 사용 0건. | grep `mpsc\|channel\|crossbeam` → NONE; terminal/mod.rs:495,513 |
| 상태 공유 | `tauri::Builder::manage(State::default())` + command 인자 `tauri::State<'_, T>` → `state.inner()`. State 타입은 보통 `#[derive(Default)]` + 내부 `Mutex<...>`. | lib.rs:62-65; pty.rs PtyState; wsl.rs WslState |
| 에러 처리 | command 반환은 거의 전부 `Result<T, String>`. lock 실패는 `.map_err(\|e\| e.to_string())?`. 비치명적 백그라운드 오류는 `eprintln!` 후 무시(store.rs:163-165, window_runtime.rs:84-89). | 전역 |
| 이벤트 emit | `AppHandle` 인자 + `use tauri::Emitter` + `app.emit("name", payload)`. background 스레드는 `app.clone()`을 move 캡처. | terminal/mod.rs:220,501 |
| 백그라운드 작업 | `std::thread::spawn(move \|\| {...})`로 detach. join 없음. `AtomicBool exited` 플래그로 종료 신호. | terminal/mod.rs:491-582; window_runtime.rs:82-91 |

**Direct runtime 권고(사실 기반)**: 기존 컨벤션과 일관성을 유지하려면 direct runtime도 `std::thread` 기반으로 짤 수 있다. 그러나 JSON-RPC는 (a) stdin write + stdout read + stderr read 3-way I/O, (b) pending request id → 응답 매칭, (c) graceful shutdown 타임아웃이 필요해 PTY보다 복잡하다. 두 가지 선택지:

1. **`std::thread` 유지(컨벤션 정합)**: reader thread가 stdout을 newline 단위로 framing → `app.emit("agent-runtime-message", ...)`. writer는 command 인자에서 `tauri::State`의 child stdin handle을 `Mutex`로 잠가 write. pending request는 `Arc<Mutex<HashMap<JsonRpcId, ...>>>`. PTY의 thread2 reader 루프(terminal/mod.rs:513-582)를 거의 그대로 본떠 newline framer로 치환하면 된다.
2. **tokio 도입**: 이미 의존성에 있으나 현재 미사용. 도입 시 프로젝트 최초의 async 코드가 되어 컨벤션을 깨고 `#[tauri::command] async fn` 혼재가 생긴다. 큐 backpressure(`agent-runtime-backpressure` 이벤트)와 timeout을 `tokio::sync::mpsc` + `tokio::time`으로 깔끔히 짤 수 있다는 이점은 있다.

코드 사실만 보면 **옵션 1이 기존 PTY 패턴·테스트 모델과 가장 자연스럽게 공존**한다. 옵션 2는 backpressure/timeout 요구가 강할 때만 정당화되며, 채택 시 ADR에 명시해야 한다(현 [`adr-001`](../adr-001-direct-agent-runtime.md) 범위 확인 필요).

---

## 8. 테스트 컨벤션

### 8.1 Rust (`#[cfg(test)]`)

- 인라인 `#[cfg(test)] mod tests { ... }`를 같은 파일(또는 `tests.rs` 서브모듈)에 둔다. 16개 모듈이 테스트를 가짐(`terminal/mod.rs`는 `#[cfg(test)] mod tests;`로 `tests.rs` 분리, mod.rs:2-3).
- 실행: `npm run test:rust` → `cargo test --manifest-path src-tauri/Cargo.toml`.
- test fixture state: `test_state_with_session(...)`(terminal/mod.rs:45-83)처럼 `#[cfg(test) pub(crate) fn`로 mock 상태 생성기를 제공. **direct runtime도 동일하게 mock runtime state 생성기를 `#[cfg(test)]`로 노출**하면 snapshot/delta 단위 테스트가 가능하다.
- 디스크 영속화 테스트는 `crate::app_env::test_support::set_state_dir_env(&tmp)` guard로 격리(store.rs:253, settings/mod.rs:666).
- test-mode 분기: `is_test_mode()`(`CLCOMX_TEST_MODE`)가 native 대신 mock 경로를 탄다. WSL 의존 코드(`wsl.rs`)는 `test_distro_name()`/`test_home_path()`로 mock 데이터를 돌려준다.

### 8.2 Frontend (vitest)

- 설정 파일: `vite.config.ts`(별도 `vitest.config.ts` 없음), E2E는 `vitest.e2e.config.ts`.
- 테스트 위치: **소스 옆 co-located `*.test.ts`**(예: `src/lib/pty.test.ts`, `src/lib/agents/registry.test.ts`, `src/lib/features/terminal/controller/main-terminal-runtime-controller.test.ts`). 약 90개 존재.
- 실행: `npm run test`(`vitest run`), `npm run verify`(test + test:rust + check).
- Tauri invoke/event는 `src/test/mocks/tauri.test.ts` 기반으로 모킹. **direct runtime의 frontend 어댑터도 동일하게 `invoke`/`listen` 모킹 + co-located `*.test.ts`**로 작성.
- E2E는 `scripts/run-e2e-project.mjs <project>`로 PTY mock 경로(`CLCOMX_TEST_MODE`)를 활용한 시나리오(`smoke`, `terminal-input`, `terminal-aux` 등) 다수.

---

## 9. Direct runtime이 들어갈 자리 (구체적 신설 위치)

| 신설 파일/모듈 | 역할 | 본뜰 기존 코드 |
| --- | --- | --- |
| `src-tauri/src/features/agent_runtime/mod.rs` | runtime 본체: `AgentRuntimeState`(= `Mutex<HashMap<RuntimeId, AgentRuntime>>` + `next_id`), spawn/send/cancel/shutdown core fn, snapshot | `features/terminal/mod.rs`(PtyState/PtySession/`pty_spawn` 구조) |
| `src-tauri/src/features/agent_runtime/transport.rs` | newline-delimited JSON-RPC framing, stdin write, stdout/stderr reader thread | `features/terminal/parsing.rs::decode_utf8_stream_chunk` 재사용 + terminal reader loop(mod.rs:513-582) |
| `src-tauri/src/features/agent_runtime/process.rs` | `wsl.exe -d <distro> -e <executable> <argv>` child spawn, graceful shutdown(stdin close→timeout→kill) | `commands/wsl.rs::WslShell::spawn`(비-PTY `std::process::Command` + `CREATE_NO_WINDOW`) |
| `src-tauri/src/features/agent_runtime/tests.rs` | fixture replay, snapshot/delta, framing 단위 테스트 | `features/terminal/tests.rs` |
| `src-tauri/src/commands/agent_runtime.rs` | 얇은 `#[tauri::command]` 래퍼 5종 + re-export | `commands/pty.rs`(re-export) / `commands/workspace.rs`(wrapper) |
| `src/lib/features/agent-runtime/*.ts` | frontend transport client + normalized event store + adapter | `src/lib/pty.ts`(invoke wrapper) + 기존 controller 패턴 |

연동 지점(integration points):

- `commands/mod.rs`: `pub mod agent_runtime;` 추가.
- `lib.rs`: `use` + `.manage(AgentRuntimeState::default())` + `generate_handler![]` 등록.
- `features/workspace`: 세션 종료 시 protocol session id를 `set_session_resume_token_in_workspace`로 영속화(단 scrub 정책 유지). `WorkspaceTabSnapshot`에 `runtime_kind`/`view_mode` 확장.
- `features/settings`: transport mode 토글 추가 시 `parse_settings_value`/`normalize_settings_payload`에 분기.
- `app_env`: 상태 디렉터리/test-mode helper 그대로 재사용. test-mode mock 경로를 direct runtime에도 추가.

---

## 10. PTY와 direct runtime의 분리/공존 권고 (사실 기반)

1. **상태를 분리하라.** `PtyState`와 별도의 `AgentRuntimeState`를 `manage`로 등록한다. RuntimeId 공간을 PTY `u32` 세션 ID와 섞지 않는다(혼선/디버깅 난이도 증가). [`07-tauri-process-runtime.md`](../07-tauri-process-runtime.md)가 `RuntimeId`를 별도 `number`로 둔 것과 일치.
2. **command 네임스페이스를 분리하라.** `pty_*` vs `agent_runtime_*`. event도 `pty-*` vs `agent-runtime-*`. 현재 emit/listen 규칙(§3.3)을 그대로 따른다.
3. **transport는 byte stream이 아니라 framed message다.** PTY의 `output_log`/`output_chunks`는 raw 터미널 텍스트지만, direct runtime은 JSON-RPC message 단위로 보존해야 한다. 단, **seq + delta + complete late-attach 메커니즘(§2.3)은 동일 원리로 재사용**하라 — message에 단조 증가 seq를 붙이고, snapshot/delta-since를 같은 형태로 제공하면 frontend transcript 재접속이 PTY와 같은 신뢰성을 얻는다.
4. **UTF-8 framing 유틸을 공유하라.** `decode_utf8_stream_chunk`(parsing.rs:101)는 stdio reader가 그대로 필요로 한다. terminal 모듈에 가둬두지 말고 공용 위치로 추출하되 terminal 테스트 import를 갱신한다.
5. **process 모델은 PTY와 다르게 명시적 kill을 가져라.** PTY는 `HashMap::remove` + Drop에 의존하지만(§2.4), direct runtime은 graceful shutdown(stdin EOF → timeout → kill)과 "process exit이 모든 pending request를 실패로 닫음"을 직접 구현해야 한다([`07-tauri-process-runtime.md`](../07-tauri-process-runtime.md) §Process lifecycle).
6. **executable allowlist를 backend에 추가하라(신규).** PTY는 frontend가 임의 shell 문자열을 넘기지만(§6), direct runtime은 `provider` enum 기반으로 backend가 `command`/`args`를 검증해야 한다. 현 코드에 선례가 없는 강화 지점이다.
7. **영속화 보안 경계를 유지하라.** resume용 protocol session id도 `pty_id`/`resume_token`과 동일하게 `sanitize_workspace_for_persist`/history scrub 대상으로 다룬다(§4.2, §4.4). 새 비밀을 평문 영속화하면 기존 경계가 깨진다.
8. **test-mode mock을 1급으로 제공하라.** `is_test_mode()` 분기로 가짜 JSON-RPC 응답 스트림을 만들어, WSL/실제 CLI 없이 E2E와 단위 테스트가 돌게 한다. PTY의 `create_mock_session`(terminal/mod.rs:290-353)이 직접 본뜰 모델이다.

---

## 11. 미해결/확인 필요 (추정 표기)

- (추정) tokio 채택 여부는 코드에 강제 사실이 없다. 현 컨벤션은 `std::thread`이며, async 도입은 ADR 결정 사항이다. 본 문서는 두 옵션의 trade-off만 사실 기반으로 제시한다(§7).
- (확인 필요) `decode_utf8_stream_chunk`를 공용화할 때 모듈 가시성(`pub(super)` → `pub(crate)`) 변경 범위와 terminal 테스트 import 영향.
- (확인 필요) `WorkspaceTabSnapshot`에 `runtime_kind` 추가 시 frontend `WorkspaceSnapshot` TS 타입(`src/lib`)과 `merge_workspace_snapshot`(service/window_ops.rs) 동작. 직렬화 forward-compat은 `#[serde(default)]`로 보장되나, frontend 측 타입/저장 로직 동기화는 별도 확인 대상이다.
- (확인 필요) Codex websocket transport(`transportKind: "websocket"`)는 [`07-tauri-process-runtime.md`](../07-tauri-process-runtime.md)에서 "검증 후 optional"로 명시. 현 backend에 websocket 클라이언트 코드/의존성 없음(`Cargo.toml` 확인). 1차 구현은 `jsonrpc-stdio`만 권고.

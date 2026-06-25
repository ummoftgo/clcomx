# ADR-001: Direct Agent Runtime

> 이 ADR은 CLCOMX가 agent provider(Codex, Claude)를 **터미널 byte stream이 아니라 구조화된 protocol event**로 직접 구동하는 새 runtime family를 도입하는 결정을 기록한다. 타입 정의는 재기술하지 않고 [`15-data-contracts.md`](15-data-contracts.md)를, 규칙은 [`04-normalized-agent-model.md`](04-normalized-agent-model.md)를, wire 사실은 `ref-*` 문서를, 코드 현실은 `research/*` 문서를 인용한다. 미확정/위험은 [`13-risks-open-questions.md`](13-risks-open-questions.md)로 연결한다.

## Status

Proposed

조사 시점: 2026-06-25. 코드 스냅샷 기준: commit `e7a5f9e`; 구현 전 현재 작업트리와 대조. version pin은 본 ADR §"Decision에 영향을 준 검증된 버전 핀"에 모은다.

---

## Context

### 현재 상태 (검증됨)

CLCOMX 백엔드는 단일 PTY runtime을 운영한다. `pty_spawn`이 Windows `wsl.exe`를 통해 WSL 안에서 `bash -li -c <command>`를 실행하고, `portable_pty::NativePtySystem`으로 stdout/stderr를 **하나의 byte stream**으로 읽어 `pty-output` 이벤트로 emit한다 (`research/codebase-backend.md` §1, §2). 세션 상태(`output_log`, `output_chunks`, `output_seq`, `home_dir`, `size`)는 `PtyState`(`Mutex<HashMap<u32, PtySession>>` + `next_id`)에 보관되고 모든 I/O는 `std::thread` 두 개(child wait, reader loop)로 처리된다. tokio는 `Cargo.toml`에 있으나 `src-tauri/src` 어디에서도 import되지 않는다(grep 0건) — backend 동시성은 100% `std::thread` + `Arc<Mutex<...>>` + `Atomic*` 기반이다 (`research/codebase-backend.md` §1).

frontend는 `claude`/`codex` CLI를 PTY에서 띄우고 xterm.js에 byte stream을 렌더링한다. `main-terminal-runtime-controller.ts`가 output chunk를 xterm에 쓰면서 loading/ready signal, bottom lock, resume fallback marker, canonical screen snapshot을 직접 관리한다 (`02-current-state.md` §5). 이 방식은 기존 CLI/TUI를 빠르게 감쌀 수 있으나, agent message·tool call·approval·diff·command output·session/turn/message/tool id를 구조화하기 어렵고, terminal ready signal·prompt glyph·footer text 같은 **UI marker에 의존하는 회귀 위험**이 있다 (`02-current-state.md` §26).

### provider가 구조화된 protocol을 공개한다 (검증됨)

두 provider 모두 terminal text보다 직접 protocol event를 쓰는 쪽이 데스크톱 앱식 UI에 적합하며, 그 표면이 1차 소스에서 확인된다.

- **Codex app-server protocol (v2 thread/turn/item)**: `codex app-server`는 기본 `stdio://` transport로 line-delimited JSON 객체를 주고받는다. `--listen`은 `stdio://`(기본)·`unix://`·`ws://IP:PORT`도 지원한다 (ref-codex §1.1). JSON-RPC 변형은 `jsonrpc` 필드를 보내지도 기대하지도 않는 line-delimited 방식이고(ref-codex §1.2), thread/turn/item 모델이 message·command execution·file change·plan·approval을 각각 별도 item/notification으로 흘려준다 (ref-codex §6, §7). pinned ref `rust-v0.142.0`, 로컬 `codex-cli 0.142.0` 일치 확인 (ref-codex §0). app-server 명령 자체는 `[experimental]`로 표시되며, 일부 method/field는 `initialize.capabilities` opt-in으로 gating된다 (ref-codex §1.1, §1.4).

- **Claude ACP (`@agentclientprotocol/claude-agent-acp`)**: 이 패키지는 stdio JSON-RPC ACP server로 동작하며(`runAcp()`), `console.log/info/warn/debug`를 전부 `console.error`로 redirect해 **stdout에는 ACP message만** 흐른다 (ref-claude-agent-acp §1). `initialize`는 항상 wire `protocolVersion: 1`을 반환하고, `agentCapabilities`로 image·embeddedContext prompt, tool call + permission request, plan/TODO, loadSession, session 관리(close/delete/fork/list/resume), terminal·elicitation·gateway(클라이언트 capability 게이트)를 광고한다 (ref-claude-agent-acp §2). `session/update` notification은 13종 SessionUpdate variant로 streaming되며 wire method 문자열은 `@agentclientprotocol/sdk@0.29.0`의 `schema.json`에 리터럴로 확인됐다 (ref-claude-agent-acp §2). pinned `@agentclientprotocol/claude-agent-acp@0.51.0`(commit `23626c9`), `@anthropic-ai/claude-agent-sdk@0.3.187`, sdk `0.29.0`, node `>=22`, ESM (ref-claude-agent-acp §"버전 고정").

- **구버전 deprecation (검증됨)**: `@zed-industries/claude-code-acp`는 rename되어 deprecated(마지막 `0.16.2`)이고 bin 이름이 `claude-code-acp`로 다르다. 새 dependency에는 신버전 `@agentclientprotocol/claude-agent-acp`(bin `claude-agent-acp`)만 쓴다 (ref-claude-agent-acp §"구버전과의 관계").

### 이미 합의된 모델·계약 (이 ADR이 전제하는 정본)

normalized model 타입은 [`15-data-contracts.md`](15-data-contracts.md) §1–§5(`AgentProvider`/`ProviderRef`/`AgentEvent`/`AgentContent`/`ToolCallUpdate`/`Approval*`/…), Agent Runtime Port는 §6, persistence 계약은 §7, Tauri command/event 계약은 §8에 정의돼 있다. 상태 머신·upsert/reconcile·순서 보존·approval 생명주기 규칙은 [`04-normalized-agent-model.md`](04-normalized-agent-model.md)에 있다. 목표 아키텍처(hexagonal: UI → Store → Event Router → Agent Runtime Port → provider Adapter → Tauri Process Runtime)는 [`03-target-architecture.md`](03-target-architecture.md)에 있다. 본 ADR은 이 구조를 **채택하는 결정의 근거와 대안 기각 사유**를 기록할 뿐, 타입/규칙/아키텍처를 재정의하지 않는다.

### 코드 구조가 새 runtime family를 수용한다 (검증됨)

`commands/pty.rs`는 `pub use crate::features::terminal::*;` 한 줄 re-export이고 실제 구현은 `features/terminal/mod.rs`에 있다. `commands/agent_runtime.rs`(신설) + `features/agent_runtime/`(신설)를 기존 `pty.rs`/`terminal`과 동일 패턴(별도 `*State` + `tauri::manage` + `invoke_handler` 등록)으로 추가하면 기존 PTY와 깔끔히 공존한다 (`research/codebase-backend.md` §1, §2.1). test-mode mock 경로(`PtyRuntime::Mock`, `is_test_mode()`)가 이미 있으므로 direct runtime도 동일한 mock 경로를 마련해 WSL 없이 E2E 회귀가 가능하다 (`research/codebase-backend.md` §2.1).

### Decision에 영향을 준 검증된 버전 핀

| provider/패키지 | pin | 출처 |
|---|---|---|
| Codex app-server protocol | git tag `rust-v0.142.0`, 로컬 `codex-cli 0.142.0` | ref-codex §0 |
| Codex wire protocol 모델 | v2 (thread/turn/item); `initialize`만 v1 | ref-codex §0 |
| Claude ACP 어댑터 | `@agentclientprotocol/claude-agent-acp@0.51.0` (commit `23626c9`) | ref-claude-agent-acp §"버전 고정" |
| Claude Agent SDK | `@anthropic-ai/claude-agent-sdk@0.3.187` | ref-claude-agent-acp §"버전 고정" |
| ACP sdk | `@agentclientprotocol/sdk@0.29.0` | ref-claude-agent-acp §"버전 고정" |
| ACP wire protocolVersion | 정수 `1` (npm semver와 별개 축) | ref-claude-agent-acp §4 |

---

## Decision

CLCOMX는 **direct agent runtime을 새 runtime family로 도입**한다. 결정의 핵심 4가지는 다음과 같다.

### D1. provider adapter로 protocol을 격리한다

Codex는 **app-server protocol adapter**(v2 thread/turn/item, stdio JSON-RPC, `jsonrpc` 필드 없음 — ref-codex §1.2)로, Claude는 **ACP adapter**(`@agentclientprotocol/claude-agent-acp@0.51.0`, stdio JSON-RPC 2.0, wire `protocolVersion: 1` — ref-claude-agent-acp §2, §4)로 연결한다. adapter는 provider wire → `AgentEvent`(15 §3) 변환만 책임진다. provider wire 사실/매핑은 ref-codex §8, ref-acp §13에 고정한다. hexagonal 경계는 `03-target-architecture.md` §"패턴".

### D2. UI와 persistence는 normalized model만 소비한다

UI/store/persistence는 provider protocol을 모르고 [`15-data-contracts.md`](15-data-contracts.md)의 normalized 타입(`AgentEvent`/`AgentContent`/`ToolCallUpdate`/`Approval*`/`AgentRuntimeMetadata`)과 [`06`](06-claude-acp-adapter.md)/[`05`](05-codex-app-server-adapter.md) adapter가 emit한 event만 본다. **타입 정본은 15**, **규칙(상태 전이·upsert/reconcile·순서 보존·approval 생명주기) 정본은 04**다. 두 문서가 충돌하면 타입은 15, 규칙은 04가 권위를 갖는다(15 §0 서두, 04 §역할 분리).

### D3. backend는 framing/transport만, protocol 해석은 frontend adapter가 한다

Tauri backend(`agent_runtime_*` command, `agent-runtime-*` event — 15 §8)는 process spawn·stdio framing·라우팅만 책임지고 **raw JSON-RPC를 그대로 올린다**(`agent-runtime-message`). provider wire → `AgentEvent` 변환은 frontend의 Codex/Claude adapter가 담당한다 (15 §8.3, `03-target-architecture.md` §Provider Adapter). `agent_runtime_*` namespace는 기존 `pty_*`와 분리하고, `AgentRuntimeState`는 `PtyState`와 별도로 둔다 (`research/codebase-backend.md` §10 권고 1·2). executable `command`는 renderer 입력에서 제거하고 backend가 provider로 신뢰 절대경로를 resolve한다. `args`/`env`는 adapter 생성값만 허용하고 Rust handler가 provider별 allowlist로 재검증한다(임의 executable/shell string 차단) — PTY 대비 의도적 강화 지점 (15 §8.1 주석, `research/codebase-backend.md` §6, §10 권고 6).

### D4. 기존 PTY/xterm runtime은 legacy/fallback/보조 터미널로 보존한다

기존 PTY runtime은 **삭제하지 않는다**. `SessionRuntimeKind = "pty" | "direct-codex" | "direct-claude"`로 host 종류를 구분하고(15 §7.1), legacy PTY output은 transcript로 끌어올리지 않고 `terminal_output_delta` event로 보존해 legacy/fallback/보조 terminal surface에만 렌더링한다(04 §3.5, 15 §3). `SessionViewMode`(`"terminal"|"editor"`)는 host 내부 surface 토글이고 runtimeKind는 host 종류 자체이므로 viewMode를 `"agent"`로 확장하지 않는다 (15 §7.2 주석, `research/codebase-frontend.md` §5, §9).

### 초기 범위 제약 (resolved defaults, 13 §"Resolved defaults")

- direct runtime은 첫 구현에서 **실험 flag 뒤**에 둔다.
- Codex·Claude 모두 **stdio 우선**. Codex websocket transport는 검증 후 optional(1차 미구현 권고; 15 §8.1 `transportKind:"websocket"` 주석).
- **transcript full cache는 1차 범위 제외** — provider replay + metadata 저장에 집중(10, 13).
- raw protocol log는 기본 비활성, redacted debug mode만(09, 13).
- Claude ACP adapter는 **npm dependency**로 정확한 버전 핀(caret 금지) (ref-claude-agent-acp §"버전 고정", 13).

---

## Alternatives considered

대안마다 "무엇을 했을 것인가 → 왜 기각했는가"를 기록한다. 모든 기각 사유는 위 Context의 검증된 사실에 근거한다.

### A. 터미널 출력 파싱을 유지/강화 (기존 xterm byte stream에서 구조 추출)

- **내용**: 기존 PTY/xterm 경로를 유지하되, byte stream에서 prompt glyph·ready signal·ANSI marker를 파싱해 message·tool call·approval을 역설계로 추출한다. 즉 `main-terminal-runtime-controller.ts`의 marker 의존(`02-current-state.md` §5)을 확장한다.
- **기각 사유**:
  1. provider가 이미 message/tool/approval/diff/usage를 **id가 붙은 구조화 event**로 노출한다(ref-codex §6·§7, ref-claude-agent-acp §2). 이를 버리고 화면 텍스트를 재파싱하면 정보를 잃고 부정확해진다.
  2. session/turn/message/tool id(15 §1.1 라우팅 키)를 화면 텍스트로 복원할 수 없다 — 동시 thread/turn 인터리빙(Codex 삼중 키 `(threadId,turnId,itemId)`, 04 §1)을 라우팅할 키가 없다.
  3. approval은 server→client request이고 응답을 `requestId`로 매칭해야 하는데(04 §4), 터미널 키 입력 emulation은 신뢰성이 없고 cancel 시 pending cleanup MUST(ACP §3.8, ref-acp §3.8 / 04 §4.2)를 보장할 수 없다.
  4. 현재도 marker 의존 회귀 위험이 명시돼 있다(`02-current-state.md` §26). 파싱을 강화하면 위험이 더 커진다.
  → 자세한 위험은 13 §"Terminal regression".

### B. 구조화 대신 더 단순한 provider CLI 모드 사용 (Codex `exec` / Claude stream-json)

- **내용**: 풀 protocol 대신 비대화형/단발 모드(예: Codex `exec` 류, Claude SDK의 stream-json 출력)를 써서 JSON line만 받아 렌더링한다.
- **기각 사유**:
  1. 이 ADR의 목표는 **대화형 데스크톱 앱식 transcript**(turn·approval·streaming delta·plan·tool card)다. 단발 exec/stream-json은 turn 재개·mid-turn approval·session resume/load 같은 대화 lifecycle을 1급으로 제공하지 않는다.
  2. Codex app-server는 thread/turn/item과 approval server-request, `thread/resume`·`thread/read`(replay)를 제공한다(ref-codex §6·§7). Claude ACP는 `session/load`·`session/resume`·`session/fork` 및 `session/request_permission`을 제공한다(ref-claude-agent-acp §2). 이 lifecycle은 persistence resume/load 정책(10, 15 §7)과 직접 연결되며, 단순 모드로는 `AgentRuntimeMetadata.canResume`/`canLoad` 계약(15 §7.1)을 채울 수 없다.
  3. permission/elicitation/terminal capability는 ACP 클라이언트 capability 게이트로만 활성화된다(ref-claude-agent-acp §2 "주의(게이트)"). 단발 모드는 이 협상 표면을 잃는다.
  → 단, **Codex websocket transport**는 별개 축(transport 방식)으로 1차 미구현·후속 검토 대상이다(13, 15 §8.1).

### C. PTY를 완전 대체 (legacy 제거)

- **내용**: direct runtime이 들어오면 PTY/xterm runtime을 삭제하고 모든 세션을 direct로 통일한다.
- **기각 사유**:
  1. direct runtime은 **첫 구현에서 실험 flag 뒤**에 두기로 했다(13 §"Resolved defaults"). flag 단계에서 PTY를 제거하면 fallback이 사라진다.
  2. 보조 터미널·임의 셸 명령 같은 비-agent 워크플로는 여전히 PTY가 필요하다. legacy PTY output은 `terminal_output_delta`로 보존하는 것이 normalized model의 명시 규칙이다(04 §3.5).
  3. 기존 `workspace.json`은 runtimeKind가 없는 세션을 갖고 있고, 이는 `"pty"`로 normalize된다(15 §7.2). 호환을 위해 PTY 경로는 유지돼야 한다(10).
  4. 기존 terminal E2E를 유지해야 회귀를 막을 수 있다(13 §"Terminal regression"). 전면 대체는 그 안전망을 제거한다.
  → 결론: PTY는 **legacy/fallback/보조 터미널**로 보존(위 D4).

---

## Consequences

### Positive

- agent message·tool call·approval·command output·diff·plan·token usage를 **구조화해 표시**할 수 있다(15 §3, §4, §5; ref-codex §6, ref-claude-agent-acp §2).
- provider session/turn/message/tool id를 **보존**한다(`ProviderRef`, 15 §1; 04 §1). resume/load·라우팅·dedup이 안정적이다.
- 동시 thread/turn stream을 삼중 키/세션 키로 **명확히 라우팅**한다(04 §1, §3.4).
- terminal marker 의존도가 줄어 marker 기반 회귀 표면이 축소된다(`02-current-state.md` §26 대비).
- backend가 framing/transport만 담당하므로(D3) protocol drift 흡수 지점이 frontend adapter 하나로 모인다(05/06).
- 새 보안 강화 지점(command/args/env allowlist, resume 토큰 scrub)을 기존 PTY 보안 경계와 일관되게 추가한다(15 §7.3, §8.1; `research/codebase-backend.md` §4.2, §10).

### Negative

- adapter·event router·process runtime·persistence migration이 추가돼 구조가 복잡해진다(03, 07, 10).
- 두 provider의 capability 차이(turn id 유무, chunk vs replace 의미, permission mode 집합)를 UI와 store가 흡수해야 한다(04 §3.2/§3.3; ref-claude-agent-acp §3).
- backend 동시성이 100% `std::thread` 기반이라(`research/codebase-backend.md` §1) JSON-RPC framing/late-attach/backpressure를 채널 없이 `Arc<Mutex>`+thread로 구현해야 한다(07).
- legacy PTY와 direct transcript가 공존하면서 host 분기(`session-factory`, `SessionShell.svelte`)와 viewMode/runtimeKind 두 축을 동시에 다뤄야 한다(15 §7.2 주석, `research/codebase-frontend.md` §5, §9, §10).

### Risks (→ 모두 13으로 연결)

- **Protocol/experimental drift**: Codex app-server는 `[experimental]`이고 일부 method/field가 capability gating된다(ref-codex §1.1, §1.4). ACP 어댑터는 0.x 라인이라 minor마다 capability·session mode·meta key가 바뀐다(ref-claude-agent-acp §4). → 13 §"Protocol drift", §"Experimental surface". 완화: 정확한 버전 핀 + CI capability 회귀 테스트(11).
- **ACP/패키지 버전 불일치**: wire `protocolVersion: 1`과 npm semver(`0.51.0`/sdk `0.29.0`)는 다른 축이다(ref-claude-agent-acp §4). 잘못 핀하면 launch가 실패하거나 capability가 어긋난다. → 13 §"Protocol drift".
- **Approval deadlock**: provider가 permission response를 기다리는 동안 UI close/cancel/process exit이 일어나면 agent가 멈춘다. cancel 시 pending approval을 cancelled로 닫는 것은 ACP MUST(ref-acp §3.8) + Codex `serverRequest/resolved`/interrupt 정리(ref-codex §4.4)와 정확히 대응한다(04 §4.2, §5). → 13 §"Approval deadlock". pending request cleanup은 runtime 필수 기능이다.
- **WSL/Windows path**: ACP는 absolute path를 요구하고 WSL/Windows/file URI를 구분해야 한다(ref-claude-agent-acp §5). → 13 §"Windows/WSL path".
- **Terminal regression**: terminal embed와 legacy PTY 공존 시 focus·shortcut·resize·bottom-follow 회귀 가능. UI 작업 전후 기존 terminal E2E 유지. → 13 §"Terminal regression".
- **Branding/제품 혼동**: Claude Agent SDK integration이 Claude Code/Anthropic 공식 제품처럼 보이면 안 된다. provider 표시·UI copy 주의. → 13 §"Branding and product confusion".

---

## 교차 참조

| 대상 | 문서 | 절 |
|---|---|---|
| normalized 타입 정본 | [`15-data-contracts.md`](15-data-contracts.md) | §1–§8 |
| 모델 규칙(상태/upsert/approval) 정본 | [`04-normalized-agent-model.md`](04-normalized-agent-model.md) | 전체 |
| 목표 아키텍처(hexagonal) | [`03-target-architecture.md`](03-target-architecture.md) | 전체 |
| 현재 PTY/xterm 구조 | [`02-current-state.md`](02-current-state.md) | §5, §26 |
| Codex wire 사실/매핑 | [`ref-codex-app-server-protocol.md`](ref-codex-app-server-protocol.md) | §0, §1, §6, §7, §8 |
| ACP wire 사실/매핑 | [`ref-acp-protocol.md`](ref-acp-protocol.md) | §3, §4, §5, §6, §13 |
| Claude ACP 구현체 capability/launch/auth | [`ref-claude-agent-acp.md`](ref-claude-agent-acp.md) | §1, §2, §3, §4, §5 |
| backend 코드 현실 | [`research/codebase-backend.md`](research/codebase-backend.md) | §1, §2, §4, §6, §10 |
| frontend 코드 현실 | [`research/codebase-frontend.md`](research/codebase-frontend.md) | §5, §9, §10 |
| 위험·기본값 | [`13-risks-open-questions.md`](13-risks-open-questions.md) | 전체 |

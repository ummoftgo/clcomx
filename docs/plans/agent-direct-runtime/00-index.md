# Direct Agent Runtime 계획서

확인일: 2026-06-25

> **먼저 읽어라**: 다운스트림 구현 에이전트는 이 색인 다음에 **[HANDOFF.md](HANDOFF.md)를 가장 먼저 읽는다.** HANDOFF는 진입 순서, 정본 규칙, 작업 분해 진입점을 한 페이지로 묶은 가이드다. 본 색인(00)은 전체 문서 지도이고, HANDOFF는 "어디부터 손대는가"를 알려준다.

## 목적

CLCOMX의 현재 에이전트 화면은 `claude`와 `codex`를 터미널 프로세스로 실행하고 출력 스트림을 xterm.js에 렌더링한다(`02-current-state.md`). 이 계획서는 터미널 에뮬레이터를 **주** 인터페이스로 삼는 구조에서 벗어나, Codex Desktop App·Claude Desktop App에 가까운 **직접 통신(direct) 기반 구조화 transcript UI**로 전환하기 위한 대형 작업 계획이다. 구체적으로는:

- Codex는 `codex app-server`의 **app-server protocol**(JSON-RPC, thread/turn/item 모델)을 1차 연결면으로 삼는다.
- Claude는 **Agent Client Protocol(ACP)**과 `@agentclientprotocol/claude-agent-acp`를 1차 연결면으로 삼는다.
- 두 provider의 wire 차이를 **공통 normalized agent model**(`04`/`15`)로 흡수해 UI·persistence가 protocol에 직접 결합되지 않게 한다.

## 범위

- Codex/Claude를 위한 **direct runtime family**를 새 feature 레이어로 추가한다(`src/lib/features/agent-runtime/`, Rust `features/agent_runtime/` + `commands/agent_runtime.rs`).
- 기존 PTY/xterm 기능은 **삭제하지 않는다.** direct runtime 도입 후에도 보조 셸, 명령 출력 embed, fallback 경로, legacy 세션 호환으로 유지한다(`02`, `10`). `pty_*`와 `agent_runtime_*`은 네임스페이스를 분리한다(`15` §8).
- 첫 구현은 실험 flag 뒤에 두고 stdio transport를 우선한다. transcript full cache는 1차 범위에서 제외(provider replay + metadata 저장 우선). 확정 기본값은 `13`에 모았다.
- 외부 근거는 공식 또는 라이선스가 명확한 오픈소스 자료만 사용한다. 유출본·출처 불명 mirror·라이선스 불명 Claude Code 소스는 제외한다(`01`).

## 정본 규칙 (single source of truth)

이 문서 집합은 **권위가 분산되지 않도록** 정본을 한 곳으로 고정한다. 충돌 시 아래 우선순위를 따른다.

| 주제 | 정본 문서 | 다른 문서의 역할 |
|---|---|---|
| **타입 정의**(`AgentEvent`/`ProviderRef`/`ToolCallUpdate`/`Approval*`/`AgentRuntimeMetadata`/`JsonRpcMessage`/`AgentRuntimeStartParams` 등 모든 TS·Rust 타입) | **[15-data-contracts.md](15-data-contracts.md)** | 재정의 금지. §번호로 인용·링크만 한다. |
| **개념·규칙·불변식**(상태 머신 전이, upsert/append/reconcile, 순서 보존, approval 생명주기, 식별자 라우팅) | **[04-normalized-agent-model.md](04-normalized-agent-model.md)** | 규칙은 04를 인용. 타입은 15로 링크. |
| **provider wire 사실**(Codex/ACP/Claude 실제 메서드·payload·매핑표) | **ref-\*** (`ref-codex-app-server-protocol.md`, `ref-acp-protocol.md`, `ref-claude-agent-acp.md`) | wire shape는 ref §번호로 인용. |
| **코드 현실**(현 backend/frontend 구조·심볼·경로) | **실제 코드(`src/`·`src-tauri/`)가 정본.** 보조 스냅샷: **`research/codebase-backend.md`·`codebase-frontend.md`**(해당 git ref 시점 매핑) | 코드 인용은 research §번호로 하되 **충돌 시 실제 코드가 우선**이며 대조 후 사용. `research/ux-reference.md`는 외부 UX 참고자료(코드 아님). |
| **위험·open question·확정 기본값** | **[13-risks-open-questions.md](13-risks-open-questions.md)** | 미확정(unverified)·결정 필요 항목은 13으로 연결한다. |

추정과 확인된 사실을 항상 구분한다. 미확정 항목은 `unverified` 또는 `결정 필요`로 명시하고 13에 등록한다.

## 문서 순서와 읽기 가이드

핵심 코어 문서는 **04·15**(규칙·타입 정본)와 **ref-\*** (wire 사실)다. 어댑터를 구현하기 전에 이 셋을 먼저 내재화한다.

### 진입 가이드

- **[HANDOFF.md](HANDOFF.md)**: 다운스트림 구현 에이전트용 진입 가이드. 읽는 순서, 정본 규칙 요약, 첫 작업 진입점. **가장 먼저 읽는다.**
- **[00-index.md](00-index.md)** (이 문서): 전체 문서 지도, 목적·범위, 정본 규칙, 완료 기준.

### 배경·조사

- **[01-source-map.md](01-source-map.md)**: 조사한 공식/오픈소스 자료, 버전 핀(Codex `rust-v0.142.0`, ACP `schema-v1.16.0`, `claude-agent-acp@0.51.0`), 제외 기준, 구현 전 재확인 체크리스트.
- **[02-current-state.md](02-current-state.md)**: 현재 PTY/xterm 중심 실행 흐름과 그 한계.

### 설계 코어

- **[03-target-architecture.md](03-target-architecture.md)**: 목표 hexagonal 아키텍처(UI → Store → Router → Runtime Port → Adapter → Tauri Process Runtime), 데이터 흐름, 설계 원칙.
- **[04-normalized-agent-model.md](04-normalized-agent-model.md)** — **규칙 정본**: 공통 이벤트/세션 모델의 상태 머신, upsert/append/reconcile, 순서 보존, approval 생명주기, 식별자 라우팅 규칙.
- **[15-data-contracts.md](15-data-contracts.md)** — **타입 정본**: normalized model·Runtime Port·persistence·Tauri command/event의 모든 TS/Rust 타입 정의와 정본 type 인덱스.

### 어댑터·런타임

- **[05-codex-app-server-adapter.md](05-codex-app-server-adapter.md)**: Codex app-server 어댑터 설계(JSON-RPC envelope, thread/turn/item 라우팅, generated 타입).
- **[06-claude-acp-adapter.md](06-claude-acp-adapter.md)**: Claude ACP 어댑터 설계(stdio JSON-RPC, `claude-agent-acp` launch/capability, turn id 합성).
- **[07-tauri-process-runtime.md](07-tauri-process-runtime.md)**: Tauri backend process/runtime(subprocess lifecycle, stdio framing, stderr capture, bounded queue/backpressure, WSL 경계, cancel/cleanup).

### UI·보안·저장

- **[08-ui-composition.md](08-ui-composition.md)**: 데스크톱 앱식 transcript UI 구성(view/controller/state, tool card, approval, composer, terminal surface 공존).
- **[09-permissions-security.md](09-permissions-security.md)**: 권한·보안·감사 경계(allowlist, approval 신뢰 경계, secret scrub, redacted debug).
- **[10-persistence-migration.md](10-persistence-migration.md)**: 저장·복원·migration(runtime kind/metadata 확장, resume/load 정책, scrub, forward/backward 호환).

### 검증·실행

- **[11-testing-acceptance.md](11-testing-acceptance.md)**: 테스트·수용 기준(fixture replay, adapter unit, Tauri command, frontend rendering, E2E 회귀).
- **[12-implementation-workstreams.md](12-implementation-workstreams.md)**: 작업 분해(모듈 배치, 워크스트림, 의존 순서, 체크리스트).
- **[13-risks-open-questions.md](13-risks-open-questions.md)** — **위험·결정 정본**: 위험, 확정 기본값, open question 등록처.

### 다이어그램·결정·용어

- **[14-sequence-and-state.md](14-sequence-and-state.md)**: 시퀀스/상태 다이어그램(세션 시작·prompt turn·approval·cancel·process exit·resume의 mermaid 시각화).
- **[adr-001-direct-agent-runtime.md](adr-001-direct-agent-runtime.md)**: direct runtime 도입 아키텍처 결정 기록(맥락·결정·대안·결과).
- **[16-glossary.md](16-glossary.md)**: 용어집(provider 식별자, normalized 개념, protocol 용어, CLCOMX 내부 용어 정의).

### 프로토콜 레퍼런스 (wire 정본)

- **[ref-codex-app-server-protocol.md](ref-codex-app-server-protocol.md)**: Codex app-server protocol wire 레퍼런스(메서드·notification·타입·reconcile·매핑표). pinned `rust-v0.142.0`.
- **[ref-acp-protocol.md](ref-acp-protocol.md)**: Agent Client Protocol wire 레퍼런스(content/tool/permission, session/update, 매핑표). pinned `schema-v1.16.0`, wire `protocolVersion=1`.
- **[ref-claude-agent-acp.md](ref-claude-agent-acp.md)**: `@agentclientprotocol/claude-agent-acp` + Claude Agent SDK 외부 사실(capability·launch·auth). pinned `@0.51.0`.

### 코드 현실·참고 (research)

> `research/codebase-*.md`는 해당 git ref 시점의 코드 구조를 박제한 **스냅샷**이다. **충돌 시 실제 코드(`src/`·`src-tauri/`)가 정본**이고, 인용된 경로·심볼·줄번호는 실제 코드와 대조해 쓴다. `ux-reference.md`는 코드가 아닌 **외부 UX 참고자료**다.

- **[research/codebase-backend.md](research/codebase-backend.md)**: 현 Rust backend 구조(PTY 상태 모델, command/event 등록, scrub, allowlist) 스냅샷.
- **[research/codebase-frontend.md](research/codebase-frontend.md)**: 현 frontend 구조(feature 레이어, host 분기, transport 래퍼, 타입 확장 지점) 스냅샷.
- **[research/ux-reference.md](research/ux-reference.md)**: 구조화 transcript UI 패턴 외부 UX 레퍼런스(코드 아님).

## 완료 기준

- 구현자가 **이 문서 집합만 읽고** Codex와 Claude 각각의 adapter를 독립적으로 구현할 수 있다: 입력·출력·상태·오류·권한 흐름이 정의되어 있고, 모든 타입은 15에서, 규칙은 04에서, wire 사실은 ref-\*에서 확정적으로 인용된다.
- **정본 분리가 일관**된다: 타입은 15에만, 규칙은 04에만 정의되고 다른 문서는 §번호 인용·링크만 한다. 중복 정의나 권위 충돌이 없다.
- 현재 PTY 기반 기능과 새 direct runtime의 **경계가 명확**하다(`pty_*` vs `agent_runtime_*`, runtimeKind, viewMode 분리).
- session, turn, message, tool call, approval, command output, file change, process exit가 공통 모델(`04`/`15`)에서 표현된다.
- 테스트 계획(`11`)이 fixture replay, adapter unit test, Tauri command test, frontend rendering test, E2E 회귀를 모두 포함한다.
- 모든 **미확정·결정 필요** 항목이 `unverified`/`결정 필요`로 표시되어 13에 등록되어 있다.

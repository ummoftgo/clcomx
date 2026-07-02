# HANDOFF — Direct Agent Runtime 구현/검증 진입 가이드

> Direct Agent Runtime 작업의 1페이지 진입점. 이 계획은 설계·조사 문서에서 출발했지만, 현재 브랜치에는 direct runtime 코드·테스트·문서 보강이 함께 존재한다. 새 작업자는 문서 정본과 현재 worktree를 모두 확인한 뒤 남은 OQ/verification slice를 이어간다.

## 한 문단 요약

CLCOMX는 현재 `claude`/`codex`를 PTY로 실행하고 xterm.js에 byte stream을 렌더링한다. 이 계획은 그 터미널 중심 구조를, Codex/Claude 데스크톱 앱처럼 **구조화된 transcript UI**(message/tool card/plan/approval/diff)를 그리는 새 runtime family로 대체한다. Codex는 `codex app-server`(JSON-RPC over stdio), Claude는 ACP(`@agentclientprotocol/claude-agent-acp`, JSON-RPC 2.0 over stdio)에 직접 연결한다. provider 차이는 **adapter**가 흡수해 CLCOMX 공통 **normalized model**(`AgentEvent`/`ProviderRef`/`ToolCallUpdate`/`Approval*`)로 바꾸고, UI/store는 그 공통 모델과 `AgentRuntimePort`만 본다(hexagonal). 기존 PTY/xterm은 삭제하지 않고 보조 셸·명령 embed·fallback·raw diagnostic으로 보존한다.

## 읽는 순서

아래 순서대로 읽으면 전체 그림 → 규칙·타입 정본 → wire 사실 → 구현 세부로 좁혀진다.

1. [00-index.md](00-index.md) — 목적·범위·완료 기준
2. [02-current-state.md](02-current-state.md) — 현재 PTY/xterm 구조(무엇을 바꾸는가)
3. [03-target-architecture.md](03-target-architecture.md) — 목표 hexagonal 아키텍처(Port/Adapter/Router/Store)
4. [04-normalized-agent-model.md](04-normalized-agent-model.md) **+** [15-data-contracts.md](15-data-contracts.md) — **규칙 정본 + 타입 정본**(반드시 함께 읽는다)
5. `ref-*` — wire 사실 정본: [ref-codex-app-server-protocol.md](ref-codex-app-server-protocol.md), [ref-acp-protocol.md](ref-acp-protocol.md), [ref-claude-agent-acp.md](ref-claude-agent-acp.md)
6. [05-codex-app-server-adapter.md](05-codex-app-server-adapter.md) / [06-claude-acp-adapter.md](06-claude-acp-adapter.md) / [07-tauri-process-runtime.md](07-tauri-process-runtime.md) — adapter·backend runtime 설계
7. [08-ui-composition.md](08-ui-composition.md) — 데스크톱 앱식 UI 구성(transcript surface)
8. [09-permissions-security.md](09-permissions-security.md) / [10-persistence-migration.md](10-persistence-migration.md) — 권한·보안·감사 / 저장·복원·migration
9. [11-testing-acceptance.md](11-testing-acceptance.md) / [12-implementation-workstreams.md](12-implementation-workstreams.md) — 테스트·수용 기준 / 작업 분해
10. [13-risks-open-questions.md](13-risks-open-questions.md) / [14-sequence-and-state.md](14-sequence-and-state.md) — 위험·기본값 / 시퀀스·상태 다이어그램

보조: [16-glossary.md](16-glossary.md)(용어집, 3축 구분 포함), [research/](research/)(코드 현실 근거), [01-source-map.md](01-source-map.md)(버전 핀), [adr-001-direct-agent-runtime.md](adr-001-direct-agent-runtime.md)·[adr-002-transcript-memory.md](adr-002-transcript-memory.md)(결정 기록).

## 각 문서의 역할 (한 줄)

| 문서 | 역할 |
|---|---|
| 00-index | 계획 목적·범위·완료 기준 |
| 01-source-map | 조사 근거와 baseline 버전(Codex `rust-v0.142.0`, ACP `schema-v1.16.0`은 baseline 후보, 현 구현 핀은 `@agentclientprotocol/claude-agent-acp@0.51.0` → SDK `0.29.0` package schema/types) |
| 02-current-state | 현재 PTY/xterm 구조 |
| 03-target-architecture | 목표 아키텍처(Port/Adapter/Router/Store/Runtime) |
| **04-normalized-agent-model** | **규칙 정본** — 상태 머신·upsert/append/replace/reconcile·approval 생명주기 |
| 05-codex-app-server-adapter | Codex adapter 설계 |
| 06-claude-acp-adapter | Claude ACP adapter 설계 |
| 07-tauri-process-runtime | Rust backend process/transport/framing/lifecycle |
| 08-ui-composition | transcript surface UI 구성 |
| 09-permissions-security | 권한·보안·감사·allowlist·scrub |
| 10-persistence-migration | 저장·복원·migration·transcript 정책 |
| 11-testing-acceptance | 테스트 계획·수용 기준 |
| 12-implementation-workstreams | Phase 0–7 작업 분해·병렬화·모듈 경로 |
| 13-risks-open-questions | 위험·확정 기본값·**unverified 레지스트리** |
| 14-sequence-and-state | 시퀀스/상태 다이어그램 |
| **15-data-contracts** | **타입 정본** — 모든 TS/Rust 타입 |
| 16-glossary | 용어집·Codex/ACP/CLCOMX 대응표·3축 구분 |
| **17-coding-conventions** | **코딩 규약 정본** — 도메인 단위 파일 분리·2000줄 임계, 한글 doc-comment(JSDoc/rustdoc) |
| adr-001 | 아키텍처 결정 기록 |
| adr-002 | 긴 세션 transcript 메모리 모델 결정 기록(shallow 반응형 + sealed-turn eviction) |
| ref-* | **wire 정본** — Codex/ACP/Claude 프로토콜 사실 |
| research/* | 코드 현실 **스냅샷**(backend/frontend, 해당 ref 시점; 충돌 시 실제 코드 우선) + 외부 UX 참고(ux-reference) |

## 구현 시작 방법

1. **[12](12-implementation-workstreams.md) Phase 흐름을 작업 지도처럼 사용한다.** 새로 구현을 시작하는 경우에는 Phase 0 → 1(공통 모델·store) → 2(Tauri JSON-RPC runtime) → 3(Codex adapter) → 4(Claude adapter) → 5(UI) → 6(persistence) → 7(verification) 순서를 따른다. 현재 구현 브랜치에서 이어가는 경우에는 [impl-log.md](impl-log.md), [11](11-testing-acceptance.md) §8/§9, [13](13-risks-open-questions.md)을 먼저 확인하고 이미 완료된 Phase를 반복 구현하지 않는다. 모듈 경로는 12 "구현 모듈 배치"에 명시돼 있다(`src/lib/features/agent-runtime/...`, `src-tauri/src/features/agent_runtime/`).
2. **정본 우선순위를 지킨다 — 절대 재정의·재발명 금지.**
   - **타입은 [15](15-data-contracts.md)가 정본.** `AgentEvent`/`ProviderRef`/`ToolCallUpdate`/`Approval*`/`AgentRuntimeMetadata`/`JsonRpcMessage`/`AgentRuntimeStartParams` 등은 15를 복사/import한다. 다른 문서에서 본 타입과 충돌하면 15가 이긴다([15](15-data-contracts.md) §9 type 인덱스).
   - **규칙은 [04](04-normalized-agent-model.md)가 정본.** 상태 전이·upsert/reconcile·approval cleanup 불변식은 04를 따른다.
   - **wire 사실은 `ref-*`가 정본.** provider 메시지 shape/필드/enum 값은 ref 문서 §번호로 확인한다. 추측하지 않는다.
3. **빌드 컨벤션을 따른다.** TS는 `src/lib/tauri/core.ts`의 `invoke`, `src/lib/tauri/event.ts`의 `listen`만 사용(직접 `@tauri-apps/api` import 금지). Rust command는 `Result<T, String>` 반환, 경계 struct는 `#[serde(rename_all="camelCase")]`([15](15-data-contracts.md) §0 컨벤션). 코드 스타일 — 도메인 단위 파일 분리(2000줄 임계 검토)와 클래스/함수 한글 doc-comment(JSDoc/rustdoc) — 은 [17](17-coding-conventions.md)이 정본이며, 12의 각 task DoD에도 편입돼 있다([17](17-coding-conventions.md) §C.2).
4. **보안 경계를 먼저 세운다.** `provider_session_id`/`provider_thread_id`/`provider_resume_token`은 디스크 저장 직전 scrub([15](15-data-contracts.md) §7.3). executable `command`는 renderer 입력에서 제거하고 backend가 provider로 resolve하며, `args`/`env`는 Rust handler에서 provider별 allowlist 재검증([15](15-data-contracts.md) §8.1, [09](09-permissions-security.md)). approval cleanup(turn cancel/shutdown은 `cancelled`+wire, process exit은 `failed`(내부)로 pending을 닫기)은 runtime 필수 기능이다([04](04-normalized-agent-model.md) §4.2·§5.0).

## 시작 전 반드시 확인

- **현재 작업 루트와 브랜치를 먼저 확인한다.** 문서에 남은 절대경로는 조사 당시 환경의 예시일 수 있다. 작업 시작 시 `pwd`, `git rev-parse --show-toplevel`, `git status --short --branch`를 실행하고, 12의 모든 파일 경로는 확인된 저장소 루트 기준 상대경로로 해석한다. 이 문서 정리 시점(2026-06-25)에 확인한 루트는 `/home/xenia/work/claudemx`, 당시 브랜치는 `codex/direct-agent-runtime-docs`였고, 구현 브랜치는 OQ-41 기록처럼 `feat/agent-runtime-impl`이다.
- **unverified / 결정 필요 항목은 [13-risks-open-questions.md](13-risks-open-questions.md)를 먼저 확인한다.** 계획서 곳곳에 "unverified" 또는 "결정 필요"로 표시된 항목은 13 레지스트리에서 현재 결정 상태를 본 뒤 진행한다. 확정 전이면 13에 결정을 기록하고 움직인다. 이미 해소된 예: `agent_thought_chunk`/reasoning 채널(OQ-01), `audio` raw 보존(OQ-04), ACP `usage_update` 매핑(OQ-02), Codex `ClientInfo`/`InitializeCapabilities`와 `initialize` 핸드셰이크(OQ-07/OQ-11), websocket transport v1 reject-before-log/authToken redaction gate(OQ-15), approval audit v1 in-memory 경계(OQ-51), transcript memory v1 기본 cap(OQ-52), Codex `thread/read(includeTurns)` full snapshot 범위와 replay partial notice 방어(OQ-54), Codex reasoning completed `summary[]` 권위 필드(OQ-46), workspace file + Codex `fuzzyFileSearch`/`skills/list` `@` mention과 resource action button, image attach/paste/drop/reference token 경로(OQ-56), realtime raw event v1 internal bridge + public diagnostic 미노출(OQ-59), tool location callback과 `SessionShell` internal/external editor 단위 흐름 및 E2E-11 internal/external default·picker command-payload spec 기반(OQ-61), post-start fatal runtime error notice/no-fallback v1 E2E 하한(OQ-60), `claude-agent-acp` `0.51.0` + sdk `0.29.0` 13종 `session/update` 기준(OQ-08/OQ-32), Claude node/native startup preflight 하한 및 현재 로컬 WSL target node/native resolve 확인(OQ-10). 아직 열린 예: 릴리스/설치 배포 matrix의 node/claude/SDK 버전·OS/WSL 조합 재확인(OQ-10), same-turn late notification wire 실측(OQ-53), OQ-52의 대용량 세션 운영 튜닝, ACP resource source·provider-backed richer image source·`$` composer 후속(OQ-56), DOM 가상화 튜닝(OQ-58), post-start fatal recovery UX와 full typed failure-code taxonomy(OQ-60), 실제 external editor focus·line reveal 검증(OQ-61).
- **OQ-56 ACP resource source 경계(2026-06-30)**: 현재 핀 `@agentclientprotocol/sdk@0.29.0`/`@agentclientprotocol/claude-agent-acp@0.51.0`에는 prompt content `resource_link`/embedded `resource`와 `embeddedContext` capability만 있고 resource search/list request가 없다. `AgentRuntimePort.searchResources`의 Claude ACP 구현은 빈 결과를 반환해 workspace fallback을 쓰는 것이 v1 경계이며, "ACP resource source" 후속은 protocol/package에 해당 RPC가 추가되거나 별도 client-side source 정책을 정할 때만 다시 연다.
- **버전 핀을 재확인한다.** Codex `rust-v0.142.0`, ACP wire `protocolVersion = 1` + schema baseline 후보 `schema-v1.16.0`(구현 핀 아님), `@agentclientprotocol/claude-agent-acp@0.51.0`(commit `23626c9`, sdk `0.29.0` 의존)은 조사 baseline이다. 초기 구현의 T0.0/OQ-41 preflight는 완료됐고, 현재 구현 기준은 [01](01-source-map.md) §4와 [13](13-risks-open-questions.md) OQ-41/RD-7에 기록돼 있다. 향후 dependency refresh, schema 재생성, target 환경 재검증 때만 같은 절차로 fresh CLI/schema/package diff와 fixture replay를 확인한다.

## Build / Run gate (AGENTS.md 준수)

CLCOMX `AGENTS.md`의 Build/Run gate를 지킨다.

- `test build → app launch`는 **명시적 검증 패스의 시작**이지 중간 단계가 아니다. 아직 따라올 구현·문서·정리가 남은 슬라이스에서는 앱을 띄우지 않는다.
- app launch는 구현 슬라이스가 정리된 뒤 **한 번만** 수행한다([12](12-implementation-workstreams.md) Phase 7). Windows/WSL E2E smoke는 direct runtime과 legacy PTY 양쪽에서 돌린다.
- 빌드 명령이 끝까지 완료됐고 launch가 그 슬라이스의 최종 산출물에 해당하는지 보고 전 확인한다.

## 문서와 구현 상태에 대한 명시

이 문서 집합(00–17, adr-*, ref-*, research/*, HANDOFF)은 최초 설계·조사 산출물에서 출발했지만, 현재는 구현 진행 중의 계획/결정/검증 로그로 함께 쓰인다. 실제 코드 상태는 현재 worktree가 권위이고, 구현·검증 증거는 [impl-log.md](impl-log.md)에 누적한다. 모호한 지점은 추측 대신 정본(15/04/ref)·레지스트리(13)·현재 코드/테스트를 함께 확인한다.

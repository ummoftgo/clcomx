# Source Map

> 이 문서는 CLCOMX "Direct Agent Runtime" 계획의 **조사 근거와 버전 핀**을 모은다. 각 프로토콜은 별도 ref 문서로 1차 소스에서 검증되었으며, 본 문서는 그 검증 결과를 요약하고 ref로 링크한다. 코드 현실 근거는 `research/*`에 있다.

확인일: 2026-06-25 (초기 조사 2026-06-24, 버전 핀 검증 2026-06-25)

---

## 0. 검증 상태 요약 (baseline pins)

ref-* 3종은 **각 프로토콜의 1차 소스(저장소 태그 소스/생성 schema/패키지 메타데이터)를 기준으로 작성한 baseline 조사 결과**다. 아래 값은 ref 문서의 §0(버전 축 절)과 일치하되, 구현 핀은 T0.0/OQ-41 preflight에서 현재 public artifact와 대조한 뒤 확정한다.

| 프로토콜 / 구현체 | baseline / pinned 값 | wire/protocol 축 | 검증 근거(ref) |
|---|---|---|---|
| OpenAI Codex app-server | git tag `rust-v0.142.0`, CLI `codex-cli 0.142.0` | protocol **v2**(thread/turn/item); `initialize`만 v1 | [`ref-codex-app-server-protocol.md`](ref-codex-app-server-protocol.md) §0 |
| Agent Client Protocol (ACP) | schema baseline 후보 `schema-v1.16.0` (**구현 핀 아님; T0.0/OQ-41에서 public artifact 확정**) | wire `protocolVersion = 1` (stable; v2는 unstable draft) | [`ref-acp-protocol.md`](ref-acp-protocol.md) §0 |
| Claude ACP adapter | `@agentclientprotocol/claude-agent-acp@0.51.0` (release commit `23626c9`) | ACP `protocolVersion = 1` 회신 | [`ref-claude-agent-acp.md`](ref-claude-agent-acp.md) §버전 고정, §4 |

> **주의 — baseline과 구현 시점 검증을 분리한다.** 위 값은 ref 문서를 작성한 조사 baseline이다. Codex/ACP/Claude adapter는 릴리스 주기가 빠르므로 구현 착수 직전 `codex --version`, `codex app-server generate-ts`, ACP public tag/release 및 패키지 내 schema artifact, `npm view @agentclientprotocol/claude-agent-acp version`을 다시 확인한다. baseline과 현재 환경이 다르면 자동으로 문서 값을 따라가지 말고 schema diff와 fixture replay 결과를 13 OQ-41에 기록한 뒤 결정한다.

> **세 개의 독립 버전 축을 혼동하지 말 것**([`ref-acp-protocol.md`](ref-acp-protocol.md) §0):
> 1. **wire protocolVersion** (ACP는 정수 `1`, Codex는 v1/v2 표면 구분) — `initialize`로 협상하는 값.
> 2. **schema release tag** (ACP baseline 후보 `schema-v1.16.0`, Codex `rust-v0.142.0`) — 저장소가 타입을 배포하는 semver 태그. protocol version과 독립적으로 자주 올라간다. ACP의 실제 생성 타입 artifact는 T0.0/OQ-41에서 확정한다.
> 3. **구현체 패키지 버전** (Claude adapter `0.51.0`) — 실제 실행하는 바이너리/패키지 semver.

---

## 1. 사용 가능한 근거

### 1.1 OpenAI Codex app-server

- 저장소: https://github.com/openai/codex
- pinned git ref: **`rust-v0.142.0`** (2026-06-22). `gh api repos/openai/codex/git/refs/tags`로 태그 실재 확인, 로컬 `codex-cli 0.142.0`과 일치 (ref-codex §0).
- 1차 ref 문서: [`ref-codex-app-server-protocol.md`](ref-codex-app-server-protocol.md) — `rust-v0.142.0` 태그의 소스를 **직접 읽어** transport/JSON-RPC framing, lifecycle, method 카탈로그, 핵심 타입(`Thread`/`Turn`/`ThreadItem`/`TokenUsageBreakdown`/`TurnPlanStep`/`CodexErrorInfo`), reconcile 규칙, normalized 매핑을 기술했다(§1–§8).
- 읽은 핵심 소스(모두 `rust-v0.142.0`): `app-server-protocol/src/jsonrpc_lite.rs`, `schema/typescript/{ClientRequest,ServerNotification,ServerRequest,ClientNotification}.ts`, `protocol/v2/{thread,turn,item,thread_data,command_exec,permissions,shared,notification}.rs` (ref-codex §0 표).

확인된 핵심 사실: app-server-protocol에는 레거시 `v1`과 현행 `v2`가 공존하며 `initialize`만 v1을 쓴다. **CLCOMX adapter는 v2(thread/turn/item) 모델을 타겟으로 한다**(ref-codex §0). 또한 Codex app-server는 `jsonrpc` 필드를 보내지도 기대하지도 않는다(ref-codex §1.2) — [15](15-data-contracts.md) §8.1 `JsonRpcMessage`가 `jsonrpc`를 optional로 둔 이유.

Codex 계획은 CLI terminal 출력 파싱이 아니라 app-server protocol을 1차 근거로 삼는다. `codex exec`/TypeScript SDK JSONL event는 fixture/fallback 참고로만 쓴다.

### 1.2 Agent Client Protocol (ACP)

- 문서: https://agentclientprotocol.com
- 저장소: https://github.com/agentclientprotocol/agent-client-protocol
- schema baseline 후보: **`schema-v1.16.0`** (2026-06-24 조사값, **구현 핀 아님**). wire **`protocolVersion = 1`**(stable).
- 1차 ref 문서: [`ref-acp-protocol.md`](ref-acp-protocol.md) — baseline 후보 schema cut의 `schema/v1` JSON Schema와 `agent-client-protocol-schema/src/version.rs`를 근거로 transport/JSON-RPC 2.0, lifecycle(initialize/session_new/load/resume/prompt/cancel), `ContentBlock`, `ToolCall`/`ToolCallUpdate`, permission, fs/terminal client method, MCP config, modes/usage, error code, normalized 매핑을 기술했다(§1–§13). 실제 구현 타입 정본은 T0.0/OQ-41에서 public artifact와 대조 후 확정한다.

확인된 핵심 방향: CLCOMX adapter는 **stable wire `protocolVersion = 1`**을 타겟으로 구현한다(ref-acp §0). v2(draft)는 `session/set_mode` 제거·`fs/*`/`terminal/*` 재배치 논의 중이므로 **참고만** 한다. `schema-v1.16.0`은 구현 핀이 아니며, 생성 타입 정본으로 쓸 ACP artifact는 T0.0/OQ-41에서 확정한다.

### 1.3 Claude Agent / ACP Adapter

- 공식 SDK 문서: https://code.claude.com/docs/en/agent-sdk/overview
- ACP adapter 저장소: https://github.com/agentclientprotocol/claude-agent-acp
- pinned 패키지: **`@agentclientprotocol/claude-agent-acp@0.51.0`** (git tag `v0.51.0`, release commit `23626c9a43b4fa2b4e98cf1abb25c55985711075`, 2026-06-24). `gh api .../tags`로 확인 (ref-claude §버전 고정).
- 의존: `@anthropic-ai/claude-agent-sdk@0.3.187`, `@agentclientprotocol/sdk@0.29.0`, node engine `>=22`, ESM. `initialize`는 `protocolVersion = 1`을 회신(`src/acp-agent.ts` 836행, ref-claude §4).
- 로컬 CLI: `2.1.187 (Claude Code)`.
- 1차 ref 문서: [`ref-claude-agent-acp.md`](ref-claude-agent-acp.md) — adapter process 실행 방법(bin `claude-agent-acp`, executable+argv), 광고 capability vs 코드 근거, permission mode ↔ ACP session mode/request_permission 매핑, protocol version 호환성, WSL node bin 실행 전제를 기술했다(§1–§5).

확인된 핵심 사실: 구버전 `@zed-industries/claude-code-acp`(마지막 `0.16.2`)는 **rename·deprecated**되었고 bin 이름이 `claude-code-acp`→`claude-agent-acp`로 바뀌었다. **새 dependency에는 신버전만 쓰고 launch 커맨드를 그대로 옮기면 안 된다**(ref-claude §구버전과의 관계). `0.x` 라인이라 minor마다 capability·session mode·meta key가 바뀌므로 **정확한 버전 핀 + CI capability 회귀 테스트**를 권장(ref-claude §4, §6).

Claude 계획은 `claude -p --output-format stream-json`을 주 경로로 삼지 않는다. stream-json은 진단/fallback으로만 남긴다.

### 1.4 UX 참고 자료

구조화된 transcript UI 패턴(메시지/streaming, tool card, content block, plan/reasoning, terminal embed, approval, composer)은 ACP 문서·Zed Agent Panel·Codex IDE·Claude Code interactive/fullscreen 문서에서 추출했다. 상세 출처·버전 앵커·매핑은 [`research/ux-reference.md`](research/ux-reference.md) §0(자료 출처 표)에 있다. **상호작용/레이아웃/정보구조 패턴만 추출하고 시각/브랜딩/카피는 복제하지 않는다**(이 문서 §3 제외 자료, [09](09-permissions-security.md) 브랜드 항목).

---

## 2. 코드 현실 근거 (`research/*`)

| 자료 | 대상 ref | 범위 |
|---|---|---|
| [`research/codebase-backend.md`](research/codebase-backend.md) | commit `e7a5f9e` | PTY runtime 해부, command 등록 패턴, 영속화(workspace/settings/history)·scrub 경계, WSL 경계·OSC·resume fallback, Rust 동시성/에러 컨벤션, direct runtime 신설 위치 |
| [`research/codebase-frontend.md`](research/codebase-frontend.md) | commit `e7a5f9e` | feature 레이어 규약, terminal feature 지도, 세션/탭 흐름, invoke/listen 래퍼, 도메인 모델, i18n/설정 UI, host 분기 전략, 연동점 체크리스트 |
| [`research/ux-reference.md`](research/ux-reference.md) | 외부 문서 | transcript UI 패턴 1차 추출 + CLCOMX 매핑 |

현재 PTY/xterm 구조의 코드 레벨 기술은 [02](02-current-state.md)에 정리되어 있다.

---

## 3. 제외 자료

- Claude Code 유출본, 비공식 decompiled source, 출처 불명 mirror
- 라이선스가 명확하지 않은 fork 또는 gist
- 최신 공식 protocol과 맞지 않는 오래된 블로그의 wire shape
- UX를 베끼기 위한 브랜드/시각 요소 복제 자료

---

## 4. 구현 전 재확인 체크

> ref-* 문서는 조사 시점 소스에서 검증되었으나, `0.x`/빈번한 schema 릴리스 특성상 **구현 착수 직전 아래를 반드시 재확인**한다. 미확정/결정 필요 항목은 [13](13-risks-open-questions.md)로 라우팅한다.

### 4.1 Codex

- [ ] `codex app-server --help`에서 `generate-ts`, `generate-json-schema`, `--listen` 옵션 확인.
- [ ] `codex app-server generate-ts` 결과를 `src/lib/features/agent-runtime/generated/codex-app-server/`의 생성 타입과 비교(ref-codex §0의 schema 산출물 기준).
- [ ] 로컬 CLI 버전이 baseline `rust-v0.142.0`과 다르면 thread/turn/item 표면 diff 확인. 최신 릴리스가 존재해도 schema diff와 adapter fixture가 통과하기 전에는 핀을 임의로 올리지 않는다.

### 4.2 ACP

- [ ] ACP public release/tag 목록, 패키지 내 `schema/v1` artifact, adapter가 실제 협상하는 `protocolVersion`(=1)을 대조한다(ref-acp §0, ux-reference §0 주의). baseline 후보 `schema-v1.16.0`과 public artifact가 다르면 어느 artifact를 생성 타입의 정본으로 쓸지 13 OQ-41에 기록하고, 확정 전에는 ACP 타입 생성/매핑 구현을 시작하지 않는다. 구현 핀 확정 시 생성 타입은 sdk `0.29.0`(`session/update` 13 variant, 13 OQ-32) 정합을 확인한다 — public artifact를 고르더라도 13종 정본을 우선한다.
- [ ] `agent_thought_chunk`/`user_message_chunk`의 정확한 discriminator를 schema에서 확정([15](15-data-contracts.md) §3 모델 gap, [`research/ux-reference.md`](research/ux-reference.md) §12-2).
- [ ] ACP diff content(`oldText`/`newText`) → [15](15-data-contracts.md) §4 `{type:"diff", patch}` 변환 규칙 확정([`research/ux-reference.md`](research/ux-reference.md) §12-3).

### 4.3 Claude adapter

- [ ] `@agentclientprotocol/claude-agent-acp` 버전을 정확히 핀(`0.51.0`)하고 caret 범위를 쓰지 않는다(ref-claude §버전 고정).
- [ ] adapter가 회신하는 `protocolVersion`이 `1`인지 확인, 불일치 시 protocol error 처리(ref-claude §4).
- [ ] **`@zed-industries/claude-code-acp`(deprecated)는 새 의존성에 추가하지 않는다.** bin 이름 차이(`claude-code-acp` vs `claude-agent-acp`) 주의(ref-claude §구버전과의 관계).
- [ ] CI에 capability 회귀 테스트 추가(minor마다 capability/session mode 변동 가능, ref-claude §4, §6).

### 4.4 환경/브랜딩

- [ ] WSL에서 node `>=22` 기반 bin 실행 전제 확인(ref-claude §5).
- [ ] Anthropic Agent SDK 약관과 branding guideline 확인: 제품이 Claude Code 또는 Anthropic 제품처럼 보이면 안 된다([13](13-risks-open-questions.md) Branding).

---

## 5. 교차 참조

| 대상 | 문서 |
|---|---|
| 현재 PTY/xterm 구조 | [02](02-current-state.md) |
| 공통 모델 규칙 | [04](04-normalized-agent-model.md) |
| 타입 정본 | [15](15-data-contracts.md) |
| Codex 어댑터 설계 | [05](05-codex-app-server-adapter.md) |
| Claude ACP 어댑터 설계 | [06](06-claude-acp-adapter.md) |
| 위험·미확정 항목 | [13](13-risks-open-questions.md) |

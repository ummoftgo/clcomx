# Implementation Workstreams

## 구현 모듈 배치

- Frontend contracts: `src/lib/features/agent-runtime/contracts/`
  - normalized model: `model.ts`
  - runtime port: `runtime-port.ts`
  - provider ids and metadata types: `metadata.ts`
- Frontend state/controller: `src/lib/features/agent-runtime/state/`, `src/lib/features/agent-runtime/controller/`
  - session store: `agent-runtime-store.svelte.ts`
  - event router: `agent-event-router.ts`
  - reducer/upsert logic: `agent-event-reducer.ts`
- Frontend adapters: `src/lib/features/agent-runtime/adapters/`
  - Codex app-server adapter: `codex-app-server-adapter.ts`
  - Claude ACP adapter: `claude-acp-adapter.ts`
  - legacy PTY adapter: `legacy-pty-adapter.ts`
- Generated protocol types: `src/lib/features/agent-runtime/generated/codex-app-server/`
- UI surface: `src/lib/features/agent-runtime/view/`
  - transcript surface, composer bridge, tool cards, approval modal, terminal output embed
- Tauri backend: `src-tauri/src/features/agent_runtime/` and `src-tauri/src/commands/agent_runtime.rs`
- i18n: `src/lib/i18n/locales/ko.ts` and `src/lib/i18n/locales/en.ts`
- Tests: colocate unit tests next to modules; add E2E coverage through the existing E2E project structure.

## Phase 0: 준비

- `codex app-server generate-ts` 결과는 `src/lib/features/agent-runtime/generated/codex-app-server/`에 둔다.
- ACP schema와 `@agentclientprotocol/claude-agent-acp@0.50.0` package version을 고정한다.
- Claude ACP adapter는 npm dependency 방식으로 고정한다.
- adapter fixture format을 정한다.
- session runtime kind를 session model에 추가할 migration plan을 세운다.

## Phase 1: 공통 모델과 store

- normalized agent model type을 추가한다.
- event apply reducer와 upsert semantics를 구현한다.
- session store에 direct runtime metadata를 추가한다.
- 기존 PTY session은 `legacy-pty` provider로 감싸서 호환 test를 만든다.

## Phase 2: Tauri JSON-RPC runtime

- stdio subprocess runtime을 추가한다.
- stdout JSON-RPC framing, stderr capture, exit event, shutdown timeout을 구현한다.
- frontend-facing Tauri command/event를 추가한다.
- mock provider process fixture로 Rust test를 작성한다.

## Phase 3: Codex adapter

- generated app-server type을 사용한다.
- initialize, thread start/resume, turn start, event subscription을 구현한다.
- delta/completion/tool/approval/command output mapping을 구현한다.
- interleaved stream fixture test를 작성한다.

## Phase 4: Claude ACP adapter

- npm dependency로 설치한 `@agentclientprotocol/claude-agent-acp`의 `claude-agent-acp` bin launch command와 initialize/session lifecycle을 구현한다.
- ACP update upsert/append semantics를 store에 연결한다.
- permission request/response와 cancel cleanup을 구현한다.
- stdout framing error와 capability mismatch test를 작성한다.

## Phase 5: UI

- direct transcript surface를 추가한다.
- message, plan, tool, command, diff, approval component를 만든다.
- composer send/cancel flow를 direct runtime에 연결한다.
- locale key를 ko/en에 추가한다.
- existing terminal surface는 legacy mode로 유지한다.

## Phase 6: Persistence와 migration

- runtime metadata 저장을 추가한다.
- direct runtime recent history 표시를 추가한다.
- legacy record compatibility test를 작성한다.
- direct runtime 실패 시 fallback action을 구현한다.

## Phase 7: Verification

- unit, Rust, frontend check를 통과시킨다.
- Windows/WSL E2E smoke를 direct runtime과 legacy PTY 모두에서 실행한다.
- app launch는 구현 slice가 정리된 뒤 한 번만 수행한다.

## 병렬화 가능한 단위

- 공통 model/store와 Tauri runtime은 interface 합의 후 병렬 가능
- Codex adapter와 Claude adapter는 공통 model fixture가 준비된 뒤 병렬 가능
- UI component는 fixture store를 기준으로 adapter 완성 전 병렬 가능
- persistence는 runtime metadata type이 확정된 뒤 시작

# Testing and Acceptance

> 이 문서는 CLCOMX "Direct Agent Runtime"의 **테스트 전략과 수용 기준**을 구체 테스트 케이스 수준으로 정의한다. 다운스트림 구현 에이전트가 이 문서만 읽고 fixture·unit·Rust·frontend·E2E 테스트를 작성할 수 있어야 한다.
>
> **역할 분리**: 테스트가 검증하는 *타입*의 정본은 [`15-data-contracts.md`](15-data-contracts.md)이고, *규칙·불변식*(상태 전이/upsert/reconcile/approval cleanup)의 정본은 [`04-normalized-agent-model.md`](04-normalized-agent-model.md)다. 이 문서는 두 문서를 인용해 "무엇을 검증할지"를 정의할 뿐, 타입이나 규칙을 재정의하지 않는다. provider wire 사실은 [`ref-codex-app-server-protocol.md`](ref-codex-app-server-protocol.md)·[`ref-acp-protocol.md`](ref-acp-protocol.md)·[`ref-claude-agent-acp.md`](ref-claude-agent-acp.md)의 §번호로 인용한다. 코드 현실(테스트 컨벤션·mock 경로)은 [`research/codebase-backend.md`](research/codebase-backend.md)·[`research/codebase-frontend.md`](research/codebase-frontend.md)의 §번호로 인용한다.
>
> **미확정 항목**은 본문에서 `unverified` 또는 `결정 필요`로 표기하고 [`13-risks-open-questions.md`](13-risks-open-questions.md)로 연결한다.

조사 시점: 2026-06-25. 코드 정합 기준: 브랜치 `feat/claude-tui-fullscreen-option`.

---

## 0. 원칙과 실행 명령

### 0.1 테스트 우선순위 (회귀 비용 기준)

direct runtime은 **protocol mapping 오류가 곧 UX 회귀**다(잘못 매핑된 tool status가 카드 상태를 깨고, 누락된 approval cleanup이 agent를 deadlock시킨다). 따라서 테스트는 아래 순서로 신뢰도를 쌓는다:

1. **fixture replay (§1)** — provider wire 캡처(JSONL)를 adapter에 흘려 normalized event 시퀀스를 검증. mapping 회귀의 1차 방어선.
2. **normalized model unit (§2)** — store reducer의 upsert/append/reconcile/approval lifecycle 불변식(04 규칙).
3. **adapter unit (§3 Codex, §4 Claude)** — wire→`AgentEvent` 변환 정확도.
4. **Tauri Rust (§5)** — transport framing·allowlist·process lifecycle.
5. **frontend (§6)** — view 렌더·focus/shortcut 회귀.
6. **E2E (§7)** — 14 시퀀스 대응 end-to-end.

앱 실제 실행(E2E)은 구현 slice가 문서·cleanup·fixture/unit test를 통과한 뒤 마지막 검증으로 수행한다.

### 0.2 실행 명령 (기존 컨벤션, research 인용)

| 대상 | 명령 | 출처 |
|---|---|---|
| frontend unit (vitest, co-located `*.test.ts`) | `npm run test` (`vitest run`) | `research/codebase-frontend.md` §1.6 |
| Rust unit (`#[cfg(test)]` / `tests.rs`) | `npm run test:rust` (`cargo test --manifest-path src-tauri/Cargo.toml`) | `research/codebase-backend.md` §8.1 |
| 정적 검사 | `npm run check:frontend` (`svelte-check && vite build`) | `research/codebase-frontend.md` §1.6 |
| 전체 게이트 | `npm run verify` (test + test:rust + check) | `research/codebase-backend.md` §8.2 |
| E2E (selenium, PTY mock 경로) | `scripts/run-e2e-project.mjs <project>` (`vitest.e2e.config.ts`) | `research/codebase-backend.md` §8.2, `research/codebase-frontend.md` §1.6 |

### 0.3 테스트 위치 규약 (기존 컨벤션 준수)

- **frontend**: 소스 옆 co-located `*.test.ts`. 예: `src/lib/features/agent-runtime/controller/agent-event-reducer.test.ts`, `.../adapters/codex/codex-app-server-adapter.test.ts`, `.../adapters/claude-acp/claude-acp-adapter.test.ts`(12 §0.1 모듈 배치 정본). controller는 `vi.fn()` deps + 실제 `create*State()` 주입(`research/codebase-frontend.md` §1.5, §1.6). view는 `@testing-library/svelte`.
- **Rust**: `features/agent_runtime/tests.rs`(인라인 `#[cfg(test)] mod tests;`로 분리), `test_*` mock state 생성기를 `#[cfg(test)] pub(crate) fn`로 노출(`research/codebase-backend.md` §8.1, §9 — `test_state_with_session` 본뜸).
- **fixture**: `src/lib/features/agent-runtime/adapters/__fixtures__/*.jsonl` (replay 입력) + 기대 산출 `*.expected.json`.
- **E2E**: `e2e/agent-runtime-*/` 프로젝트(`e2e/smoke/`, `e2e/terminal-input/` 패턴). helper는 `e2e/helpers/`(`tauri.ts`, `launcher.ts`, `terminal.ts`) 재사용.
- **testid**: `src/lib/testids.ts`의 `TEST_IDS`에 키 추가(e2e/unit 공유, `research/codebase-frontend.md` §1.6, §10 체크리스트 #9).

### 0.4 표기 규약

각 테스트 케이스는 **입력 → 기대** 형식으로 쓴다. 입력은 wire 메시지(JSON-RPC) 또는 `AgentEvent`, 기대는 산출 `AgentEvent` 시퀀스, store 상태, 또는 wire 아웃바운드 메시지다.

---

## 1. Fixture replay 전략 (mapping 회귀 1차 방어선)

### 1.1 목적과 형식

provider가 보내는 wire 메시지를 **NDJSON(JSONL) 한 줄=한 메시지**로 캡처해 fixture로 박고, adapter에 그대로 흘려 normalized `AgentEvent` 시퀀스를 스냅샷 비교한다. ACP는 newline-delimited가 wire 규칙 그대로이고(ref-acp §1 stdio transport), Codex도 line-delimited JSON이다(ref-codex §1.2). 따라서 캡처 파일 형식이 wire 형식과 1:1이라 재현성이 높다.

```
src/lib/features/agent-runtime/adapters/__fixtures__/
├── codex/
│   ├── thread-start-turn.jsonl          # initialize~turn/completed 1회
│   ├── delta-completed-reconcile.jsonl  # agentMessage delta→completed
│   ├── command-exec-approval.jsonl      # commandExecution + requestApproval
│   ├── interleaved-two-turns.jsonl      # 동시 thread/turn 인터리빙
│   └── *.expected.json                  # 기대 AgentEvent[] (ref 보존 포함)
└── claude/
    ├── initialize-session-new.jsonl
    ├── prompt-update-stream.jsonl       # session/prompt + session/update 청크
    ├── tool-call-permission.jsonl       # tool_call + request_permission
    ├── session-load-replay.jsonl        # load replay update 스트림
    └── *.expected.json
```

### 1.2 replay harness 시그니처

adapter는 wire 메시지 1개를 받아 0..N개 `AgentEvent`를 내보내는 **순수 함수형 변환기**로 설계한다(상태는 adapter 인스턴스가 보유). harness는 fixture를 줄 단위로 읽어 순서대로 먹인다.

```ts
// src/lib/features/agent-runtime/adapters/replay-harness.ts (test util)
export interface AdapterUnderTest {
  /** wire 메시지 1개(JsonRpcMessage) → 이번 입력으로 생성된 AgentEvent[] */
  ingest(message: JsonRpcMessage): AgentEvent[];
  /** 아웃바운드(approval 응답 등) 캡처용 */
  drainOutbound(): JsonRpcMessage[];
}

export function replayFixture(adapter: AdapterUnderTest, jsonlPath: string): AgentEvent[] {
  const lines = readFileSync(jsonlPath, "utf8").split("\n").filter(Boolean);
  const events: AgentEvent[] = [];
  for (const line of lines) {
    events.push(...adapter.ingest(JSON.parse(line) as JsonRpcMessage));
  }
  return events;
}
```

> `JsonRpcMessage`/`AgentEvent` 타입은 15 §8.1, §3 정본을 import한다(재정의 금지).

### 1.3 캡처 방법 (fixture 생산)

- **1차(권고)**: backend `agent-runtime-message` 이벤트(15 §8.3, raw JSON-RPC를 그대로 올림)를 redacted debug mode(13 §"raw protocol log")에서 파일로 tee. 실제 wire라 가장 신뢰도 높다.
- **2차(부트스트랩)**: ref 문서의 verified payload(ref-codex §9 시퀀스, ref-acp §3·§4·§5·§6 예시)를 손으로 JSONL로 옮긴다. ordering 일부는 `unverified`(ref-codex §10, §9 주석) → 해당 fixture는 "예시 기반"으로 주석 표기하고, 실제 캡처가 생기면 교체한다([13](13-risks-open-questions.md)로 연결).
- 캡처에는 **반드시 redaction**을 적용한다: provider session/thread id, resume token, file 내용 일부는 마스킹(09 §감사, 15 §7.3 scrub 경계). fixture는 commit되므로 비밀이 새면 안 된다.

### 1.4 fixture replay 케이스 목록

| # | fixture | 입력(wire) | 기대(AgentEvent[]) |
|---|---|---|---|
| FR-CX-1 | `codex/thread-start-turn.jsonl` | initialize result → initialized → thread/started → turn/started → item/started(agentMessage) → delta×N → item/completed → turn/completed | `session_started` → `session_status_changed:running` → `agent_message{replace,empty}` → `agent_message_delta`×N → `agent_message{replace,final}` → `turn_completed{completed}` + `session_status_changed:idle` |
| FR-CX-2 | `codex/delta-completed-reconcile.jsonl` | item/started → delta "Look" → delta "s good" → item/completed(text="Looks good") | delta append 후 completed의 `text`가 **권위**로 replace (04 §3.2.1) |
| FR-CX-3 | `codex/command-exec-approval.jsonl` | item/started(commandExecution) → item/commandExecution/requestApproval(id=7) → (응답) → outputDelta → item/completed | `tool_call_updated{execute,in_progress}` → `approval_requested{id:"7"}` → `command_output_delta{stdout}` → `tool_call_updated{completed}` |
| FR-CX-4 | `codex/interleaved-two-turns.jsonl` | (threadId=A,turnId=t1)와 (threadId=B,turnId=t2) item이 교차 | 각 event `ref`가 올바른 `(threadId,turnId,itemId)` 삼중 키로 분리(04 §1, ref-codex §7.1) |
| FR-CL-1 | `claude/initialize-session-new.jsonl` | initialize result(protocolVersion=1) → session/new result(sessionId) | (event 아님) provider 확정 → `session_started{ref.sessionId,cwd}` (ref-acp §13.1) |
| FR-CL-2 | `claude/prompt-update-stream.jsonl` | session/update(agent_message_chunk msg_1)×N → session/prompt result(stopReason=end_turn) | `agent_message_delta`×N(messageId 그룹핑) → `turn_completed{completed}` + `session_status_changed:idle` |
| FR-CL-3 | `claude/tool-call-permission.jsonl` | session/update(tool_call) → session/request_permission(id=42) → (응답) → tool_call_update(completed) | `tool_call_updated{upsert}` → `approval_requested{id:"42"}` → `approval_resolved` → `tool_call_updated{replace content}` (04 §3.3) |
| FR-CL-4 | `claude/session-load-replay.jsonl` | session/load 호출 후 응답 **전** update 스트림 → load result | `session_loaded` + replay update들이 transcript 재구성(ref-acp §3.4, §13.1) |

기대 비교는 `expect(events).toEqual(expectedJson)`로 하되, **`ref.requestId`/`ref.threadId` 등 원본 id 보존(15 §0.1, 04 §1)을 명시 assert**한다(스냅샷이 빠뜨리지 않도록 별도 `it`로 분리).

---

## 2. Normalized model unit tests (04 규칙 정본 기준)

대상: store reducer(`src/lib/features/agent-runtime/controller/agent-event-reducer.ts`, 12 §0.1)와 `state/agent-runtime-store.svelte.ts`의 approval/pending table 로직. 입력은 `AgentEvent`(15 §3), 출력은 store 상태. **04의 각 규칙 절에 1:1 대응**시킨다.

### 2.1 message upsert / append / replace (04 §3.1)

| # | 입력 | 기대 |
|---|---|---|
| NM-1 | `agent_message{ref.itemId:"i1", content:[], mode:"replace"}` 후 `agent_message_delta{i1,"Hi"}` 후 `agent_message_delta{i1," there"}` | transcript에 itemId=i1 항목 1개, text="Hi there" |
| NM-2 | `agent_message{i1, content:[text:"final"], mode:"replace"}` (델타 누적 후) | i1 content가 통째 "final"로 교체(append 아님) |
| NM-3 | `agent_message_delta{ref.messageId:"m1"}` 후 messageId="m2" delta | m1, m2 **별개 항목 2개**(messageId 바뀌면 새 메시지, 04 §1 ACP 규칙) |
| NM-4 | 같은 messageId 청크가 순서대로 도착 | append 순서 보존(04 §3.4) |
| NM-5 | 새 itemId 첫 등장 | 새 transcript 항목 생성; 기존 itemId면 갱신(04 §3.1) |

### 2.2 tool call upsert (04 §3.1, §3.3)

| # | 입력 | 기대 |
|---|---|---|
| NM-6 | `tool_call_updated{update.id:"c1", status:"pending", title:"Edit"}` 후 `tool_call_updated{id:"c1", status:"in_progress"}` | id=c1 카드 1개, status=in_progress, title 유지(부분 갱신은 바뀐 필드만, 15 §5 `ToolCallUpdate`) |
| NM-7 | `tool_call_updated{id:"c1", content:[a]}` 후 `tool_call_updated{id:"c1", content:[b,c]}` | content가 [b,c]로 **전체 교체**(ACP replace 의미, 04 §3.3) |
| NM-8 | `tool_call_content_delta{ref.toolCallId:"c1", content}` (Codex streaming) | c1 content 뒤에 append(04 §3.3 chunk 의미) |

### 2.3 Codex delta→completed reconcile (04 §3.2)

| # | 입력 | 기대 |
|---|---|---|
| NM-9 | agentMessage delta 누적 후 completed.text | completed.text가 권위, delta 누적과 일치 가정 OK(04 §3.2.1) |
| NM-10 | reasoning delta(`agent_message_delta{channel:"thought"}`) 누적 후 completed reasoning item(`agent_message{channel:"thought", mode:"replace"}`) | thought 채널에서 delta는 messageId/contentIndex별 **append 누적**, completed reasoning item이 thought 채널의 **권위**로 replace(reconcile). response 채널과 별도 스트림으로 누적(04 §3.2.2, §3.2.5; 15 §3 `channel?: "response" | "thought"`). delta=completed 가정 금지지만 더 이상 drop 아님 |
| NM-11 | reasoning textDelta(contentIndex=0)와 (contentIndex=1) 혼재 (둘 다 `channel:"thought"`) | 같은 itemId 안에서 인덱스별 다중 스트림 분리 누적, thought 채널로 고정(04 §3.2.5) |

### 2.4 approval lifecycle (04 §4.1)

| # | 입력 | 기대 |
|---|---|---|
| NM-12 | `approval_requested{request.id:"7"}` | pending table에 "7" 등록, 세션 status → `requires_action`(04 §2.1 규칙 3, §4.1) |
| NM-13 | NM-12 후 `approval_resolved{requestId:"7", outcome:"selected"}` | pending에서 "7" 제거, status → `running`(04 §4.1) |
| NM-14 | 같은 itemId에 approvalId가 다른 2개 approval | `requestId`(+approvalId)로 별개 pending 2개(04 §1 Codex zsh-exec-bridge) |
| NM-15 | provider 원본 `requestId`가 `ApprovalRequest.id`와 `ProviderRef.requestId` 양쪽에 보존 | 원본 id 미손실 assert(15 §0.1) |

### 2.5 cancel cleanup (04 §4.2 불변식)

| # | 입력 | 기대 |
|---|---|---|
| NM-16 | pending "7" 존재 중 `turn_completed{status:"cancelled"}` (해당 turn) | "7"을 `ApprovalDecision{outcome:"cancelled"}`로 닫고 pending에서 제거(04 §4.2 규칙 1) |
| NM-17 | NM-16에서 cancel된 turn의 미완료 tool call | client가 `cancelled`로 합성 표시(ACP는 wire status에 cancelled 없음, ref-acp §5, 15 §5 status note) |
| NM-18 | `process_exited` 시 pending "7","8" 존재 | 모든 pending request를 **실패로 닫음**(04 §4.2 규칙 2, §5) |
| NM-19 | Codex `serverRequest/resolved{requestId:"7"}` 수신 | "7"만 닫고 사용자 응답 불필요(04 §4.2 규칙 3) |
| NM-20 | `ApprovalDecision{outcome:"failed"}` 발생 | client 내부 처리만, wire로 전송 안 함(04 §4.2 규칙 4) — outbound 캡처에 없음 assert |

### 2.6 raw 보존 (15 §0.2)

| # | 입력 | 기대 |
|---|---|---|
| NM-21 | experimental 필드 포함 wire(예: Codex `#[experimental]` 필드, ACP `_meta`) | normalized로 매핑 안 된 payload가 `ProviderRef.raw`에 그대로 보존(15 §0.2, ref-codex §1.4, ref-acp §extensibility) |
| NM-22 | tool call의 미매핑 input/output | `rawInput`/`rawOutput`에 보존(15 §5) |

### 2.7 상태 머신 전이 (04 §2.1)

| # | 입력 | 기대 |
|---|---|---|
| NM-23 | start → `session_started` | starting → ready(04 §2.1 규칙 1) |
| NM-24 | ready 상태 `sendPrompt`/turn started | ready → running(규칙 2) |
| NM-25 | running 중 approval_requested | running → requires_action(규칙 3) |
| NM-26 | `turn_completed{failed}` | turn 실패지만 세션 status는 `idle`(규칙 6, 세션 failed와 구분) |
| NM-27 | `error{recoverable:false}` + systemError | 세션 status → `failed`(규칙 6) |
| NM-28 | `process_exited` | status → `exited`(규칙 7) |

### 2.8 sequence/ordering (04 §3.4)

| # | 입력 | 기대 |
|---|---|---|
| NM-29 | adapter가 단조 증가 seq를 부여한 event들이 재정렬되어 도착 | store가 seq로 안정 정렬·dedup(04 §3.4) |
| NM-30 | legacy `terminal_output_delta` | transcript 모델로 끌어올리지 않고 terminal surface에만 라우팅(04 §3.5) |

---

## 3. Codex adapter tests (ref-codex 인용)

대상: `src/lib/features/agent-runtime/adapters/codex/codex-app-server-adapter.ts`(테스트는 co-located `codex-app-server-adapter.test.ts`, 12 §0.1). 입력은 Codex wire `JsonRpcMessage`, 출력은 `AgentEvent[]` 또는 outbound `JsonRpcMessage`. 매핑 정본은 ref-codex §8.

### 3.1 thread start / resume

| # | 입력 | 기대 |
|---|---|---|
| CX-1 | `thread/started{thread:{id,sessionId,cwd}}` | `session_started{ref:{threadId,sessionId}, cwd}`(ref-codex §8) |
| CX-2 | `thread/resume` 응답 또는 `thread/read{includeTurns}` 결과 | `session_loaded` + turns replay(ref-codex §3.1 `thread/read`, §8) |
| CX-3 | `thread/status/changed{status:{type:"active",activeFlags:["waitingOnApproval"]}}` | `session_status_changed:requires_action`(ref-codex §6.1, §8) |
| CX-4 | `thread/status/changed{status:{type:"systemError"}}` | `session_status_changed:failed`(ref-codex §8) |

### 3.2 delta → completed reconcile

| # | 입력 | 기대 |
|---|---|---|
| CX-5 | item/started(agentMessage,empty) → agentMessage/delta×N → item/completed(text) | `agent_message{replace}` → `agent_message_delta`×N → `agent_message{replace,final}`(ref-codex §7.1) |
| CX-6 | plan delta → item/completed(plan) | completed 권위로 reconcile, delta는 점진 렌더만(ref-codex §7.1 plan/reasoning 주석) |
| CX-7 | `turn/plan/updated{plan:[{step,status:"inProgress"}]}` | `plan_updated{entries:[{content:step, status:"in_progress"}]}` (casing 변환 inProgress→in_progress, ref-codex §6.8, §8) |

### 3.3 command output routing

| # | 입력 | 기대 |
|---|---|---|
| CX-8 | `item/commandExecution/outputDelta{itemId,delta}` (평문) | `command_output_delta{stream:"stdout", delta}` — thread 채널 평문(ref-codex §5.2, §8) |
| CX-9 | `command/exec/outputDelta{processId, deltaBase64, stream}` (standalone) | base64 디코드 후 `command_output_delta`/`terminal_output_delta`, processId 라우팅(ref-codex §5.3 — 다른 채널, base64 주의) |
| CX-10 | item/completed(commandExecution, status:"declined") | `tool_call_updated{status:"failed"}` (declined→failed, ref-codex §6.3, §8) |

### 3.4 approval mapping

| # | 입력/방향 | 기대 |
|---|---|---|
| CX-11 | `item/commandExecution/requestApproval{id:7, threadId,turnId,itemId}` (server→client request) | `approval_requested{request.id:"7"}`, options=accept/acceptForSession/decline/cancel → kind allow_once/allow_always/reject_once/cancel(ref-codex §4.1, §8) |
| CX-12 | `respondApproval{outcome:"selected", optionId(allow_once)}` (아웃바운드) | outbound `{id:7, result:{decision:"accept"}}`, **`jsonrpc` 필드 없음**(ref-codex §1.2, §8.1) |
| CX-13 | allow_always 선택 | `decision:"acceptForSession"`(ref-codex §8.1) |
| CX-14 | reject_always 선택 | `decision:"decline"` (영구 거부 등가물 없음 → decline, ref-codex §8.1, `결정 필요` → [13](13-risks-open-questions.md)) |
| CX-15 | `serverRequest/resolved{threadId,requestId:7}` | 해당 requestId pending 닫기(ref-codex §4.4) |

### 3.5 interleaved turn 분리

| # | 입력 | 기대 |
|---|---|---|
| CX-16 | threadId=A/turnId=t1 item과 threadId=B/turnId=t2 item 교차 도착 | 각 event `ref`가 올바른 삼중 키, 두 turn이 섞이지 않음(ref-codex §7.1) |
| CX-17 | 같은 thread 내 turn t1 완료 후 t2 시작 | t1 `turn_completed` 후 t2 `running` 별개(ref-codex §8) |

### 3.6 process exit / error

| # | 입력 | 기대 |
|---|---|---|
| CX-18 | `error{willRetry:true, codexErrorInfo:"usageLimitExceeded"}` | `error{recoverable:true}`, 코드 분류(ref-codex §6.9, §8) |
| CX-19 | app-server process exit(`agent-runtime-exit`) | `process_exited`, 모든 pending 실패 닫기(04 §5) |
| CX-20 | `thread/tokenUsage/updated{tokenUsage}` | `turn_completed.usage`로 보강, `TokenUsageBreakdown` 매핑(`totalTokens` 버림, ref-codex §6.7, §8) |

---

## 4. Claude ACP adapter tests (ref-acp / ref-claude-agent-acp 인용)

대상: `src/lib/features/agent-runtime/adapters/claude-acp/claude-acp-adapter.ts`(테스트는 co-located `claude-acp-adapter.test.ts`, 12 §0.1). 매핑 정본은 ref-acp §13, 구현체 사실은 ref-claude-agent-acp.

### 4.1 initialize / session new·load

| # | 입력/방향 | 기대 |
|---|---|---|
| CL-1 | `initialize` 아웃바운드 | `{jsonrpc:"2.0", protocolVersion:1, clientCapabilities, clientInfo}` 전송(ref-acp §3.1) |
| CL-2 | initialize result(protocolVersion=1, agentCapabilities) | provider 확정, capability 파싱: `loadSession`(top-level), `sessionCapabilities.resume`(중첩) **위치 비대칭** 정확히 판독(ref-acp §3.5 주의) |
| CL-3 | initialize result(protocolVersion≠1) | protocol error 처리(ref-claude-agent-acp §4, ref-acp §3.1 버전 협상) |
| CL-4 | `session/new` result(sessionId) | `session_started{ref.sessionId, cwd}`(ref-acp §13.1) |
| CL-5 | `session/load` 호출 후 응답 전 update 스트림 → load result | `session_loaded` + replay update를 transcript 재구성(ref-acp §3.4, §13.1) |
| CL-6 | `session/resume` result | `session_loaded` (replay 없음, ref-acp §3.5) |

### 4.2 prompt accepted vs session/update 분리

| # | 입력 | 기대 |
|---|---|---|
| CL-7 | `session/prompt` 전송 | `session_status_changed:running` (accepted는 response가 아니라 turn 시작, ref-acp §13.1) |
| CL-8 | `session/prompt` result(stopReason=end_turn) | `turn_completed{completed}` + `session_status_changed:idle`(ref-acp §3.6, §13.1) |
| CL-9 | stopReason=cancelled | `turn_completed{cancelled}`(ref-acp §3.6) |
| CL-10 | stopReason=refusal | `turn_completed{completed}` + UI 거부 표시(refusal은 CLCOMX status에 없음 → metadata 보존, ref-acp §13.1) |
| CL-11 | stopReason=max_tokens | `turn_completed{completed}` (ref-acp §3.6 — closed oneOf, default branch 불필요) |

> **검증 포인트**: `session/prompt` result는 turn의 **종료 신호**이지 acceptance가 아니다. `session/update` notification(스트리밍)과 prompt response(stopReason)를 혼동하면 안 된다(ref-acp §3.7). adapter가 둘을 별개 경로로 처리하는지 assert.

### 4.3 chunk vs update replace

| # | 입력 | 기대 |
|---|---|---|
| CL-12 | `session/update{agent_message_chunk, messageId:"m1"}`×N | `agent_message_delta`×N, messageId 그룹핑 append(ref-acp §4, §13.2) |
| CL-13 | messageId가 m1→m2로 바뀜 | 새 메시지 시작(ref-acp §4 ContentChunk, 04 §3.3) |
| CL-14 | `tool_call` 후 `tool_call_update{content:[...]}` | content **전체 교체**(append 아님, ref-acp §5, §13.3, 04 §3.3) |
| CL-15 | `tool_call_update{toolCallId, status:"completed"}` (바뀐 필드만) | id 기준 upsert, status만 갱신(ref-acp §5 — 나머지 optional) |
| CL-16 | `plan` notification | `plan_updated{entries}` 전체 교체(ref-acp §10, §13.2) |

### 4.4 agent_thought_chunk 처리

| # | 입력 | 기대 |
|---|---|---|
| CL-17 | `session/update{agent_thought_chunk, messageId}`×N | `agent_message_delta{channel:"thought"}`×N로 매핑, messageId 그룹핑 append; completed/turn 종료 시 thought 채널로 고정(ref-acp §13.2; 15 §3 `channel?: "response" | "thought"`; 04 §3.2.2). response 채널과 별도 스트림 — **더 이상 skip 아님** |
| CL-18 | `audio` content block | 미지원 처리(드롭 또는 raw 보존, ref-acp §13.2 — CLCOMX 모델에 audio 없음) |

> CL-17(thought)은 D11 정책으로 확정됐다: `channel:"thought"` 누적으로 기대값을 고정하고, response 채널과 별도 스트림임을 assert한다(13 OQ-01/RD-13 "해소됨"). CL-18(audio)만 04 §"이벤트"의 audio 정책 확정 전까지 "raw 보존되며 crash하지 않음"만 assert하고 `// TODO(13): audio policy` 주석을 단다.

### 4.5 permission mapping

| # | 입력/방향 | 기대 |
|---|---|---|
| CL-19 | `session/request_permission{id:42, toolCall, options}` | `approval_requested{request.id:"42", toolCallId}`, options optionId/name/kind 매핑(ref-acp §6, §13.4) |
| CL-20 | PermissionOptionKind 4종(allow_once/allow_always/reject_once/reject_always) | `ApprovalOption.kind` 1:1(ref-acp §6) |
| CL-21 | `respondApproval{selected, optionId}` 아웃바운드 | `{jsonrpc:"2.0", id:42, result:{outcome:{outcome:"selected", optionId}}}`(ref-acp §6) |
| CL-22 | cancel 시 pending permission | `{outcome:{outcome:"cancelled"}}` 응답(ref-acp §3.8 MUST, 04 §4.2) |
| CL-23 | ExitPlanMode permission(claude 구현체) | optionId bypassPermissions/auto/acceptEdits/default/plan, kind 매핑(ref-claude-agent-acp §3 request_permission 표) |
| CL-24 | 일반 tool 3-option(allow_always/allow/reject) | kind allow_always/allow_once/reject_once(ref-claude-agent-acp §3) |

### 4.6 stdout invalid JSON framing error

| # | 입력 | 기대 |
|---|---|---|
| CL-25 | stdout 라인이 valid JSON 아님(ACP stdout purity 위반) | `error{recoverable:false, message}` emit, transcript 오염 안 함(ref-acp §1 stdout purity, ref-claude-agent-acp §5 stdout 청결) |
| CL-26 | JSON이지만 ACP 메시지 아님(method/result/error 없음) | framing error(ref-acp §1) |
| CL-27 | 알 수 없는 `sessionUpdate` variant(예: plan_update/plan_removed/session_info_update) | graceful 무시, crash 없음(ref-claude-agent-acp §2 — 클라이언트는 모르는 variant 무시 가능해야) |

> **참고**: stdout 라인 framing(byte 분리)은 backend(Rust)가 책임지고(§5.2, 15 §8.3), adapter는 이미 framed JSON 객체를 받는다. CL-25는 "backend가 라인은 줬으나 그 라인이 valid JSON-RPC가 아닐 때 adapter가 안전하게 error로 처리하는지"를 본다. 라인 분리 자체의 결함은 §5.2 Rust 테스트가 잡는다.

---

## 5. Tauri Rust tests (#[cfg(test)], research §8.1 인용)

대상: `src-tauri/src/features/agent_runtime/{transport.rs, process.rs, mod.rs}` + `tests.rs`. mock state 생성기는 `test_*` `#[cfg(test)] pub(crate) fn`로 노출(PTY `test_state_with_session` 본뜸, `research/codebase-backend.md` §8.1, §9). 입력은 byte stream/command 호출, 출력은 emit된 `AgentRuntimeEvent` 또는 `Result`.

### 5.1 stdio JSON-RPC framer (newline framing)

| # | 입력 | 기대 |
|---|---|---|
| RS-1 | `{"id":1,...}\n{"id":2,...}\n` 한 번에 read | 2개 메시지로 분리, 각각 `agent-runtime-message` emit(ref-acp §1 newline-delimited) |
| RS-2 | `{"id":1,...}` (개행 없이 끝, 다음 read에서 `}\n` 도착) | 부분 라인 버퍼링 후 완성 시 1개 emit(framer 경계 보존) |
| RS-3 | UTF-8 멀티바이트가 read 경계에서 잘림 | `decode_utf8_stream_chunk` 재사용해 경계 보존(`research/codebase-backend.md` §2.6, §10 권고 4) |
| RS-4 | 빈 라인 / 공백 라인 | 무시(메시지로 emit 안 함) |
| RS-5 | line이 4MB cap 초과 | overflow 처리(아래 5.5와 연동) |

### 5.2 stderr / stdout 분리

| # | 입력 | 기대 |
|---|---|---|
| RS-6 | stdout에 JSON-RPC, stderr에 로그 라인 | stdout→`agent-runtime-message`, stderr→`agent-runtime-stderr` 별개 채널(15 §8.3, ref-acp §1 stderr MAY log) |
| RS-7 | stderr가 비-UTF8/멀티라인 | stderr line emit, stdout framer 오염 없음 |

### 5.3 allowlist 검증 (신규 강화 지점)

PTY와 달리 direct runtime은 backend가 provider별 executable/args를 allowlist로 재검증한다(15 §8.1 주석, `research/codebase-backend.md` §6, §10 권고 6 — 현 코드에 선례 없음).

| # | 입력 | 기대 |
|---|---|---|
| RS-8 | `agent_runtime_start{provider:"codex", command:"codex", args:["app-server"]}` | 허용, RuntimeId 반환 |
| RS-9 | `provider:"claude"`, command가 node + claude-agent-acp dist 경로 | 허용(ref-claude-agent-acp §1) |
| RS-10 | command가 임의 executable(예: `/bin/sh`, `rm`) | `Err(String)` 거부(allowlist 위반) |
| RS-11 | args에 shell 메타문자/주입 시도 | 거부 또는 executable+argv로만 처리(shell string 아님, `research/codebase-backend.md` §2.2 executable+argv 규칙) |
| RS-12 | env key가 `^[A-Za-z_][A-Za-z0-9_]*$` 위반 | 거부(registry `assertValidEnvKey` 선례, `research/codebase-backend.md` §6) |

### 5.4 process lifecycle: shutdown timeout → kill

| # | 입력 | 기대 |
|---|---|---|
| RS-13 | `agent_runtime_shutdown` → child가 stdin EOF에 정상 종료 | graceful, `agent-runtime-exit{code}` emit(15 §8, 07 §Process lifecycle) |
| RS-14 | child가 timeout 내 종료 안 함 | timeout 후 강제 kill, exit emit(`research/codebase-backend.md` §10 권고 5 — PTY와 달리 명시적 kill) |
| RS-15 | shutdown 시 pending request 존재 | process exit이 모든 pending을 실패로 닫음 신호(04 §5; backend는 framing만, 의미 처리는 frontend지만 exit 이벤트는 backend) |

### 5.5 bounded queue overflow (backpressure)

| # | 입력 | 기대 |
|---|---|---|
| RS-16 | 빠른 메시지 flood로 queue saturation | `agent-runtime-backpressure{droppedMessages}` emit(15 §8.3) |
| RS-17 | overflow 후 정상화 | 후속 메시지 정상 emit, droppedMessages 카운트 정확 |

> backpressure 정책(드롭 vs 블록)은 `std::thread` vs tokio 선택에 따라 다르다(`research/codebase-backend.md` §7, §11 — tokio 채택은 ADR 결정). 1차는 `std::thread`+`Mutex` 기반 권고. 정책 미확정분은 [13](13-risks-open-questions.md)로.

### 5.6 is_test_mode mock (E2E·unit 1급 지원)

| # | 입력 | 기대 |
|---|---|---|
| RS-18 | `CLCOMX_TEST_MODE` 설정 후 `agent_runtime_start` | native subprocess 대신 mock JSON-RPC 응답 스트림(PTY `create_mock_session` 본뜸, `research/codebase-backend.md` §2.1, §10 권고 8) |
| RS-19 | mock runtime에 send | 미리 정의된 mock 응답 emit(WSL/실제 CLI 없이) |
| RS-20 | snapshot/delta 단위 테스트 | `test_*` state 생성기로 mock 상태 만들어 검증(`research/codebase-backend.md` §8.1, §9) |

### 5.7 serde 미러 (TS↔Rust 1:1)

| # | 입력 | 기대 |
|---|---|---|
| RS-21 | `AgentRuntimeStartParams`(camelCase JSON) deserialize | `#[serde(rename_all="camelCase")]` 정확 파싱(15 §8.2, §0.4) |
| RS-22 | `JsonRpcMessage`(jsonrpc 생략, Codex 케이스) untagged 파싱 | Request/Notification/Response/Error 4종 분기(15 §8.1, §8.2) |
| RS-23 | `AgentRuntimeMetadataRecord` round-trip | scrub 필드 제외 직렬화(15 §7.3) |

---

## 6. Frontend tests (vitest, research §1.6 인용)

대상: `src/lib/features/agent-runtime/{view,controller,state}`. controller는 `vi.fn()` deps + 실제 state, view는 `@testing-library/svelte`. testid는 `TEST_IDS`(`research/codebase-frontend.md` §1.6, §10 #9).

### 6.1 컴포넌트 렌더

| # | 입력 | 기대 |
|---|---|---|
| FE-1 | transcript에 user/agent message 항목 | `AgentTranscriptSurface`가 메시지 순서대로 렌더, testid `agentTranscript` 노출 |
| FE-2 | `visible=false` prop | host가 자체 `.hidden` CSS로 숨김(unmount 안 함, `research/codebase-frontend.md` §3.3, §9.2 — 탭 전환 무재mount 계약) |
| FE-3 | direct runtime metadata 표시(provider/sessionId debug) | metadata 표시(scrub된 값은 표시 안 함, 15 §7.3) |

### 6.2 tool card

| # | 입력 | 기대 |
|---|---|---|
| FE-4 | `ToolCallUpdate{kind:"execute", status:"in_progress"}` | command output card 렌더, collapsed 기본 |
| FE-5 | 카드 클릭 | collapsed↔expanded 토글 |
| FE-6 | `kind:"edit"` + diff content | FileDiffCard 렌더(15 §4 AgentContent diff) |
| FE-7 | command output terminal embed | terminal embed 렌더, **app shortcut 가로채지 않음**(`research/codebase-frontend.md` §11 focus/shortcut 위험) |

### 6.3 approval modal

| # | 입력 | 기대 |
|---|---|---|
| FE-8 | `pendingApproval` 설정 | `ApprovalModal.svelte` 표시, options 렌더, testid `approvalModal`(인라인 변형은 `ApprovalInlineCard.svelte` / testid `approvalInlineCard`, 12 §0.1) |
| FE-9 | option label | i18n key로 감싸 표시(label 원문은 보존하되 표시는 i18n, 04 §4.1, ref-claude-agent-acp §3) |
| FE-10 | option 클릭 | `respondApproval{selected, optionId}` 콜백 호출(deps `vi.fn` 검증) |
| FE-11 | modal 열린 중 turn cancel | modal 닫힘 + cancelled outcome(04 §4.2) |

### 6.4 i18n 누락 방지

| # | 입력 | 기대 |
|---|---|---|
| FE-12 | en.ts와 ko.ts 키 트리 비교 | `agentRuntime.*` namespace 키가 양쪽 1:1 동일(`research/codebase-frontend.md` §6.1 — 두 파일 키 구조 동일 MUST). 누락 시 fail |
| FE-13 | 새 UI text 하드코딩 검출 | transcript/composer/approval에 raw 문자열 없음, 전부 `$t(...)`(§6.2 추가 방식) |

> FE-12는 en/ko를 import해 키 경로 set을 재귀 수집·diff하는 단위 테스트로 구현(예약 namespace는 `agentRuntime.status.*`/`approval.*`/`toolKind.*`/`errors.*`/`fallback.*`, `research/codebase-frontend.md` §6.2).

### 6.5 focus / shortcut 회귀

| # | 입력 | 기대 |
|---|---|---|
| FE-14 | composer 입력 포커스 중 Ctrl+T/Ctrl+W | app tab shortcut과 composer 입력 충돌 없음(`research/codebase-frontend.md` §11) |
| FE-15 | approval modal 열림 중 키보드 | focus가 modal에 trap, transcript로 새지 않음 |
| FE-16 | terminal embed 포커스 | embed가 입력 받되 app shortcut은 통과(분리, §11) |
| FE-17 | assistant dock / aux surface 공존 | 기존 terminal focus-bridge와 충돌 없음(`terminal-focus-bridge.ts`/`terminal-shortcut-routing.ts` 회귀) |

### 6.6 host 분기 / 무재mount 계약

| # | 입력 | 기대 |
|---|---|---|
| FE-18 | `session.runtimeKind="direct-codex"` | `SessionShell.svelte`가 `AgentRuntimeShell` 선택(옵션 B 분기, `research/codebase-frontend.md` §9 옵션 B) |
| FE-19 | `runtimeKind` 부재(legacy 세션) | `"pty"`로 normalize → `Terminal.svelte`(15 §7.2, `research/codebase-frontend.md` §10 #1) |
| FE-20 | direct runtime 세션은 ptyId 없음 | `onPtyId` 흐름 우회/no-op, persist에서 죽은 세션 오인 안 됨(`research/codebase-frontend.md` §11 위험, §10 #12) |
| FE-21 | 탭 전환 | host 재mount 없음, transport 구독 유지(`research/codebase-frontend.md` §3.3, §9.2) |

---

## 7. E2E scenarios (14 시퀀스 대응)

E2E는 selenium + `CLCOMX_TEST_MODE` mock 경로(§5.6 RS-18)로 실제 WSL/CLI 없이 돌린다(`research/codebase-backend.md` §8.2). 각 시나리오는 `e2e/agent-runtime-*/`에 배치하고 `e2e/helpers/`(`tauri.ts`, `launcher.ts`, `terminal.ts`) 재사용. `describe.skipIf(process.platform !== "win32")` 가드는 기존 smoke 패턴 따른다(`e2e/smoke/smoke.test.ts`).

> **14 대응**: 아래 시나리오 번호는 [`14-sequence-and-state.md`](14-sequence-and-state.md)의 시퀀스 다이어그램과 1:1 대응한다(14는 존재함). 14의 시퀀스가 갱신되면 본 표 번호와 동기화한다 → [13](13-risks-open-questions.md)에 "14와 본 표 동기화 유지" 항목 연결.

| # | 시나리오 | 14 시퀀스 | 입력(사용자/mock) → 기대 |
|---|---|---|---|
| E2E-1 | Codex 새 세션 prompt→stream | 14 §"Codex turn" | launcher에서 codex direct 세션 생성 → composer에 prompt 입력·전송 → mock이 agentMessage delta 스트림 → transcript에 streaming text 표시, turn_completed 후 idle |
| E2E-2 | Claude ACP 새 세션 prompt→update | 14 §"Claude turn" | claude direct 세션 → prompt 전송 → mock이 `session/update` agent_message_chunk → transcript 표시, stopReason=end_turn 후 idle |
| E2E-3 | approval 요청·allow | 14 §"Approval allow" | mock이 commandExecution requestApproval(Codex)/request_permission(Claude) → `approvalModal` 표시 → Allow 클릭 → 응답 wire 전송 확인 → tool 진행·완료 |
| E2E-4 | approval 요청·reject | 14 §"Approval reject" | 위와 동일하나 Reject 클릭 → decline/reject_once 전송, tool 미실행 표시 |
| E2E-5 | cancel 중 pending approval cleanup | 14 §"Cancel cleanup" | approval pending 중 turn cancel → 모든 pending이 cancelled로 닫힘, modal 닫힘, agent deadlock 없음(04 §4.2, ref-acp §3.8) |
| E2E-6 | direct 실패 → legacy PTY fallback | 14 §"Fallback" | direct runtime start 실패(또는 미지원 agent) → legacy `Terminal.svelte`로 graceful fallback, 세션 사용 가능(`research/codebase-frontend.md` §9 옵션 B fallback, 08 §legacy PTY fallback) |
| E2E-7 | 기존 PTY 세션 무회귀 | (legacy 보존) | runtimeKind 없는 기존 workspace.json 복원 → PTY 세션 정상 open, xterm 동작(15 §7.2 normalize, `research/codebase-frontend.md` §10 #1) |
| E2E-8 | resume/load 복원 | 14 §"Resume" | direct 세션 종료 후 history에서 재열기 → `session/resume`(replay 없음) 또는 `thread/read`/`session/load`(replay) → transcript 복원(ref-acp §3.4/§3.5, ref-codex §3.1) |
| E2E-9 | 탭 전환 무재mount | (UI 계약) | direct 세션 + terminal 세션 혼재 탭 전환 → 비활성 host 살아있음, transport 구독 유지(`research/codebase-frontend.md` §3.3) |
| E2E-10 | raw protocol log 기본 off | (보안) | 기본 실행 시 raw wire 파일 미생성, debug mode 켜야 redacted 캡처(13 §raw log, 09 §감사) |

---

## 8. Acceptance checklist (수용 기준)

구현 slice가 merge 가능하려면 아래를 모두 만족해야 한다. 각 항목은 위 테스트 케이스로 뒷받침된다.

### 8.1 기능 커버리지

- [ ] Codex와 Claude 모두 **새 session, resume/load, prompt, stream, tool call, approval, cancel, error, process exit** 각각에 대해 문서(§3/§4 매핑)와 테스트(fixture FR-* + adapter CX-*/CL-*)가 존재한다.
- [ ] normalized model의 upsert/append/reconcile/approval lifecycle/cancel cleanup/raw 보존(04 §3·§4·§5)이 unit test(NM-1..NM-30)로 검증된다.
- [ ] interleaved turn 분리(CX-16/17, ref-codex §7.1)와 ACP chunk/replace 구분(CL-12..CL-16, ref-acp §4·§5)이 검증된다.

### 8.2 transport / process

- [ ] stdio JSON-RPC framing(newline·UTF-8 경계·부분 라인), stderr/stdout 분리, bounded queue overflow, shutdown timeout→kill이 Rust test(RS-1..RS-17)로 검증된다.
- [ ] provider별 executable/args/env allowlist가 backend에서 검증되어 임의 executable/shell string을 차단한다(RS-8..RS-12, `research/codebase-backend.md` §6·§10 권고 6).
- [ ] `is_test_mode` mock 경로가 1급으로 제공되어 WSL/실제 CLI 없이 E2E·unit이 돈다(RS-18..RS-20).

### 8.3 legacy 보존

- [ ] xterm terminal-first 화면이 legacy path로 계속 동작한다(E2E-7).
- [ ] 기존 PTY E2E(`e2e/smoke`, `e2e/terminal-input`, `e2e/terminal-aux` 등)가 회귀 없이 통과한다(13 §Terminal regression).
- [ ] direct runtime 실패 시 legacy PTY fallback이 동작한다(E2E-6).

### 8.4 UI / i18n / focus

- [ ] 새 UI text는 전부 locale key로 관리되고 en/ko 키 트리가 1:1 동일하다(FE-12/13).
- [ ] composer·terminal embed·approval modal·assistant dock 간 focus/shortcut 회귀가 없다(FE-14..FE-17).
- [ ] 탭 전환이 direct runtime host를 재mount하지 않는다(FE-21, E2E-9).

### 8.5 보안 / 추적성

- [ ] provider id(threadId/sessionId/requestId)가 저장소와 debug view에서 추적 가능하다(NM-15, 15 §0.1).
- [ ] provider session/thread id·resume token은 디스크 저장 시 scrub된다(RS-23, 15 §7.3, `research/codebase-backend.md` §4.2).
- [ ] raw protocol log가 기본 비활성화이며 redaction 정책이 있다(E2E-10, 13 §raw log, 09 §감사).

### 8.6 게이트

- [ ] `npm run verify`(test + test:rust + check)가 통과한다.
- [ ] fixture replay(FR-*)가 commit된 JSONL로 재현 가능하며, 비밀이 redaction되어 있다(§1.3).

---

## 9. 미확정 / 결정 필요 (→ [13](13-risks-open-questions.md))

테스트가 고정값을 assert하기 전에 정책 결정이 필요한 항목:

1. ~~agent_thought_chunk / Codex reasoning 처리 정책~~ **해소됨(D11)**: thought를 `channel:"thought"` 별도 스트림으로 누적(15 §3 `channel` 필드, 04 §3.2.2/§3.2.5). CL-17/NM-10/NM-11 기대값은 thought 채널 누적으로 고정(13 OQ-01/RD-13 해소).
2. **ACP audio content**(CL-18): 미지원 드롭 vs raw 보존(ref-acp §13.2).
3. **reject_always → Codex decline 매핑**(CX-14): 영구 거부 등가물 부재, decline + 사용자 규칙으로 임시(ref-codex §8.1·§10).
4. **backpressure 정책**(RS-16/17): drop vs block, `std::thread` vs tokio 선택에 종속(`research/codebase-backend.md` §7·§11 — ADR 결정).
5. **message seq + snapshot/delta-since** late-attach: 현 계약(15 §8.3)에는 seq 미포함, 후속 추가 권고. E2E late-attach 신뢰성 테스트는 그 후(04 §3.4, `research/codebase-backend.md` §10 권고 3).
6. **14-sequence-and-state.md 동기화**: 14는 존재함. E2E §7 표가 14 시퀀스와 1:1로 유지돼야 함. 14 시퀀스 갱신 시 본 표 번호와 일치시킬 것.
7. **fixture 캡처 신뢰도**: 실제 wire 캡처 전까지 ref 예시 기반 fixture는 ordering `unverified`(ref-codex §9·§10). 실제 캡처로 교체 필요.

---

## 10. 교차 참조

| 대상 | 문서 | 절 |
|---|---|---|
| 테스트가 검증하는 타입 정본 | [`15-data-contracts.md`](15-data-contracts.md) | §1–§8 |
| 테스트가 검증하는 규칙·불변식 정본 | [`04-normalized-agent-model.md`](04-normalized-agent-model.md) | §2·§3·§4·§5 |
| Codex wire 사실·매핑 | [`ref-codex-app-server-protocol.md`](ref-codex-app-server-protocol.md) | §1·§4·§5·§6·§7·§8·§9 |
| ACP wire 사실·매핑 | [`ref-acp-protocol.md`](ref-acp-protocol.md) | §1·§3·§4·§5·§6·§13 |
| Claude ACP 구현체 사실 | [`ref-claude-agent-acp.md`](ref-claude-agent-acp.md) | §1·§2·§3·§5 |
| backend 코드 현실·테스트 컨벤션·mock | [`research/codebase-backend.md`](research/codebase-backend.md) | §2·§6·§8·§9·§10 |
| frontend 코드 현실·테스트 컨벤션·host 분기 | [`research/codebase-frontend.md`](research/codebase-frontend.md) | §1.6·§3·§6·§9·§10·§11 |
| 위험·결정 필요·기본값 | [`13-risks-open-questions.md`](13-risks-open-questions.md) | 전체 |
| 시퀀스/상태 다이어그램(E2E 대응) | [`14-sequence-and-state.md`](14-sequence-and-state.md) | 전체 |
| permission·redaction·감사 | [`09-permissions-security.md`](09-permissions-security.md) | 전체 |
| UI 구성·legacy fallback | [`08-ui-composition.md`](08-ui-composition.md) | 전체 |

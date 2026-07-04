# Testing and Acceptance

> 이 문서는 CLCOMX "Direct Agent Runtime"의 **테스트 전략과 수용 기준**을 구체 테스트 케이스 수준으로 정의한다. 다운스트림 구현 에이전트가 이 문서만 읽고 fixture·unit·Rust·frontend·E2E 테스트를 작성할 수 있어야 한다.
>
> **역할 분리**: 테스트가 검증하는 *타입*의 정본은 [`15-data-contracts.md`](15-data-contracts.md)이고, *규칙·불변식*(상태 전이/upsert/reconcile/approval cleanup)의 정본은 [`04-normalized-agent-model.md`](04-normalized-agent-model.md)다. 이 문서는 두 문서를 인용해 "무엇을 검증할지"를 정의할 뿐, 타입이나 규칙을 재정의하지 않는다. provider wire 사실은 [`ref-codex-app-server-protocol.md`](ref-codex-app-server-protocol.md)·[`ref-acp-protocol.md`](ref-acp-protocol.md)·[`ref-claude-agent-acp.md`](ref-claude-agent-acp.md)의 §번호로 인용한다. 코드 현실(테스트 컨벤션·mock 경로)은 [`research/codebase-backend.md`](research/codebase-backend.md)·[`research/codebase-frontend.md`](research/codebase-frontend.md)의 §번호로 인용한다.
>
> **미확정 항목**은 본문에서 `unverified` 또는 `결정 필요`로 표기하고 [`13-risks-open-questions.md`](13-risks-open-questions.md)로 연결한다.

조사 시점: 2026-06-25. 코드 스냅샷 기준: commit `e7a5f9e`; 구현 전 현재 작업트리와 대조.

---

## 0. 원칙과 실행 명령

### 0.1 테스트 우선순위 (회귀 비용 기준)

direct runtime은 **protocol mapping 오류가 곧 UX 회귀**다(잘못 매핑된 tool status가 카드 상태를 깨고, 누락된 approval cleanup이 agent를 deadlock시킨다). 따라서 테스트는 아래 순서로 신뢰도를 쌓는다:

1. **fixture replay (§1)** — provider wire 캡처(`{direction,message}` envelope NDJSON)를 adapter에 흘려 normalized event 시퀀스를 검증. mapping 회귀의 1차 방어선.
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

provider가 보내는 wire 메시지를 **NDJSON(`.jsonl`) 한 줄 = `{ direction: "in"|"out", message: JsonRpcMessage }` envelope**로 캡처해 fixture로 박고, envelope의 `message`를 adapter에 흘려 normalized `AgentEvent` 시퀀스를 스냅샷 비교한다(`direction`: in=provider→client, out=client→provider). 이 형식은 12 §T0.5 fixture 포맷 정본·§T2.5 test-mode mock 재사용과 **단일 형식**으로 통일된다. backend mock은 deterministic handshake/lifecycle 블록을 fixture 우선으로 재생하고, 입력값에 따라 달라지는 prompt/approval 블록은 같은 JSON-RPC line shape의 generator fallback으로 만든다. ACP는 newline-delimited가 wire 규칙 그대로이고(ref-acp §1 stdio transport), Codex도 line-delimited JSON이다(ref-codex §1.2). 따라서 envelope의 `message`가 wire 메시지와 1:1이라 재현성이 높다.

```
src/lib/features/agent-runtime/adapters/__fixtures__/
├── codex/
│   ├── codex-initialize.jsonl          # initialize handshake sanity
│   ├── thread-start-turn.jsonl          # initialize~turn/completed 1회
│   ├── delta-completed-reconcile.jsonl  # agentMessage delta→completed
│   ├── command-exec-approval.jsonl      # commandExecution + requestApproval
│   ├── interleaved-two-turns.jsonl      # 동시 thread/turn 인터리빙 ({direction,message} envelope NDJSON)
│   └── *.expected.json                  # 기대 AgentEvent[] (ref 보존 포함)
└── claude-acp/
    ├── claude-initialize.jsonl          # initialize handshake sanity
    ├── claude-initialize-session-new.jsonl
    ├── claude-prompt-update-stream.jsonl       # session/prompt + session/update 청크
    ├── claude-tool-call-permission.jsonl       # tool_call + request_permission
    ├── claude-session-load-replay.jsonl        # load replay update 스트림
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

/** fixture 한 줄 = {direction,message} envelope (12 §T0.5 포맷 정본) */
interface FixtureLine {
  direction: "in" | "out";
  message: JsonRpcMessage;
}

export function replayFixture(adapter: AdapterUnderTest, jsonlPath: string): AgentEvent[] {
  const lines = readFileSync(jsonlPath, "utf8").split("\n").filter(Boolean);
  const events: AgentEvent[] = [];
  for (const line of lines) {
    const { direction, message } = JSON.parse(line) as FixtureLine;
    if (direction !== "in") continue; // out(client→provider)은 outbound 기대 비교용; ingest엔 in만 흘림
    events.push(...adapter.ingest(message));
  }
  return events;
}
```

> `JsonRpcMessage`/`AgentEvent` 타입은 15 §8.1, §3 정본을 import한다(재정의 금지). fixture 형식(`{direction,message}` envelope)은 12 §T0.5 정본을 따른다(재정의 금지).

### 1.3 캡처 방법 (fixture 생산)

- **1차(권고)**: backend `agent-runtime-message` 이벤트(15 §8.3, raw JSON-RPC를 그대로 올림)와 client→provider 아웃바운드를 각각 `direction:"in"`/`"out"` envelope으로 감싸 redacted debug mode(13 §"raw protocol log")에서 파일로 tee. 실제 wire라 가장 신뢰도 높다. opt-in raw debug JSONL의 inbound entry는 reader-local 1-based `seq`를 포함하므로, OQ-53 같은 종료 신호 뒤 same-turn 보조 notification 여부는 캡처 파일의 arrival order와 `seq`로 대조한다. 단 v1의 `agent-runtime-message` realtime event 자체는 adapter 전용 raw bridge이므로, fixture/diagnostic 파일 생산은 redacted debug log 경계에서 수행하고 frontend public diagnostic 구독 API처럼 취급하지 않는다(OQ-59).
- **2차(부트스트랩)**: ref 문서의 verified payload(ref-codex §9 시퀀스, ref-acp §3·§4·§5·§6 예시)를 손으로 `{direction,message}` envelope NDJSON으로 옮긴다. ordering 일부는 `unverified`(ref-codex §10, §9 주석) → 해당 fixture는 "예시 기반"으로 주석 표기하고, 실제 캡처가 생기면 교체한다([13](13-risks-open-questions.md)로 연결).
- 캡처에는 **반드시 redaction**을 적용한다: provider session/thread id, resume token, file 내용 일부는 마스킹(09 §감사, 15 §7.3 scrub 경계). fixture는 commit되므로 비밀이 새면 안 된다.
- 현재 검증은 `codex-fixture-replay.test.ts`와 `claude-acp-fixture-replay.test.ts`가 commit된 JSONL/expected JSON을 재생하고, fixture corpus hygiene 테스트가 모든 JSONL/JSON parse 가능성과 secret-shaped 값 부재를 검사한다. `sessionId:"sess-1"`/`threadId:"th_1"` 같은 fixture-local synthetic id는 redaction 대상 secret으로 보지 않는다.

### 1.4 fixture replay 케이스 목록

| # | fixture | 입력(wire) | 기대(AgentEvent[]) |
|---|---|---|---|
| FR-CX-0 | `codex/codex-initialize.jsonl` | initialize handshake only | normalized `AgentEvent[]` 없음 — handshake payload fixture parse/redaction/harness sanity |
| FR-CX-1 | `codex/thread-start-turn.jsonl` | initialize result → initialized → thread/started → turn/started → item/started(agentMessage) → delta×N → item/completed → turn/completed | `session_started` → `session_status_changed:running` → `agent_message{replace,empty}` → `agent_message_delta`×N → `agent_message{replace,final}` → `turn_completed{completed}` + `session_status_changed:idle` |
| FR-CX-2 | `codex/delta-completed-reconcile.jsonl` | item/started → delta "Look" → delta "s good" → item/completed(text="Looks good") | delta append 후 completed의 `text`가 **권위**로 replace (04 §3.2.1) |
| FR-CX-3 | `codex/command-exec-approval.jsonl` | item/started(commandExecution) → item/commandExecution/requestApproval(id=7) → (응답) → outputDelta → item/completed | `tool_call_updated{execute,in_progress}` → `approval_requested{id:"7"}` → `command_output_delta{stdout}` → `tool_call_updated{completed}` |
| FR-CX-4 | `codex/interleaved-two-turns.jsonl` | (threadId=A,turnId=t1)와 (threadId=B,turnId=t2) item이 교차 | 각 event `ref`가 올바른 `(threadId,turnId,itemId)` 삼중 키로 분리(04 §1, ref-codex §7.1) |
| FR-CL-0 | `claude-acp/claude-initialize.jsonl` | initialize handshake only | normalized `AgentEvent[]` 없음 — handshake payload fixture parse/redaction/harness sanity |
| FR-CL-1 | `claude-acp/claude-initialize-session-new.jsonl` | initialize result(protocolVersion=1) → session/new result(sessionId) | (initialize event 없음) provider 확정 → `session_started{ref.sessionId,cwd}` + `session_status_changed:ready` (ref-acp §13.1) |
| FR-CL-2 | `claude-acp/claude-prompt-update-stream.jsonl` | session/update(agent_message_chunk msg_1)×N → session/prompt result(stopReason=end_turn) | `agent_message_delta`×N(messageId 그룹핑) → `turn_completed{completed, ref.raw.stopReason}` + `session_status_changed:idle` |
| FR-CL-3 | `claude-acp/claude-session-load-replay.jsonl` | session/load 호출 후 응답 **전** update 스트림 → load result | replay update들이 transcript를 재구성한 뒤 `session_loaded`(ref-acp §3.4, §13.1) |
| FR-CL-4 | `claude-acp/claude-tool-call-permission.jsonl` | session/update(tool_call) → session/request_permission(id=42) → (outbound approval response fixture 보존) → tool_call_update(completed) | `tool_call_updated{upsert}` → `session_status_changed:requires_action` → `approval_requested{id:"42"}` → `tool_call_updated{replace content}` (04 §3.3). 사용자 결정 후 `approval_resolved`는 adapter/controller approval lifecycle 테스트가 담당한다. |

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
| NM-8b | `command_output_delta{stream:"stdout"}`/`command_output_delta{stream:"stderr"}`가 같은 execute tool call에 교차 도착 | `AgentContent{type:"terminal"}`의 `output`(stdout)과 `stderr` 버퍼가 stream별로 분리 누적되고, `CommandOutputCard`가 stderr를 기본 collapsed + 표시 직전 redaction으로 렌더한다(04 §3.2.3, 08 §7, 09 §6). 증거: `agent-event-reducer.test.ts`, `CommandOutputCard.test.ts`, `ToolCallCard.test.ts`. |

### 2.3 Codex delta→completed reconcile (04 §3.2)

| # | 입력 | 기대 |
|---|---|---|
| NM-9 | agentMessage delta 누적 후 completed.text | completed.text가 권위, delta 누적과 일치 가정 OK(04 §3.2.1) |
| NM-10 | reasoning delta(`agent_message_delta{channel:"thought"}`) 누적 후 completed reasoning item(`agent_message{channel:"thought", mode:"replace"}`) | thought 채널에서 delta는 provider별 키(Codex `segment`, ACP `messageId`)로 **append 누적**, completed reasoning item이 thought 채널의 **권위**로 replace(reconcile). response 채널과 별도 스트림으로 누적(04 §3.2.2, §3.2.5; 15 §3 `channel?: "response" | "thought"`). delta=completed 가정 금지지만 더 이상 drop 아님 |
| NM-11 | reasoning textDelta(contentIndex=0)와 (contentIndex=1) 혼재 (둘 다 `channel:"thought"`) | 같은 itemId 안에서 `segment:{kind:"content", index}`별 다중 스트림 분리 누적, thought 채널로 고정. summaryTextDelta는 `segment:{kind:"summary", index}`로 보존(04 §3.2.5, 15 §3/§4) |

### 2.4 approval lifecycle (04 §4.1)

| # | 입력 | 기대 |
|---|---|---|
| NM-12 | `approval_requested{request.id:"7"}` | pending table에 "7" 등록, 세션 status → `requires_action`(04 §2.1 규칙 3, §4.1) |
| NM-13 | NM-12 후 `approval_resolved{requestId:"7", outcome:"selected"}` | pending에서 "7" 제거, status → `running`(04 §4.1) |
| NM-14 | 같은 itemId에 approvalId가 다른 2개 approval | `requestId`(+approvalId)로 별개 pending 2개(04 §1 Codex zsh-exec-bridge) |
| NM-15 | provider 원본 `requestId`가 `ApprovalRequest.id`와 `ProviderRef.requestId` 양쪽에 보존 | 원본 id 미손실 assert(15 §0.1) |
| NM-15b | **pending key 충돌 회귀(D-PENDINGKEY)**: 두 runtime(세션 handle A·B)이 각각 **같은 JSON-RPC id**(예 둘 다 `requestId:"7"`)로 approval을 보냄 → `approval_requested{sessionHandle:A, id:"7"}` + `approval_requested{sessionHandle:B, id:"7"}` 후 A의 "7"만 resolve | pending table key가 `(sessionHandle, requestId)`라 두 approval이 별개 엔트리로 공존하고, A resolve가 B의 "7"을 건드리지 않음 — approval 응답이 **올바른 세션으로만 라우팅(오응답 없음)**. "두 runtime이 같은 id를 받아도 오응답하지 않음"을 불변식으로 assert. 전역 단독 `requestId` 키였다면 충돌해 한쪽이 오라우팅됨(03 §2.3/§2.8, 04 §4.1 참조, 12 T1.4 DoD; JSON-RPC id는 runtime/connection 단위 유일이라 cross-runtime 전역 유일 아님) |

### 2.5 cancel cleanup (04 §4.2 불변식)

| # | 입력 | 기대 |
|---|---|---|
| NM-16 | pending "7" 존재 중 `turn_completed{status:"cancelled"}` (해당 turn) | "7"을 `ApprovalDecision{outcome:"cancelled"}`로 닫고 pending에서 제거(04 §4.2 규칙 1) |
| NM-17 | NM-16에서 cancel된 turn의 미완료 tool call | client가 `cancelled`로 합성 표시(ACP는 wire status에 cancelled 없음, ref-acp §5, 15 §5 status note) |
| NM-18 | `process_exited` 시 pending "7","8" 존재 | 모든 pending request를 **실패로 닫음**(04 §4.2 규칙 2, §5) |
| NM-18b | shutdown 시퀀스(S3): pending approval "7" + pending RPC 존재 상태에서 adapter `shutdown()` 호출 | **unlisten/세션 삭제 전에** pending approval을 cancelled로 닫고(04 §4.2) pending RPC를 로컬 reject한 뒤 listener 해제·세션 삭제. 종료 순서를 assert — pending 종료 콜백이 unlisten보다 먼저 호출됨(S3 (a); 05/06 adapter shutdown 순서, 04 §5) |
| NM-18c | shutdown으로 pending "7"을 이미 cancelled로 닫은 **후** 늦은 `process_exited`(또는 늦은 exit) 도착 | "7"은 **재차 닫히지 않음** — exit/shutdown으로 인한 pending 종료는 **멱등하며 정확히 한 번**(이중 종료/누락 없음). `approval_resolved`가 "7"에 대해 1회만 emit됨을 assert(S3 (c); 04 §4.2 규칙 4 멱등 무시, §5) |
| NM-18d | pending 없는 상태에서 shutdown → 늦은 exit | teardown이 멱등, crash·중복 emit 없음(S3 (c) 정확히 한 번 — pending 0건도 동일 규칙) |
| NM-18e | 같은 runtime에 `process_exited`/exit 이벤트가 두 번 도착 | 첫 exit만 `process_exited`와 pending cleanup을 emit하고, 두 번째 exit는 no-op — pending이 있든 없든 `process_exited`/`approval_resolved` 중복 emit 없음(04 §5, S3 (c) 멱등) |
| NM-19 | Codex `serverRequest/resolved{requestId:"7"}` 수신 | "7"만 닫고 사용자 응답 불필요(04 §4.2 규칙 3) |
| NM-20 | `ApprovalDecision{outcome:"failed"}` 발생 | client 내부 처리만, wire로 전송 안 함(04 §4.2 규칙 4) — outbound 캡처에 없음 assert |
| NM-20b | **audit entry 1건/결정(D-AUDIT)**: user 결정(`approval_resolved{outcome:"selected"}`), auto 결정(향후 auto-approve 경로), cleanup 결정(cancel/shutdown→`cancelled`, exit→`failed`) 각각 발생 | 각 결정마다 in-memory audit trail에 `ApprovalAuditEntry`가 **정확히 1건** 추가됨(`decidedBy`가 각각 `user`/`auto`/`cleanup`). 누락·중복 없음을 assert. cleanup 다중 pending(NM-18 류)에서도 닫힌 pending 수만큼 entry 1:1(09 §3.4 audit 체크리스트, 12 audit task) |
| NM-20c | **audit entry에 비밀 비포함(D-AUDIT)**: 명령 전문/credential/파일 내용이 담긴 approval(예 `commandExecution` 명령줄, env 값)을 결정 | audit entry에는 `requestId`/`optionId`/`optionKind`/`outcome`/`decidedAt`/`decidedBy`(+`sessionHandle`/`provider`/`toolCallId?`/`scope?`)만 존재하고, **명령 전문·credential·파일 내용·raw label은 부재**임을 assert(09 §3.4 — raw 명령은 §5 redaction 대상, optionId만 저장·label 금지) |

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

> v1 순서 권위는 **per-(라우팅 키) receive-order**다(04 §3.4). event-level `seq`는 v1에 미도입(15 AgentEvent에 추가 안 함, D-SEQ M-1) — adapter 단조 seq를 통한 cross-key 전역 정렬은 **후속(event-level seq 도입 후) enhancement**다. 따라서 v1 필수는 NM-29a(per-키 수신순서)이고, NM-29(seq 정렬)는 후속으로 강등한다.

| # | 입력 | 기대 |
|---|---|---|
| NM-29a | **(v1 필수)** 같은 라우팅 키(예 같은 `(threadId,turnId,itemId)` 또는 같은 messageId 그룹)에 대한 event들이 adapter 수신 순서대로 도착 | store가 **per-키 receive-order**를 권위로 append/replace 순서 보존(04 §3.4 v1 권위). cross-key 전역 재정렬은 v1 비요구 |
| NM-29 | **(후속 — event-level seq 도입 후)** adapter가 단조 증가 seq를 부여한 event들이 재정렬되어 도착 | store가 seq로 안정 정렬·dedup. **v1 미도입**(seq가 15 AgentEvent에 추가된 뒤에만 활성, D-SEQ M-1) — v1에서는 NM-29a로 대체(04 §3.4) |
| NM-30 | legacy `terminal_output_delta` | transcript 모델로 끌어올리지 않고 terminal surface에만 라우팅(04 §3.5). 증거: `legacy-pty-adapter.test.ts`, `agent-event-reducer.test.ts` NM-30 |

### 2.9 transcript 메모리 residency: seal / eviction / late-event (04 §3.7, 08 §5, 13 §1.12)

긴 세션에서 frontend in-memory transcript 모델(`TranscriptModel`, **08 §5 정본**)이 unbounded로 자라는 문제(13 §1.12 Long-session transcript memory (S2))를 reducer/store 수준에서 잠근다. 정본 인용: **3-상태 turn residency·seal 조건·seal 불변식·late-event 규칙 = 04 §3.7**, **view-model 타입(`TranscriptModel`/`TranscriptTurnResidency`/`TranscriptItem`/`AgentRuntimeViewState`) = 08 §5**(15 아님 — 15는 신규 타입 없이 "AgentEvent 불변, seal/eviction은 08 view-model/04 reducer 내부 정책" note만). reducer 시그니처는 `applyEvent(prev: TranscriptModel, event: AgentEvent): TranscriptModel`(08 §5)이다.

> **명명 주의**: 여기서 검증하는 것은 **turn residency / memory residency**(protocol lifecycle과 구분)이며, DOM 가상화(OQ-17, §2.8 주석 / 08 §3)와는 **별개 경계**다 — 반응형 표면(`visibleItemIds`/`itemVersions`)이 살아 있어도 sealed turn body(`itemsById`) eviction으로 heap이 감소한다. residency enum `TranscriptTurnResidency = "unsealed" | "sealed-retained" | "evicted-tombstone"`은 **08 §5 정의**다.

> **fixture 경계(정본)**: 아래 NM-31~NM-35의 입력은 **reducer/store event fixture**(NDJSON `{direction,message}` 시퀀스 또는 `AgentEvent[]`)이지 **adapter fixture가 아니다** — `applyEvent`를 직접 구동해 `TranscriptModel`을 검증한다(§1 adapter replay와 별개 레벨). 특히 **late same-turn event**(종료 신호 후 같은 turn에 도착하는 보조 notification) 검증은 reducer/store event fixture로 합성해 분기 규칙(unseal vs drop)을 고정하고, **실제 wire에서 그런 late event가 도착하는지 여부는 OQ-53**으로 분리한다(구현 직전 wire 실측 전까지 fixture 기반).

| # | 입력 | 기대 |
|---|---|---|
| NM-31 | 긴 세션을 합성: `HOT_WINDOW`(최근 N개 sealed turn cap, OQ-52)를 **초과**하도록 turn을 연속 seal시키는 event 시퀀스 | window = 최근 N개 sealed turn + 모든 unsealed/active turn(인터리빙 포함) + streaming turn. cap 초과 시 **oldest sealed turn body가 evict**되어 `turnsById[oldest].residency==="evicted-tombstone"`이 되고, `itemsById` 크기가 cap(window body + tombstone 메타) 내로 유지됨 — **heap bounded**를 assert. 세션 길이를 더 늘려도 `itemsById.size`가 일정 상한 아래 유지(04 §3.7, 08 §5, 13 §1.12; window/cap 수치는 OQ-52) |
| NM-31b | NM-31 상태에서 반응형 표면 크기 측정: `visibleItemIds`/`itemVersions`/`status`/`pending`만 반응형(`$state`), `itemsById`는 plain `Map` | 반응형 표면 크기가 **세션 길이와 무관하게 bounded**(visible window 크기에 비례)임을 assert — streaming은 body 갱신 + `itemVersions[itemId]` bump으로 표현되고, plain Map body 증가가 반응성 오버헤드를 키우지 않음(shallow 반응형 표면; 08 §5, 13 §1.12). DOM 가상화(OQ-17)와 별개로 store 레벨에서 성립 |
| NM-31c | NM-31 상태에서 **메타 인덱스 pruning** 측정: evict된 turn 다수 발생 | evict 시 해당 turn의 `itemVersions` 항목이 제거되고 `turnsById`가 {unsealed/sealed-retained + tombstone LRU}만 유지함을 assert — `itemVersions` 키 수와 `turnsById.size`가 evict된 turn 수에 비례해 자라지 **않고** bounded 유지(body뿐 아니라 반응형 표면·메타 인덱스도 세션 길이와 무관; 04 §3.7 eviction 윈도우 pruning, 08 §5) |
| NM-31e | execute tool call의 `terminal.stderr`가 크고 `HOT_WINDOW_BYTES`를 초과함 | stderr buffer도 hot-window byte 계산에 포함되어 oldest sealed turn부터 evict된다. stdout만 세고 stderr를 누락하지 않는다. 증거: `agent-event-reducer.test.ts` NM-31e. |
| NM-32 | unsealed turn에 seal 조건 충족 event: 종료 신호(Codex `turn/completed`·ACP `stopReason`) + open item 0 + pending approval/request 0 + turn-level 슬롯(usage/plan/diff) 반영 + 짧은 quiescence grace 경과 | 해당 turn `residency: "unsealed" → "sealed-retained"` 전이(body 유지). seal **불변식**(open item 0·pending 0·slot 반영)을 모두 만족할 때만 전이됨을 assert — 하나라도 미충족이면 unsealed 유지(04 §3.7 seal 조건/불변식). grace 미경과 시 아직 unsealed(OQ-53 same-turn 보조 notification 대비) |
| NM-32b | seal 조건 중 **pending approval 1건 잔존** 상태에서 종료 신호 도착 | seal **안 됨** — pending 0 불변식 위반이므로 `unsealed` 유지. pending resolve 후 grace 경과해야 `sealed-retained` 전이(04 §3.7 seal 불변식: pending 0 필수) |
| NM-33 | `sealed-retained` turn에 **늦은 event**(same-turn 보조 notification 합성) 도착 | **unseal → patch → reseal**: residency가 `sealed-retained → unsealed`로 잠시 되돌아가 event를 apply(body에 반영됨)한 뒤 다시 seal 조건 재충족 시 `sealed-retained`로 reseal. late patch가 **transcript body에 반영**되고 reseal telemetry(unseal/reseal 카운터)가 1 증가함을 assert(04 §3.7 late-event 규칙: sealed-retained는 unseal-patch-reseal) |
| NM-33c | `sealed-retained` turn에 늦은 `turn_completed{status:"failed"}` 또는 stopReason warning 보강 도착 | 종료/notice 계열 event도 patch event와 동일하게 먼저 unseal한다. failed/refusal/max_* notice가 body에 붙고 `resealCount`가 증가한 뒤, reseal 트리거에서 다시 `sealed-retained`로 전이한다. sealed 상태에 body를 몰래 붙이지 않는다(04 §3.7 late-event 규칙, 04 §3.6 notice dedup) |
| NM-33d | `sealed-retained` turn에 중복 `turn_completed{status:"completed"}` 도착(새 notice/cancel/body patch 없음) | no-op으로 처리한다. body가 바뀌지 않는 중복 종료 event는 unseal하지 않고 `resealCount`도 증가시키지 않는다. 즉 NM-33의 late-event telemetry는 실제 patch가 있는 보강 event에만 붙는다(04 §3.6 notice dedup, §3.7 late-event 규칙) |
| NM-33e | `sealed-retained` turn에 동일 `error` event 재emit(동일 message hash notice가 이미 있음) | no-op으로 처리한다. dedup notice가 이미 있으면 body patch가 아니므로 unseal/reseal telemetry를 증가시키지 않는다. 첫 error는 notice를 생성하며 unseal되지만, 중복 error는 sealed-retained를 그대로 유지한다(04 §3.6 error notice dedup, §3.7) |
| NM-33f | `sealed-retained` turn에 동일 비정상 `process_exited` 재emit(세션 notice가 이미 있음) | no-op으로 처리한다. 세션당 1건 process exit notice dedup 후에는 body patch가 없으므로 unseal하지 않는다. tombstone turn으로 온 late exit은 여전히 NM-34d처럼 drop 카운트만 증가한다(04 §3.6 process_exited notice dedup, §5.0 멱등 종료, §3.7) |
| NM-34 | `evicted-tombstone` turn에 **늦은 event** 도착 | event **apply 안 됨**(body 미복원·tombstone 유지) + `droppedLateEventCount` 1 증가. transcript body가 복원되지 않고(`itemsById`에 해당 turn item/notice 없음) residency가 `evicted-tombstone`에 머무름을 assert — message/tool/plan/file 변경뿐 아니라 `error`/비정상 `process_exited`처럼 notice를 생성하는 event도 tombstone body를 되살리지 않는다. tombstone은 작은 LRU/TTL로 bounded(04 §3.7 late-event 규칙: evicted-tombstone은 apply 금지 + drop 카운트; 08 §5 `tombstones = LRU<turnId> + droppedLateEventCount`) |
| NM-34b | tombstone 다수 생성으로 tombstone LRU/TTL cap 초과 | oldest tombstone이 LRU/TTL로 제거되어 `tombstones` 집합도 **bounded** 유지(droppedLateEventCount 누계는 보존). tombstone 메타 자체가 unbounded로 자라지 않음을 assert(04 §3.7, 08 §5 tombstone LRU/TTL; cap 수치 OQ-52) |
| NM-35 | seal/eviction을 거친 모델에서 `AgentEvent` 자체는 불변임을 확인 | reducer가 받는/저장하는 `AgentEvent`(15 §3)는 seal/eviction과 무관하게 그대로이고, residency·seal·eviction은 **08 view-model/04 reducer 내부 정책**임을 assert — 15에 신규 타입이 추가되지 않음(15 note 일치, 08 §5, 04 §3.7) |

> NM-31의 v1 보수 기본값은 구현에 고정되어 있지만, window/cap 운영 튜닝(`HOT_WINDOW`, `itemsById` cap, tombstone TTL, heavy item/image cap)은 **실측 전 성능 결론으로 assert하지 않는다** → [13](13-risks-open-questions.md) OQ-52. NM-33은 same-turn 보조 notification이 실제 wire에서 종료 신호 뒤에 도착하는지(→ seal grace 필요 여부)에 의존하므로 입력은 합성 fixture로 두고 실제 wire 발생은 OQ-53으로 분리한다(구현 직전 실측). 격리 replay-reload(tombstone 구간)는 Codex `thread/read` `includeTurns:true`가 전체 snapshot을 반환하는 것으로 실측됐다(OQ-54 해소). 따라서 FE-27은 live 미병합/scratch 폐기와 full snapshot event 상한/partial notice를 고정한다.

---

## 3. Codex adapter tests (ref-codex 인용)

대상: `src/lib/features/agent-runtime/adapters/codex/codex-app-server-adapter.ts`(테스트는 co-located `codex-app-server-adapter.test.ts`, 12 §0.1). 입력은 Codex wire `JsonRpcMessage`, 출력은 `AgentEvent[]` 또는 outbound `JsonRpcMessage`. 매핑 정본은 ref-codex §8.

### 3.1 thread start / resume

| # | 입력 | 기대 |
|---|---|---|
| CX-1 | `thread/started{thread:{id,sessionId,cwd}}` | `session_started{ref:{threadId,sessionId}, cwd}`(ref-codex §8) |
| CX-2 | `thread/resume` 응답 또는 `thread/read{threadId, includeTurns:true}` 결과 | `session_loaded` + turns replay(ref-codex §3.1 `thread/read`, §8). replay=true 경로는 `includeTurns:true`를 반드시 보내며, returned `thread.turns[].items[]`를 completed item replay로 재생한다(OQ-54) |
| CX-3 | `thread/status/changed{status:{type:"active",activeFlags:["waitingOnApproval"]}}` | `session_status_changed:requires_action`(ref-codex §6.1, §8) |
| CX-4 | `thread/status/changed{status:{type:"systemError"}}` | `session_status_changed:failed`(ref-codex §8) |
| CX-4b/OQ-20 | `sendPrompt("hi")` outbound `turn/start` | params가 정확히 `{threadId, input:[{type:"text", text:"hi", text_elements:[]}]}`이고, `approvalPolicy`/`sandboxPolicy`/`model`/`effort` 및 experimental override 필드를 포함하지 않음(ref-codex §6.5, 05 §2.4) |
| CX-4c | Codex `sendPrompt` 입력이 전부 capability 미지원 content(image 미opt-in 등)라 `mapAgentContentToUserInput(...)` 결과가 `[]` | 빈 `turn/start{input:[]}`를 보내지 않고 recoverable `error` event만 emit한다. running 전이를 만들지 않음(05 §5.3d outbound guard, 08 §6.4 빈 prompt 방어 parity) |

### 3.2 delta → completed reconcile

| # | 입력 | 기대 |
|---|---|---|
| CX-5 | item/started(agentMessage,empty) → agentMessage/delta×N → item/completed(text) | `agent_message{replace}` → `agent_message_delta`×N → `agent_message{replace,final}`(ref-codex §7.1). reasoning delta는 별도 케이스로 `segment` metadata를 보존(CX-5b/NM-11) |
| CX-5b | `item/reasoning/textDelta{contentIndex}` / `summaryTextDelta{summaryIndex}` | `agent_message_delta{channel:"thought", segment:{kind:"content"|"summary", index}}`로 매핑하고 reducer가 segment별로 append |
| CX-5c | `item/completed` reasoning `{summary:string[], content:string[]}` (OQ-46) | completed reasoning item은 thought 채널의 권위로 `agent_message{channel:"thought", mode:"replace"}`를 emit한다. app-server snapshot 실측(48 threads, reasoning 2,026 items) 결과 `summary[]`가 권위 필드였으므로 text는 `summary[]` join으로 만든다. `summary[]`가 비어 있는 schema-drift/legacy 입력은 `content[]` fallback으로 보존한다. |
| CX-6 | plan delta → item/completed(plan) | completed 권위로 reconcile, delta는 점진 렌더만(ref-codex §7.1 plan/reasoning 주석) |
| CX-7 | `turn/plan/updated{plan:[{step,status:"inProgress"}]}` | `plan_updated{entries:[{content:step, status:"in_progress"}]}` (casing 변환 inProgress→in_progress, ref-codex §6.8, §8) |

### 3.3 command output routing

| # | 입력 | 기대 |
|---|---|---|
| CX-8 | `item/commandExecution/outputDelta{itemId,delta}` (평문) | `command_output_delta{stream:"stdout", delta}` — thread 채널 평문(ref-codex §5.2, §8) |
| CX-9 | `command/exec/outputDelta{processId, deltaBase64, stream}` (standalone) | **v1 미지원**(13 OQ-21 확정). thread 채널 `item/commandExecution/outputDelta`만 `command_output_delta`로 매핑한다. standalone base64 채널은 후속 범위이며, v1 mapper는 raw 보존/unknown counter 경계로만 가시화한다(ref-codex §5.3 — 다른 채널, base64 주의) |
| CX-10 | item/completed(commandExecution, status:"declined") | `tool_call_updated{status:"failed"}` (declined→failed, ref-codex §6.3, §8) |
| CX-10b/OQ-61 | item/completed(commandExecution, generated baseline 밖 optional `locations[]`) | `tool_call_updated.update.locations`에 valid `FileLocation{path,line,column}`만 보존한다. generated 타입에 없는 provider/test-mode 확장 필드여도 UI location jump 하한을 잃지 않는다. |

### 3.4 approval mapping

| # | 입력/방향 | 기대 |
|---|---|---|
| CX-11 | `item/commandExecution/requestApproval{id:7, threadId,turnId,itemId}` (server→client request) | `approval_requested{request.id:"7"}`, options=accept/acceptForSession/decline/cancel → kind allow_once/allow_always/reject_once/cancel(ref-codex §4.1, §8) |
| CX-11b | **OQ-47 escalation 분류**: `item/permissions/requestApproval`, command approval의 `proposedExecpolicyAmendment`/`proposedNetworkPolicyAmendments`/`networkApprovalContext`, raw/future `sandbox:"danger-full-access"`·`sandboxRequested:"danger-full-access"`·`approvalMode:"Agent (Full Access)"`, raw/future `additionalPermissions` 중 network enable/fs write overlay, raw/future `commandActions`의 `write`/`edit`/`delete`/`move`/`execute`/`fetch`류 부수효과 action type, fileChange `grantRoot` | `codexApprovalSeverity(...) === "escalation"`이며, 일반 command approval과 read-only fs overlay, 현재 generated `commandActions`의 `read`/`listFiles`/`search`/`unknown`은 `"normal"`이다. v1은 고위험 집합을 inline으로 강등하지 않음(09 §8.3, 05 D-ESCALATION, 13 OQ-47) |
| CX-12 | `respondApproval{outcome:"selected", optionId(allow_once)}` (아웃바운드) | outbound `{id:7, result:{decision:"accept"}}`, **`jsonrpc` 필드 없음**(ref-codex §1.2, §8.1) |
| CX-13 | allow_always 선택 | `decision:"acceptForSession"`(ref-codex §8.1) |
| CX-14 | `reject_always` 선택(공용 approval 경계의 방어 매핑; v1 Codex UI에는 미노출) | `decision:"decline"` (영구 거부 등가물 없음 → decline, ref-codex §8.1, OQ-14 해소) |
| CX-15 | `serverRequest/resolved{threadId,requestId:7}` | 해당 requestId pending 닫기(ref-codex §4.4) |
| CX-15b | **미지원 server→client request**(id 있는 요청이나 adapter가 모르는 method, 예 알 수 없는 elicitation method) | outbound로 JSON-RPC **error 응답**(`{id, error:{code:-32601, message}}`) 또는 명시적 decline 응답을 보낸다. **무응답으로 끝나지 않음**(provider deadlock 방지) — `drainOutbound()`에 정확히 1개 응답이 있고, 응답 `id`가 요청 `id`와 일치함을 assert(R5; 05 §7.1 default 분기는 `return []`로 끝내지 말고 unknown server request에 error/unsupported 응답 후 종료; 04 §5 edge 규칙, 13 unknown-variant silent-drop 금지) |
| CX-15c | 미지원 **notification**(id 없음, 예 알 수 없는 v2 notification) | 응답 불필요 — raw 보존(`ProviderRef.raw`) + unknown counter 증가만, outbound 없음 assert(R5 notification 경로, 15 §0.2) |
| CX-15d | `item/started`/`item/completed` 내부의 v1 밖 `ThreadItem` variant | transcript event 없음(`[]`)을 유지하되 raw diagnostic payload(`method`, `threadId`, `turnId`, `item`)와 unknown counter를 남김. unknown method뿐 아니라 unknown variant도 silent drop하지 않음을 assert(RD-10, 15 §0.2) |

### 3.5 interleaved turn 분리

| # | 입력 | 기대 |
|---|---|---|
| CX-16 | threadId=A/turnId=t1 item과 threadId=B/turnId=t2 item 교차 도착 | 각 event `ref`가 올바른 삼중 키, 두 turn이 섞이지 않음(ref-codex §7.1) |
| CX-17 | 같은 thread 내 turn t1 완료 후 t2 시작 | t1 `turn_completed` 후 t2 `running` 별개(ref-codex §8) |

### 3.6 process exit / error

| # | 입력 | 기대 |
|---|---|---|
| CX-18 | `error{willRetry:true, codexErrorInfo:"usageLimitExceeded"}` | `error{recoverable:true}`, 코드 분류(ref-codex §6.9, §8) |
| CX-18a | thread/start 또는 resume 후 runtime `error`/backpressure event | `error.ref`가 시작된 Codex `threadId`/`sessionId`를 보존한다. error notice dedup은 라우팅 키 + message hash(04 §3.6)에 기대므로, 알려진 provider id를 session-level runtime event에서 잃지 않는다. |
| CX-19 | app-server process exit(`agent-runtime-exit`) | `process_exited`, 모든 pending 실패 닫기(04 §5) |
| CX-19a | thread/start 또는 resume 후 app-server process exit | `process_exited.ref`가 시작된 Codex `threadId`/`sessionId`를 보존한다. process exit notice와 추적성은 session 단위 dedup(04 §3.6, 15 §1 `ProviderRef`)에 기대므로, 알려진 provider id를 `{provider:"codex"}`만으로 축약하지 않는다. |
| CX-20 | `thread/tokenUsage/updated{tokenUsage}` | `turn_completed.usage`로 보강, `TokenUsageBreakdown` 매핑(`totalTokens` 버림, ref-codex §6.7, §8) |

---

## 4. Claude ACP adapter tests (ref-acp / ref-claude-agent-acp 인용)

대상: `src/lib/features/agent-runtime/adapters/claude-acp/claude-acp-adapter.ts`(테스트는 co-located `claude-acp-adapter.test.ts`, 12 §0.1). 매핑 정본은 ref-acp §13, 구현체 사실은 ref-claude-agent-acp.

### 4.1 initialize / session new·load

| # | 입력/방향 | 기대 |
|---|---|---|
| CL-1 | `initialize` 아웃바운드 | `{jsonrpc:"2.0", protocolVersion:1, clientCapabilities, clientInfo}` 전송(ref-acp §3.1) |
| CL-1a | OQ-43 conservative capability payload | `clientCapabilities`가 `fs.*=false`, `terminal=false`, `auth.terminal=false`, `auth._meta.gateway=false`, `_meta.terminal_output=false`, `_meta["terminal-auth"]=false`, `elicitation.form/url=null`로 전송됨 |
| CL-2 | initialize result(protocolVersion=1, agentCapabilities) | provider 확정, capability 파싱: `loadSession`(top-level), `sessionCapabilities.resume`(중첩) **위치 비대칭** 정확히 판독(ref-acp §3.5 주의) |
| CL-3 | initialize result(protocolVersion≠1) | protocol error 처리(ref-claude-agent-acp §4, ref-acp §3.1 버전 협상) |
| CL-4 | `session/new` result(sessionId) | `session_started{ref.sessionId, cwd}`(ref-acp §13.1) |
| CL-5 | `session/load` 호출 후 응답 전 update 스트림 → load result | `session_loaded` + replay update를 transcript 재구성(ref-acp §3.4, §13.1) |
| CL-6 | `session/resume` result | `session_loaded` (replay 없음, ref-acp §3.5) |
| CL-6a | OQ-44 process-per-session shutdown | Claude ACP v1 shutdown은 `shutdownRuntime(runtimeId)`만 사용하고 `session/close` wire를 보내지 않음 |
| CL-6b | `session/new`/`session/load`/`session/resume` result의 `modes.currentModeId`와 `configOptions[id="mode"].currentValue`, 이후 `current_mode_update`/`config_option_update` | `SessionStartResult.sessionMode`/`permissionMode`를 반환하고, notification은 `runtime_metadata_changed{metadata:{sessionMode,permissionMode}}`를 emit한다(ref-acp §10, ref-claude-agent-acp §2/§3, 09 §8.2) |

### 4.2 prompt accepted vs session/update 분리

| # | 입력 | 기대 |
|---|---|---|
| CL-7 | `session/prompt` 전송 | `session_status_changed:running` (accepted는 response가 아니라 turn 시작, ref-acp §13.1) |
| CL-7a | ACP live prompt optimistic echo(OQ-57): capability가 true인 세션에서 image/resource 포함 `AgentContent[]` 전송 | `user_message{mode:"replace"}`가 running 전 1회 emit되고, `ref.messageId="<sessionId>:t<n>:u"`, `content=input.content` 원본 그대로. 다음 turn은 `<sessionId>:t<n+1>:u`로 유일 |
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
| CL-18 | `audio` content block | v1 미지원이지만 drop하지 않고 `AgentContent{type:"json"}` raw 블록으로 보존, text delta 경로로 새지 않음(ref-acp §13.2 — CLCOMX 모델에 audio 없음) |

> CL-17(thought)은 D11 정책으로 확정됐다: `channel:"thought"` 누적으로 기대값을 고정하고, response 채널과 별도 스트림임을 assert한다(13 OQ-01/RD-13 "해소됨"). CL-18(audio)은 v1 미지원으로 확정하되 raw를 `json` content로 보존하고 crash하지 않는지 assert한다(13 OQ-04 해소).

### 4.5 permission mapping

| # | 입력/방향 | 기대 |
|---|---|---|
| CL-19 | `session/request_permission{id:42, toolCall, options}` | `approval_requested{request.id:"42", toolCallId}`, options optionId/name/kind 매핑(ref-acp §6, §13.4) |
| CL-20 | PermissionOptionKind 4종(allow_once/allow_always/reject_once/reject_always) | `ApprovalOption.kind` 1:1(ref-acp §6) |
| CL-21 | `respondApproval{selected, optionId}` 아웃바운드 | `{jsonrpc:"2.0", id:42, result:{outcome:{outcome:"selected", optionId}}}`(ref-acp §6) |
| CL-21b | **원본 numeric id 타입 보존(R3)**: `session/request_permission{id:42(number), ...}` 수신 → 사용자가 응답 → `buildPermissionResponse` 아웃바운드 | wire 응답의 `id`가 **숫자 `42`**(보존한 원본 `PendingApproval.rpcId`)여야 한다 — **문자열 `"42"`가 아님**. `ApprovalRequest.id`/`ProviderRef.requestId`는 `String(id)="42"`(UI·store 문자열 키)지만, wire 응답 `id`는 원본 타입 유지. 입력=numeric `42` → 기대 outbound `id:42(number)` (R3; 06 §6.1/§6.2 `PendingApproval.rpcId` 보존, 05 §6 CodexRouting rpcId 보존 동일 패턴; numeric→문자열 변질로 인한 매칭 실패/deadlock 방지) |
| CL-21c | string id permission(`id:"req-1"`) | wire 응답 `id:"req-1"`(string 그대로 보존) — string·number 양쪽에서 원본 타입 미손실 assert(R3) |
| CL-22 | cancel 시 pending permission | `{outcome:{outcome:"cancelled"}}` 응답, 응답 `id`는 보존한 원본 rpcId 타입(R3) (ref-acp §3.8 MUST, 04 §4.2) |
| CL-23 | ExitPlanMode permission(claude 구현체) | optionId bypassPermissions/auto/acceptEdits/default/plan, kind 매핑(ref-claude-agent-acp §3 request_permission 표) |
| CL-24 | 일반 tool 3-option(allow_always/allow/reject) | kind allow_always/allow_once/reject_once(ref-claude-agent-acp §3) |
| CL-24b | **미지원 server→client request(R5)**: capability 미광고 상태에서 도착한 `fs/read_text_file`/`terminal/create` 등 또는 알 수 없는 method(id 있는 요청) | outbound로 JSON-RPC **error 응답**(`{jsonrpc:"2.0", id, error:{code:-32601, message:"Method not found"}}`) 또는 명시적 decline 응답을 보낸다. **무응답으로 끝나지 않음**(provider deadlock 방지) — `drainOutbound()`에 정확히 1개 응답, 응답 `id`가 요청 `id`와 (원본 타입 그대로) 일치함을 assert(R5; ref-acp §1·§"error code 표"의 `-32601` Method not found, 06 미지원 server request error/decline parity, 04 §5 edge 규칙) |

### 4.6 stdout invalid JSON framing error

| # | 입력 | 기대 |
|---|---|---|
| CL-25 | stdout 라인이 valid JSON 아님(ACP stdout purity 위반) | `error{recoverable:false, message}` emit, transcript 오염 안 함(ref-acp §1 stdout purity, ref-claude-agent-acp §5 stdout 청결) |
| CL-26 | JSON이지만 ACP 메시지 아님(method/result/error 없음) | framing error(ref-acp §1) |
| CL-27 | 알 수 없는 `sessionUpdate` variant 또는 미지원 **notification**(id 없음, 예 plan_update/plan_removed) | graceful 무시, crash 없음, raw 보존(`ProviderRef.raw`) + unknown counter 증가, **outbound 없음** assert — notification(id 없음)은 응답 불필요(R5 notification 경로, ref-claude-agent-acp §2, 15 §0.2). `session_info_update.title`은 `session_title_changed`로 매핑하므로 미지원 예시에서 제외한다. id 있는 미지원 *request*는 CL-24b(error/decline 응답)와 구분 |

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
| RS-5 | valid JSON line / one-off invalid JSON line / line이 4MB cap 초과 | valid는 message로 emit, one-off invalid/cap 초과는 recoverable framing error로 분류(연속 invalid는 5회째 `recoverable:false`) |
| RS-5b | raw newline/pretty-print로 한 JSON 메시지가 EOF-like incomplete line(`{"id":1` 등)으로 쪼개짐 | 즉시 fatal framing break(`recoverable:false`)로 분류하고 reader latch에 들어간다(07 §4.4 embedded newline 규칙) |

### 5.2 stderr / stdout 분리

| # | 입력 | 기대 |
|---|---|---|
| RS-6 | stdout에 JSON-RPC, stderr에 로그 라인 | stdout→`agent-runtime-message`, stderr→`agent-runtime-stderr` 별개 채널(15 §8.3, ref-acp §1 stderr MAY log) |
| RS-7 | stderr가 비-UTF8/멀티라인 | stderr line emit, stdout framer 오염 없음 |

### 5.3 allowlist 검증 (신규 강화 지점 — R4 backend-resolve command + 정확 args + env key)

PTY와 달리 direct runtime은 backend가 provider별로 command를 resolve하고 args/env를 allowlist로 재검증한다(07 §8.1 정본, 15 §8.1 주석, `research/codebase-backend.md` §6, §10 권고 6 — 현 코드에 선례 없음). **S1 정본(B1 정정)**: renderer/adapter는 **실행 파일 command를 넘기지 않는다**. `AgentRuntimeStartParams`(15 §8.1)에서 `command` 필드가 **제거**되어 renderer 비제어이며, backend가 `provider`로 신뢰 절대경로를 resolve한다 — `codex` → resolve된 codex app-server 절대경로, `claude` → resolve된 node 절대경로. 따라서 동명 바이너리(`/tmp/codex`, `/tmp/node`)로 우회할 입력 자체가 존재하지 않는다(renderer가 경로를 못 넘김). adapter가 넘기는 것은 `provider`, `distro`, `workDir`, `args`(검증 대상), `env`(non-secret) 뿐이다.

**args 검증(backend)**: Codex는 `args`가 **정확히** `["app-server","--stdio"]`. Claude는 `args.length == 2` 이고 `args[0]`이 backend가 검증한 `adapterEntryPath`(절대경로, `claude-agent-acp` `dist/index.js` 패턴)와 정확 일치하며 `args[1]`은 고정 `--hide-claude-auth`다. `adapterEntryPath`는 renderer 자유 입력이 아니라 backend가 **고정 npm 의존 위치에서 resolve(또는 사전 등록된 절대경로)**한 값이다. env key는 정규식 + provider별 허용 key 집합으로 강제한다(값은 non-secret, C1). shell metachar 검사는 방어용으로 유지한다. 아래 RS-8..RS-12d는 이 S1 정본의 수용 테스트다(09 untrusted renderer 위협모델, 07 §8.1 인용; 타입 정본 15 §8.1은 S1로 `command` 필드 제거).

> **resolve 주체·캐시 무효화·`adapterEntryPath` 탐색 방식은 T2.0/OQ-36에서 확정됐다(→ [13](13-risks-open-questions.md) OQ-36)**. owner는 `agent_runtime/resolver.rs`, cache key는 `(provider,distro)`, clear 후 재탐색한다. 단위 테스트는 실제 WSL/CLI 설치 상태에 묶이지 않도록 `TrustedPathResolver`를 주입해 resolver/cache 경계와 pinned adapter layout을 검증하고, start 경로는 backend가 provider로 resolve한 신뢰 절대경로만 쓰는 계약을 고정한다. 현 RS-10c가 실패만 다루던 공백을 RS-10d/10e가 보완한다(12 T2.0/T2.4 DoD 연계).

| # | 입력 | 기대 |
|---|---|---|
| RS-8 | `agent_runtime_start{provider:"codex", distro, workDir, args:["app-server","--stdio"]}` (command 필드 **없음** — 타입에서 제거) | 허용, RuntimeId 반환. backend가 `codex` provider로 신뢰 절대경로를 resolve해 spawn하고 Codex 정확 args 통과(S1, 07 §8.1). spawn된 executable이 backend-resolve한 codex 절대경로임을 assert(mock resolve 주입) |
| RS-8b | `provider:"codex"`, `args:["app-server"]`(또는 `["app-server","--stdio","--extra"]`) | `Err(String)` 거부 — Codex args는 정확히 `["app-server","--stdio"]`여야 함(07 §8.1 args 정확 검증) |
| RS-8c/OQ-31 | `distro:"  "` 빈 값 | `Err(String)` 거부. v1은 `list_wsl_distros` 집합 대조를 하지 않지만, 빈 distro는 start 경계에서 막는다 |
| RS-8d/OQ-31 | `workDir`가 Windows path(`C:\...`), relative path, `~` path | `Err(String)` 거부. `/home/x//y/` 같은 WSL absolute path는 문자열 정규화해 `/home/x/y`로 canonicalize한다. 실제 `test -d` 존재 검증은 하지 않음 |
| RS-9 | `provider:"claude"`, `args:[검증된 adapterEntryPath(절대경로, claude-agent-acp dist/index.js 패턴),"--hide-claude-auth"]` (command 필드 **없음**) | 허용. backend가 `claude` provider로 node 신뢰 절대경로를 resolve하고 `args.length==2` + `args[0]`가 backend 검증 adapterEntryPath + `args[1]`이 고정 auth 숨김 플래그임을 통과(S1, 07 §8.1, 06 §2.2, ref-claude-agent-acp §1·§2). spawn된 executable이 backend-resolve한 node 절대경로임을 assert |
| RS-9b | `provider:"claude"`, `args:["/tmp/x.js"]`(임의 .js, backend 신뢰 adapterEntryPath 아님), `args:[adapterEntryPath]`(hide flag 누락), 또는 `args:[adapterEntryPath,"--x"]`(임의 argv) | `Err(String)` 거부 — `args[0]`가 backend 검증 adapterEntryPath와 미일치하거나 `--hide-claude-auth` 고정 플래그가 누락/변조됨(07 §8.1 임의 .js·임의 argv 거부) |
| RS-10 | **renderer가 command를 넣을 경로가 없음(구조적 차단)**: 직렬화 시 추가 `command` 키가 붙은 payload를 deserialize | `command` 필드는 타입에 없으므로 무시되거나(미정의 필드) deny — renderer가 executable 경로를 제어할 입력 자체가 없음을 assert. 동명 바이너리(`/tmp/codex`,`/tmp/node`) 우회 불가가 구조적으로 성립(S1; 07 §8.1 basename 비교 제거, 15 §8.1 command 제거) |
| RS-10b | `provider:"claude"`, `args:["/tmp/x.js"]` (backend node resolve 사용, adapterEntryPath 미일치) | `Err(String)` 거부 — executable은 backend가 고정 resolve하므로 renderer가 못 바꾸고, `args[0]`가 신뢰 adapterEntryPath 아니라 거부(S1 핵심 거부 케이스, 09 위협모델). renderer가 임의 .js를 실행시킬 수 없음을 assert |
| RS-10c | backend resolve가 신뢰 codex/node 절대경로를 못 찾음(미설치/탐색 실패) | `Err(String)` — provider 신뢰 경로 resolve 실패 시 spawn하지 않음(S1 backend-resolve 계약). OQ-36 확정값에 따라 owner는 `agent_runtime/resolver.rs`이고, 테스트는 `TrustedPathResolver` mock 실패 주입으로 실제 WSL/CLI 설치 상태와 분리한다. |
| RS-10d | **resolve 성공경로(executable) + 캐시 무효화**: `CachingResolver`가 `resolve_trusted_executable(provider, distro)` 계약의 성공값을 받음 → 동일 key 재호출 → `clear()` 후 재호출 | 신뢰 **절대경로** 반환(상대경로 아님), cache hit에서는 inner resolver 미호출, `clear()` 후에는 재탐색(stale 캐시 미반환). 외부 WSL/CLI 상태는 mock `TrustedPathResolver`로 대체하되 cache boundary는 실제 resolver 코드로 검증한다(S1 backend-resolve 계약, 07 §8.1, 12 T2.0/T2.4 DoD 연계) |
| RS-10e | **resolve 성공경로(adapter entry) + pinned layout + 캐시 무효화**: `CachingResolver`가 `resolve_trusted_adapter_entry("claude", distro)` 계약의 성공값을 받음 → 비핀 layout 입력 → pinned layout 입력 → `clear()` 후 재호출 | 비핀 layout(`/opt/acp/dist/index.js` 등)은 캐시에 저장하지 않고 거부한다. pinned `node_modules/@agentclientprotocol/claude-agent-acp/dist/index.js` 절대경로만 허용·캐시하며, `clear()` 후에는 재탐색(stale 캐시 미반환)한다(07 §8.1, 12 T2.0/T2.4 DoD 연계) |
| RS-10f/OQ-24 | **startup executable version preflight**: resolve된 executable 절대경로로 `preflight_executable_version(provider,distro,executable)` 실행 | `--version` probe가 성공하고 비어 있지 않은 문자열을 반환해야 spawn을 진행한다. 이 probe는 path cache hit와 별개로 startup마다 실행되어 runtime 중 provider 교체/stale binary를 최소한 감지한다(13 §1.10, OQ-24). |
| RS-10g/OQ-24 | `preflight_executable_version`에 상대 executable(`codex` 등) 전달 | `Err(String)` 거부 — version preflight도 backend-resolved 신뢰 **절대경로**만 받는다. |
| RS-10h/OQ-24 | `validate_launch_for_start` 성공 후 start 직전 preflight가 실패 | `preflight_launch_for_start`가 resolved executable(`/usr/bin/codex` 등)을 넘겨 probe를 1회 실행하고, 실패를 `Err(String)`으로 반환해 spawn으로 진행하지 않는다. 실패 사유는 redacted launch audit 경계로 보낸다. |
| RS-10i/OQ-24 | start 직전 preflight가 whitespace/빈 version 문자열 반환 | `Err(String)` 거부 — start 경계에서도 빈 provider version을 허용하지 않는다. |
| RS-10j/OQ-24 | test/mock resolver가 `preflight_executable_version`을 override하지 않음 | 기본 fallback은 `preflight unavailable`로 실패한다. 운영 `WslResolver`의 preflight 구현 부재로 오해되는 `not implemented` placeholder를 남기지 않는다. |
| RS-10k/OQ-10 | Claude start 직전 native binary preflight | `node <adapterEntryPath> --cli --version` 성격의 probe가 실행되어 `@anthropic-ai/claude-agent-sdk` optional dependency 또는 `CLAUDE_CODE_EXECUTABLE` override로 native binary가 resolve되는지 확인한다. 성공해야 spawn으로 진행한다. |
| RS-10l/OQ-10 | Claude native binary preflight 실패(`Claude native binary not found` 등) | `Err(String)` 거부 — optional dependency 누락/override 오류가 `session/prompt` 이후가 아니라 start preflight에서 드러나고, spawn으로 진행하지 않는다. |
| RS-10m/OQ-10 | `CLAUDE_CODE_EXECUTABLE` 등 검증된 launch env가 있는 Claude start | native binary preflight가 `launch.non_secret_env`를 받아 실제 launch와 같은 env 조건에서 `--cli --version`을 probe한다. |
| RS-11 | args에 shell 메타문자/주입 시도(`;`/`|`/`$(`/개행 등) | 거부(executable+argv 직접 실행이라 셸 비경유지만 방어적 metachar 검사 유지, 07 §8.1 규칙 3, `research/codebase-backend.md` §2.2) |
| RS-12 | env key가 `^[A-Za-z_][A-Za-z0-9_]*$` 위반(예: `1BAD`, `A-B`, `A B`) | `Err(String)` 거부(registry `assertValidEnvKey` 선례, 07 §8.1 규칙 5, `research/codebase-backend.md` §6) |
| RS-12b | env key가 정규식은 통과하나 provider별 허용 key 집합 밖(미등록 key) | `Err(String)` 거부 — env key allowlist(provider별 허용 집합) 강제(07 §8.1 규칙 5, S1 env key allowlist). 값은 non-secret 전용(C1, 07 §5.1·§8.1·§11) |
| RS-12c | **websocket reject-before-log(D-WSAUTH)**: `agent_runtime_start{transportKind:"websocket", ..., authToken:"secret-xyz"}` (15 §8.1 websocket variant — v1 미사용) | handler가 **로깅·스냅샷 노출 전에** 즉시 `Err(String)` 거부(13 RD-2, 07 handler websocket 즉시 reject). 거부 경로에서 캡처한 로그·debug snapshot·audit 어디에도 `authToken` 값(`secret-xyz`)이 평문으로 나타나지 않음을 assert — `authToken`이 redaction/scrub 집합에 포함되어 token 로깅 없이 reject됨(09 secret scrub `authToken` 포함, 15 §8.1 "v1 미사용 — 로깅/스냅샷 노출 전 reject"). variant 타입 자체는 future-sketch로 유지 |
| RS-12d | **launch reject audit redaction**: allowlist 실패를 유도하는 secret-shaped provider(`provider:"sk-super-secret"`)로 `agent_runtime_start` 검증 wrapper 호출 | 반환값은 원래 실패 `Err(String)`이고, `agent-runtime-audit.log`에는 `launchRejected` JSONL entry 1건이 남는다. entry는 `event`/`atMs`/`transportKind`/redacted `provider`/redacted `reason`만 포함하며, secret-shaped provider 값·`args`·`env`·`workDir`·`authToken` 같은 renderer params 전체는 직렬화하지 않는다(09 §4 checklist). |

### 5.4 process lifecycle: shutdown timeout → kill (S3 — reap 후 반환 + cleanup 경계)

**S3 정본(B3 정정)**: `agent_runtime_shutdown`은 **authoritative cleanup 경계**다. backend shutdown은 graceful stdin close → timeout → kill → **child reap까지 끝낸 뒤 반환**하며, 최종 exit이 반영/계상된 후에만 teardown이 일어나도록 한다(늦은 exit로 pending이 누락되지 않게). 아래 RS-13..RS-15c는 backend 경계 테스트다(RS-15c는 `REAP_GRACE_MS` 초과 시 Err 반환+runtime 미제거 필수 실패 분기). adapter-side pending 종료 순서(unlisten 전에 정확히 한 번)는 §2.5 NM-18b/18c가 검증한다.

| # | 입력 | 기대 |
|---|---|---|
| RS-13 | `agent_runtime_shutdown` → child가 stdin EOF에 정상 종료 | graceful, child reap 완료 후 반환, `agent-runtime-exit{code}` emit(S3 reap-후-반환, 15 §8, 07 §5.2) |
| RS-14 | child가 timeout 내 종료 안 함 | timeout 후 강제 kill, **child reap 후 반환**, exit emit(`research/codebase-backend.md` §10 권고 5 — PTY와 달리 명시적 kill; S3) |
| RS-15 | shutdown 시 pending request 존재 | process exit이 모든 pending을 실패로 닫음 신호(04 §5; backend는 framing만, 의미 처리는 frontend지만 exit 이벤트는 backend) |
| RS-15b | shutdown 반환 시점 vs 최종 exit 반영 순서 | `agent_runtime_shutdown`이 반환할 때 child가 이미 reap되어 exit이 계상됨 — 반환 후 늦게 도착하는 exit이 **없음**을 assert(S3: 최종 exit 반영 후에만 teardown). 반환 전에 exit emit 또는 exited 플래그 set 확인(07 §5.2·§5.3) |
| RS-15c | `REAP_GRACE_MS` 초과해도 child가 reap되지 않음(`exited=false`) | `agent_runtime_shutdown`이 `Err(String)` 반환, `state.runtimes`에서 runtime을 **제거하지 않음**(teardown 금지) — 늦은 exit 계상 가능성 보존(S3 reap-실패 분기, 07 §5.2). happy-path만 통과하고 실패 분기에서 runtime을 제거하는 회귀를 잠금 |

### 5.5 bounded queue overflow (backpressure)

| # | 입력 | 기대 |
|---|---|---|
| RS-16 | 빠른 메시지 flood로 queue saturation | `agent-runtime-backpressure{droppedMessages}` emit(15 §8.3) |
| RS-17 | overflow 후 정상화 | 후속 메시지 정상 emit, droppedMessages 카운트 정확 |

> v1 동시성 모델은 `std::thread`+`Mutex`로 확정됐다(07 §7.4). OQ-39는 T2.0에서 해소되어 수치 정책도 확정됐다: `MAX_MESSAGE_LOG_BYTES = 8 * 1024 * 1024`, `MAX_LINE_BYTES = 4 * 1024 * 1024`, `BACKPRESSURE_NOTIFY_INTERVAL = 256`, 정책은 replay log oldest drop + telemetry이며 실시간 emit은 throttle/block/drop하지 않는다(OQ-50 후속). 따라서 RS-16/17은 bounded replay log trim과 `droppedMessages` telemetry count를 고정 assert한다.

### 5.6 is_test_mode mock (E2E·unit 1급 지원)

| # | 입력 | 기대 |
|---|---|---|
| RS-18 | `CLCOMX_TEST_MODE` 설정 후 `agent_runtime_start` | native subprocess 대신 mock JSON-RPC 응답 스트림(PTY `create_mock_session` 본뜸, `research/codebase-backend.md` §2.1, §10 권고 8) |
| RS-19 | mock runtime에 send | 미리 정의된 mock 응답 emit(WSL/실제 CLI 없이). Codex mock은 `location` prompt에서 `locations[]`가 포함된 `commandExecution` item을 emit해 E2E-11 작성 기반을 제공한다. |
| RS-20 | snapshot/delta 단위 테스트 | `test_*` state 생성기로 mock 상태 만들어 검증(`research/codebase-backend.md` §8.1, §9) |

### 5.7 serde 미러 (TS↔Rust 1:1) — camelCase **필드** round-trip 필수화 (S2)

**S2 정본(B2 정정)**: enum 레벨 `#[serde(rename_all="camelCase")]`는 **variant 이름만** 바꾸고 variant **내부 필드**(`work_dir`/`request_id`/`runtime_id`/`dropped_messages` 등)는 snake_case로 남아 TS의 `workDir`/`requestId`/`runtimeId`/`droppedMessages`와 불일치 → Tauri command/event payload **역직렬화 실패**한다. 정본 해결: variant 필드를 가진 enum(`AgentRuntimeStartParams`, `AgentRuntimeCancelTarget`, `AgentRuntimeEvent`, `JsonRpcMessage` 등)에 `#[serde(rename_all_fields = "camelCase")]`(serde ≥ 1.0.181) 추가 또는 필드별 `#[serde(rename="...")]`. struct 미러(`AgentRuntimeSnapshot`, `JsonRpcError`, `AgentRuntimeMetadataRecord`)는 struct 레벨 `rename_all`로 이미 정상이라 유지한다(15 §8).

따라서 **camelCase 필드까지 일치하는 TS↔Rust JSON round-trip 테스트를 필수화**한다(enum variant 필드가 camelCase로 직렬화/역직렬화되는지). 아래 RS-21..RS-25는 그 round-trip 수용 테스트다(RS-21..RS-24는 variant 필드를 가진 enum, RS-25는 struct 미러). TS가 보내는 camelCase JSON 문자열(고정 fixture)을 Rust가 deserialize → 같은 값으로 serialize 시 다시 camelCase가 나오는지(왕복 동일) assert한다.

> **serde 버전 의존성**: T2.0/OQ-37에서 `src-tauri/Cargo.lock` serde `1.0.228` ≥ `1.0.181`임을 확인했으므로 구현은 `#[serde(rename_all_fields = "camelCase")]`를 사용한다. RS-21..RS-25 round-trip 테스트는 variant 내부 필드가 camelCase로 직렬화/역직렬화되는지 검증한다.

| # | 입력 | 기대 |
|---|---|---|
| RS-21 | `AgentRuntimeStartParams` **camelCase 필드** JSON round-trip: `{transportKind:"jsonrpc-stdio", provider:"codex", distro, workDir, args, env}`(S1로 `command` 없음) deserialize → re-serialize | variant 필드 `workDir`가 camelCase로 정확 파싱·재직렬화(snake_case `work_dir`로 새지 않음). enum `rename_all_fields`/필드별 rename 검증(S2, 15 §8.1·§8.2) |
| RS-22 | `AgentRuntimeCancelTarget` round-trip 3종: `{type:"request", requestId:"7"}`, `{type:"turn", turnId:"t1"}`, `{type:"process"}` | variant 필드 `requestId`/`turnId`가 camelCase로 round-trip 일치(snake_case `request_id`/`turn_id`로 새지 않음). type discriminator + 필드 camelCase 동시 검증(S2, 15 §8.1) |
| RS-23 | `AgentRuntimeEvent` round-trip 5종: `message{runtimeId,message}`/`stderr{runtimeId,line}`/`exit{runtimeId,code?,signal?}`/`error{runtimeId,message,recoverable}`/`backpressure{runtimeId,droppedMessages}` | 모든 variant 필드 `runtimeId`/`droppedMessages`가 camelCase round-trip 일치(snake_case `runtime_id`/`dropped_messages`로 새지 않음). frontend `listen`이 받는 payload와 1:1(S2, 15 §8.3) |
| RS-24 | `JsonRpcMessage` round-trip: (a) jsonrpc 생략 Codex 케이스, (b) `jsonrpc:"2.0"` ACP 케이스, 4종(Request/Notification/Response/Error) untagged 분기 | untagged 4종 정확 분기 + `id`/`method`/`params`/`result`/`error` 필드 보존, jsonrpc optional round-trip(S2, 15 §8.1·§8.2) |
| RS-25 | `AgentRuntimeSnapshot`/`JsonRpcError`/`AgentRuntimeMetadataRecord` struct round-trip | struct 레벨 `rename_all="camelCase"`로 `runtimeId`/`startedAt`/`pendingRequestIds` 등 camelCase 정상(struct 미러는 S2 변경 불필요, 유지 확인). metadata는 scrub 필드 제외 직렬화(15 §7.3) |

---

## 6. Frontend tests (vitest, research §1.6 인용)

대상: `src/lib/features/agent-runtime/{view,controller,state}`. controller는 `vi.fn()` deps + 실제 state, view는 `@testing-library/svelte`. testid는 `TEST_IDS`(`research/codebase-frontend.md` §1.6, §10 #9).

### 6.1 컴포넌트 렌더

| # | 입력 | 기대 |
|---|---|---|
| FE-1 | transcript에 user/agent message 항목 | `AgentTranscriptSurface`가 메시지 순서대로 렌더, testid `agentTranscript` 노출 |
| FE-1b | `agent_message_delta{channel:"thought"}` | `MessageBubble`이 `role="reasoning"` thinking 블록으로 렌더하고 기본 collapsed 상태에서 본문을 숨긴다. 토글은 `aria-expanded=false`를 노출하고 클릭 시 `true`로 바뀌며 thought 본문이 표시된다(08 §6.2, §10.3). |
| FE-2 | `visible=false` prop | host가 자체 `.hidden` CSS로 숨김(unmount 안 함, `research/codebase-frontend.md` §3.3, §9.2 — 탭 전환 무재mount 계약) |
| FE-3 | direct runtime metadata 표시(provider/version/capability debug) | provider와 protocol/adapter/provider version, resume/load capability, sandbox/approval/reviewer, permission/session mode 같은 비밀이 아닌 metadata를 표시한다. `providerSessionId`/`providerThreadId`/`providerResumeToken` 등 scrub 대상 값은 표시하지 않는다(15 §7.3) |
| FE-3b/OQ-06 | `session_status_changed` → direct tab status | `AgentTranscriptSurface`가 status를 publish하고 `SessionShell`/`SessionViewport`/live session을 거쳐 `TabBar.svelte`가 `agentRuntimeStatus` badge를 표시한다. status는 live UI 상태이며 workspace snapshot에는 저장하지 않는다. |
| FE-3c | start/resume 완료 전 또는 실패 후 fallback 표시 중 `runtime_metadata_changed`가 들어오고, 사용자가 retry 또는 fresh start로 낮춤 | 실패한 시도의 attempt-local metadata patch는 기존 persisted metadata 유무와 무관하게 폐기한다. 실패로 닫힌 controller에서 늦게 온 patch도 무시한다. retry/fresh start 성공 세션의 metadata에는 성공한 시도에서 온 `SessionStartResult`/metadata patch만 병합되고, 실패 시도의 `permissionMode`/`sessionMode`/sandbox 등은 UI badge나 persistence callback에 섞이지 않는다. |
| FE-3d | start/resume 결과 전 `session_title_changed`가 들어온 뒤 attempt가 실패하거나, 실패 후 fallback 표시 중 실패한 controller에서 늦은 title이 들어옴 | 결과 전 title은 attempt-local 최신 값으로 보류하고, 성공한 attempt에서만 탭/session title 갱신 callback으로 flush한다. 실패한 attempt의 provider title은 live session title/workspace snapshot callback에 반영하지 않으며, 실패 후 늦은 title도 무시한다. |
| FE-3e | start/resume 결과 전 store event(`session_started`/`session_loaded`/`session_status_changed` 및 transcript/tool/approval event)가 들어온 뒤 attempt가 실패하거나, 실패 후 fallback 표시 중 실패한 controller에서 늦은 event가 들어옴. 단 `resume.replay===true` 복원 시도는 provider load 응답 전에 replay transcript event가 올 수 있음(10 §4.2). | fresh start와 replay 없는 resume은 결과 전 store event를 attempt-local queue에 순서대로 보류하고, 성공한 attempt에서만 live store로 flush한다. 실패한 attempt의 lifecycle/status/transcript event는 composer/surface/tab status 또는 transcript body에 반영하지 않으며, 실패 후 늦은 event도 무시한다. `resume.replay===true` 경로의 replay transcript event는 `Restoring…`/composer 잠금 상태에서 live store에 즉시 dispatch해 transcript를 재구성한다. 이때 metadata/title/status publish는 start result 전까지 attempt gate에 묶고, resume 실패 시 controller disposal + fresh start 경계가 replay transcript를 비워 stale 메시지가 새 세션에 섞이지 않음을 검증한다. |

### 6.2 tool card

| # | 입력 | 기대 |
|---|---|---|
| FE-4 | `ToolCallUpdate{kind:"execute", status:"in_progress"}` | command output card 렌더, collapsed 기본 |
| FE-5 | 카드 클릭 | collapsed↔expanded 토글 |
| FE-6 | `kind:"edit"` + diff content | FileDiffCard 렌더(15 §4 AgentContent diff) |
| FE-7 | command output terminal embed | terminal embed 렌더, **app shortcut 가로채지 않음**(`research/codebase-frontend.md` §11 focus/shortcut 위험) |
| FE-7a | `ToolCallUpdate.locations[]` + location open handler 주입 | expanded `ToolCallCard` location row가 접근 가능한 버튼으로 렌더되고 stable `agentToolLocationTestId(itemId,index)`를 노출한다. 표시 문자열은 redaction을 거치되 click callback에는 raw `FileLocation{path,line,column}`을 전달한다. `MessageList`와 `AgentTranscriptSurface`가 이 callback을 끊지 않는다. `SessionShell` direct host는 callback을 기존 editor facade와 terminal file-link action 정책으로 연결한다. internal target은 embedded editor tab을 열고 line/column을 보존하며 `InternalEditor` shell은 E2E 관찰용 `data-active-path`/`data-active-line`/`data-active-column`을 노출한다. external target은 direct path를 `resolve_terminal_path`로 `ResolvedTerminalPath`까지 보강한 뒤 default editor 또는 editor picker 흐름으로 연다. Windows 앱에서 실제 외부 editor focus/line reveal은 OQ-61 E2E 검증 범위 |

### 6.3 approval modal

| # | 입력 | 기대 |
|---|---|---|
| FE-8 | `pendingApproval` 설정 | `ApprovalModal.svelte` 표시, options 렌더, testid `approvalModal`(인라인 변형은 `ApprovalInlineCard.svelte` / testid `approvalInlineCard`, 12 §0.1) |
| FE-9 | option label | i18n key로 감싸 표시(label 원문은 보존하되 표시는 i18n, 04 §4.1, ref-claude-agent-acp §3) |
| FE-10 | option 클릭 | `respondApproval{selected, optionId}` 콜백 호출(deps `vi.fn` 검증) |
| FE-11 | modal 열린 중 turn cancel | modal 닫힘 + cancelled outcome(04 §4.2) |
| FE-11g | composer `status:"running"`에서 draft 입력 후 Enter | draft 편집은 가능하지만 아직 queue 정책이 없으므로 추가 prompt를 전송하지 않는다. 버튼은 stop으로 유지되고 명시 stop만 `cancelTurn` 경로를 탄다(08 §6.5). |

### 6.3b composer command palette / completion triggers

| # | 입력 | 기대 |
|---|---|---|
| FE-11a | `available_commands_updated` event | store의 `availableCommands`가 최신 목록으로 전체 교체되고 composer prop 소스로 노출 |
| FE-11b | composer draft `/` 또는 `/co` | provider `availableCommands` + 로컬 `/resume`을 `/` 팔레트에 표시하고 query prefix로 필터 |
| FE-11c | 팔레트가 열린 상태에서 Enter/Tab | 전송하지 않고 draft를 `/<command> `로 채운다. 공백 뒤 인자 입력이 시작되면 팔레트를 닫는다 |
| FE-11d | composer draft 끝 token `@query`, resource action button 또는 `$` | `resourceSearch`가 없으면 `@` popup과 resource action button을 열지 않는다. direct surface의 provider-backed `searchResources`가 연결된 경우 Codex `fuzzyFileSearch` file 결과와 `skills/list` enabled skill 결과를 우선 표시하고, provider 결과가 없거나 실패하면 workspace file search로 fallback한다. draft 끝의 `@query`는 파일/리소스 팔레트를 열고 Enter/Tab 선택 시 해당 token만 `@relative/path ` 또는 `@skillName `으로 교체하며 앞 prompt text는 보존한다. resource action button은 입력 가능 상태에서 draft 끝에 `@` token을 열고 같은 팔레트 흐름으로 진입하며, 빈 query도 controller/source에 전달해 source가 기본 후보를 제공할 수 있게 한다. 전송 payload에는 text content와 `resource{uri:"file://..."}` content가 함께 포함되며, Codex skill 후보는 `resourceKind:"skill"`/`text:<skill name>`을 보존해 `UserInput.skill`로 내려간다. 단 선택된 resource는 해당 token이 공백 경계 안에 그대로 남은 경우에만 포함되고, token 뒤에 문자를 붙여 다른 단어로 편집하면 stale resource를 전송하지 않는다. resource URI는 WSL path의 segment를 percent-encoding해 공백·`#`·`?`를 안전하게 보존한다. `$` 변수/skill trigger는 v1 보류(OQ-56) |
| FE-11e | ACP `promptCapabilities.image=false`, `embeddedContext=false` 세션에서 image/resource content가 포함된 prompt | `session/prompt`에는 capability를 통과한 content만 내려가고, optimistic `user_message` echo도 실제 전송 가능한 content만 반영한다. text 없는 resource는 baseline `resource_link`로 보존하고, text 포함 resource만 embedded context gate를 탄다. capability가 true이면 기존 OQ-57처럼 non-text content를 보존한다. 모든 content가 gate에서 제거되면 빈 `session/prompt`를 보내지 않고 recoverable `error` event로 낮춘다 |
| FE-11f | `ComposerCapabilities.image=true/false`와 image file 선택/paste/drop | capability true면 composer image attach button + hidden file input을 노출하고, 선택·paste·drop된 `image/*` file을 data URI `AgentContent{type:"image"}`로 전송한다. draft가 비어 있지 않으면 file picker는 끝에, paste/drop은 textarea cursor/selection 위치에 locale 기반 `[Image #N]`/`[이미지 #N]` reference token을 삽입하고, attachment chip은 같은 token을 표시한다. attachment 제거 시 대응 token도 draft에서 제거하고 남은 attachment/token은 현재 prompt 순서대로 재번호 매김한다. prompt 전송 후 다음 prompt의 image reference는 다시 #1부터 시작한다. draft가 비어 있으면 token을 넣지 않아 image-only prompt도 send 가능하다. capability false면 image attach control을 렌더하지 않고 paste/drop image handling도 활성화하지 않는다. direct surface는 `SessionStartResult.composerCapabilities` → store → composer prop 전달을 유지한다(OQ-56) |

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
| FE-16 | command output embed 포커스 | v1은 full xterm embed가 아니라 경량 read-only 렌더를 채택하므로 output embed는 `tabindex`/`contenteditable`/입력 textarea를 만들지 않는다. 따라서 app shortcut을 가로채지 않는다(08 §7.4, §11) |
| FE-17 | assistant dock / aux surface 공존 | 기존 terminal focus-bridge와 충돌 없음(`terminal-focus-bridge.ts`/`terminal-shortcut-routing.ts` 회귀) |

### 6.5b transcript scroll / auto-follow

| # | 입력 | 기대 |
|---|---|---|
| FE-17a | autoFollow 기본값에서 새 message/delta 도착 | `.transcript-region.scrollTop = scrollHeight`로 바닥 추종 |
| FE-17b | 사용자가 바닥이 아닌 곳으로 scroll 후 새 message/delta 도착 | auto-follow가 꺼져 scrollTop을 강제로 바닥으로 끌어내리지 않음. 바닥 재도달 후 다시 추종 |
| FE-17c | inline approval pending 발생 | autoFollow 상태와 무관하게 `[data-approval-anchor]`가 `scrollIntoView({block:"nearest"})` 대상이 됨 |

### 6.6 host 분기 / 무재mount 계약

| # | 입력 | 기대 |
|---|---|---|
| FE-18 | `session.runtimeKind="direct-codex"` | `SessionShell.svelte`가 `AgentTranscriptSurface` 선택(옵션 B 분기, `research/codebase-frontend.md` §9 옵션 B) |
| FE-19 | `runtimeKind` 부재(legacy 세션) | `"pty"`로 normalize → `Terminal.svelte`(15 §7.2, `research/codebase-frontend.md` §10 #1) |
| FE-20 | direct runtime 세션은 ptyId 없음 | `onPtyId` 흐름 우회/no-op, persist와 tab close 정책에서 `ptyId` 부재를 죽은 세션으로 오인하지 않음(`research/codebase-frontend.md` §11 위험, §10 #12) |
| FE-21 | 탭 전환 | host 재mount 없음, transport 구독 유지(`research/codebase-frontend.md` §3.3, §9.2) |
| FE-21b | 실제 탭 close/component unmount | direct runtime host가 `shutdown(sessionHandle)`을 정확히 한 번 호출하고, pagehide/beforeunload와 중복되어도 멱등 유지(10 §4.3, 14 §6.1) |

### 6.7 persistence 왕복 / settings 동기화

대상: `src/lib/features/workspace/session-store-snapshot.ts`(`createWorkspaceTabSnapshot`), `src/lib/features/session/service/live-session-workspace-sync.ts`(`createSessionCore`/`createRuntimeSession`/`applyWorkspaceWindowSnapshot`)(12 §0.2 항목 11). direct 세션의 `runtimeKind`/`agentRuntime`(15 §7.2) 영속화 3경로(저장→복원→기존세션 갱신)를 검증한다. backend snapshot scrub 직렬화는 RS-25(§5.7)가, 부재→`"pty"` normalize는 FE-19(§6.6)가 이미 다룬다 — 여기서는 frontend 왕복·전파를 본다. v1은 agent-runtime 전용 신규 Settings 섹션을 신설하지 않으므로(08 §2.1, 15 §3) settings 3함수 동기화는 조건부 가드로만 남긴다.

| # | 입력 | 기대 |
|---|---|---|
| FE-22 | direct 세션(`runtimeKind:"direct-codex"`, `agentRuntime` 설정)에 `createWorkspaceTabSnapshot` 적용 후 저장 경계 sanitize 적용 | live snapshot에는 `runtimeKind`/`agentRuntime`이 포함되고, 저장 직전 `sanitizeWorkspaceSnapshotForSave`/backend `sanitize_workspace_for_persist` 경계에서 scrub 대상(`providerSessionId`/`providerThreadId`/`providerResumeToken`)이 제거된다. 비-scrub 필드(`provider`/version/capability/`lastTurnId`)는 보존(10 §3.2/§6, 12 §0.2 #11, 15 §7.3) |
| FE-23 | FE-22 snapshot으로 `createSessionCore`/`createRuntimeSession` 복원 | 복원된 세션의 `runtimeKind`/`agentRuntime`가 snapshot과 동일 필드로 복구(왕복 무손실, scrub된 필드는 부재 그대로). direct runtime 복원 시 `ptyId`/`auxPtyId`는 `-1`로 정규화한다. legacy snapshot(필드 부재)은 FE-19 normalize 경로로 위임(12 §0.2 #11) |
| FE-24 | 기존 세션이 있는 상태에서 `applyWorkspaceWindowSnapshot` 호출(window snapshot이 direct 세션 갱신 포함) | 기존 세션 객체에 `runtimeKind`/`agentRuntime`가 전파(갱신 경로) — 새 세션 생성뿐 아니라 **기존 세션 갱신 경로**에서도 두 필드가 누락 없이 반영(12 §0.2 #11 "기존 세션 갱신은 `applyWorkspaceWindowSnapshot`"). 기존 PTY session 객체가 direct snapshot으로 갱신되면 stale `ptyId`/`auxPtyId`를 `-1`로 비워 PTY lifecycle을 타지 않는다. |
| FE-24b | scrub된 cold-restore metadata(`provider`/capability는 있으나 provider id 없음)로 direct host mount | `resumeSession`을 호출하지 않고 새 `startSession`으로 탭 컨텍스트를 유지하며, transcript 상단에 "이전 대화를 복원할 수 없음" notice를 표시한다(10 §4.4/§4.5). |
| FE-24c | provider id가 있는 cold-restore metadata로 `resumeSession`/load를 시도했지만 provider 호출이 실패 | 실패한 controller를 shutdown/정리한 뒤 새 `startSession`으로 탭 컨텍스트를 유지한다. fallback modal 없이, **캐시가 없으면** "이전 대화를 복원할 수 없음" notice를, **캐시가 있으면** 보관해 둔 캐시를 재주입해 read-only 히스토리 + `historyReadOnly` notice를 표시한다(10 §4.4/§4.4a). 실패한 resume/load attempt에서 온 replay transcript event는 fresh start live store에 병합하지 않는다(재주입 캐시에도 섞이지 않음). fresh direct start 자체가 실패할 때만 §4.6 fallback 선택지를 표시한다(10 §4.6). |
| FE-25 | agent-runtime 전용 신규 Settings 섹션 없음 | v1에서는 `Settings`/`DEFAULT_SETTINGS`/settings registry에 `agentRuntime` 섹션을 추가하지 않고 기존 `TerminalSettings`/`InterfaceSettings`를 재사용한다(08 §2.1, 15 §3). 향후 새 settings 섹션을 도입하는 변경에서만 `cloneDefaults`/`normalizeSettings`/`updateSettings` 3함수 동기화 테스트를 추가한다(`research/codebase-frontend.md` §7.3, §11; 12 §0.2 #10). |

> FE-25는 v1에서 새 settings 섹션을 만들라는 요구가 아니다. 08/15의 "Settings 섹션 신설 없음" 결정과 충돌하지 않도록, 실제 settings 3함수 동기화 테스트는 새 섹션/필드를 추가하는 후속 변경의 범위에서만 작성한다(`research/codebase-frontend.md` §7.3 — 새 섹션 추가 시 3함수 동기화 MUST).

### 6.8 transcript 메모리 scrollback: read-only 렌더 / 격리 replay-reload (04 §3.7, 08 §5, 13 §1.12, 10 §4.7)

대상: `AgentTranscriptSurface`/`MessageList`의 scrollback 렌더와 tombstone 구간 "이전 기록 불러오기" 동작. §2.9가 reducer/store 레벨 residency를 검증하는 데 비해, 여기서는 **view 레벨**에서 sealed-retained body가 read-only로 렌더되는지, evicted-tombstone 구간이 **격리 replay-reload**(live store 미병합)로 조회되는지를 본다. 격리 replay = read-only history inspection이며 복원/영속 캐시가 아니다(10 §4.7 runtime scrollback replay — 디스크 X, full cache 아님, live 미병합; §4.2 cold restore와 구분).

| # | 입력 | 기대 |
|---|---|---|
| FE-26 | `sealed-retained` turn 구간으로 스크롤백(body 유지된 oldest 직전 turn) | 해당 turn item들이 **read-only로 정상 렌더**됨(`itemsById` body 존재). 편집/재실행 UI 없이 표시만 되고, late event 도착 시 §2.9 NM-33 경로로 unseal-patch-reseal됨(view는 `itemVersions` bump으로 재렌더)(08 §5, 04 §3.7) |
| FE-27 | `evicted-tombstone` 구간으로 스크롤백 → "이전 기록 불러오기" 액션, `canLoad===true` | read-only **격리 scratch replay 세션**(`session/load`·`thread/read`)으로 해당 구간을 조회해 별도 inspection 뷰에 표시. **live store에 미병합**(`itemsById`/`visibleItemIds`가 그대로, running turn과 충돌 없음)이고 scratch 세션은 조회 후 폐기됨을 assert. provider replay 조회가 실패하면 loading에 머무르지 않고 "사용 불가" notice로 낮춘다. 디스크 영속·full cache 아님(10 §4.7, 08 §5, T5.6 DoD: live 미병합/scratch 폐기/running 충돌 없음) |
| FE-28 | `evicted-tombstone` 구간 "이전 기록 불러오기", `canLoad===false`(resume/replay 미지원 provider·세션) | 격리 replay 미시도 — "사용 불가" notice만 표시(replay 호출 없음). tombstone body가 복원되지 않고 live store도 불변임을 assert(10 §4.7 canLoad 분기, 08 §5) |

> FE-27의 Codex 격리 replay는 `thread/read{includeTurns:true}` 전체 thread snapshot을 scratch 세션으로 조회한다(OQ-54 해소). 테스트는 "**live 미병합 + scratch 폐기 + running 충돌 없음**" 계약(T5.6 DoD)을 고정 assert하고, 기본 UI 경로는 provider port 기반 scratch `resumeSession({replay:true})`를 호출한다. full snapshot 방어선으로 provider port 수집과 scratch reducer 입력은 `DEFAULT_REPLAY_EVENT_LIMIT` 상한을 적용하며, 상한을 넘으면 `ReplayPanel`이 partial snapshot notice를 표시한다. FE-27/28은 Phase 5(T5.6) 산출이며 Phase 1(reducer/eviction, §2.9)과 분리된다.

---

## 7. E2E scenarios (14 시퀀스 대응)

E2E는 selenium + `CLCOMX_TEST_MODE` mock 경로(§5.6 RS-18)로 실제 WSL/CLI 없이 돌린다(`research/codebase-backend.md` §8.2). direct runtime 전용 시나리오는 `e2e/agent-runtime/`에 배치하고 `e2e/helpers/`(`tauri.ts`, `launcher.ts`, `terminal.ts`, `agent-runtime.ts`)를 재사용한다. `describe.skipIf(process.platform !== "win32")` 가드는 기존 smoke 패턴 따른다(`e2e/smoke/smoke.test.ts`).

> **14 대응**: 아래 시나리오 번호는 [`14-sequence-and-state.md`](14-sequence-and-state.md)의 시퀀스 다이어그램과 1:1 대응한다(14는 존재함). 14의 시퀀스가 갱신되면 본 표 번호와 동기화한다 → [13](13-risks-open-questions.md)에 "14와 본 표 동기화 유지" 항목 연결.

| # | 시나리오 | 14 시퀀스 | 입력(사용자/mock) → 기대 |
|---|---|---|---|
| E2E-1 | Codex 새 세션 prompt→stream | 14 §"Codex turn" | launcher에서 codex direct 세션 생성 → composer에 prompt 입력·전송 → mock이 agentMessage delta 스트림 → transcript에 streaming text 표시, turn_completed 후 idle |
| E2E-2 | Claude ACP 새 세션 prompt→update | 14 §"Claude turn" | claude direct 세션 → prompt 전송 → mock이 `session/update` agent_message_chunk → transcript 표시, stopReason=end_turn 후 idle |
| E2E-3 | approval 요청·allow | 14 §"Approval allow" | mock이 commandExecution requestApproval(Codex)/request_permission(Claude) → approval UI(modal 또는 inline) 표시 → Allow 클릭 → 응답 wire 전송 확인 → tool 진행·완료 |
| E2E-4 | approval 요청·reject | 14 §"Approval reject" | 위와 동일하나 Reject 클릭 → decline/reject_once 전송, tool 미실행 표시 |
| E2E-5 | cancel 중 pending approval cleanup | 14 §"Cancel cleanup" | approval pending 중 turn cancel → 모든 pending이 cancelled로 닫힘, approval UI 닫힘, agent deadlock 없음(04 §4.2, ref-acp §3.8) |
| E2E-6 | direct 실패 → legacy PTY fallback | 14 §"Fallback" | direct runtime start 실패(또는 미지원 agent) → legacy `Terminal.svelte`로 graceful fallback, 세션 사용 가능(`research/codebase-frontend.md` §9 옵션 B fallback, 08 §legacy PTY fallback) |
| E2E-7 | 기존 PTY 세션 무회귀 | (legacy 보존) | runtimeKind 없는 기존 workspace.json 복원 → PTY 세션 정상 open, xterm 동작(15 §7.2 normalize, `research/codebase-frontend.md` §10 #1) |
| E2E-8 | recent history direct host 보존 | 10 §5.5, 14 §"Start" | direct 세션 종료 후 recent history에 direct 배지가 표시되고, history에서 재열면 `runtimeKind="direct-*"` host로 새 direct start가 수행됨. provider id/resume 키는 history에 저장하지 않으므로 transcript resume/load 복원은 assert하지 않음. |
| E2E-9 | 탭 전환 무재mount | (UI 계약) | direct 세션 + terminal 세션 혼재 탭 전환 → 비활성 host 살아있음, transport 구독 유지(`research/codebase-frontend.md` §3.3) |
| E2E-10 | raw protocol log 기본 off | (보안) | 기본 실행 시 raw wire 파일 미생성, debug mode 켜야 redacted 캡처(13 §raw log, 09 §감사) |
| E2E-11 | tool location editor open | 08 §4.3, 13 OQ-61 | mock tool call이 `ToolCallUpdate.locations[]`를 포함 → location row 클릭. internal target spec은 `fileOpenTarget:"internal"` seed 후 embedded editor의 active path/line/column을 확인한다. external default-editor spec은 `fileOpenTarget:"external"`/`defaultEditorId:"cursor"` seed 후, external picker spec은 `fileOpenMode:"picker"` seed 후 picker에서 `cursor` 선택까지 거쳐 test-mode `open_in_editor` command payload(`editor-open-events.jsonl`)의 editor/path/line/column을 확인한다. 추가 real-launch spec은 `CLCOMX_TEST_MODE_EDITOR_REAL_LAUNCH=1`과 fake `cursor.cmd` override를 켠 뒤 실제 spawned process가 `--goto <path>:12:4` argv를 받는지 확인한다. 실제 설치 editor의 focus/line reveal은 별도 Windows 수동/자동 검증 범위다. |
| E2E-12 | scrub된 direct workspace cold restore | 10 §4.4, 13 OQ-16 | `workspace.json`에 `runtimeKind:"direct-codex"`와 scrub된 `agentRuntime` metadata(provider/capability는 있으나 `providerThreadId` 없음)를 seed → 앱 부팅 시 direct host가 mount되고 legacy PTY host는 열리지 않음 → `resumeSession` 없이 fresh direct session으로 시작하며 복원 불가 notice를 표시하고 새 prompt 응답이 동작한다. |

> 2026-07-01 현재 `e2e/agent-runtime/agent-runtime.test.ts`는 E2E-1(Codex prompt stream), E2E-2(Claude prompt update), E2E-3/4(Codex command approval allow/reject), E2E-3 보조 spec(Claude `request_permission` allow), E2E-5(Codex inline approval pending 중 stop cancel cleanup), E2E-6(fallback), OQ-60 post-start fatal runtime error notice/no-fallback spec, E2E-7 보조 spec(direct runtime 미선택 시 legacy PTY host), E2E-8(recent history direct host), E2E-9(tab switch host 유지), E2E-10(raw log default-off/opt-in redaction + inbound `seq` + analyzer terminal marker/lateEvents 판정 + synthetic ACP late candidate 검출), E2E-11 internal target spec, external default-editor/picker command-payload spec, fake external editor process real-launch spec, E2E-12 scrub된 `workspace.json` cold restore spec을 포함한다. E2E-7의 기존 workspace snapshot 복원 경로는 `e2e/workspace-restore/workspace-restore.test.ts`가 runtimeKind 없는 `workspace.json` → mock PTY reattach로 덮는다. Codex mapper(CX-10b)와 test-mode mock(RS-19)은 E2E-11/OQ-60 입력 기반을 갖췄고, location row/internal editor DOM 관찰 지점, external `open_in_editor` payload 관찰 지점, fake editor process argv 관찰 지점도 FE-7a 하한으로 준비됐다. Windows 실행은 `npm run test:e2e:wsl -- --install-tools --project agent-runtime`(1 file / 14 tests), `npm run test:e2e:wsl -- --skip-build --project agent-runtime`(1 file / 16 tests), 최신 `npm run test:e2e:wsl -- --project agent-runtime`(1 file / 18 tests), 최신 `npm run test:e2e:wsl -- --skip-build` 전체 순차 실행(9 projects / 29 tests)으로 통과했다. 추가로 OQ-53 Codex live lower bound는 앱 수동 launch 없이 `codex app-server --stdio` probe에서 tool-free simple turn 1회(`turn/completed` inbound `seq=28`, `lateEvents=[]`, post-completion grace 1.5초), tool-bearing shell command turn 1회(commandExecution seq 19/20, `turn/completed` seq 33, `lateEvents=[]`, post-completion grace 2초), read-only sandbox approval request turn 1회(`requestApproval` seq 20, `serverRequest/resolved` seq 21, `turn/completed` seq 37, `lateEvents=[]`, post-completion grace 2.5초), fileChange diff turn 1회(fileChange seq 66/67, `turn/diff/updated` seq 68/71/82, `turn/completed` seq 84, `lateEvents=[]`, post-completion grace 2.5초)를 캡처해 확인했다. ACP 쪽은 test-mode Claude mock에서 stopReason response 뒤 delayed `session/update:plan_update`가 들어오는 synthetic raw log를 analyzer가 `lateEvents[]`로 검출하는 E2E 하한을 추가했다(`session/prompt` out → `agent_message_chunk` seq 3 → stopReason response seq 4 → `plan_update` seq 5). 다만 실제 설치 editor process focus/line reveal 검증은 fake process argv 확인 범위를 넘어서므로 OQ-61의 잔여 실측 slice로 두고, OQ-53도 plan 포함 Codex live turn, Claude ACP live stopReason 뒤 `session/update` 후보 캡처를 잔여로 둔다.

---

## 8. Acceptance checklist (수용 기준)

구현 slice가 merge 가능하려면 아래를 모두 만족해야 한다. 각 항목은 위 테스트 케이스로 뒷받침된다.

### 8.1 기능 커버리지

- [x] Codex와 Claude 모두 **새 session, resume/load, prompt, stream, tool call, approval, cancel, error, process exit** 각각에 대해 문서(§3/§4 매핑)와 테스트(fixture FR-* + adapter CX-*/CL-*)가 존재한다. 증거: Codex `codex-fixture-replay.test.ts` FR-CX-0..4, `codex-wire-mapper.test.ts` CX-1..20(CX-9는 standalone command/exec v1 미지원 raw/unknown 경계), `codex-app-server-adapter.test.ts` CX-1/2/4b(OQ-20 exact `turn/start` params)/4c(unsupported content empty prompt guard)/12..15/18a/19/19a + shutdown/cancel. Claude `claude-acp-fixture-replay.test.ts` FR-CL-0..4, `claude-acp-initialize.test.ts` CL-1..3, `claude-acp-adapter.test.ts` CL-4..11/19/22/24b/25..27 + shutdown/cancel, `claude-acp-session-update.test.ts` CL-12..18/27, `claude-acp-permission.test.ts` CL-19..24.
- [x] normalized model의 upsert/append/reconcile/approval lifecycle/cancel cleanup/raw 보존(04 §3·§4·§5)이 unit test(NM-1..NM-30)로 검증된다. 증거: `agent-event-reducer.test.ts` NM-1..11/17/21/22/29a/30..35, `legacy-pty-adapter.test.ts` NM-30 wrapper+transcript 미반영, `pending-approval-table.test.ts` NM-12..16/18..20, `agent-runtime-store.svelte.test.ts` NM-12/13/20b/20c/23..28/31b. NM-29(seq 정렬)는 15 M-1에 따라 후속이며 v1 필수는 NM-29a다.
- [x] shutdown/process cleanup ordering(S3): adapter shutdown이 **unlisten/세션 삭제 전에** 모든 pending approval/RPC를 정확히 한 번 닫고, 늦은 exit과 중복 exit이 멱등 처리되어 이중 종료·누락이 없다(NM-18b/18c/18d/18e, 04 §4.2·§5; backend reap 경계는 RS-13/14/15b/15c). Codex와 Claude ACP shutdown은 async pending approval cancel response가 완료되기 전 backend shutdown으로 넘어가지 않는다. 증거: `codex-app-server-adapter.test.ts`의 "shutdown closes pending approval/RPC BEFORE backend shutdown + unlisten; idempotent on late exit", "S3: shutdown awaits async pending approval cancel response before backend shutdown" 및 "exit closes all pending approval(failed) + rejects pending RPC + process_exited", `claude-acp-adapter.test.ts`의 "shutdown: pending approval/RPC 정리 → shutdownRuntime await → unlisten, late exit 멱등", "S3: shutdown awaits async pending approval cancel response before backend shutdown" 및 "process exit → process_exited emit + pending 정리(멱등)".
- [x] interleaved turn 분리(CX-16/17, ref-codex §7.1)와 ACP chunk/replace 구분(CL-12..CL-16, ref-acp §4·§5)이 검증된다. 증거: `codex-fixture-replay.test.ts` FR-CX-4, `codex-wire-mapper.test.ts` CX-16/17, `claude-acp-session-update.test.ts` CL-12..16.
- [x] 미지원 server→client **request**(id 있는 요청)는 Codex·Claude 양쪽에서 JSON-RPC error(`-32601`)/decline 응답을 보내고 **무응답으로 끝나지 않는다**(CX-15b, CL-24b, R5; 04 §5 edge 규칙). 미지원 **notification**(id 없음)은 raw 보존+counter만, 응답 없음(CX-15c, CL-27). Codex `ThreadItem` 내부 unknown variant도 transcript event 없이 raw diagnostic+counter로 남긴다(CX-15d). 증거: `codex-wire-mapper.test.ts` CX-15b/15c/15d, `claude-acp-adapter.test.ts` CL-24b/CL-27/CL-27b, `claude-acp-session-update.test.ts` CL-27 raw/counter.
- [x] 긴 세션 transcript 메모리가 **bounded**다(13 §1.12 S2): `HOT_WINDOW` 초과 시 oldest sealed turn body가 evict되어 `itemsById`가 cap(window+tombstone) 내로 유지되고, 반응형 표면(`visibleItemIds`/`itemVersions`)은 세션 길이와 무관하게 bounded다(NM-31/31b, 04 §3.7, 08 §5). seal 전이(NM-32/32b)·late-event 분기(`sealed-retained`→unseal-patch-reseal NM-33, `evicted-tombstone`→apply 금지+`droppedLateEventCount` NM-34)가 검증된다. 입력은 **reducer/store event fixture**이고 실제 same-turn late wire 발생은 OQ-53, window/cap 운영 튜닝은 OQ-52다. 증거: `agent-event-reducer.test.ts` NM-31/31c/31d/31e/31f/31g/31h/32/32b/33/33b/33c/33d/33e/33f/34/34c/34d/35(terminal stderr, tool raw, image data URI, file diff byte cap 포함), `agent-runtime-store.svelte.test.ts` NM-31b와 OQ-52 기본 cap 1,000-turn synthetic fixture.
- [x] event router/window registry가 **단일 window 소유 + runtimeId 바인딩 + window-close 격리 + cross-window dispatch 차단** 계약을 따른다(OQ-48). 같은 JSON-RPC id를 쓰는 두 runtime의 approval도 `(sessionHandle, requestId)` 복합 키로 독립 라우팅되어 오응답하지 않는다(NM-15b). 증거: `agent-event-router.test.ts`, `pending-approval-table.test.ts`.

### 8.2 transport / process

- [x] stdio JSON-RPC framing(newline·UTF-8 경계·부분 라인), stderr/stdout 분리, bounded queue overflow, shutdown timeout→kill(**child reap 후 반환**)이 Rust test(RS-1..RS-17)로 검증된다(S3 reap 경계 RS-13/14/15b/15c). 증거: `src-tauri/src/features/agent_runtime/tests.rs` RS-1..7, RS-13/14/15c, RS-16/17, AC-4b.
- [x] renderer/adapter는 **command를 넘기지 않고**(15 §8.1 `command` 필드 제거), backend가 `provider`로 신뢰 절대경로를 resolve한다(codex→codex 절대경로, claude→node 절대경로). args(Codex 정확 `["app-server","--stdio"]`, Claude `args.length==2`+검증된 adapterEntryPath+고정 `--hide-claude-auth`)·env key allowlist가 backend에서 재검증되어 임의 .js·동명 바이너리 우회(`/tmp/codex`,`/tmp/node`)·미등록 env key를 차단하고, renderer가 executable 경로를 제어할 입력 자체가 없다(RS-8..RS-12d, 07 §8.1 S1 정본, 09 untrusted renderer 위협모델). distro/workDir은 OQ-31 v1 경계처럼 non-empty + WSL absolute path 문자열 정규화까지만 검증한다. allowlist/startup 실패는 원래 `Err`로 거부하면서 redacted `launchRejected` audit entry로 남긴다. 증거: `agent_runtime::tests` RS-8/8b/8c/8d/9/9b/10c/11/12/12b/12c/12d.
- [x] `resolve_trusted_executable`/`resolve_trusted_adapter_entry`(13 OQ-36)의 **성공경로 계약**(신뢰 절대경로 반환 + 캐시 무효화 후 재탐색 + pinned adapter layout)이 resolver/cache 경계 테스트로 검증되어 RS-10c의 실패-only 공백을 보완한다(RS-10d/10e, 12 T2.0/T2.4 DoD 연계). startup executable version preflight는 cache와 별개로 startup마다 실행되고 절대경로만 허용하며, start 직전 실패/빈 출력이면 spawn으로 진행하지 않는다(RS-10f/10g/10h/10i, OQ-24). Claude start는 이어서 `node <adapterEntryPath> --cli --version` native probe를 실행해 SDK optional dependency 또는 `CLAUDE_CODE_EXECUTABLE` override가 실제 launch env에서 resolve되는지 확인하고, 실패하면 spawn으로 진행하지 않는다(RS-10k/10l/10m, OQ-10). 기본 mock fallback도 `not implemented` placeholder 없이 실패한다(RS-10j). 증거: `agent_runtime::tests` RS-10d/10e/10f/10g/10h/10i/10j/10k/10l/10m.
- [x] Tauri 경계 enum payload의 **camelCase 필드 round-trip(TS↔Rust)** 이 일치한다 — `AgentRuntimeStartParams`/`AgentRuntimeCancelTarget`/`AgentRuntimeEvent`/`JsonRpcMessage`의 variant 필드(`workDir`/`requestId`/`runtimeId`/`droppedMessages` 등)가 snake_case로 새지 않는다(RS-21..RS-25, S2 `rename_all_fields` 또는 필드별 rename; serde ≥ 1.0.181 확인 → 13). 증거: `agent_runtime::tests` RS-21..25.
- [x] `is_test_mode` mock 경로가 1급으로 제공되어 WSL/실제 CLI 없이 E2E·unit이 돈다(RS-18..RS-20). 증거: `agent_runtime::tests` RS-18/19/19b/19c/20, backend `start()`의 `is_test_mode()` → `start_mock()` 분기. RS-19는 startup seed가 아니라 provider별 요청-응답형 mock(`initialize`/`thread-start`/`turn-start`, Codex approval request/decision/`turn/interrupt`, Claude `session-new`/`session-load`/`session-prompt`/`session/request_permission`)을 검증하고, fixture-local routing literal이 실제 요청 id로 재작성되는지도 고정한다.

### 8.3 legacy 보존

- [x] xterm terminal-first 화면이 legacy path로 계속 동작한다(E2E-7). Spec 증거는 두 갈래다: `e2e/workspace-restore/workspace-restore.test.ts`가 runtimeKind 없는 legacy workspace 복원 → mock PTY reattach를 검증하고, `e2e/agent-runtime/agent-runtime.test.ts`가 direct runtime toggle 미선택 → `terminalShell` PTY host를 검증한다. 둘 다 2026-06-29 Windows 전체 E2E(`npm run test:e2e:wsl -- --skip-build`)에서 통과했다.
- [x] 기존 PTY E2E(`e2e/smoke`, `e2e/terminal-input`, `e2e/terminal-aux` 등)가 회귀 없이 통과한다(13 §Terminal regression). 2026-07-01 Windows 전체 E2E 순차 실행이 `smoke`, `settings`, `windows-tabs`, `workspace-restore`, `image-paste`, `agent-runtime`, `terminal-input`, `terminal-links`, `terminal-aux` 9 projects / 29 tests를 모두 통과했다.
- [x] direct runtime 실패 시 legacy PTY fallback이 동작한다(E2E-6). `e2e/agent-runtime/agent-runtime.test.ts`가 `CLCOMX_AGENT_RUNTIME_MOCK_FAIL=1`로 fallback panel → legacy PTY 선택 경로를 검증하고, 2026-06-29 Windows `agent-runtime` E2E에서 통과했다. Svelte 단위 경계는 `AgentTranscriptSurface.test.ts`가 legacy PTY callback 전에 실패한 direct controller `shutdown("S1")` 완료를 기다리는지 검증한다.

### 8.4 UI / i18n / focus

- [x] 새 UI text는 전부 locale key로 관리되고 en/ko 키 트리가 1:1 동일하다(FE-12/13). Codex approval mapper가 넣는 `agentRuntime.approval.*` title/option key는 표시 경계에서 locale 문자열로 변환된 뒤 redaction된다. 증거: `i18n-hardcoded-text.test.ts`, `key-parity.test.ts`, `ApprovalInlineCard.test.ts`, `ApprovalModal.test.ts`.
- [x] direct runtime status가 transcript/composer뿐 아니라 기존 탭 모델의 status badge로도 표시된다(OQ-06). 증거: `AgentTranscriptSurface.test.ts` OQ-06, `SessionViewport.test.ts`, `session-shell-adapter.test.ts`, `session-store-mutations.test.ts`, `TabBar.test.ts` OQ-06.
- [x] Codex `sandbox`/`approvalPolicy`/`approvalsReviewer`가 session metadata badge로 표시되고, non-secret metadata로 workspace persistence scrub 후에도 보존된다(09 §8.2, 15 §7.1/§7.3). 증거: `codex-app-server-adapter.test.ts`, `AgentTranscriptSurface.test.ts`, Rust `workspace::store::tests::sanitize_workspace_for_persist_strips_agent_runtime_secrets`.
- [x] Claude `permissionMode`/`sessionMode`가 session metadata badge로 표시되고, `current_mode_update`/`config_option_update`가 metadata persistence callback까지 반영된다(09 §8.2, 15 §3/§7.1). 증거: `claude-acp-adapter.test.ts`, `AgentTranscriptSurface.test.ts`, Rust `workspace::store::tests::sanitize_workspace_for_persist_strips_agent_runtime_secrets`.
- [x] `danger-full-access`/`bypassPermissions` metadata badge는 고위험 경고로 시각적으로 구분된다(09 §8.3). 증거: `AgentTranscriptSurface.test.ts` bypass/full-access metadata warning.
- [x] direct runtime launcher/provider 표시는 공식 앱명처럼 읽히지 않는 중립 provider 라벨을 사용한다(09 §9). 증거: `SessionLauncher.test.ts` direct history/direct toggle provider wording, `registry.test.ts` built-in icon logo asset 부재.
- [x] transcript/code/command mono 폰트는 agent-runtime 전용 settings 섹션 없이 `--ui-font-mono-stack` 토큰으로 소비되며, 이 토큰은 기존 `settings.terminal.fontFamily`/`fontFamilyFallback`에서 산출된다(OQ-55). 증거: `theme-bridge.test.ts`.
- [x] thought/reasoning stream은 response message와 분리된 접이식 thinking 블록으로 렌더되고, 기본 collapsed 상태와 `aria-expanded` 토글을 제공한다(FE-1b, 08 §6.2/§10.3). 증거: `MessageList.test.ts` reasoning case.
- [x] tool location row는 callback이 주입된 경우 접근 가능한 버튼으로 렌더되고, `ToolCallCard` → `MessageList` → `AgentTranscriptSurface` 경계가 raw `FileLocation`을 상위 handler에 전달한다(FE-7a, 08 §4.3). `SessionShell` direct host는 이 callback을 existing editor facade의 internal editor open 경로와 terminal file-link action의 external default/picker 경로로 연결한다. internal target은 file content load, editor view 전환, line/column 보존, session editor state persistence를 수행한다. external target은 `resolve_terminal_path`로 Windows path를 보강한 뒤 configured default editor 또는 picker 선택 editor로 연다. direct embedded editor foreground 오류는 direct notice surface로 표시한다. 증거: `ToolCallCard.test.ts`, `MessageList.test.ts`, `AgentTranscriptSurface.test.ts`, `SessionShell.test.ts` OQ-61, `InternalEditor.test.ts`, Rust `test_mode_resolves_location_fixture_without_real_file`/`test_mode_open_in_editor_records_launch_payload`/`test_mode_real_editor_launch_spawns_override_with_line_args`, `e2e/agent-runtime/agent-runtime.test.ts` E2E-11 internal target spec, external default-editor/picker command-payload spec, fake external editor process real-launch spec. 최신 Windows `agent-runtime` E2E는 1 file / 18 tests로 통과했고 OQ-61 E2E-11 경로도 계속 포함된다. 실제 설치 external editor process focus/line reveal 확인은 남아 있다.
- [x] composer `@` workspace/provider file+skill mention은 provider-backed Codex `fuzzyFileSearch` file 결과와 `skills/list` enabled skill 결과를 우선 표시하고, 결과가 없거나 실패하면 workspace file search 결과 팔레트로 fallback하며, 선택된 후보를 `resource` content로 전송한다(OQ-56 1차 범위). Codex skill 후보는 `resourceKind:"skill"`/`text:<skill name>`을 보존해 outbound mapper가 `UserInput.skill`로 내린다. resource action button은 `resourceSearch` source가 있을 때만 노출되고, 입력 가능 상태에서 draft 끝 `@` token을 열며, 빈 query도 controller/source에 전달하고, 입력 잠김 상태에서는 비활성이다. 선택된 token이 다른 단어로 편집되면 stale resource content를 제외하고, 공백·`#`·`?`가 포함된 WSL path는 percent-encoded file URI로 내려간다. image attach control은 `ComposerCapabilities.image`가 true일 때만 노출되고, 선택·paste·drop된 image file을 data URI `AgentContent.image`로 전송한다. draft가 비어 있지 않으면 file picker는 끝에, paste/drop은 cursor 위치에 image reference token을 넣고 chip 제거 시 token도 제거한다. 삭제/전송 후 numbering은 현재 prompt 기준 #1부터 다시 맞추며, image-only prompt도 허용한다. direct surface는 start result capability를 composer까지 전달한다. 증거: `AgentComposer.test.ts`, `AgentTranscriptSurface.test.ts`, `agent-runtime-controller.test.ts`, `codex-app-server-adapter.test.ts`, `codex-wire-mapper.test.ts`.
- [x] composer·terminal embed·approval modal·assistant dock 간 focus/shortcut 회귀가 없다(FE-14..FE-17). 증거: FE-14 composer 입력 중 App tab shortcut bubble 차단은 `AgentComposer.test.ts`, FE-15 modal focus trap/Escape cancel은 `ApprovalModal.test.ts`, FE-16 command output embed 비포커스/비입력 표면은 `CommandOutputCard.test.ts`/`ToolCallCard.test.ts`, FE-17 이미 소비된 assistant/aux surface keydown을 App 전역 tab shortcut이 재처리하지 않음은 `App.test.ts`가 검증한다.
- [x] running 중 composer draft는 편집 가능하지만 추가 prompt queue 정책이 확정되기 전까지 Enter/send 전송은 발생하지 않고, stop 버튼만 cancel 경로를 탄다(FE-11g, 08 §6.5). 증거: `AgentComposer.test.ts`.
- [x] legacy PTY host는 direct runtime과 같은 구조화 approval/sandbox 보장을 제공하지 않는다는 notice를 표시하고, direct host에는 이 notice를 표시하지 않는다(09 §8.4). 증거: `SessionShell.test.ts`.
- [x] 탭 전환이 direct runtime host를 재mount하지 않는다(FE-21, E2E-9). FE-21 Svelte mount 계약은 `SessionViewport.test.ts`가 activeSessionId 변경 시 keyed session shell mount/destroy가 발생하지 않고 `visible` prop만 바뀌는지 검증하며, `AgentTranscriptSurface.test.ts` OQ-17이 direct host의 `visible=false`가 `.hidden` CSS 토글일 뿐 runtime shutdown을 유발하지 않음을 검증한다. 실제 탭 close/component unmount shutdown 경계는 `AgentTranscriptSurface.test.ts` 10 §4.3 및 pagehide 테스트가 별도로 검증한다. `e2e/agent-runtime/agent-runtime.test.ts`의 실제 direct 세션 + terminal 세션 혼재 탭 전환 중 direct host DOM 유지 spec은 2026-06-29 Windows `agent-runtime` E2E에서 통과했다.
- [x] sealed-retained turn 구간이 read-only로 정상 렌더되고(FE-26), evicted-tombstone 구간의 "이전 기록 불러오기"가 `canLoad`면 **격리 replay-reload**(provider port-backed scratch `resumeSession({replay:true})`, live 미병합·scratch 폐기·running 충돌 없음)로, 아니면 "사용 불가" notice로 동작한다(FE-27/28, 10 §4.7, 08 §5, 12 T5.6 DoD). provider replay 조회 실패도 loading stuck 없이 "사용 불가" notice로 낮추고, scratch loader는 `dispose()` 이후 다시 열리거나 cached replay 결과를 재사용하지 않으며 in-flight replay가 dispose 뒤 완료/실패해도 event 배열이나 late failure를 노출하지 않는다. OQ-54 실측 결과 Codex `thread/read{includeTurns:true}`는 전체 snapshot을 반환하므로 provider port 수집과 scratch reduce 모두 기본 1000 event 상한을 두고, 상한 초과 시 partial snapshot notice를 표시한다. 복원/영속 캐시가 아니라 read-only history inspection이다. 증거: `MessageList.test.ts`, `runtime-replay.test.ts`, `ReplayPanel.test.ts`, `AgentTranscriptSurface.test.ts` replay affordance/canLoad true/false/default provider replay/load failure/full snapshot partial notice.

### 8.5 보안 / 추적성

- [x] provider 원본 id(`threadId`/`sessionId`/`requestId`)가 `ProviderRef`와 pending table 등 **메모리 store/normalized event 경로**에서 손실 없이 추적 가능하다(NM-15, 15 §0.1). 단 UI metadata strip과 디스크에는 scrub 대상 `providerSessionId`/`providerThreadId`/`providerResumeToken`을 노출하지 않는다(FE-3, RS-25, 15 §7.3). 증거: `pending-approval-table.test.ts` NM-15/15b, `AgentTranscriptSurface.test.ts` metadata strip, `workspace.test.ts`, Rust `workspace`/`agent_runtime::tests` RS-25.
- [x] approval wire 응답이 **원본 JSON-RPC id 타입을 보존**한다 — numeric id(예 `42`)가 `"42"`로 변질되지 않고, `ApprovalRequest.id`/`ProviderRef.requestId`는 문자열 키, wire 응답 `id`는 원본 타입 유지(CL-21b/21c, R3; 06 §6.1/§6.2 `rpcId`, 05 §6 CodexRouting). 증거: `claude-acp-permission.test.ts` CL-21b/21c, `claude-acp-adapter.test.ts` CL-24b.
- [x] 사용자 approval action은 **store에 실제 pending으로 존재하는 requestId**에만 port/wire 경로로 내려간다. 없는 id는 controller에서 reject하고, adapter 내부의 늦은/중복 응답 no-op은 04 §4.2 멱등 규칙으로 유지한다(09 §2). 증거: `agent-runtime-controller.test.ts` SEC-APPROVAL.
- [x] approval wire 응답은 **실제 pending approval의 허용 option id**만 전송한다. 알 수 없는 `optionId`는 provider wire 전송 전에 reject되고 pending은 재시도 가능 상태로 남는다(09 §2 표시-선택 일치). 증거: `codex-app-server-adapter.test.ts` / `claude-acp-adapter.test.ts` SEC-APPROVAL.
- [x] 모든 approval 결정(user/auto/cleanup)에 audit entry가 **정확히 1건** 기록되고, audit entry에는 명령 전문·credential·파일 내용·raw label이 섞이지 않는다(`requestId`/`optionId`/`optionKind`/`outcome`/시각/`decidedBy`만)(NM-20b/20c, 09 §3.4, 12 audit task). 증거: `agent-runtime-store.svelte.test.ts` NM-20b/20c.
- [x] websocket transportKind start가 **token을 로그·snapshot·audit에 남기지 않고 즉시 reject**된다 — `authToken`이 scrub 집합에 포함되어 노출 전 거부된다(RS-12c, 13 RD-2, 09 secret scrub `authToken`, 15 §8.1 websocket variant v1 미사용). 증거: `agent_runtime::tests` RS-12c/RS-18.
- [x] allowlist/startup reject가 원래 `Err`로 반환되면서 redacted backend audit에 남는다. `agent-runtime-audit.log`의 `launchRejected` entry는 최소 메타(`event`/`atMs`/`transportKind`/redacted `provider`/redacted `reason`)만 기록하고 renderer start params 전체를 저장하지 않는다. 증거: `agent_runtime::tests` RS-12d, `agent_runtime/audit.rs`, `agent_runtime::start`.
- [x] adapter launch helper가 `AgentRuntimeStartParams.env`에 secret-shaped key/value를 싣기 전에 reject한다(09 §5.3). 오류 메시지는 env key만 포함하고 secret value는 포함하지 않으며, backend env allowlist/argv 비경유 검증은 2차 경계로 유지된다. 증거: `codex-launch.test.ts`, `claude-acp-launch.test.ts`, `agent_runtime::tests` RS-12/RS-12b/AC-10b.
- [x] `IS_SANDBOX` 등 provider bypass 게이트 우회 env가 launch env로 통과하지 않는다(09 §8.3). `IS_SANDBOX`는 provider별 env allowlist에 없으므로 backend에서 `Err(String)`으로 거부된다. 증거: `agent_runtime::tests` RS-12b/`rs12b_claude_specific_env_keys`, `allowlist.rs`.
- [x] tool `content` 표시와 `rawInput`/`rawOutput` raw detail 표시가 분리되고, raw detail은 표시 직전에 redaction된다(09 §5 TB-4, §8.1). 접힌 tool card summary/title도 provider title 또는 첫 location path를 그대로 노출하지 않고 같은 표시 redaction을 거친다. 증거: `ToolCallCard.test.ts`, `display-redaction.test.ts`.
- [x] transcript raw detail 표시 경계가 JSON-RPC envelope를 노출하지 않는다(09 §6). 원본 raw는 reducer/store에 보존하지만, 표시 문자열은 envelope shape를 placeholder로 치환한 뒤 credential redaction을 적용한다. 증거: `display-redaction.test.ts`.
- [x] v1 direct runtime은 approval에 연결되지 않은 client side-effect tool을 노출하지 않는다(09 §8.1). Claude ACP initialize는 `fs.writeTextFile=false`, `terminal=false`, `auth.terminal=false`, `_meta.terminal_output=false`를 광고하고, Codex app-server initialize는 `capabilities:null`이다. Codex server→client `item/tool/call`·`applyPatchApproval`·`execCommandApproval`은 `-32601 method not found`로 거부되어 approval UI/event나 부수효과가 발생하지 않는다. 지원되는 command/fileChange 부수효과는 `item/*/requestApproval` → `ApprovalRequest` 경로만 탄다. 증거: `claude-acp-initialize.test.ts` OQ-43, `codex-app-server-adapter.test.ts` SEC-CLIENT-TOOLS/CX-12..15, `codex-wire-mapper.test.ts` CX-11/CX-15b.
- [x] provider session/thread id·resume token은 디스크 저장 시 scrub된다(RS-25, 15 §7.3, `research/codebase-backend.md` §4.2). 증거: `workspace.test.ts`, `tab-history.test.ts`, `SessionLauncher.test.ts` stale direct history token 표시 방어, Rust `workspace` tests(`sanitize_workspace_for_persist_strips_agent_runtime_secrets`, `write_workspace_omits_agent_runtime_secrets_on_disk`), `history` tests(`upsert_tab_history_does_not_store_resume_tokens`).
- [x] direct 세션의 `runtimeKind`/`agentRuntime`가 **저장→복원→기존세션 갱신** 3경로 모두에서 무손실 왕복(scrub 후)한다(FE-22..FE-24, 12 §0.2 #11, 15 §7.2/§7.3). scrub된 cold restore metadata는 새 direct session으로 시작하되 복원 불가 notice를 표시하고(FE-24b), provider `resumeSession`/load 호출 실패도 실패 controller 정리 후 새 direct session으로 낮춘다 — 캐시가 없으면 복원 불가 notice, 캐시가 있으면 read-only 히스토리 복귀 + `historyReadOnly` notice(FE-24c, 10 §4.4a). v1은 새 settings 섹션을 만들지 않으며, 향후 settings 섹션/필드를 추가할 때만 `cloneDefaults`/`normalizeSettings`/`updateSettings` 3함수 동기화를 별도 검증한다(FE-25, 12 §0.2 #10). 증거: `session-store-snapshot.test.ts`, `session-store-mutations.test.ts`, `session-runtime.test.ts`, `AgentTranscriptSurface.test.ts`, Rust `workspace` tests, `e2e/agent-runtime/agent-runtime.test.ts` E2E-12 scrubbed direct `workspace.json` cold restore spec.
- [x] raw protocol log가 기본 비활성화이며 redaction 정책이 있다(E2E-10, 13 §raw log, 09 §감사). Backend 단위 경계는 `agent_runtime::tests::e2e10_raw_protocol_debug_log_is_off_by_default` / `...is_opt_in_and_redacted` / `e2e10_outbound_protocol_debug_log_is_opt_in_and_redacted` / `e2e10_raw_protocol_debug_log_redacts_runtime_env_values` / `d_replaylog_redacts_runtime_env_values_without_redacting_realtime_event` / `e2e10_raw_protocol_debug_log_redacts_mcp_env_values` / `transport::redact_tests::short_runtime_env_values_do_not_corrupt_unrelated_json_fields`가 검증한다(`CLCOMX_AGENT_DEBUG_LOG` 기본 off, opt-in JSONL append, inbound/outbound redaction, inbound reader `seq`, runtime launch env value redaction, diagnostic-only replay log redaction + realtime raw event 유지, MCP `env` object value redaction, 짧은 non-secret env literal의 payload 과잉 치환 방지). Frontend transport 경계는 `AGENT_RUNTIME_EVENT_NAMES` tuple을 정본으로 사용해 raw `agent-runtime-message` 문자열 drift를 막고, 주석상 adapter 전용 bridge로 고정한다. `transport.test.ts`는 public helper `createAgentTransportController`가 raw `agent-runtime-message`를 구독하지 않고 stderr/exit/error/backpressure diagnostic channel만 노출하는지 검증한다. `runtime-port-factory.test.ts`는 production Codex/Claude deps가 Tauri event channel과 payload `type`이 일치하지 않는 raw payload를 adapter로 넘기지 않는지 검증한다. OQ-59는 v1 internal raw bridge + public diagnostic 미노출 정책으로 해소됐다. `e2e/agent-runtime/agent-runtime.test.ts`의 default-off와 opt-in redaction spec은 2026-06-29 Windows `agent-runtime` E2E에서 통과했다.
- [x] OQ-60 v1 하한이 유지된다. Post-start `recoverable:false` error와 abnormal `process_exited`는 fallback panel/PTY callback으로 승격되지 않고 notice/status 경로에 남는다(`AgentTranscriptSurface.test.ts` OQ-60). Windows `agent-runtime` E2E도 Codex test-mode prompt가 post-start `agent-runtime-error{recoverable:false, code:"framing_broken"}`를 emit하는 경로에서 transcript notice와 fallback panel 부재를 확인한다. transport/backend가 분류 가능한 framing error는 optional `AgentRuntimeErrorCode` seed를 보존한다: `transport.test.ts`는 `agent-runtime-error.code`가 diagnostic handler로 전달되는지, `codex-app-server-adapter.test.ts`는 runtime error `code`가 normalized `AgentEvent.error.code`로 보존되는지, Rust `ac4b_fatal_framing_latches_and_suppresses_followup_stdout`는 EOF-like fatal framing이 `framing_broken` code를 emit하는지, `oq60_repeated_invalid_lines_escalate_to_framing_broken_code_and_latch`는 5회 연속 invalid line이 `recoverable:false` + `framing_broken`으로 승격되고 latch 뒤 stdout을 drop하는지 검증한다. Full provider taxonomy와 post-start recovery UX는 13 OQ-60 후속이다.

### 8.6 게이트

- [x] `npm run verify`(test + test:rust + check)가 통과한다. 확인: 2026-06-29 `npm run verify` 통과 — vitest 132 files / 989 tests, cargo test 164 tests, svelte-check 0 errors/0 warnings, vite build OK(기존 chunk size warning만), cargo check OK.
- [x] fixture replay(FR-*)가 commit된 JSONL로 재현 가능하며, 비밀이 redaction되어 있다(§1.3). 증거: `codex-fixture-replay.test.ts` FR-CX-0..4, `claude-acp-fixture-replay.test.ts` FR-CL-0..4 + fixture corpus hygiene(secret-shaped pattern blocklist/JSON parseability). 확인: `npm test -- codex-fixture-replay claude-acp-fixture-replay` 통과(2 files, 14 tests).

---

## 9. 미확정 / 결정 필요 (→ [13](13-risks-open-questions.md))

테스트가 고정값을 assert하기 전에 정책 결정이 필요한 항목:

1. ~~agent_thought_chunk / Codex reasoning 처리 정책~~ **해소됨(D11)**: thought를 `channel:"thought"` 별도 스트림으로 누적(15 §3 `channel` 필드, 04 §3.2.2/§3.2.5). CL-17/NM-10/NM-11 기대값은 thought 채널 누적으로 고정(13 OQ-01/RD-13 해소).
2. ~~**ACP audio content**(CL-18)~~ **해소됨(OQ-04)**: v1은 audio composer capability를 끄고, inbound ACP `audio` content는 drop하지 않고 `AgentContent{type:"json"}` raw 블록으로 보존한다(ref-acp §13.2).
3. ~~**reject_always → Codex decline 매핑**(CX-14)~~ **해소됨(OQ-14)**: generated decision enum에 영구 거부 값이 없으므로 공용 approval 경계의 `reject_always`는 `decline`으로 방어 매핑한다. v1 Codex command/fileChange UI는 `reject_always`를 노출하지 않는다. 증거: `codex-app-server-adapter.test.ts` CX-14.
4. ~~**backpressure 정책**(RS-16/17)~~ **해소됨(T2.0/OQ-39)**: v1 동시성 모델은 `std::thread`+`Mutex`로 확정됐고(07 §7.4), 수치 정책은 `MAX_MESSAGE_LOG_BYTES = 8 * 1024 * 1024`, `MAX_LINE_BYTES = 4 * 1024 * 1024`, `BACKPRESSURE_NOTIFY_INTERVAL = 256`, replay log oldest drop + telemetry로 고정됐다. RS-16/17은 bounded replay log trim과 `droppedMessages` count를 검증한다.
5. **message seq + snapshot/delta-since** late-attach: 현 계약(15 §8.3)에는 seq 미포함, 후속 추가 권고. E2E late-attach 신뢰성 테스트는 그 후(04 §3.4, `research/codebase-backend.md` §10 권고 3).
6. **14-sequence-and-state.md 동기화**: 14는 존재함. E2E §7 표가 14 시퀀스와 1:1로 유지돼야 함. 14 시퀀스 갱신 시 본 표 번호와 일치시킬 것.
7. **fixture 캡처 신뢰도**: 실제 wire 캡처 전까지 ref 예시 기반 fixture는 ordering `unverified`(ref-codex §9·§10). 실제 캡처로 교체 필요.
8. ~~**command/entry resolve 주체**(S1, RS-8..RS-10c)~~ **해소됨(T2.0/OQ-36/OQ-38)**: backend owner는 `agent_runtime/resolver.rs`, cache key는 `(provider,distro)`, `clear()`로 무효화한다. env key allowlist도 provider별 집합으로 확정됐다. RS-8..RS-12b와 RS-10d/10e가 renderer 비제어, args/env 거부, executable/adapter entry 성공경로와 cache boundary를 검증한다.
9. ~~**serde 버전 확인**(S2, RS-21..RS-24)~~ **해소됨(T2.0/OQ-37)**: `src-tauri/Cargo.lock` serde `1.0.228` ≥ `1.0.181`이므로 `#[serde(rename_all_fields="camelCase")]`를 사용한다. RS-21..RS-25가 camelCase 필드 round-trip 일치를 검증한다.
10. **transcript 메모리 운영 수치 실측**(NM-31/31b/34b, OQ-52): v1 보수 기본값(`HOT_WINDOW_SEALED_TURNS=50`, `HOT_WINDOW_BYTES=8MiB`, `TOMBSTONE_LRU=200`, `SEAL_QUIESCENCE_GRACE_MS=250`)과 bounded eviction 동작은 구현/테스트로 고정됐다. terminal stderr, tool raw, image data URI, file diff patch도 hot-window byte 계산에 포함된다(NM-31e/f/g/h). `agent-runtime-store.svelte.test.ts`의 OQ-52 fixture는 기본 cap으로 1,000 turn을 합성해 `visibleItemIds`/`itemVersions`/`itemsById`/`turnsById`/tombstone LRU가 cap에 수렴하고, tombstone late drop과 sealed-retained late patch/reseal 분기가 유지되는지 확인한다. 남은 범위는 실제 대용량 세션 성능 실측 후 운영 튜닝값·tombstone TTL·heavy item cap을 조정할지 여부다. 테스트는 "bounded 유지" 불변식만 고정하고, 실측 전 운영 임계값을 성능 결론처럼 assert하지 않는다(04 §3.7, 08 §5, 13 OQ-52).
11. **same-turn 보조 notification 도착 여부**(NM-33, OQ-53): 종료 신호(Codex `turn/completed`·ACP `stopReason`) 후 같은 turn에 보조 notification이 실제 wire에서 도착하는지 → seal grace 필요 여부. NM-33 입력은 **reducer/store event fixture**(합성)로 두고 실제 wire 발생은 구현 직전 실측(13 OQ-53, 04 §3.7). opt-in raw debug JSONL이 확보되면 `debug-log-analyzer.test.ts`가 고정한 `analyzeRawProtocolDebugLog` 경계로 Codex `turn/completed`의 실제 envelope(`params.threadId` + `params.turn.id`) 및 ACP `session/prompt` stopReason response marker를 `terminalMarkers[]`로 확인하고, 이후 same routing key notification 후보를 `lateEvents[]`로 재현 가능하게 판정한다. E2E-10은 raw debug log를 analyzer로 읽어 test-mode Codex prompt + approval turn의 terminal marker 존재와 `lateEvents=[]`를 고정하고, test-mode Claude ACP synthetic late candidate(`session/prompt` out → stopReason response → delayed `session/update:plan_update`)가 `lateEvents[]`로 검출되는지도 고정한다. 2026-06-30 Codex app-server stdio probe의 tool-free simple turn 1회에서는 `thread/tokenUsage/updated`가 `turn/completed`보다 먼저 도착했고(`seq=25` vs `seq=28`), completion 뒤 1.5초 동안 late 후보가 없었다. 같은 날 tool-bearing shell command turn 1회에서도 commandExecution `item/completed`와 `thread/tokenUsage/updated`가 `turn/completed`보다 먼저 도착했고(`seq=20/21/30` vs `seq=33`), completion 뒤 2초 동안 late 후보가 없었다. 2026-07-01 read-only sandbox approval request turn 1회에서는 `item/commandExecution/requestApproval` seq 20, client 응답 뒤 `serverRequest/resolved` seq 21, `item/completed` seq 23, `thread/tokenUsage/updated` seq 24/34, `turn/completed` seq 37로 모두 terminal marker보다 앞섰고, completion 뒤 2.5초 동안 late 후보가 없었다. 같은 날 fileChange diff turn 1회에서는 fileChange `item/completed` seq 67과 `turn/diff/updated` seq 68/71/82가 모두 `turn/completed` seq 84보다 앞섰고, completion 뒤 2.5초 동안 late 후보가 없었다. 이 결과는 Codex 단순/tool-bearing/approval request/fileChange diff turn 하한과 ACP synthetic 검출 경계 하한이며, plan 포함 Codex live turn과 Claude ACP live turn은 별도 캡처가 필요하다.
12. ~~**격리 replay 범위**(FE-27, OQ-54)~~ **해소됨**: Codex `thread/read{includeTurns:true}`는 전체 thread snapshot을 반환한다. 기본 UI 경로는 provider port-backed scratch replay를 호출하고, full snapshot 방어로 provider port 수집과 scratch reduce에 기본 1000 event 상한을 적용한다. 테스트는 "live 미병합 + scratch 폐기 + running 충돌 없음"(T5.6 DoD), 상한 방어, partial snapshot notice를 고정한다(10 §4.7, 13 OQ-54).
13. **post-start fatal recovery UX / typed failure-code taxonomy**(OQ-60): E2E-6/FE fallback 테스트는 fresh direct start 실패에만 적용한다. 기동 완료 후 `agent-runtime-exit` 또는 `recoverable:false` runtime error는 현재 notice/cleanup 경로(CX-19/CL-25/RS-5b)로 검증하고, `AgentTranscriptSurface.test.ts` OQ-60과 Windows `agent-runtime` E2E post-start fatal spec은 post-start fatal/exit가 fallback panel이나 PTY callback으로 승격되지 않음을 고정한다. PTY fallback panel 승격이나 full stable error-code taxonomy assert는 OQ-60 결정 전까지 추가하지 않는다.
14. **tool location 실제 editor 연결**(FE-7a, OQ-61): callback 경계와 `SessionShell` direct host의 internal editor open, external default editor, external picker 단위 흐름은 구현됐다. E2E-11 internal target spec, external default-editor/picker command-payload spec, fake external editor process real-launch spec도 Windows `agent-runtime` E2E에서 통과했다. 남은 검증은 fake process argv 확인을 넘어 실제 설치 editor가 focus/line reveal을 의도대로 수행하는지 확인하는 slice다.

---

## 10. 교차 참조

| 대상 | 문서 | 절 |
|---|---|---|
| 테스트가 검증하는 타입 정본 | [`15-data-contracts.md`](15-data-contracts.md) | §1–§8 |
| 테스트가 검증하는 규칙·불변식 정본 | [`04-normalized-agent-model.md`](04-normalized-agent-model.md) | §2·§3(§3.7 seal/eviction/late-event)·§4·§5 |
| Codex wire 사실·매핑 | [`ref-codex-app-server-protocol.md`](ref-codex-app-server-protocol.md) | §1·§4·§5·§6·§7·§8·§9 |
| ACP wire 사실·매핑 | [`ref-acp-protocol.md`](ref-acp-protocol.md) | §1·§3·§4·§5·§6·§13 |
| Claude ACP 구현체 사실 | [`ref-claude-agent-acp.md`](ref-claude-agent-acp.md) | §1·§2·§3·§5 |
| backend 코드 현실·테스트 컨벤션·mock | [`research/codebase-backend.md`](research/codebase-backend.md) | §2·§6·§8·§9·§10 |
| frontend 코드 현실·테스트 컨벤션·host 분기 | [`research/codebase-frontend.md`](research/codebase-frontend.md) | §1.6·§3·§6·§9·§10·§11 |
| 위험·결정 필요·기본값 | [`13-risks-open-questions.md`](13-risks-open-questions.md) | 전체 |
| 시퀀스/상태 다이어그램(E2E 대응) | [`14-sequence-and-state.md`](14-sequence-and-state.md) | 전체 |
| permission·redaction·감사 | [`09-permissions-security.md`](09-permissions-security.md) | 전체 |
| UI 구성·legacy fallback·transcript view-model 정본 | [`08-ui-composition.md`](08-ui-composition.md) | 전체(§5 `TranscriptModel`/`TranscriptTurnResidency` 정본) |
| persistence·runtime scrollback replay | [`10-persistence-migration.md`](10-persistence-migration.md) | §4.7(read-only history inspection; §4.2 cold restore와 구분) |

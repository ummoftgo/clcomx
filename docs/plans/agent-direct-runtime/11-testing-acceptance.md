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

provider가 보내는 wire 메시지를 **NDJSON(`.jsonl`) 한 줄 = `{ direction: "in"|"out", message: JsonRpcMessage }` envelope**로 캡처해 fixture로 박고, envelope의 `message`를 adapter에 흘려 normalized `AgentEvent` 시퀀스를 스냅샷 비교한다(`direction`: in=provider→client, out=client→provider). 이 형식은 12 §T0.5 fixture 포맷 정본·§T2.5 test-mode mock 재사용과 **단일 형식**으로 통일된다(replay 입력과 E2E mock 단일 출처). ACP는 newline-delimited가 wire 규칙 그대로이고(ref-acp §1 stdio transport), Codex도 line-delimited JSON이다(ref-codex §1.2). 따라서 envelope의 `message`가 wire 메시지와 1:1이라 재현성이 높다.

```
src/lib/features/agent-runtime/adapters/__fixtures__/
├── codex/
│   ├── thread-start-turn.jsonl          # initialize~turn/completed 1회
│   ├── delta-completed-reconcile.jsonl  # agentMessage delta→completed
│   ├── command-exec-approval.jsonl      # commandExecution + requestApproval
│   ├── interleaved-two-turns.jsonl      # 동시 thread/turn 인터리빙 ({direction,message} envelope NDJSON)
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

- **1차(권고)**: backend `agent-runtime-message` 이벤트(15 §8.3, raw JSON-RPC를 그대로 올림)와 client→provider 아웃바운드를 각각 `direction:"in"`/`"out"` envelope으로 감싸 redacted debug mode(13 §"raw protocol log")에서 파일로 tee. 실제 wire라 가장 신뢰도 높다.
- **2차(부트스트랩)**: ref 문서의 verified payload(ref-codex §9 시퀀스, ref-acp §3·§4·§5·§6 예시)를 손으로 `{direction,message}` envelope NDJSON으로 옮긴다. ordering 일부는 `unverified`(ref-codex §10, §9 주석) → 해당 fixture는 "예시 기반"으로 주석 표기하고, 실제 캡처가 생기면 교체한다([13](13-risks-open-questions.md)로 연결).
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
| CX-15b | **미지원 server→client request**(id 있는 요청이나 adapter가 모르는 method, 예 알 수 없는 elicitation method) | outbound로 JSON-RPC **error 응답**(`{id, error:{code:-32601, message}}`) 또는 명시적 decline 응답을 보낸다. **무응답으로 끝나지 않음**(provider deadlock 방지) — `drainOutbound()`에 정확히 1개 응답이 있고, 응답 `id`가 요청 `id`와 일치함을 assert(R5; 05 §7.1 default 분기는 `return []`로 끝내지 말고 unknown server request에 error/unsupported 응답 후 종료; 04 §5 edge 규칙, 13 unknown-variant silent-drop 금지) |
| CX-15c | 미지원 **notification**(id 없음, 예 알 수 없는 v2 notification) | 응답 불필요 — raw 보존(`ProviderRef.raw`) + unknown counter 증가만, outbound 없음 assert(R5 notification 경로, 15 §0.2) |

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
| CL-27 | 알 수 없는 `sessionUpdate` variant 또는 미지원 **notification**(id 없음, 예 plan_update/plan_removed/session_info_update) | graceful 무시, crash 없음, raw 보존(`ProviderRef.raw`) + unknown counter 증가, **outbound 없음** assert — notification(id 없음)은 응답 불필요(R5 notification 경로, ref-claude-agent-acp §2, 15 §0.2). id 있는 미지원 *request*는 CL-24b(error/decline 응답)와 구분 |

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

### 5.3 allowlist 검증 (신규 강화 지점 — R4 backend-resolve command + 정확 args + env key)

PTY와 달리 direct runtime은 backend가 provider별로 command를 resolve하고 args/env를 allowlist로 재검증한다(07 §8.1 정본, 15 §8.1 주석, `research/codebase-backend.md` §6, §10 권고 6 — 현 코드에 선례 없음). **S1 정본(B1 정정)**: renderer/adapter는 **실행 파일 command를 넘기지 않는다**. `AgentRuntimeStartParams`(15 §8.1)에서 `command` 필드가 **제거**되어 renderer 비제어이며, backend가 `provider`로 신뢰 절대경로를 resolve한다 — `codex` → resolve된 codex app-server 절대경로, `claude` → resolve된 node 절대경로. 따라서 동명 바이너리(`/tmp/codex`, `/tmp/node`)로 우회할 입력 자체가 존재하지 않는다(renderer가 경로를 못 넘김). adapter가 넘기는 것은 `provider`, `distro`, `workDir`, `args`(검증 대상), `env`(non-secret) 뿐이다.

**args 검증(backend)**: Codex는 `args`가 **정확히** `["app-server","--stdio"]`. Claude는 `args.length == 1` 이고 `args[0]`이 backend가 검증한 `adapterEntryPath`(절대경로, `claude-agent-acp` `dist/index.js` 패턴)와 정확 일치. `adapterEntryPath`는 renderer 자유 입력이 아니라 backend가 **고정 npm 의존 위치에서 resolve(또는 사전 등록된 절대경로)**한 값이다. env key는 정규식 + provider별 허용 key 집합으로 강제한다(값은 non-secret, C1). shell metachar 검사는 방어용으로 유지한다. 아래 RS-8..RS-12b는 이 S1 정본의 수용 테스트다(09 untrusted renderer 위협모델, 07 §8.1 인용; 타입 정본 15 §8.1은 S1로 `command` 필드 제거).

> **resolve 주체·캐시 무효화·`adapterEntryPath` 탐색 방식은 `결정 필요`(→ [13](13-risks-open-questions.md) OQ-36 "command/entry resolve 주체")**. 테스트는 "renderer가 command를 못 넘기고 backend가 provider로 신뢰 절대경로를 resolve한다"는 계약과 args/env 거부 규칙, 그리고 **resolve 성공경로**(신뢰 절대경로 반환 + 캐시 무효화 후 재탐색, RS-10d/10e)만 고정 assert하고, resolve 구현 디테일(어느 cache/탐색)은 mock으로 주입한다. 현 RS-10c가 실패만 다루던 공백을 RS-10d/10e가 보완한다(12 T2.0/T2.4 DoD 연계).

| # | 입력 | 기대 |
|---|---|---|
| RS-8 | `agent_runtime_start{provider:"codex", distro, workDir, args:["app-server","--stdio"]}` (command 필드 **없음** — 타입에서 제거) | 허용, RuntimeId 반환. backend가 `codex` provider로 신뢰 절대경로를 resolve해 spawn하고 Codex 정확 args 통과(S1, 07 §8.1). spawn된 executable이 backend-resolve한 codex 절대경로임을 assert(mock resolve 주입) |
| RS-8b | `provider:"codex"`, `args:["app-server"]`(또는 `["app-server","--stdio","--extra"]`) | `Err(String)` 거부 — Codex args는 정확히 `["app-server","--stdio"]`여야 함(07 §8.1 args 정확 검증) |
| RS-9 | `provider:"claude"`, `args:[검증된 adapterEntryPath(절대경로, claude-agent-acp dist/index.js 패턴)]` (command 필드 **없음**) | 허용. backend가 `claude` provider로 node 신뢰 절대경로를 resolve하고 `args.length==1` + `args[0]`가 backend가 검증한 adapterEntryPath임을 통과(S1, 07 §8.1, 06 §2.2, ref-claude-agent-acp §1·§2). spawn된 executable이 backend-resolve한 node 절대경로임을 assert |
| RS-9b | `provider:"claude"`, `args:["/tmp/x.js"]`(임의 .js, backend 신뢰 adapterEntryPath 아님) 또는 `args.length!=1` | `Err(String)` 거부 — `args[0]`가 backend 검증 adapterEntryPath와 미일치/임의 스크립트(07 §8.1 임의 .js 거부) |
| RS-10 | **renderer가 command를 넣을 경로가 없음(구조적 차단)**: 직렬화 시 추가 `command` 키가 붙은 payload를 deserialize | `command` 필드는 타입에 없으므로 무시되거나(미정의 필드) deny — renderer가 executable 경로를 제어할 입력 자체가 없음을 assert. 동명 바이너리(`/tmp/codex`,`/tmp/node`) 우회 불가가 구조적으로 성립(S1; 07 §8.1 basename 비교 제거, 15 §8.1 command 제거) |
| RS-10b | `provider:"claude"`, `args:["/tmp/x.js"]` (backend node resolve 사용, adapterEntryPath 미일치) | `Err(String)` 거부 — executable은 backend가 고정 resolve하므로 renderer가 못 바꾸고, `args[0]`가 신뢰 adapterEntryPath 아니라 거부(S1 핵심 거부 케이스, 09 위협모델). renderer가 임의 .js를 실행시킬 수 없음을 assert |
| RS-10c | backend resolve가 신뢰 codex/node 절대경로를 못 찾음(미설치/탐색 실패) | `Err(String)` — provider 신뢰 경로 resolve 실패 시 spawn하지 않음(S1 backend-resolve 계약; resolve 주체는 13 결정 필요, mock으로 실패 주입) |
| RS-10d | **resolve 성공경로(executable)**: 설치된 provider에 대해 `resolve_trusted_executable(provider, distro)`(13 OQ-36) 호출(mock 아닌 실제 resolve 로직, 탐색 성공) | 신뢰 **절대경로** 반환(상대경로·동명 PATH 바이너리 아님) — `codex`→codex app-server 절대경로, `claude`→node 절대경로. 반환 경로가 spawn executable로 그대로 전달됨을 assert(S1 backend-resolve 계약, 07 §8.1, 12 T2.0/T2.4 DoD 연계) |
| RS-10e | **resolve 성공경로(adapter entry) + 캐시 무효화**: `resolve_trusted_adapter_entry("claude", distro)`(13 OQ-36)로 신뢰 `adapterEntryPath`를 1회 resolve(캐시 채움) → 무효화 트리거(13 OQ-36 cache key/clear 조건) 후 재호출 | 1차 호출이 신뢰 절대경로(`claude-agent-acp` `dist/index.js` 패턴)를 반환하고, 무효화 후 재호출이 재탐색(stale 캐시 미반환)함을 assert. cache key/TTL/clear 조건은 `결정 필요`(→ [13](13-risks-open-questions.md) OQ-36) — 테스트는 "성공 시 신뢰 절대경로 반환 + 무효화 후 재탐색" 계약만 고정하고 캐시 구현 디테일은 mock 주입(07 §8.1, 12 T2.0/T2.4 DoD 연계) |
| RS-11 | args에 shell 메타문자/주입 시도(`;`/`|`/`$(`/개행 등) | 거부(executable+argv 직접 실행이라 셸 비경유지만 방어적 metachar 검사 유지, 07 §8.1 규칙 3, `research/codebase-backend.md` §2.2) |
| RS-12 | env key가 `^[A-Za-z_][A-Za-z0-9_]*$` 위반(예: `1BAD`, `A-B`, `A B`) | `Err(String)` 거부(registry `assertValidEnvKey` 선례, 07 §8.1 규칙 5, `research/codebase-backend.md` §6) |
| RS-12b | env key가 정규식은 통과하나 provider별 허용 key 집합 밖(미등록 key) | `Err(String)` 거부 — env key allowlist(provider별 허용 집합) 강제(07 §8.1 규칙 5, S1 env key allowlist). 값은 non-secret 전용(C1, 07 §5.1·§8.1·§11) |
| RS-12c | **websocket reject-before-log(D-WSAUTH)**: `agent_runtime_start{transportKind:"websocket", ..., authToken:"secret-xyz"}` (15 §8.1 websocket variant — v1 미사용) | handler가 **로깅·스냅샷 노출 전에** 즉시 `Err(String)` 거부(13 RD-2, 07 handler websocket 즉시 reject). 거부 경로에서 캡처한 로그·debug snapshot·audit 어디에도 `authToken` 값(`secret-xyz`)이 평문으로 나타나지 않음을 assert — `authToken`이 redaction/scrub 집합에 포함되어 token 로깅 없이 reject됨(09 secret scrub `authToken` 포함, 15 §8.1 "v1 미사용 — 로깅/스냅샷 노출 전 reject"). variant 타입 자체는 future-sketch로 유지 |

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

> v1 동시성 모델은 `std::thread`+`Mutex`로 확정됐다(07 §7.4). backpressure 테스트의 미확정분은 tokio 여부가 아니라 OQ-39의 수치 정책(`MAX_MESSAGE_LOG_BYTES`, single-line cap, notify interval, drop/block)이다. OQ-39 확정 전에는 RS-16/17의 기대값을 고정하지 않는다.

### 5.6 is_test_mode mock (E2E·unit 1급 지원)

| # | 입력 | 기대 |
|---|---|---|
| RS-18 | `CLCOMX_TEST_MODE` 설정 후 `agent_runtime_start` | native subprocess 대신 mock JSON-RPC 응답 스트림(PTY `create_mock_session` 본뜸, `research/codebase-backend.md` §2.1, §10 권고 8) |
| RS-19 | mock runtime에 send | 미리 정의된 mock 응답 emit(WSL/실제 CLI 없이) |
| RS-20 | snapshot/delta 단위 테스트 | `test_*` state 생성기로 mock 상태 만들어 검증(`research/codebase-backend.md` §8.1, §9) |

### 5.7 serde 미러 (TS↔Rust 1:1) — camelCase **필드** round-trip 필수화 (S2)

**S2 정본(B2 정정)**: enum 레벨 `#[serde(rename_all="camelCase")]`는 **variant 이름만** 바꾸고 variant **내부 필드**(`work_dir`/`request_id`/`runtime_id`/`dropped_messages` 등)는 snake_case로 남아 TS의 `workDir`/`requestId`/`runtimeId`/`droppedMessages`와 불일치 → Tauri command/event payload **역직렬화 실패**한다. 정본 해결: variant 필드를 가진 enum(`AgentRuntimeStartParams`, `AgentRuntimeCancelTarget`, `AgentRuntimeEvent`, `JsonRpcMessage` 등)에 `#[serde(rename_all_fields = "camelCase")]`(serde ≥ 1.0.181) 추가 또는 필드별 `#[serde(rename="...")]`. struct 미러(`AgentRuntimeSnapshot`, `JsonRpcError`, `AgentRuntimeMetadataRecord`)는 struct 레벨 `rename_all`로 이미 정상이라 유지한다(15 §8).

따라서 **camelCase 필드까지 일치하는 TS↔Rust JSON round-trip 테스트를 필수화**한다(enum variant 필드가 camelCase로 직렬화/역직렬화되는지). 아래 RS-21..RS-25는 그 round-trip 수용 테스트다(RS-21..RS-24는 variant 필드를 가진 enum, RS-25는 struct 미러). TS가 보내는 camelCase JSON 문자열(고정 fixture)을 Rust가 deserialize → 같은 값으로 serialize 시 다시 camelCase가 나오는지(왕복 동일) assert한다.

> **serde 버전 의존성**: `rename_all_fields`는 **serde ≥ 1.0.181**에서만 동작한다. 구현 전 `src-tauri/Cargo.toml`의 serde 버전을 확인해야 한다(`결정 필요` → [13](13-risks-open-questions.md) "serde 버전 확인"). 미만이면 필드별 `#[serde(rename="camelCaseName")]`로 대체한다. round-trip 테스트는 이 둘 중 어느 방식이든 **camelCase 필드 일치**만 검증한다.

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

### 6.7 persistence 왕복 / settings 동기화

대상: `src/lib/features/workspace/session-store-snapshot.ts`(`createWorkspaceTabSnapshot`), `src/lib/features/session/service/live-session-workspace-sync.ts`(`createSessionCore`/`createRuntimeSession`/`applyWorkspaceWindowSnapshot`), `src/lib/stores/settings.svelte.ts`(`cloneDefaults`/`normalizeSettings`/`updateSettings`)(12 §0.2 항목 10·11). direct 세션의 `runtimeKind`/`agentRuntime`(15 §7.2) 영속화 3경로(저장→복원→기존세션 갱신)와 settings 3함수 동기화를 검증한다. backend snapshot scrub 직렬화는 RS-25(§5.7)가, 부재→`"pty"` normalize는 FE-19(§6.6)가 이미 다룬다 — 여기서는 frontend 왕복·전파·default 보존을 본다.

| # | 입력 | 기대 |
|---|---|---|
| FE-22 | direct 세션(`runtimeKind:"direct-codex"`, `agentRuntime` 설정)에 `createWorkspaceTabSnapshot` 적용 | snapshot에 `runtimeKind`/`agentRuntime`(15 §7.3 scrub 후 — session/thread id·resume token 제외) 포함. scrub 대상 필드가 snapshot에 없음 + 비-scrub 필드 보존 동시 assert(12 §0.2 #11, 15 §7.3) |
| FE-23 | FE-22 snapshot으로 `createSessionCore`/`createRuntimeSession` 복원 | 복원된 세션의 `runtimeKind`/`agentRuntime`가 snapshot과 동일 필드로 복구(왕복 무손실, scrub된 필드는 부재 그대로). legacy snapshot(필드 부재)은 FE-19 normalize 경로로 위임(12 §0.2 #11) |
| FE-24 | 기존 세션이 있는 상태에서 `applyWorkspaceWindowSnapshot` 호출(window snapshot이 direct 세션 갱신 포함) | 기존 세션 객체에 `runtimeKind`/`agentRuntime`가 전파(갱신 경로) — 새 세션 생성뿐 아니라 **기존 세션 갱신 경로**에서도 두 필드가 누락 없이 반영(12 §0.2 #11 "기존 세션 갱신은 `applyWorkspaceWindowSnapshot`") |
| FE-25 | 새 agentRuntime 설정 섹션 default가 `cloneDefaults`/`normalizeSettings`/`updateSettings` 세 함수 모두에 반영 | 세 함수 어느 경로(초기화·정규화·갱신)로 들어와도 새 섹션 default가 동일하게 채워짐 — 한 함수만 갱신해 default가 어긋나는 회귀를 잠금(`research/codebase-frontend.md` §7.3, §11; 12 §0.2 #10) |

> FE-25는 settings 3함수가 default 정의를 한 곳에서 공유하는지(또는 세 함수가 동일 default를 산출하는지)를 cloneDefaults 결과·normalizeSettings(빈 입력)·updateSettings(미지정 섹션) 산출을 교차 비교하는 단위 테스트로 구현한다(`research/codebase-frontend.md` §7.3 — 새 섹션 추가 시 3함수 동기화 MUST).

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
- [ ] shutdown cleanup ordering(S3): adapter shutdown이 **unlisten/세션 삭제 전에** 모든 pending approval/RPC를 정확히 한 번 닫고, 늦은 exit이 멱등 처리되어 이중 종료·누락이 없다(NM-18b/18c/18d, 04 §4.2·§5; backend reap 경계는 RS-13/14/15b/15c).
- [ ] interleaved turn 분리(CX-16/17, ref-codex §7.1)와 ACP chunk/replace 구분(CL-12..CL-16, ref-acp §4·§5)이 검증된다.
- [ ] 미지원 server→client **request**(id 있는 요청)는 Codex·Claude 양쪽에서 JSON-RPC error(`-32601`)/decline 응답을 보내고 **무응답으로 끝나지 않는다**(CX-15b, CL-24b, R5; 04 §5 edge 규칙). 미지원 **notification**(id 없음)은 raw 보존+counter만, 응답 없음(CX-15c, CL-27).

### 8.2 transport / process

- [ ] stdio JSON-RPC framing(newline·UTF-8 경계·부분 라인), stderr/stdout 분리, bounded queue overflow, shutdown timeout→kill(**child reap 후 반환**)이 Rust test(RS-1..RS-17)로 검증된다(S3 reap 경계 RS-13/14/15b/15c).
- [ ] renderer/adapter는 **command를 넘기지 않고**(15 §8.1 `command` 필드 제거), backend가 `provider`로 신뢰 절대경로를 resolve한다(codex→codex 절대경로, claude→node 절대경로). args(Codex 정확 `["app-server","--stdio"]`, Claude `args.length==1`+검증된 adapterEntryPath)·env key allowlist가 backend에서 재검증되어 임의 .js·동명 바이너리 우회(`/tmp/codex`,`/tmp/node`)·미등록 env key를 차단하고, renderer가 executable 경로를 제어할 입력 자체가 없다(RS-8..RS-12b, 07 §8.1 S1 정본, 09 untrusted renderer 위협모델).
- [ ] `resolve_trusted_executable`/`resolve_trusted_adapter_entry`(13 OQ-36)의 **성공경로**(신뢰 절대경로 반환 + 캐시 무효화 후 재탐색)가 실제 resolve 로직으로 검증되어 RS-10c의 실패-only 공백을 보완한다(RS-10d/10e, 12 T2.0/T2.4 DoD 연계).
- [ ] Tauri 경계 enum payload의 **camelCase 필드 round-trip(TS↔Rust)** 이 일치한다 — `AgentRuntimeStartParams`/`AgentRuntimeCancelTarget`/`AgentRuntimeEvent`/`JsonRpcMessage`의 variant 필드(`workDir`/`requestId`/`runtimeId`/`droppedMessages` 등)가 snake_case로 새지 않는다(RS-21..RS-25, S2 `rename_all_fields` 또는 필드별 rename; serde ≥ 1.0.181 확인 → 13).
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
- [ ] approval wire 응답이 **원본 JSON-RPC id 타입을 보존**한다 — numeric id(예 `42`)가 `"42"`로 변질되지 않고, `ApprovalRequest.id`/`ProviderRef.requestId`는 문자열 키, wire 응답 `id`는 원본 타입 유지(CL-21b/21c, R3; 06 §6.1/§6.2 `rpcId`, 05 §6 CodexRouting).
- [ ] 모든 approval 결정(user/auto/cleanup)에 audit entry가 **정확히 1건** 기록되고, audit entry에는 명령 전문·credential·파일 내용·raw label이 섞이지 않는다(`requestId`/`optionId`/`optionKind`/`outcome`/시각/`decidedBy`만)(NM-20b/20c, 09 §3.4, 12 audit task).
- [ ] websocket transportKind start가 **token을 로그·snapshot·audit에 남기지 않고 즉시 reject**된다 — `authToken`이 scrub 집합에 포함되어 노출 전 거부된다(RS-12c, 13 RD-2, 09 secret scrub `authToken`, 15 §8.1 websocket variant v1 미사용).
- [ ] provider session/thread id·resume token은 디스크 저장 시 scrub된다(RS-25, 15 §7.3, `research/codebase-backend.md` §4.2).
- [ ] direct 세션의 `runtimeKind`/`agentRuntime`가 **저장→복원→기존세션 갱신** 3경로 모두에서 무손실 왕복(scrub 후)하고, 새 settings 섹션 default가 `cloneDefaults`/`normalizeSettings`/`updateSettings` 3함수에 동기화된다(FE-22..FE-25, 12 §0.2 #10·#11, 15 §7.2/§7.3).
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
4. **backpressure 정책**(RS-16/17): v1 동시성 모델은 `std::thread`+`Mutex`로 확정됨(07 §7.4). 구현 전 OQ-39에서 drop vs block, `MAX_MESSAGE_LOG_BYTES`, single-line cap, notify interval을 확정해야 한다.
5. **message seq + snapshot/delta-since** late-attach: 현 계약(15 §8.3)에는 seq 미포함, 후속 추가 권고. E2E late-attach 신뢰성 테스트는 그 후(04 §3.4, `research/codebase-backend.md` §10 권고 3).
6. **14-sequence-and-state.md 동기화**: 14는 존재함. E2E §7 표가 14 시퀀스와 1:1로 유지돼야 함. 14 시퀀스 갱신 시 본 표 번호와 일치시킬 것.
7. **fixture 캡처 신뢰도**: 실제 wire 캡처 전까지 ref 예시 기반 fixture는 ordering `unverified`(ref-codex §9·§10). 실제 캡처로 교체 필요.
8. **command/entry resolve 주체**(S1, RS-8..RS-10c): backend가 `provider`로 신뢰 절대경로를 resolve하는 주체·캐시 무효화·`adapterEntryPath` 탐색 방식 미확정. 테스트는 계약(renderer 비제어 + provider resolve)과 args/env 거부만 고정 assert하고 resolve 구현은 mock 주입(→ [13](13-risks-open-questions.md) "command/entry resolve 주체").
9. **serde 버전 확인**(S2, RS-21..RS-24): `#[serde(rename_all_fields="camelCase")]`는 serde ≥ 1.0.181 필요. 구현 전 `src-tauri/Cargo.toml` serde 버전 확인, 미만이면 필드별 `#[serde(rename="...")]`로 대체. round-trip 테스트는 어느 방식이든 camelCase 필드 일치만 검증(→ [13](13-risks-open-questions.md) "serde 버전 확인").

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

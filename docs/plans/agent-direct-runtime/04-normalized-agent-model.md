# Normalized Agent Model

## 목표

Codex app-server와 Claude ACP의 event shape는 다르다. UI와 persistence가 두 protocol에 직접 결합되지 않도록 CLCOMX 내부 공통 모델을 둔다.

> **역할 분리 (중요)**: 이 문서는 normalized model의 **개념·규칙·불변식**을 다룬다. 상태 전이 규칙, upsert/append/reconcile 알고리즘, 순서 보존, approval 생명주기, provider별 식별자 라우팅이 여기 있다.
>
> **모든 타입 정의의 정본은 [`15-data-contracts.md`](15-data-contracts.md)다.** `AgentProvider`, `ProviderRef`, `AgentSessionStatus`, `AgentEvent`, `AgentContent`, `ToolCallUpdate`, `ApprovalRequest`/`ApprovalOption`/`ApprovalDecision`, `AgentPlanEntry`, `FileLocation`, `FileChangeSummary`, `TokenUsage`는 모두 15 §1–§5에 정의돼 있다. 이 문서는 그 타입을 **재정의하지 않고** 규칙만 설명한다. 타입과 규칙이 충돌하면 타입은 15가, 규칙은 04가 권위를 갖는다.
>
> provider wire → normalized 매핑표는 [`ref-codex-app-server-protocol.md`](ref-codex-app-server-protocol.md) §8과 [`ref-acp-protocol.md`](ref-acp-protocol.md) §13에 있다. 이 문서의 규칙은 그 매핑을 전제로 한다.

---

## 1. 핵심 식별자와 라우팅 키

정본 타입: [`15-data-contracts.md`](15-data-contracts.md) §1 (`AgentProvider`, `ProviderRef`).

원본 id는 provider별 field로 보존한다. 공통 id를 만들더라도 원본 id를 덮어쓰지 않는다. 매핑되지 않은 payload는 `ProviderRef.raw`에 둔다.

### provider별 식별자의 의미

provider마다 "무엇이 라우팅 키인가"가 다르다. 정확한 매핑 표는 15 §1.1에 있고, 여기서는 의미를 설명한다.

- **Codex (v2 thread/turn/item 모델)**: 한 connection 위에서 여러 thread가 동시에 흐를 수 있고, 각 thread 안에서 turn이, 각 turn 안에서 item이 흐른다. 따라서 모든 item/turn notification은 `(threadId, turnId, itemId)` **삼중 키**로 라우팅·upsert해야 한다 (ref-codex §7.1). `Thread.sessionId`는 세션 트리(fork/resume 공유) 식별자이고, persistence resume 키 후보다. approval server-request는 `threadId/turnId/itemId` + JSON-RPC `id`를 들고 오며, zsh-exec-bridge 분기 시 한 `itemId`에 여러 approval이 붙으면 `approvalId`(원본은 `raw`)로 구분한다.

- **Claude ACP (v1)**: `SessionId`가 최상위 라우팅 키다. **turn id가 wire에 존재하지 않는다** — `session/prompt` 1회가 1 turn이고, 종료는 응답의 `stopReason`으로만 안다. 메시지 청크는 `ContentChunk.messageId`로 그룹핑되고(값이 바뀌면 새 메시지 시작), tool call은 `ToolCallId`로 식별된다. approval은 `session/request_permission`의 JSON-RPC `id`로 응답을 매칭한다.

### turn id 합성 규칙 (ACP)

ACP는 turn id가 없으므로 CLCOMX가 합성한다. `sendPrompt` 시 client가 **prompt 단위로 단조 증가하는 turnId**(예: `<sessionId>:t<n>`)를 부여하고, 그 turn 동안 발생하는 모든 `AgentEvent.ref.turnId`에 같은 값을 넣는다. `session/prompt` 응답(`stopReason`)을 받으면 그 turnId의 turn을 종료한다. 이 합성 turnId는 wire로 나가지 않는 내부 값이다.

### 라우팅 키 요약

- Codex 메시지/tool/명령 event: `(provider="codex", threadId, turnId, itemId)`.
- ACP 메시지 event: `(provider="claude", sessionId, messageId)`. tool call: `(sessionId, toolCallId)`.
- approval event: 양 provider 모두 `requestId`(JSON-RPC id)로 pending table 매칭.

---

## 2. 세션 상태 머신

정본 타입: [`15-data-contracts.md`](15-data-contracts.md) §2 (`AgentSessionStatus`).

ACP의 신호 합성과 Codex의 thread/turn status를 공통 상태로 축약한다. 축약 전 원본 status는 `ProviderRef.raw` 또는 metadata에 남긴다.

### 2.1 전이 규칙

```text
            startSession                initialize/session 생성 완료
   (start) ───────────────▶ starting ───────────────────────────▶ ready
                                │                                    │
                                │ initialize 실패 / process 즉사       │ sendPrompt
                                ▼                                    ▼
                             failed ◀── systemError ──────────── running ──┐
                                ▲                                  │   ▲    │ approval_requested
                                │                                  │   │    │ / user input 대기
              process 종료       │                turn_completed    │   │    ▼
   (any) ───────────────▶ exited│                (completed/        │   │ requires_action
                                │                 failed/cancelled) │   │    │
                                │                                  ▼   │    │ approval_resolved
                                └──────────────────────────────── idle ◀───┘
                                                                    │
                                                          sendPrompt│ (다음 turn)
                                                                    └─▶ running
```

규칙:

1. `starting` → `ready`: process spawn + protocol initialize(+ ACP `session/new` 또는 Codex `thread/start`)가 끝나야 `ready`. process는 떴지만 initialize 전이면 아직 `starting` (`07-tauri-process-runtime.md` §"process start와 protocol initialize를 분리한다").
2. `ready`/`idle` → `running`: `sendPrompt`로 turn이 시작될 때. Codex `turn/started`, ACP `session/prompt` 전송 시점.
3. `running` → `requires_action`: pending approval 또는 user input 대기. Codex `ThreadStatus.active`의 `activeFlags`에 `waitingOnApproval`/`waitingOnUserInput`가 있을 때(ref-codex §8), ACP는 `session/request_permission` 수신을 client가 합성(ref-acp §13.1).
4. `requires_action` → `running`: approval이 resolve되어 turn이 재개될 때.
5. `running`/`requires_action` → `idle`: `turn_completed`(status `completed`/`failed`/`cancelled` 모두) 이후 다음 prompt 대기. ACP `stopReason`(`end_turn`/`max_*`/`refusal`/`cancelled`) 수신, Codex `turn/completed`.
6. `* → failed`: 복구 불가 에러. Codex `ThreadStatus.systemError`, `error` notification 중 `willRetry=false`이고 치명적인 경우. `turn_completed{status:"failed"}`는 turn 실패일 뿐 세션은 `idle`로 갈 수 있다(세션 전체 실패와 구분).
7. `* → exited`: `process_exited`. process 종료는 모든 pending request를 실패로 닫는다(§5).

### 2.2 provider status 합성

- **Codex**: `ThreadStatus` tagged enum(`notLoaded`/`idle`/`systemError`/`active{activeFlags}`)을 §2.1 상태로 매핑(정확한 표 ref-codex §8). `notLoaded`→`starting`, `idle`→`idle`(또는 ready), `active`→`running`(+flag→`requires_action`), `systemError`→`failed`.
- **ACP**: wire 신호가 없으므로 (a) `stopReason`, (b) tool call `status`, (c) `session/request_permission` 수신 3가지를 합성한다. `requires_action`은 "permission pending" 상태를 client가 만든 합성 값이며 ACP wire 신호가 아니다(ref-acp §13.1).

---

## 3. 이벤트와 store 적용 규칙

정본 타입: [`15-data-contracts.md`](15-data-contracts.md) §3 (`AgentEvent`), §4 (`AgentContent`), §5 (하위 타입).

event apply는 **순서 보존이 핵심**이다. 같은 session 안에서 message id별 append/replace 순서를 보존한다. provider가 순서를 보장하지 않는 event는 adapter에서 sequence를 부여한다(§3.4).

> **reasoning/thinking 채널 정책 (정본, 해소됨)**: reasoning/thinking은 전용 event variant를 만들지 않고 `agent_message`/`agent_message_delta`의 `channel?: "response" | "thought"` 필드로 구분한다(타입 정본 15 §3, 미지정 시 `"response"`). `"thought"` 채널은 `"response"`와 **별도 스트림**으로 messageId/contentIndex별 누적하며, completed reasoning item이 thought 채널의 **권위**(reconcile)다. provider별 매핑은 Codex §3.2.2/§3.2.5(05 §5.2), ACP §3.3(06 §5). UI는 thought 채널을 접이식 'thinking' 블록(기본 collapsed)으로 response와 시각 구분해 렌더한다(08).

### 3.1 message upsert / append / replace

- message와 tool call은 **id 기준 upsert**를 지원한다(Codex `itemId`, ACP `messageId`/`toolCallId`).
- `mode: "replace"`는 기존 content를 통째로 교체한다.
- `mode: "append"`는 기존 content 뒤에 chunk를 붙인다.
- 새 id면 새 transcript 항목을 만들고, 기존 id면 갱신한다.

### 3.2 Codex delta → completed item reconcile

Codex는 streaming delta와 최종 completed item을 모두 보낸다. reconcile 키는 `itemId`다 (ref-codex §7). 아래 하위 절 번호(§3.2.1~§3.2.5)는 다운스트림 문서가 인용하는 안정적 앵커다.

#### 3.2.1 메시지

`item/started`(빈 `agentMessage`) → 여러 `item/agentMessage/delta`(`agent_message_delta`로 append) → `item/completed`(최종 `agentMessage.text`를 `agent_message{mode:"replace"}`로 reconcile). **completed의 `text`가 권위적**이며 delta 누적과 일치한다고 가정해도 된다(메시지 한정). 이 절은 `channel:"response"`(기본) 메시지에 한정한다 — reasoning/thinking 누적은 §3.2.2·§3.2.5를 따른다.

#### 3.2.2 plan · reasoning

- **plan**: 소스 주석상 "concatenated delta가 completed와 일치하지 않을 수 있음"이 명시돼 있다 → **completed item을 권위로 삼고, delta는 점진 렌더링용으로만** 쓴다. 메시지처럼 delta=completed를 가정하면 안 된다.
- **reasoning / thinking (channel:"thought" 정본)**: Codex `reasoning` item은 전용 event를 만들지 않고 `agent_message`/`agent_message_delta`의 `channel:"thought"`로 흘린다(15 §3). `item/reasoning/textDelta` → `agent_message_delta{channel:"thought"}`로 append하고, completed reasoning item → `agent_message{channel:"thought", mode:"replace"}`로 reconcile한다. **thought 채널은 `channel:"response"`와 별도 스트림으로 누적**하며(한 본문에 섞지 않음), completed reasoning item이 thought 채널의 **권위**다. plan과 마찬가지로 delta 누적=completed를 가정하지 않는다(점진 렌더용). 인덱스별 누적은 §3.2.5, UI 렌더(접이식 'thinking' 블록, 기본 collapsed)는 08.

#### 3.2.3 명령 출력

`item/started`(commandExecution, `inProgress`) → 여러 `item/commandExecution/outputDelta`(`command_output_delta`) → `item/completed`(`completed`/`failed`/`declined`, `aggregatedOutput`/`exitCode`). reconcile 키 `itemId`.

#### 3.2.4 파일 변경

`item/started`(fileChange) → `item/fileChange/patchUpdated`(`file_change_updated`) → `item/completed`(`PatchApplyStatus`).

#### 3.2.5 reasoning 인덱스 누적

`item/reasoning/textDelta`(`contentIndex`)·`summaryTextDelta`(`summaryIndex`)는 같은 `itemId` 안에서 인덱스별로 다중 스트림을 누적한다. 이 누적은 §3.2.2의 thought 채널(`channel:"thought"`) 스트림으로 흐르며, messageId/contentIndex별로 append하고 completed reasoning item이 권위(reconcile)다 — `channel:"response"` 스트림과 섞지 않는다.

### 3.3 ACP chunk vs update replace

ACP는 두 가지 갱신 의미가 섞여 있다 (ref-acp §4, §5).

- **chunk(append 의미)**: `agent_message_chunk`/`user_message_chunk`/`agent_thought_chunk`는 `ContentChunk`다. 같은 `messageId`의 청크는 누적(append)한다. `messageId`가 바뀌면 새 메시지 시작. `agent_thought_chunk`는 `agent_message_delta`/`agent_message{channel:"thought"}`로 매핑해 thought 채널 스트림에 append한다(thought 정책은 §3.2.2, ACP 매핑은 06 §5).
- **replace(전체 교체 의미)**: `tool_call_update`의 `content`/`locations`는 **collection 전체 교체**다(partial append 아님). `plan`도 전체 목록 재전송(교체). 따라서 ACP tool call content는 append하지 말고 마지막 update로 통째 갈아끼운다.
- `tool_call`(신규)과 `tool_call_update`(부분 갱신)는 둘 다 `toolCallId` 기준 upsert이며, update는 바뀐 필드만 온다.

### 3.4 순서 보존과 sequence 부여

- adapter는 provider wire를 받은 **수신 순서를 보존**해 `AgentEvent`를 emit한다.
- provider가 순서를 보장하지 않거나(예: 동시 thread/turn 인터리빙), transport가 재정렬할 수 있는 경우 adapter가 **단조 증가 sequence**를 event에 부여해 store가 안정적으로 정렬·dedup할 수 있게 한다.
- transcript late-attach 신뢰성을 위해, backend transport message에도 PTY와 동일한 seq + snapshot/delta-since 메커니즘을 적용하는 것을 권고한다(15 §8.3, `research/codebase-backend.md` §2.3·§10 권고 3). seq는 후속 단계에서 message payload에 추가한다(현재 계약엔 미포함).

### 3.5 legacy PTY 처리

Legacy PTY output은 전체 agent transcript가 아니라 `terminal_output_delta` event로 보존하고, UI는 legacy/fallback terminal surface에만 렌더링한다. transcript 모델로 끌어올리지 않는다.

---

## 4. pending approval 생명주기

정본 타입: [`15-data-contracts.md`](15-data-contracts.md) §5 (`ApprovalRequest`/`ApprovalOption`/`ApprovalDecision`).

approval은 server→client request이며, **request id로 pending table을 관리**한다.

### 4.1 정상 흐름

1. provider가 approval 요청 → adapter가 `approval_requested{request}` emit. `request.id`는 JSON-RPC `id`(문자열화)이고 `ProviderRef.requestId`에도 보존한다. 세션 상태는 `requires_action`으로 합성(§2).
2. UI가 사용자에게 `options`를 보여주고(`label`은 i18n으로 감싼다), 사용자가 하나 선택.
3. `respondApproval`로 `ApprovalDecision{outcome:"selected", optionId}`를 보낸다. adapter가 provider 응답으로 변환:
   - Codex: `{ id, result: { decision } }` (`jsonrpc` 필드 없음). kind→decision 매핑은 ref-codex §8.1.
   - ACP: `{ jsonrpc:"2.0", id, result: { outcome: { outcome:"selected", optionId } } }` (ref-acp §6).
4. resolve되면 `approval_resolved{decision}` emit, pending table에서 제거, 세션 상태는 `running`으로 복귀.

### 4.2 cancel 시 정리 (불변식)

turn cancel 시 **unresolved approval은 반드시 cancelled로 닫는다**(이때 process는 살아 있으므로 wire `cancelled` 응답을 보낸다). 이는 두 protocol의 MUST와 정확히 대응한다. (process **exit**(process 사망) 경로의 pending 정리는 wire 응답이 불가하므로 `cancelled`가 아니라 `failed`(client 내부 전용)로 닫는다 — §5.0 규칙 1·3.)

- ACP: "Client는 pending된 모든 `session/request_permission`에 `cancelled` outcome으로 **MUST** 응답"(ref-acp §3.8). 즉 cancel 시 모든 pending approval에 `{ outcome: { outcome:"cancelled" } }`를 보낸다.
- Codex: `serverRequest/resolved` notification(`{threadId, requestId}`)을 받으면 해당 `requestId`의 pending approval을 닫는다(다른 경로로 이미 해결됨). turn interrupt 시에도 unresolved를 cancelled로 정리(ref-codex §4.4).

#### cancel cleanup 정본 순서 (규칙 정본)

이 절이 cancel cleanup 순서의 **규칙 정본**이다. `cancelTurn` 호출 또는 `turn_completed{status:"cancelled"}` 수신 시, adapter는 아래 순서를 **그대로** 따른다. **approval cancelled 응답을 provider turn cancel보다 먼저** 보내는 것이 핵심이며(approval을 매단 채로 turn을 끊으면 wire 상에서 응답 없는 pending request가 남는다), 이중 응답과 race를 막기 위해 `closing` 표시 + 멱등 무시를 명문화한다. 타입은 15 §5 정본(`ApprovalDecision`), wire는 ref-* 인용이며 이 문서에서 재정의하지 않는다.

1. **pending을 원자적으로 `closing` 표시**: 해당 turn의 모든 pending approval을 pending table에서 원자적으로 `closing` 상태로 전이한다. `closing`(및 이후 closed)은 그 `requestId`에 대한 추가 응답·resolve를 차단하는 내부 상태이며 wire로 나가지 않는다. 이 원자적 표시가 동시 도착한 사용자 `respondApproval`과 cancel 사이의 이중 응답을 막는다.
2. **cancelled 응답을 wire로 먼저 전송**: `closing`으로 표시한 각 pending approval에 cancelled 응답을 **provider turn cancel보다 먼저** wire로 보낸다.
   - Codex: `{ id, result: { decision: "cancel" } }` (ref-codex §4.1; `jsonrpc` 필드 없음).
   - ACP: `{ jsonrpc:"2.0", id, result: { outcome: { outcome:"cancelled" } } }` (ref-acp §6).
   각 응답 직후 `approval_resolved{decision: ApprovalDecision{outcome:"cancelled"}}`를 emit하고 pending table에서 제거(`closing`→closed)한다.
3. **그 다음 provider turn cancel 전송**: 모든 approval cancelled 응답을 보낸 뒤에 provider turn cancel을 보낸다.
   - Codex: `turn/interrupt` request `{threadId, turnId}` (ref-codex §3.2).
   - ACP: `session/cancel` notification `{sessionId}` (ref-acp §3.8; notification이므로 응답 없음).
4. **늦은 응답 멱등 무시**: cancel 이후 도착하는 늦은 `serverRequest/resolved`(Codex) / `stopReason`(ACP) / 동일 `requestId`에 대한 resolved 응답은, 대상이 이미 `closing`/closed이면 **멱등하게 무시**한다(상태 변경·재emit 없음). 이미 wire로 cancelled를 보낸 requestId에 사용자 응답이 뒤늦게 들어와도 무시한다.

규칙 요약:

1. `cancelTurn` 호출 또는 `turn_completed{status:"cancelled"}` 수신 시, 위 cancel cleanup 정본 순서(1~4)를 따라 해당 turn에 속한 모든 pending approval을 `ApprovalDecision{outcome:"cancelled"}`로 닫고 wire cancelled 응답을 provider turn cancel보다 먼저 보낸다.
2. `process_exited`(및 shutdown) 시 모든 pending approval(및 pending RPC)을 정확히 한 번 멱등 종료한다(§5.0).
3. `serverRequest/resolved`(Codex) 수신 시 해당 requestId만 닫는다(사용자 응답 불필요). cancel cleanup 중/후 도착분은 규칙 4(멱등 무시)를 따른다.
4. `ApprovalDecision.outcome: "failed"`는 client 내부 에러용이며 **wire로 보내지 않는다**(ACP는 selected/cancelled만, Codex도 decision enum만).

> **다운스트림 인용**: 이 순서는 Codex adapter `05 §7.3`, Claude ACP adapter `06 §4.3`, 검증 매트릭스 `14 §5`가 인용·준수하는 **단일 정본**이다. 특히 06 §4.3은 기존에 `session/cancel`을 먼저 보내고 approval을 나중에 닫는 순서였으나, 이 정본에 따라 **approval cancelled 응답 먼저 → `session/cancel` 나중**으로 교정한다.

---

## 5. process exit / 에러 정리

- `process_exited`는 모든 pending request(approval 포함)를 실패로 닫는다 (`07-tauri-process-runtime.md` §Process lifecycle "process exit은 모든 pending request를 실패로 닫는다"). 정확히-한-번 멱등 종료 규칙과 shutdown authoritative cleanup 경계는 **§5.0 정본**.
- `error` event의 `recoverable`은 재시도 가능 여부다. Codex `error.willRetry`→`recoverable`, 그리고 `error.codexErrorInfo`(`usageLimitExceeded`/`contextWindowExceeded` 등)로 코드 분류 가능(ref-codex §6.9·§8). 매핑 불가 항목은 `raw` 보존.
- `turn_completed{status:"failed"}`는 turn 실패이고 세션은 `idle`로 갈 수 있다. 세션 전체 `failed`(systemError)와 구분한다(§2.1 규칙 6).

### 5.0 exit/shutdown pending cleanup 정본 (불변식 — 정확히 한 번 멱등 종료)

이 절이 **exit 또는 shutdown 시 pending 정리의 규칙 정본**이다(S3). exit(process 종료)과 shutdown(세션 종료 요청)은 둘 다 그 시점에 살아 있는 모든 pending approval과 pending RPC를 닫아야 한다. 핵심 불변식은 **각 pending을 정확히 한 번만, 멱등하게 종료**하는 것이다 — 늦게 도착하는 exit·응답·resolve가 이중 종료나 누락을 만들지 않는다. 타입은 15 §5 정본(`ApprovalDecision`), wire는 ref-* 인용이며 이 문서에서 재정의하지 않는다.

규칙:

1. **종료 분류 (정본)**: pending cleanup 시 각 pending은 의미에 따라 닫는다.
   - pending **approval**(server→client request)은: process가 **살아 있는** cancel/shutdown 경로에서는 `outcome:"cancelled"`로 닫고 wire `cancelled` 응답을 보낸다(§4.2); process가 **이미 종료된** exit 경로에서는 wire 응답이 불가하므로 `outcome:"failed"`(client 내부 전용, wire 미전송 — §4.2 규칙 4, 14 process exit, 15 §5)로 닫는다. 어느 쪽이든 `approval_resolved{decision}`를 emit한다.
   - pending **RPC**(client가 보낸 요청의 응답 대기분)는 로컬에서 **failed로 reject**한다. process가 이미 종료됐거나 종료 중이면 wire 응답이 도착하지 않으므로, adapter가 대기 중인 promise/continuation을 실패로 정리한다.

2. **정확히 한 번 · 멱등 (불변식)**: 한 `requestId`(approval 또는 RPC)의 종료는 그 pending의 생애 동안 **정확히 한 번만** 일어난다. 종료 시 pending table에서 제거(또는 closed 표시)하고, 그 `requestId`에 대해 **늦게 도착하는** exit notification·provider 응답·`serverRequest/resolved`(Codex)·`stopReason`(ACP)·동일 `requestId`에 대한 resolve는 대상이 이미 종료/부재이면 **멱등하게 무시**한다(상태 변경·재emit 없음). 이는 §4.2 cancel cleanup의 `closing`/closed 멱등 무시 규칙(§4.2 규칙 4)과 동일한 메커니즘을 exit/shutdown 축으로 확장한 것이다.

3. **exit(process 종료) 경로**: `process_exited`(15 §3, backend `agent-runtime-exit` event 수신) 시 adapter는 그 시점의 **모든** pending approval을 `failed`로(process가 죽어 wire 응답 불가, client 내부 전용), 모든 pending RPC를 failed로 규칙 1·2에 따라 닫는다. 세션 상태는 `exited`로 전이한다(§2.1 규칙 7). backend는 exit event를 알릴 뿐 실제 pending 정리는 frontend adapter가 수행한다(07 §5.3와 일치).

4. **shutdown(세션 종료) 경계 — authoritative cleanup**: `shutdown`(15 §6 Port)은 **authoritative cleanup 경계**다. shutdown은 adapter 측과 backend 측 책임이 분리되며, 순서가 정본이다.
   - **(a) adapter 순서: pending 종료 → backend shutdown await → unlisten/삭제**: adapter는 (process가 살아 있는 동안) 모든 pending approval을 cancelled로 닫고(§4.2) 모든 pending RPC를 로컬에서 failed로 reject한다(규칙 1·2). listener를 **살아 있는 상태로 둔 채** pending을 닫아야 `approval_resolved` emit과 멱등 처리가 정상 동작한다. 그다음 `agent_runtime_shutdown`을 **await**하고((b)에서 reap 후 반환), **반환된 뒤에만** listener를 해제(`subscribeEvents` 해제)하고 세션을 삭제한다. unlisten을 backend shutdown보다 먼저 하면 shutdown 도중의 최종 exit·늦은 응답을 놓친다.
   - **(b) backend shutdown은 reap 후 반환한다**: backend `agent_runtime_shutdown`은 graceful stdin close → timeout → kill → **child reap(`wait`)** 까지 끝낸 뒤 반환한다(07 §5.2/§5.3). 최종 exit이 반영·계상된 후에만 teardown(runtime 제거)이 일어나도록 하여, 늦은 exit으로 인한 pending 누락을 방지한다.
   - **(c) 멱등 합류**: shutdown 경로의 adapter 측 pending 종료(a)와 exit event 경로(규칙 3)는 같은 pending을 가리킬 수 있다. 규칙 2의 정확히-한-번 멱등 불변식에 의해 어느 쪽이 먼저 닫든 **두 번 닫히지 않고 누락되지도 않는다**.

> **다운스트림 인용**: 이 정리 규칙은 Codex adapter `05`(adapter shutdown이 unlisten·세션 삭제 전에 pending을 닫음)·Claude ACP adapter `06`(동형)·`07 §5.2`(shutdown이 reap 후 반환, authoritative cleanup 경계)·검증 매트릭스 `14`(shutdown 시퀀스 순서/멱등 노트)가 인용·준수하는 **단일 정본**이다. exit·shutdown pending cleanup의 정확히-한-번 멱등 종료 테스트는 11에 추가한다.

### 5.1 미지원/unknown server request·notification 응답 규칙 (불변식)

provider server→client 메시지 중 **`id`가 있는 REQUEST**(응답을 기대하는 요청)와 **`id`가 없는 NOTIFICATION**(응답 불필요)은 처리 규칙이 다르다. 둘 다 unknown/미지원 method일 때 **silent-drop을 금지**한다 — 이유가 다르다. unknown notification을 버리면 transcript가 조용히 비고, unknown **request**를 버리면 provider가 응답을 영원히 기다리며 turn이 **deadlock**된다. request vs notification 구분 규칙은 ref-codex §1.2(`id` 유무)·ref-acp §1을 따른다.

규칙:

1. **미지원/unknown server REQUEST(`id` 있음)에는 반드시 응답한다 (MUST).** adapter가 해석할 수 없거나 v1이 지원하지 않는 method를 `id`와 함께 받으면, 무응답으로 폐기하지 말고 다음 중 하나를 **반드시** wire로 보낸다:
   - **JSON-RPC error 응답** — `{ id, error: { code: -32601, message: "Method not found" } }`(method 미지원 시). ACP는 `-32601`이 verified error code다(ref-acp §11). Codex도 `JSONRPCError` 형태(`{ id, error: { code, message, data? } }`)를 request 실패 응답으로 받는다(ref-codex §1.2, `jsonrpc` 필드 없음). 매핑/파싱 실패류는 `-32602`(invalid params)·`-32603`(internal error)을 쓸 수 있다.
   - **명시적 decline/cancel 응답** — approval류 server request처럼 도메인 의미가 있는 미지원 request는 error 대신 명시적 거부 응답으로 닫는다. Codex permission-profile escalation(`item/permissions/requestApproval`)은 v1 기본값(D12)으로 **자동 decline**하고 원본은 `raw` 보존한다(13 OQ-19, ref-codex §4.3). decline/cancel 응답에 쓰는 원본 JSON-RPC `id`는 **타입(`string|number`)을 보존**해 매칭 실패를 막는다(05 §6 CodexRouting id 타입 복원).
   - 어느 경로든 응답을 보낸 뒤 해당 `requestId`의 pending 항목을 닫는다. **응답 없는 폐기는 금지**다(provider 영구 대기 방지).

2. **unknown NOTIFICATION(`id` 없음)은 응답하지 않되 가시화한다.** 응답이 불필요하므로 wire 응답을 보내지 않는다. 대신 원본 payload를 `ProviderRef.raw`(또는 metadata)에 **보존**하고 unknown-method counter를 증가시켜 telemetry/로그로 가시화한다(13 RD-10·위험 1.1, 15 §0.2). transcript에서 조용히 사라지지 않게 한다.

3. unknown variant 전반의 **silent-drop 금지 원칙**은 13 RD-10(`raw` 보존 + 로그/카운터)이 단일 정본이며, 위 1·2는 그 원칙을 server request/notification 축으로 구체화한 것이다. 타입은 15 §0.2·§5 정본을, wire(error code·decision enum)는 ref-acp §11 / ref-codex §1.2·§4를 인용하며 이 문서에서 재정의하지 않는다.

> **다운스트림 인용**: 이 규칙은 Codex adapter `05 §7.1`(default 분기에서 `routing.resolveApproval` 후 `return []`로 끝내지 말고, unknown server request에 JSON-RPC error/unsupported 또는 명시적 decline 응답을 **먼저** 보낸다)과 Claude ACP adapter `06`(parity로 미지원 server request에 error/decline 응답)이 인용·준수한다. unknown-request 응답 테스트는 11에 추가한다.

---

## 6. 교차 참조

| 대상 | 문서 |
|---|---|
| 모든 normalized 타입 정의(정본) | [`15-data-contracts.md`](15-data-contracts.md) §1–§5 |
| Agent Runtime Port·persistence·Tauri 계약(정본) | [`15-data-contracts.md`](15-data-contracts.md) §6–§8 |
| Codex wire → normalized 매핑·reconcile 근거 | [`ref-codex-app-server-protocol.md`](ref-codex-app-server-protocol.md) §6, §7, §8 |
| ACP wire → normalized 매핑·chunk/replace 근거 | [`ref-acp-protocol.md`](ref-acp-protocol.md) §4, §5, §6, §13 |
| unknown/미지원 server request·notification 응답(silent-drop 금지) | §5.1, [`13-risks-open-questions.md`](13-risks-open-questions.md) RD-10, [`ref-acp-protocol.md`](ref-acp-protocol.md) §11, [`ref-codex-app-server-protocol.md`](ref-codex-app-server-protocol.md) §1.2, §4 |
| exit/shutdown pending cleanup(정확히 한 번 멱등 종료·authoritative 경계) | §5.0, [`07-tauri-process-runtime.md`](07-tauri-process-runtime.md) §5.2, §5.3 |
| hexagonal 구조·Store/Router 역할 | [`03-target-architecture.md`](03-target-architecture.md) |
| process lifecycle·cancel·framing | [`07-tauri-process-runtime.md`](07-tauri-process-runtime.md) |
| persistence·resume/load 정책 | [`10-persistence-migration.md`](10-persistence-migration.md) |

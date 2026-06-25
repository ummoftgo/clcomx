# Reference: OpenAI Codex app-server protocol

> 이 문서는 CLCOMX `agent-direct-runtime` 어댑터 구현을 위해 OpenAI Codex의 **app-server protocol**을 1차 소스(공식 저장소)에서 wire 수준으로 정리한 레퍼런스다.
> 다운스트림 구현 에이전트가 이 문서만 읽고도 Codex app-server 어댑터를 만들 수 있도록, method/notification 카탈로그 + 대표 payload JSON + CLCOMX normalized model(`04-normalized-agent-model.md`) 매핑을 포함한다.

## 0. 버전 핀과 출처

| 항목 | 값 |
| --- | --- |
| 저장소 | https://github.com/openai/codex |
| pinned git ref (tag) | `rust-v0.142.0` |
| 로컬 CLI 확인 | `codex-cli 0.142.0` (`codex --version` 실행 결과, app-server protocol과 동일 버전) |
| 핵심 crate 경로 | `codex-rs/app-server-protocol` |

`rust-v0.142.0` 태그는 실제로 존재하며(`gh api repos/openai/codex/git/refs/tags`로 확인), 로컬에 설치된 `codex` 0.142.0과 일치한다. 본 문서의 모든 타입은 이 태그의 소스에서 직접 읽었다. 파일 경로와 줄 인용은 `rust-v0.142.0` 기준이다.

**Protocol 버전 주의**: app-server-protocol에는 레거시 `v1`과 현행 `v2`가 공존한다. `initialize`만 v1 타입을 쓰고, thread/turn/item 기반의 현행 표면은 전부 `protocol/v2`에 정의된다. CLCOMX 어댑터는 **v2 (thread/turn/item) 모델**을 대상으로 해야 한다. 이 문서는 v2를 중심으로 기술한다.

### 읽은 소스 파일 (모두 `rust-v0.142.0`)

| 파일 | 역할 |
| --- | --- |
| `codex-rs/app-server-protocol/src/jsonrpc_lite.rs` | JSON-RPC 프레이밍(RequestId, JSONRPCMessage 등) |
| `codex-rs/app-server-protocol/schema/typescript/ClientRequest.ts` | client→server **request** method 카탈로그(생성 산출물) |
| `codex-rs/app-server-protocol/schema/typescript/ServerNotification.ts` | server→client **notification** method 카탈로그(생성 산출물) |
| `codex-rs/app-server-protocol/schema/typescript/ServerRequest.ts` | server→client **request**(approval/elicitation) 카탈로그 |
| `codex-rs/app-server-protocol/schema/typescript/ClientNotification.ts` | client→server **notification** 카탈로그 |
| `codex-rs/app-server-protocol/src/protocol/v2/thread.rs` | thread lifecycle params/response/notification |
| `codex-rs/app-server-protocol/src/protocol/v2/turn.rs` | turn start/steer/interrupt, turn notifications |
| `codex-rs/app-server-protocol/src/protocol/v2/item.rs` | `ThreadItem` 분류, item 진행/완료 notification, approval params |
| `codex-rs/app-server-protocol/src/protocol/v2/thread_data.rs` | `Thread`, `Turn`, `TurnError` 등 핵심 구조체 |
| `codex-rs/app-server-protocol/src/protocol/v2/command_exec.rs` | standalone `command/exec` 표면 |
| `codex-rs/app-server-protocol/src/protocol/v2/permissions.rs` | permissions approval params/response |
| `codex-rs/app-server-protocol/src/protocol/v2/shared.rs` | `AskForApproval`, `SandboxMode`, `ApprovalsReviewer`, `TurnError` 관련 |
| `codex-rs/app-server-protocol/src/protocol/v2/notification.rs` | `ErrorNotification`, `ServerRequestResolvedNotification` 등 |

---

## 1. Transport와 JSON-RPC 프레이밍

### 1.1 실행 방법 (CLI)

로컬 `codex app-server --help`(0.142.0) 실행 결과 인용:

```
[experimental] Run the app server or related tooling

Usage: codex app-server [OPTIONS] [COMMAND]

Commands:
  daemon                Manage the local app-server daemon
  proxy                 Proxy stdio bytes to the running app-server control socket
  generate-ts           [experimental] Generate TypeScript bindings for the app server protocol
  generate-json-schema  [experimental] Generate JSON Schema for the app server protocol
  help

Options:
      --listen <URL>    Transport endpoint URL. Supported values:
                        `stdio://` (default), `unix://`, `unix://PATH`, `ws://IP:PORT`, `off`
                        [default: stdio://]
      --stdio           Use stdio as the transport (equivalent to `--listen stdio://`)
  -c, --config <key=value>
      --enable <FEATURE>   Enable a feature (= `-c features.<name>=true`)
      --disable <FEATURE>
      --strict-config
```

- **권장 기동**: `codex app-server` (기본 `stdio://`) 또는 명시적으로 `codex app-server --stdio`.
- app-server 자체가 `[experimental]`로 표시되지만 별도 experimental 플래그 없이 동작한다. 단, protocol 내 일부 *필드/메서드*는 experimental gating이 있고(아래 1.4), client가 `initialize.capabilities`로 opt-in 해야 노출된다.
- **TS/JSON schema 생성**: `codex app-server generate-ts --out <DIR> [--experimental]`, `codex app-server generate-json-schema --out <DIR>`. `--experimental` 플래그를 줘야 experimental method/field가 생성물에 포함된다 (`generate-ts --help` 실행 결과 확인).

> 인용 위 두 블록은 로컬 `codex app-server --help` / `codex app-server generate-ts --help` (codex-cli 0.142.0) 실행 결과다.

### 1.2 JSON-RPC 변형

`src/jsonrpc_lite.rs` 모듈 주석(verified):

> "We do not do true JSON-RPC 2.0, as we neither send nor expect the `\"jsonrpc\": \"2.0\"` field."

즉 **`jsonrpc` 필드를 보내지도, 기대하지도 않는다.** 줄바꿈 구분(line-delimited) JSON 객체를 stdio로 주고받는다. 메시지 종류(`JSONRPCMessage`, `#[serde(untagged)]`)는 네 가지:

| 타입 | 필수 필드 | 비고 |
| --- | --- | --- |
| `JSONRPCRequest` | `id`, `method`, (옵션 `params`, `trace`) | response를 기대 |
| `JSONRPCNotification` | `method`, (옵션 `params`) | response 없음 |
| `JSONRPCResponse` | `id`, `result` | request 성공 응답 |
| `JSONRPCError` | `id`, `error: { code: number, message: string, data?: any }` | request 실패 응답 |

`RequestId`는 `string | number` (untagged union; `src/jsonrpc_lite.rs`).

### 1.3 메시지 라우팅 키

- **request/response 매칭**: `id`. client→server, server→client 양방향 모두 같은 규칙.
- **이벤트 라우팅**: notification은 `id`가 없으며, payload 안의 `threadId` / `turnId` / `itemId`로 라우팅한다(섹션 5).
- server→client **request**(approval 등)에 응답할 때는 동일한 `id`를 가진 `JSONRPCResponse`를 돌려준다(섹션 4).

### 1.4 Experimental gating

많은 v2 필드/메서드가 `#[experimental("...")]`로 표시된다. 기본 schema 생성 및 비-experimental client에는 노출되지 않는다. CLCOMX 어댑터는 안정 필드만 의존하고, experimental 필드는 `ProviderRef.raw`에 보존하는 전략을 권장한다. 본 카탈로그에서 experimental 항목은 표시한다.

---

## 2. Lifecycle: initialize

### 2.1 `initialize` (client→server request)

- method: `"initialize"`
- params 타입: `InitializeParams` (레거시 v1; `schema/typescript/InitializeParams.ts`)
- result 타입: `InitializeResponse`

`InitializeParams` (verified, `schema/typescript/InitializeParams.ts`):

```ts
type InitializeParams = {
  clientInfo: ClientInfo,
  capabilities: InitializeCapabilities | null,
};
```

`InitializeResponse` (verified, `schema/typescript/InitializeResponse.ts`):

```ts
type InitializeResponse = {
  userAgent: string,
  codexHome: string,        // 절대경로, 서버의 $CODEX_HOME
  platformFamily: string,   // 예: "unix" | "windows"
  platformOs: string,       // 예: "macos" | "linux" | "windows"
};
```

대표 요청 JSON:

```json
{ "id": 1, "method": "initialize",
  "params": { "clientInfo": { "name": "clcomx", "version": "0.5.6" }, "capabilities": null } }
```

### 2.2 `initialized` (client→server notification)

- method: `"initialized"`, params 없음 (verified, `schema/typescript/ClientNotification.ts`):

```ts
type ClientNotification = { "method": "initialized" };
```

핸드셰이크 순서(권장): `initialize` request → `initialize` response 수신 → `initialized` notification 전송. 그 후 thread/turn 호출.

> `ClientInfo` / `InitializeCapabilities`의 정확한 필드는 본 조사에서 개별 파일을 끝까지 읽지 않았다. `clientInfo`는 최소 `name`/`version` 형태로 보이지만 **unverified** — 구현 시 `schema/typescript/ClientInfo.ts`, `InitializeCapabilities.ts`를 확인할 것(openQuestions 참조).

---

## 3. Method 카탈로그 (client→server requests)

아래는 `schema/typescript/ClientRequest.ts`(생성 산출물, verified)의 `method` 태그 전체 목록이다. 모든 항목은 `{ "method": <name>, "id": RequestId, "params": <ParamsType> }` 형태. CLCOMX 어댑터가 실제로 쓸 핵심만 굵게 표시.

### 3.1 Thread lifecycle

| method | params 타입 | 비고 |
| --- | --- | --- |
| **`thread/start`** | `ThreadStartParams` | 새 thread 생성. result `ThreadStartResponse` |
| **`thread/resume`** | `ThreadResumeParams` | 기존 thread 재개. result `ThreadResumeResponse` |
| `thread/fork` | `ThreadForkParams` | |
| `thread/archive` | `ThreadArchiveParams` | |
| `thread/delete` | `ThreadDeleteParams` | |
| `thread/unsubscribe` | `ThreadUnsubscribeParams` | 이 connection의 notification 구독 해제 |
| `thread/name/set` | `ThreadSetNameParams` | |
| `thread/goal/set` `thread/goal/get` `thread/goal/clear` | `ThreadGoal*Params` | |
| `thread/metadata/update` | `ThreadMetadataUpdateParams` | |
| `thread/unarchive` | `ThreadUnarchiveParams` | |
| `thread/compact/start` | `ThreadCompactStartParams` | 컨텍스트 압축 |
| `thread/shellCommand` | `ThreadShellCommandParams` | |
| `thread/approveGuardianDeniedAction` | `ThreadApproveGuardianDeniedActionParams` | |
| `thread/rollback` | `ThreadRollbackParams` | |
| `thread/list` | `ThreadListParams` | result `ThreadListResponse` |
| `thread/loaded/list` | `ThreadLoadedListParams` | 현재 메모리에 로드된 thread |
| **`thread/read`** | `ThreadReadParams` | `{ threadId, includeTurns? }`, result `{ thread: Thread }` |
| `thread/inject_items` | `ThreadInjectItemsParams` | ⚠️ 다른 메서드가 `path/like` camelCase인데 이 메서드만 `inject_items` (snake) — `ClientRequest.ts` 그대로 |

### 3.2 Turn

| method | params 타입 | result |
| --- | --- | --- |
| **`turn/start`** | `TurnStartParams` | `TurnStartResponse` `{ turn: Turn }` |
| `turn/steer` | `TurnSteerParams` | `TurnSteerResponse` `{ turnId }` (진행 중 turn에 입력 추가) |
| **`turn/interrupt`** | `TurnInterruptParams` `{ threadId, turnId }` | `TurnInterruptResponse` `{}` (cancel) |
| `review/start` | `ReviewStartParams` | code review 모드 |

### 3.3 standalone command exec (thread/turn 없이 sandbox 실행)

| method | params | 비고 |
| --- | --- | --- |
| `command/exec` | `CommandExecParams` | argv 실행. 최종 response는 프로세스 종료 후 |
| `command/exec/write` | `CommandExecWriteParams` | stdin 쓰기/닫기 (`processId` 필요) |
| `command/exec/terminate` | `CommandExecTerminateParams` | |
| `command/exec/resize` | `CommandExecResizeParams` | PTY 크기 변경 |

### 3.4 기타 (CLCOMX MVP 범위 밖이지만 참고)

`skills/*`, `hooks/list`, `marketplace/*`, `plugin/*`, `app/list`, `fs/*`(readFile/writeFile/createDirectory/getMetadata/readDirectory/remove/copy/watch/unwatch), `model/list`, `modelProvider/capabilities/read`, `experimentalFeature/*`, `permissionProfile/list`, `mcpServer/oauth/login`, `mcpServer/resource/read`, `mcpServer/tool/call`, `mcpServerStatus/list`, `config/mcpServer/reload`, `windowsSandbox/setupStart`(params `WindowsSandboxSetupStartParams`), `windowsSandbox/readiness`(params 없음), `account/*`(login/start, login/cancel, logout, rateLimits/read, usage/read, read, …), `feedback/upload`, `config/read`, `config/value/write`, `config/batchWrite`, `configRequirements/read`, `externalAgentConfig/*`.

레거시 v1 호환 메서드(camelCase, 슬래시 없음): `getConversationSummary`, `gitDiffToRemote`, `getAuthStatus`, `fuzzyFileSearch`.

---

## 4. Server→client requests (approval / elicitation)

`schema/typescript/ServerRequest.ts`(verified). server가 `id`를 붙여 보내며, client는 동일 `id`로 `JSONRPCResponse`를 돌려준다. 각 항목 `{ "method": <name>, "id": RequestId, "params": <ParamsType> }`.

| method | params | response 타입 | direction |
| --- | --- | --- | --- |
| **`item/commandExecution/requestApproval`** | `CommandExecutionRequestApprovalParams` | `CommandExecutionRequestApprovalResponse` `{ decision }` | agent→client |
| **`item/fileChange/requestApproval`** | `FileChangeRequestApprovalParams` | `FileChangeRequestApprovalResponse` `{ decision }` | agent→client |
| `item/tool/requestUserInput` | `ToolRequestUserInputParams` | `ToolRequestUserInputResponse` `{ answers }` | EXPERIMENTAL |
| `mcpServer/elicitation/request` | `McpServerElicitationRequestParams` | `McpServerElicitationRequestResponse` | MCP elicitation |
| `item/permissions/requestApproval` | `PermissionsRequestApprovalParams` | `PermissionsRequestApprovalResponse` | sandbox/permission 상승 |
| `item/tool/call` | `DynamicToolCallParams` | `DynamicToolCallResponse` | dynamic tool 위임 |
| `account/chatgptAuthTokens/refresh` | `ChatgptAuthTokensRefreshParams` | … | auth |
| `attestation/generate` | `AttestationGenerateParams` | … | |
| `applyPatchApproval` | `ApplyPatchApprovalParams` | `ApplyPatchApprovalResponse` | 레거시 v1 |
| `execCommandApproval` | `ExecCommandApprovalParams` | `ExecCommandApprovalResponse` | 레거시 v1 |

### 4.1 Command 실행 approval

`CommandExecutionRequestApprovalParams` (verified, `item.rs:1324`):

```jsonc
{
  "threadId": "...", "turnId": "...", "itemId": "...",
  "startedAtMs": 1719300000000,
  "approvalId": null,            // zsh-exec-bridge 서브커맨드일 때만 UUID로 라우팅 분기
  "environmentId": null,         // string | null (옵셔널 키 아님 — 항상 존재)
  "reason": "network access required",
  "networkApprovalContext": null, // 옵션, managed-network approval prompt context (NetworkApprovalContext)
  "command": "curl https://...",
  "cwd": "/repo",
  "commandActions": [ /* CommandAction[] */ ],
  "proposedExecpolicyAmendment": null,
  "proposedNetworkPolicyAmendments": null
  // experimental: additionalPermissions, availableDecisions
}
```

응답 `CommandExecutionRequestApprovalResponse` (verified):

```json
{ "decision": "accept" }
```

`CommandExecutionApprovalDecision` (verified, `item.rs:48`) — serde `camelCase`:
`accept` | `acceptForSession` | `acceptWithExecpolicyAmendment` (변형: `{ "acceptWithExecpolicyAmendment": { "execpolicyAmendment": ... } }`) | `applyNetworkPolicyAmendment` | `decline`(턴 계속) | `cancel`(턴 즉시 중단).

> ⚠️ `accept`/`acceptForSession`/`decline`/`cancel`은 단위 enum이라 문자열 그대로 직렬화되지만, `acceptWithExecpolicyAmendment`와 `applyNetworkPolicyAmendment`는 **데이터를 가진 variant**라서 외부 태그 객체로 직렬화된다. CLCOMX는 단순 4종(accept/acceptForSession/decline/cancel)만 보내는 것을 권장.

### 4.2 File change approval

`FileChangeRequestApprovalParams` (verified, `item.rs:1403`): `{ threadId, turnId, itemId, startedAtMs, reason?, grantRoot? }`.
응답: `{ "decision": <FileChangeApprovalDecision> }`. `FileChangeApprovalDecision`(verified, `item.rs:94`): `accept` | `acceptForSession` | `decline` | `cancel`.

### 4.3 Permissions approval

`PermissionsRequestApprovalParams` (verified, `permissions.rs:743`): `{ threadId, turnId, itemId, environmentId?, startedAtMs, cwd, reason?, permissions: RequestPermissionProfile }`.
응답 `PermissionsRequestApprovalResponse`: `{ permissions: GrantedPermissionProfile, scope: "turn"|"session", strictAutoReview? }`.

### 4.4 `serverRequest/resolved` notification

server→client **notification** `serverRequest/resolved` (`ServerRequestResolvedNotification`, verified, `notification.rs`): `{ threadId, requestId }`. server가 보낸 approval request가 (다른 경로로) 해결되어 더 이상 응답이 필요 없을 때 알려준다. CLCOMX는 이 notification을 받으면 해당 `requestId`의 pending approval을 닫아야 한다 (04 문서의 "turn cancel 시 unresolved request를 cancelled로 닫는다" 규칙과 연동).

---

## 5. Notification 카탈로그 (server→client)

`schema/typescript/ServerNotification.ts`(verified). 각 항목 `{ "method": <name>, "params": <ParamsType> }` (id 없음).

### 5.1 Thread/turn lifecycle

| method | params | 핵심 필드 |
| --- | --- | --- |
| `error` | `ErrorNotification` | `{ error: TurnError, willRetry, threadId, turnId }` |
| **`thread/started`** | `ThreadStartedNotification` | `{ thread: Thread }` |
| **`thread/status/changed`** | `ThreadStatusChangedNotification` | `{ threadId, status: ThreadStatus }` |
| `thread/archived` `thread/deleted` `thread/unarchived` `thread/closed` | `Thread*Notification` | `{ threadId }` |
| `thread/name/updated` | `ThreadNameUpdatedNotification` | `{ threadId, threadName? }` |
| `thread/goal/updated` `thread/goal/cleared` | … | |
| `thread/settings/updated` | `ThreadSettingsUpdatedNotification` | |
| **`thread/tokenUsage/updated`** | `ThreadTokenUsageUpdatedNotification` | `{ threadId, turnId, tokenUsage: ThreadTokenUsage }` — `ThreadTokenUsage`/`TokenUsageBreakdown` 정확한 형태는 6.7 |
| `thread/compacted` | `ContextCompactedNotification` | `{ threadId, turnId, ... }` (deprecated; `ContextCompaction` item 선호) |
| **`turn/started`** | `TurnStartedNotification` | `{ threadId, turn: Turn }` |
| **`turn/completed`** | `TurnCompletedNotification` | `{ threadId, turn: Turn }` |
| `turn/diff/updated` | `TurnDiffUpdatedNotification` | `{ threadId, turnId, diff }` (턴 누적 통합 diff) |
| `turn/plan/updated` | `TurnPlanUpdatedNotification` | `{ threadId, turnId, explanation: string\|null, plan: TurnPlanStep[] }` — `TurnPlanStep` 정확한 형태는 6.8 |
| `turn/moderationMetadata` | `TurnModerationMetadataNotification` | |
| `hook/started` `hook/completed` | `Hook*Notification` | |

### 5.2 Item lifecycle + 진행(delta)

| method | params | 핵심 필드 |
| --- | --- | --- |
| **`item/started`** | `ItemStartedNotification` | `{ item: ThreadItem, threadId, turnId, startedAtMs }` |
| **`item/completed`** | `ItemCompletedNotification` | `{ item: ThreadItem, threadId, turnId, completedAtMs }` |
| `item/autoApprovalReview/started` `item/autoApprovalReview/completed` | `ItemGuardianApprovalReview*Notification` | UNSTABLE |
| `rawResponseItem/completed` | `RawResponseItemCompletedNotification` | `{ threadId, turnId, item: ResponseItem }` (내부용; JSON schema 제외) |
| **`item/agentMessage/delta`** | `AgentMessageDeltaNotification` | `{ threadId, turnId, itemId, delta }` |
| `item/plan/delta` | `PlanDeltaNotification` | `{ threadId, turnId, itemId, delta }` EXPERIMENTAL |
| `item/reasoning/textDelta` | `ReasoningTextDeltaNotification` | `{ ..., itemId, delta, contentIndex }` |
| `item/reasoning/summaryTextDelta` | `ReasoningSummaryTextDeltaNotification` | `{ ..., itemId, delta, summaryIndex }` |
| `item/reasoning/summaryPartAdded` | `ReasoningSummaryPartAddedNotification` | `{ ..., itemId, summaryIndex }` |
| **`item/commandExecution/outputDelta`** | `CommandExecutionOutputDeltaNotification` | `{ threadId, turnId, itemId, delta }` (delta는 평문 문자열) |
| `item/commandExecution/terminalInteraction` | `TerminalInteractionNotification` | `{ ..., itemId, processId, stdin }` |
| `item/fileChange/outputDelta` | `FileChangeOutputDeltaNotification` | deprecated, 더 이상 emit 안 함 |
| `item/fileChange/patchUpdated` | `FileChangePatchUpdatedNotification` | `{ ..., itemId, changes: FileUpdateChange[] }` |
| `item/mcpToolCall/progress` | `McpToolCallProgressNotification` | |

### 5.3 standalone `command/exec` 스트리밍 (thread와 무관)

| method | params | 핵심 필드 |
| --- | --- | --- |
| `command/exec/outputDelta` | `CommandExecOutputDeltaNotification` | `{ processId, stream: "stdout"\|"stderr", deltaBase64, capReached }` |
| `process/outputDelta` | `ProcessOutputDeltaNotification` | |
| `process/exited` | `ProcessExitedNotification` | |

> ⚠️ thread 안의 명령 출력은 `item/commandExecution/outputDelta`(평문 `delta`)이고, standalone `command/exec`의 출력은 `command/exec/outputDelta`(**base64** `deltaBase64`)다. 둘은 다른 채널이다.

### 5.4 기타 notification

`skills/changed`, `mcpServer/oauthLogin/completed`, `mcpServer/startupStatus/updated`, `account/updated`, `account/rateLimits/updated`, `account/login/completed`, `app/list/updated`, `remoteControl/status/changed`, `externalAgentConfig/import/progress|completed`, `fs/changed`, `model/rerouted`, `model/verification`, `model/safetyBuffering/updated`, `warning`, `guardianWarning`, `deprecationNotice`, `configWarning`, `fuzzyFileSearch/sessionUpdated|sessionCompleted`, `thread/realtime/started`, `thread/realtime/itemAdded`, `thread/realtime/transcript/delta`, `thread/realtime/transcript/done`, `thread/realtime/outputAudio/delta`, `thread/realtime/sdp`, `thread/realtime/error`, `thread/realtime/closed`(전부 슬래시 구분 — `ServerNotification.ts` @ `rust-v0.142.0` 확인), `windows/worldWritableWarning`, `windowsSandbox/setupCompleted`.

---

## 6. 핵심 타입

### 6.1 `Thread` (verified, `thread_data.rs:135`)

```jsonc
{
  "id": "string",
  "sessionId": "string",          // 같은 세션 트리 공유
  "forkedFromId": null,
  "parentThreadId": null,         // subagent일 때만
  "preview": "first user message",
  "ephemeral": false,
  "modelProvider": "openai",
  "createdAt": 1719300000,         // unix sec
  "updatedAt": 1719300100,
  "recencyAt": null,
  "status": { "type": "idle" },    // ThreadStatus, tagged
  "path": "/path/to/rollout",
  "cwd": "/abs/cwd",
  "cliVersion": "0.142.0",
  "source": "vscode",              // SessionSource
  "threadSource": null,
  "agentNickname": null, "agentRole": null,
  "gitInfo": { "sha": null, "branch": null, "originUrl": null },
  "name": null,
  "turns": []                       // resume/rollback/fork/read(includeTurns)에서만 채워짐
}
```

`ThreadStatus` (verified, tagged `type`, `thread.rs:1232`):
`{ "type": "notLoaded" }` | `{ "type": "idle" }` | `{ "type": "systemError" }` | `{ "type": "active", "activeFlags": ["waitingOnApproval"|"waitingOnUserInput"] }`.

### 6.2 `Turn` (verified, `thread_data.rs:188`)

```jsonc
{
  "id": "string",
  "items": [ /* ThreadItem[] */ ],
  "itemsView": "full",            // "notLoaded" | "summary" | "full"
  "status": "completed",          // TurnStatus: completed|interrupted|failed|inProgress
  "error": null,                   // TurnError, status=failed 일 때만
  "startedAt": 1719300000,
  "completedAt": 1719300050,
  "durationMs": 50000
}
```

`TurnError` (verified, `thread_data.rs`): `{ message: string, codexErrorInfo?: CodexErrorInfo, additionalDetails?: string }`. `CodexErrorInfo`의 정확한 variant 목록은 6.9.

### 6.3 `ThreadItem` (verified, `item.rs:215`) — 내부 태그 `type` (camelCase)

모든 variant는 `id: string`을 갖는다. 주요 variant:

| `type` | 핵심 필드 | CLCOMX 매핑 후보 |
| --- | --- | --- |
| `userMessage` | `clientId?`, `content: UserInput[]` | `user_message` |
| `agentMessage` | `text`, `phase?`, `memoryCitation?` | `agent_message` (delta는 `item/agentMessage/delta`) |
| `reasoning` | `summary: string[]`, `content: string[]` | `agent_message`(thought) 또는 별도 |
| `plan` | `text` (EXPERIMENTAL) | `plan_updated` 보조 |
| `commandExecution` | `command`, `cwd`, `processId?`, `source`, `status`, `commandActions`, `aggregatedOutput?`, `exitCode?`, `durationMs?` | `tool_call_updated`(kind=execute) + `command_output_delta` |
| `fileChange` | `changes: FileUpdateChange[]`, `status: PatchApplyStatus` | `file_change_updated` / `tool_call_updated`(kind=edit) |
| `mcpToolCall` | `server`, `tool`, `status`, `arguments`, `appContext?`, `result?`, `error?`, `durationMs?` | `tool_call_updated`(kind=other/fetch) |
| `dynamicToolCall` | `namespace?`, `tool`, `arguments`, `status`, `contentItems?`, `success?` | `tool_call_updated` |
| `webSearch` | `query`, `action?` | `tool_call_updated`(kind=fetch) |
| `collabAgentToolCall` | `tool`, `status`, `senderThreadId`, `receiverThreadIds`, … | (멀티에이전트, MVP 밖) |
| `subAgentActivity` | `kind`, `agentThreadId`, `agentPath` | (멀티에이전트) |
| `imageView` | `path` | `agent_message`(image content) |
| `imageGeneration` | `status`, `revisedPrompt?`, `result`, `savedPath?` | |
| `sleep` | `durationMs` | |
| `enteredReviewMode` / `exitedReviewMode` | `review` | |
| `contextCompaction` | — | |
| `hookPrompt` | `fragments` | |

`FileUpdateChange` (verified): `{ path, kind: PatchChangeKind, diff }`. `PatchChangeKind`(tagged `type`): `{type:"add"}` | `{type:"delete"}` | `{type:"update", movePath?}`.

Item 상태 enum(serde camelCase, verified):
- `CommandExecutionStatus`: `inProgress` | `completed` | `failed` | `declined`
- `PatchApplyStatus`: `inProgress` | `completed` | `failed` | `declined`
- `McpToolCallStatus` / `DynamicToolCallStatus`: `inProgress` | `completed` | `failed`

### 6.4 `UserInput` (verified, `turn.rs`) — tagged `type` (camelCase)

`{type:"text", text, text_elements}` | `{type:"image", url, detail?}` | `{type:"localImage", path, detail?}` | `{type:"skill", name, path}` | `{type:"mention", name, path}`.

> `text` variant의 스팬 필드 실제 wire 키는 `text_elements`(snake_case, 타입 `TextElement[]`, 필수)다 — camelCase가 아님에 주의. `image`/`localImage`의 `detail`(`ImageDetail`)은 옵셔널. (`schema/typescript/v2/UserInput.ts` @ `rust-v0.142.0`. enum 값은 6.6)

### 6.5 `TurnStartParams` (verified, `turn.rs`) — 안정 필드 발췌

```jsonc
{
  "threadId": "string",
  "input": [ { "type": "text", "text": "hello" } ],
  "clientUserMessageId": null,       // 옵션
  "cwd": null,                        // 옵션
  "approvalsReviewer": null,          // "user" | "auto_review"
  "sandboxPolicy": null,
  "model": null, "effort": null, "summary": null, "personality": null,
  "outputSchema": null
  // experimental: responsesapiClientMetadata, additionalContext, environments,
  //   runtimeWorkspaceRoots, approvalPolicy, permissions, collaborationMode, multiAgentMode
}
```

`ThreadStartParams`(verified, `thread.rs:55`) 안정 필드: `model?`, `modelProvider?`, `serviceTier?`, `cwd?`, `approvalsReviewer?`, `sandbox?`(`SandboxMode`: `read-only`|`workspace-write`|`danger-full-access`, kebab-case), `config?`, `serviceName?`, `baseInstructions?`, `developerInstructions?`, `personality?`, `ephemeral?`, `sessionStartSource?`, `threadSource?`. 다수는 experimental.

`AskForApproval`(verified, `shared.rs`, **kebab-case**): `untrusted` | `on-failure` | `on-request` | `never` | `granular`(experimental, 데이터 variant). `ApprovalsReviewer`(verified): `"user"` | `"auto_review"`(legacy alias `"guardian_subagent"`).

> 주의: `TurnStartParams`의 approval 정책 필드 실제 키는 `approvalPolicy`(타입 `AskForApproval`)다. 위 6.5 예시의 주석은 `approvalsReviewer`(routing)와 별개. `serviceTier`/`sandboxPolicy`(`SandboxPolicy`, `SandboxMode`와 다른 타입)는 안정 필드이며 `effort`/`summary`/`personality`/`outputSchema`도 안정 필드다. (`schema/typescript/v2/TurnStartParams.ts` @ `rust-v0.142.0`)

### 6.6 `TurnStartParams` option enum 값 (verified)

아래는 6.5의 옵션 override 필드들이 받는 구체 값이다. 모두 `rust-v0.142.0`의 생성 TS에서 직접 읽음.

- `ImageDetail`(verified, `schema/typescript/ImageDetail.ts`) — `UserInput`의 `image`/`localImage` variant `detail`에 사용: `"auto"` | `"low"` | `"high"` | `"original"`.
- `Personality`(verified, `schema/typescript/Personality.ts`): `"none"` | `"friendly"` | `"pragmatic"`.
- `ReasoningSummary`(verified, `schema/typescript/ReasoningSummary.ts`): `"auto"` | `"concise"` | `"detailed"` | `"none"`.
- `ReasoningEffort`(verified, `schema/typescript/ReasoningEffort.ts`): 생성 타입은 자유 `string`(고정 enum이 아님; OpenAI reasoning effort 문자열을 그대로 전달). 따라서 strict client는 모델이 받는 effort 문자열을 그대로 넣어야 한다.

> `UserInput.text` variant의 텍스트 스팬 필드 실제 키는 `text_elements`(snake_case, 타입 `TextElement[]`)다 — 6.4의 `textElements?` 표기는 부정확하며 실제 wire 키는 `text_elements`이고 필수(옵셔널 아님). `image`/`localImage`의 `detail`은 옵셔널. (`schema/typescript/v2/UserInput.ts` @ `rust-v0.142.0`)

### 6.7 `ThreadTokenUsage` / `TokenUsageBreakdown` (verified)

`thread/tokenUsage/updated`(`ThreadTokenUsageUpdatedNotification`)의 payload 정확한 형태 (verified, `schema/typescript/v2/ThreadTokenUsageUpdatedNotification.ts`, `ThreadTokenUsage.ts`, `TokenUsageBreakdown.ts` @ `rust-v0.142.0`):

```ts
type ThreadTokenUsageUpdatedNotification = {
  threadId: string,
  turnId: string,
  tokenUsage: ThreadTokenUsage,
};
type ThreadTokenUsage = {
  total: TokenUsageBreakdown,        // 누적
  last: TokenUsageBreakdown,         // 직전 호출
  modelContextWindow: number | null,
};
type TokenUsageBreakdown = {
  totalTokens: number,
  inputTokens: number,
  cachedInputTokens: number,
  outputTokens: number,
  reasoningOutputTokens: number,
};
```

> 8장 매핑이 가리키던 `TokenUsageBreakdown`은 위 5개 필드를 갖는다(`totalTokens` 포함). 어댑터는 `tokenUsage.total` 또는 `tokenUsage.last`를 골라 CLCOMX `TokenUsage`로 변환한다.

### 6.8 `TurnPlanStep` (verified)

`turn/plan/updated`(`TurnPlanUpdatedNotification`)의 plan 항목 정확한 형태 (verified, `schema/typescript/v2/TurnPlanUpdatedNotification.ts`, `TurnPlanStep.ts`, `TurnPlanStepStatus.ts` @ `rust-v0.142.0`):

```ts
type TurnPlanUpdatedNotification = {
  threadId: string,
  turnId: string,
  explanation: string | null,
  plan: Array<TurnPlanStep>,
};
type TurnPlanStep = {
  step: string,                      // 단계 텍스트 (label/text 아님 — 필드명은 step)
  status: TurnPlanStepStatus,
};
type TurnPlanStepStatus = "pending" | "inProgress" | "completed";
```

> 주의: step 텍스트의 실제 필드명은 `step`이고, 상태 enum casing은 `pending`/`inProgress`/`completed`(camelCase)다. 8장 매핑에서 `inProgress`→`in_progress` 변환.

### 6.9 `CodexErrorInfo` (verified)

`TurnError.codexErrorInfo`(6.2)에 들어가는 타입 (verified, `schema/typescript/v2/CodexErrorInfo.ts` @ `rust-v0.142.0`). 일부는 단위 문자열, 일부는 데이터 variant(외부 태그 객체)다:

```ts
type CodexErrorInfo =
  | "contextWindowExceeded"
  | "usageLimitExceeded"
  | "serverOverloaded"
  | "cyberPolicy"
  | { "httpConnectionFailed": { httpStatusCode: number | null } }
  | { "responseStreamConnectionFailed": { httpStatusCode: number | null } }
  | "internalServerError"
  | "unauthorized"
  | "badRequest"
  | "threadRollbackFailed"
  | "sandboxError"
  | { "responseStreamDisconnected": { httpStatusCode: number | null } }
  | { "responseTooManyFailedAttempts": { httpStatusCode: number | null } }
  | { "activeTurnNotSteerable": { turnKind: NonSteerableTurnKind } }
  | "other";
```

소스 doc-comment에 따르면 이 계층은 codex 에러 코드를 camelCase로 노출하기 위한 변환 레이어이며, upstream HTTP status가 있으면 해당 variant의 `httpStatusCode`로 전달된다. 어댑터는 `usageLimitExceeded`/`contextWindowExceeded` 등을 CLCOMX 에러 코드로 매핑할 수 있고, 매핑 불가 항목은 `raw`에 보존한다.

---

## 7. Delta ↔ completed item reconcile 규칙

verified 동작(필드/주석 기준):

1. **메시지**: `item/started`(빈/부분 `agentMessage`) → 여러 `item/agentMessage/delta`(`{itemId, delta}`) → `item/completed`(최종 `agentMessage.text`). reconcile 키는 `itemId`. completed의 `text`가 **권위적**이며 delta 누적과 정확히 일치한다고 가정해도 좋다(메시지 한정).
   - 단 `plan`(`item/plan/delta`)과 `reasoning`은 "concatenated delta가 completed와 일치하지 않을 수 있음"이 소스 주석에 명시 → completed item을 권위로 삼고 delta는 점진 렌더링용으로만 사용.
2. **명령 출력**: `item/started`(commandExecution, status=`inProgress`) → 여러 `item/commandExecution/outputDelta`(`{itemId, delta}` 평문) → `item/completed`(status=`completed`/`failed`/`declined`, `aggregatedOutput`, `exitCode`, `durationMs`). reconcile 키 `itemId`.
3. **파일 변경**: `item/started`(fileChange) → `item/fileChange/patchUpdated`(`{itemId, changes}`) → `item/completed`(`status: PatchApplyStatus`).
4. **reasoning**: `item/reasoning/textDelta`(`contentIndex`)와 `summaryTextDelta`(`summaryIndex`)는 인덱스로 다중 스트림을 구분 → 같은 `itemId` 안에서 인덱스별로 누적.

### 7.1 Interleaved turn 라우팅 키

- 모든 item/turn notification은 `threadId` + `turnId` + (해당 시) `itemId`를 포함한다. 동시에 여러 thread/turn이 흐를 수 있으므로 **(threadId, turnId, itemId)** 삼중 키로 라우팅·upsert해야 한다.
- approval server-request도 `threadId/turnId/itemId`(+ `approvalId?`)를 포함하고, 응답은 JSON-RPC `id`로 라우팅한다. zsh-exec-bridge 분기 시 한 `itemId`에 여러 approval callback이 붙으므로 `approvalId`로 구분.

---

## 8. CLCOMX normalized model 매핑

CLCOMX `04-normalized-agent-model.md`의 `AgentEvent`/`ProviderRef`로의 매핑(`provider: "codex"`). `ProviderRef`에는 원본 `threadId`/`turnId`/`itemId`/`requestId`를 그대로 보존하고, 미매핑 필드는 `raw`에 둔다.

| Codex notification/request | CLCOMX `AgentEvent` | 매핑 메모 |
| --- | --- | --- |
| `thread/started` | `session_started` `{ ref{threadId,sessionId}, cwd }` | `thread.cwd` |
| `thread/status/changed` | `session_status_changed` | `ThreadStatus` → `AgentSessionStatus`: `idle`→`idle`, `active`→`running`(activeFlags에 `waitingOnApproval`/`waitingOnUserInput` 있으면 `requires_action`), `systemError`→`failed`, `notLoaded`→`starting` |
| `turn/started` | `session_status_changed: running` | `ref.turnId = turn.id` |
| `turn/completed` | `turn_completed` `{ status, usage? }` | `TurnStatus` → `completed`/`failed`/`cancelled`(interrupted→cancelled) |
| `turn/plan/updated` | `plan_updated` `{ entries }` | `TurnPlanStep`={`step`, `status`}; `status`(`pending`/`inProgress`/`completed`) → `pending`/`in_progress`/`completed`. 정확한 형태 6.8 |
| `item/started`(userMessage) | `user_message` `{ content, mode:"replace" }` | `UserInput[]` → `AgentContent[]` |
| `item/started`(agentMessage) | `agent_message` `{ content:[], mode:"replace" }` | 빈 메시지로 upsert 시작 |
| `item/agentMessage/delta` | `agent_message_delta` `{ delta }` | `ref.itemId` 기준 append |
| `item/completed`(agentMessage) | `agent_message` `{ content:[text], mode:"replace" }` | 최종본으로 reconcile |
| `item/started`/`completed`(commandExecution) | `tool_call_updated` `{ kind:"execute", status }` | `CommandExecutionStatus`→`pending`/`in_progress`/... ; `command_output_delta`는 별도 |
| `item/commandExecution/outputDelta` | `command_output_delta` `{ stream, delta }` | thread 채널, 평문 |
| `command/exec/outputDelta`(standalone) | `command_output_delta` 또는 `terminal_output_delta` | **base64 디코드 필요**, `processId` 라우팅 |
| `item/started`/`completed`(fileChange), `item/fileChange/patchUpdated` | `file_change_updated` `{ change }` + `tool_call_updated`(kind:"edit") | `PatchChangeKind`→`create`/`delete`/`update`(movePath→move) |
| `item/*`(mcpToolCall/dynamicToolCall/webSearch) | `tool_call_updated` | kind: webSearch→`fetch`, 기타→`other`; `rawInput`=arguments, `rawOutput`=result |
| `item/commandExecution/requestApproval` (server request) | `approval_requested` `{ request: ApprovalRequest }` | `request.id` = JSON-RPC `id`; options = accept/acceptForSession/decline/cancel → `allow_once`/`allow_always`/`reject_once`/`cancel` |
| `item/fileChange/requestApproval` | `approval_requested` | 동일 |
| `item/permissions/requestApproval` | `approval_requested` | scope turn/session 매핑 |
| `serverRequest/resolved` | `approval_resolved` `{ decision: cancelled }` 또는 pending 정리 | unresolved request 닫기 |
| `thread/tokenUsage/updated` | (turn_completed 보강용) `TokenUsage` | `tokenUsage.total`(또는 `.last`)의 `TokenUsageBreakdown`→`{totalTokens, inputTokens, cachedInputTokens, outputTokens, reasoningOutputTokens}`. 정확한 형태 6.7 |
| `error` | `error` `{ message, recoverable }` | `willRetry`→`recoverable`; `error.codexErrorInfo`(`CodexErrorInfo`, 6.9)로 코드 분류 가능(`usageLimitExceeded`/`contextWindowExceeded` 등) |
| `turn/diff/updated` | (보조) `file_change_updated` 집계 | 턴 누적 diff 문자열 |

### 8.1 Approval 응답(아웃바운드) 매핑

CLCOMX `ApprovalDecision` → Codex 응답:

| CLCOMX `ApprovalOption.kind` | Codex `decision`(command/fileChange) |
| --- | --- |
| `allow_once` | `accept` |
| `allow_always` | `acceptForSession` |
| `reject_once` | `decline` |
| `reject_always` | `decline`(영구 거부 등가물 없음 → decline + 사용자 규칙) |
| `cancel` | `cancel` |

응답은 `{ "id": <서버가 보낸 request id>, "result": { "decision": "accept" } }` 형태의 `JSONRPCResponse`로 보낸다(`jsonrpc` 필드 없음).

---

## 9. 대표 메시지 시퀀스 (turn 1회)

```text
C→S  {"id":1,"method":"initialize","params":{...}}
S→C  {"id":1,"result":{"userAgent":"...","codexHome":"...","platformOs":"linux","platformFamily":"unix"}}
C→S  {"method":"initialized"}
C→S  {"id":2,"method":"thread/start","params":{"cwd":"/repo"}}
S→C  {"id":2,"result":{"thread":{...},"model":"...","cwd":"/repo",...}}
S→C  {"method":"thread/started","params":{"thread":{...}}}
C→S  {"id":3,"method":"turn/start","params":{"threadId":"<id>","input":[{"type":"text","text":"fix bug"}]}}
S→C  {"id":3,"result":{"turn":{"id":"<turnId>","status":"inProgress",...}}}
S→C  {"method":"turn/started","params":{"threadId":"<id>","turn":{...}}}
S→C  {"method":"item/started","params":{"item":{"type":"agentMessage","id":"i1","text":""},...}}
S→C  {"method":"item/agentMessage/delta","params":{"threadId":..,"turnId":..,"itemId":"i1","delta":"Look"}}
S→C  {"method":"item/started","params":{"item":{"type":"commandExecution","id":"i2","command":"grep ...","status":"inProgress",...},...}}
S→C  {"id":7,"method":"item/commandExecution/requestApproval","params":{"threadId":..,"itemId":"i2",...}}
C→S  {"id":7,"result":{"decision":"accept"}}
S→C  {"method":"item/commandExecution/outputDelta","params":{"itemId":"i2","delta":"match...\n",...}}
S→C  {"method":"item/completed","params":{"item":{"type":"commandExecution","id":"i2","status":"completed","exitCode":0,...},...}}
S→C  {"method":"item/completed","params":{"item":{"type":"agentMessage","id":"i1","text":"Looks fixed."},...}}
S→C  {"method":"turn/completed","params":{"threadId":..,"turn":{"id":"<turnId>","status":"completed",...}}}
```

> 위 시퀀스는 본문 검증된 타입들로 재구성한 **예시**이며 실제 바이트 캡처는 아니다(unverified ordering 세부). 메서드명/필드명은 verified.

---

## 10. 확인 못 한 부분 (unverified) / open questions

- `ClientInfo`, `InitializeCapabilities`의 정확한 필드(특히 capability opt-in 키와 experimental 노출 제어 방식)는 개별 schema 파일을 끝까지 읽지 않음.
- `initialize`→`initialized` 핸드셰이크가 **필수**인지(없이도 thread/start 가능한지)는 server 구현(app-server crate handler)을 읽어 확인 필요. 순서는 권장 추정.
- 섹션 9의 메시지 **순서/타이밍**(예: `turn/start` response가 `turn/started` notification보다 먼저 오는지)은 타입에서 추론한 것으로 실제 wire 캡처로 검증하지 않음.
- `reject_always`에 대응하는 Codex 영구 거부 decision의 정확한 등가물은 불명확(현재 decline로 매핑 권장).
- `CommandExecutionApprovalDecision`의 데이터 variant(`acceptWithExecpolicyAmendment`, `applyNetworkPolicyAmendment`)는 Rust 상 외부 태그(externally-tagged) enum variant임이 확인됨 → `{ "acceptWithExecpolicyAmendment": { "execpolicyAmendment": ... } }` 형태로 직렬화. 다만 생성된 응답 JSON schema 리터럴 자체는 열지 않았으므로 정확한 내부 필드명은 schema 재확인 권장. CLCOMX는 단위 variant 4종만 전송 권장(변동 없음).
- SDK(`sdk/typescript/src/thread.ts`, `events.ts`)는 `codex exec` 계열의 상위 래퍼로 보이며 app-server JSON-RPC와 1:1이 아닐 수 있음 — 본 문서는 app-server-protocol crate를 권위 소스로 사용했고 SDK는 교차검증에 쓰지 않음(파일 존재만 확인).

> 적대적 검증(rust-v0.142.0 재확인) 후 해소된 항목: `ThreadTokenUsage`/`TokenUsageBreakdown`(→6.7), `TurnPlanStep`/`TurnPlanStepStatus`(→6.8), `CodexErrorInfo`(→6.9), `TurnStartParams` option enum(`ImageDetail`/`Personality`/`ReasoningSummary`/`ReasoningEffort`, →6.6), realtime notification 슬래시 표기·`windowsSandbox/{setupStart,readiness}` 메서드명(→3.4/5.4), `CommandExecutionRequestApprovalParams.networkApprovalContext`(→4.1). 이들은 더 이상 unverified가 아니다.

# Reference: Agent Client Protocol (ACP) Wire Spec

> 이 문서는 CLCOMX의 Claude ACP adapter(`06-claude-acp-adapter.md`)와 normalized agent model(`04-normalized-agent-model.md`)을 구현하기 위한 1차 소스 기반 프로토콜 레퍼런스다. 다운스트림 구현 에이전트가 이 문서만으로 ACP client 어댑터를 작성할 수 있도록 wire-level 정확도를 목표로 한다.

## 0. 버전 축의 구분 (중요)

ACP에는 서로 다른 두 개의 버전 축이 있다. 혼동하면 안 된다.

| 축 | 의미 | 값 (조사 시점) |
|---|---|---|
| **Protocol version** (`protocolVersion`) | wire 상에서 `initialize`로 협상하는 정수. breaking change에서만 증가. | `LATEST = 1` (stable). `0`은 pre-release fallback. `2`는 **unstable draft**, `unstable_protocol_v2` feature로만 노출되며 `LATEST`에 포함되지 않음. |
| **Schema release tag** (git tag) | `agentclientprotocol/agent-client-protocol` 저장소가 스키마/타입을 배포하는 npm/crate semver 태그. protocol version과 독립적으로 자주 올라감. | 조사에 사용한 태그: `schema-v1.16.0` |
| **ACP agent 구현체 버전** (Claude) | CLCOMX가 실제로 실행하는 ACP agent 바이너리/패키지(`@agentclientprotocol/claude-agent-acp`)의 버전. 위 두 축과 또 다르다. | `0.51.0` (release commit `23626c9`, 2026-06-24). verified: https://github.com/agentclientprotocol/claude-agent-acp `package.json` + commit `23626c9` "chore(main): release 0.51.0 (#808)" |

확인된 사실(verified): `agent-client-protocol-schema/src/version.rs` (ref `schema-v1.16.0`)에서 `pub const LATEST: Self = Self::V1;`이고 `V2`는 `#[cfg(feature = "unstable_protocol_v2")]`로 게이트됨. 따라서 **현재 production 에이전트가 실제로 협상하는 stable wire 프로토콜은 protocolVersion = 1**이다.
출처: https://github.com/agentclientprotocol/agent-client-protocol/blob/schema-v1.16.0/agent-client-protocol-schema/src/version.rs

### v1 vs v2(draft) 메서드 차이 (참고용, v2는 미확정)

`schema/v1/meta.json`과 `schema/v2/meta.json`을 비교한 결과(verified):

- v2(draft)는 `session/set_mode`를 **제거**하고 `session/set_config_option`만 둔다.
- v2(draft)의 `clientMethods`는 `session/request_permission`, `session/update` **두 개뿐**이며 `fs/*`, `terminal/*`가 빠져 있다. (transport 변경/재배치 논의 중)

> **결론: CLCOMX adapter는 protocolVersion = 1 (schema-v1.16.0)을 타겟으로 구현한다.** 이 문서의 본문(1장 이후)은 전부 v1 stable 기준이다. v2는 stabilize되기 전까지 참고만 한다.
> 출처: https://github.com/agentclientprotocol/agent-client-protocol/blob/schema-v1.16.0/schema/v1/meta.json , https://github.com/agentclientprotocol/agent-client-protocol/blob/schema-v1.16.0/schema/v2/meta.json

---

## 1. Transport & JSON-RPC 2.0

ACP는 JSON-RPC 2.0 위에서 동작한다. 두 가지 메시지 종류만 있다.

- **Method**: request-response 쌍. `result` 또는 `error`로 응답.
- **Notification**: 단방향. 응답 없음(success/error 둘 다 없음).

### stdio transport 규칙 (verified, 모두 인용)

출처: https://agentclientprotocol.com/protocol/v1/transports.md

- JSON-RPC 메시지는 **UTF-8 MUST**.
- The client launches the agent as a subprocess.
- The agent reads JSON-RPC messages from its standard input (`stdin`) and sends messages to its standard output (`stdout`).
- Messages are delimited by newlines (`\n`), and **MUST NOT** contain embedded newlines. (즉 한 메시지 = 한 줄, NDJSON)
- The agent **MAY** write UTF-8 strings to its standard error (`stderr`) for logging purposes. Clients **MAY** capture, forward, or ignore this logging.
- The agent **MUST NOT** write anything to its `stdout` that is not a valid ACP message. (**stdout purity**)
- The client **MUST NOT** write anything to the agent's `stdin` that is not a valid ACP message.
- Agents and clients **SHOULD** support stdio whenever possible. Streamable HTTP는 draft proposal(미확정).

### JSON 표기 규칙 (verified)

출처: https://agentclientprotocol.com/protocol/v1/overview.md (Conventions 섹션)

- ACP-defined object property keys는 `camelCase`.
- discriminator field가 담는 string value는 `snake_case` (예: `sessionUpdate: "agent_message_chunk"`, `type: "resource_link"`).
- JSON-RPC envelope field(`jsonrpc`, `id`, `method`, `params`, `result`, `error`)는 JSON-RPC 2.0 그대로.
- 모든 파일 경로는 **absolute MUST**. line number는 **1-based**.

### Extensibility (verified)

- custom data는 모든 object의 `_meta` field로 추가. 구현체는 `_meta` 키의 값에 대해 가정하면 안 됨(MUST NOT).
- custom method는 이름을 `_` prefix로 만든다.
- custom capability는 `initialize`에서 광고.

출처: https://agentclientprotocol.com/protocol/v1/overview.md , 각 타입 schema의 `_meta` 설명(ref `schema-v1.16.0`).

### JSON-RPC envelope 예시

요청:
```json
{ "jsonrpc": "2.0", "id": 1, "method": "initialize", "params": { /* ... */ } }
```
응답(성공):
```json
{ "jsonrpc": "2.0", "id": 1, "result": { /* ... */ } }
```
응답(에러):
```json
{ "jsonrpc": "2.0", "id": 1, "error": { "code": -32601, "message": "Method not found" } }
```
notification(응답 없음, `id` 없음):
```json
{ "jsonrpc": "2.0", "method": "session/update", "params": { /* ... */ } }
```

---

## 2. 메서드/노티피케이션 카탈로그

방향: `C→A` = Client가 Agent에게, `A→C` = Agent가 Client에게.
모든 method/notification 이름은 `schema/v1/meta.json` (ref `schema-v1.16.0`)에서 verified.

### Agent가 구현 (Client가 호출, C→A)

| Method | Kind | Baseline/Optional | params 타입 | result 타입 | 비고 |
|---|---|---|---|---|---|
| `initialize` | request | baseline | `InitializeRequest` | `InitializeResponse` | 연결 1회, 버전/capability 협상 |
| `authenticate` | request | optional | `AuthenticateRequest` | `AuthenticateResponse` | agent가 auth method 광고 시 |
| `session/new` | request | baseline | `NewSessionRequest` | `NewSessionResponse` | 새 세션 |
| `session/load` | request | optional (`loadSession` cap) | `LoadSessionRequest` | `LoadSessionResponse` | 과거 메시지 replay |
| `session/resume` | request | optional (`sessionCapabilities.resume`) | `ResumeSessionRequest` | `ResumeSessionResponse` | replay 없이 재개 |
| `session/prompt` | request | baseline | `PromptRequest` | `PromptResponse` (`stopReason`) | 1 turn 실행 |
| `session/cancel` | **notification** | baseline | `CancelNotification` | — | turn 중단 |
| `session/set_mode` | request | optional | `SetSessionModeRequest` | `SetSessionModeResponse` | mode 전환 (v1 전용; v2 draft에서 제거) |
| `session/set_config_option` | request | optional (`session-config-options`) | `SetSessionConfigOptionRequest` | `SetSessionConfigOptionResponse` (`configOptions` 반환, 빈 result 아님) | config selector |
| `session/list` | request | optional (`sessionCapabilities.list`) | `ListSessionsRequest` | `ListSessionsResponse` | 페이지네이션(`cursor`/`nextCursor`) |
| `session/delete` | request | optional (`sessionCapabilities.delete`) | `DeleteSessionRequest` | `DeleteSessionResponse` | |
| `session/close` | request | optional (`sessionCapabilities.close`) | `CloseSessionRequest` | `CloseSessionResponse` | cancel 후 리소스 해제 |
| `logout` | request | optional (`agentCapabilities.auth.logout`) | `LogoutRequest` | `LogoutResponse` | |

### Client가 구현 (Agent가 호출, A→C)

| Method | Kind | Optional | params 타입 | result 타입 | capability gate |
|---|---|---|---|---|---|
| `session/request_permission` | request | baseline | `RequestPermissionRequest` | `RequestPermissionResponse` | — |
| `session/update` | **notification** | baseline | `SessionNotification` | — | — |
| `fs/read_text_file` | request | optional | `ReadTextFileRequest` | `ReadTextFileResponse` | `clientCapabilities.fs.readTextFile` |
| `fs/write_text_file` | request | optional | `WriteTextFileRequest` | `WriteTextFileResponse` | `clientCapabilities.fs.writeTextFile` |
| `terminal/create` | request | optional | `CreateTerminalRequest` | `CreateTerminalResponse` | `clientCapabilities.terminal` |
| `terminal/output` | request | optional | `TerminalOutputRequest` | `TerminalOutputResponse` | `clientCapabilities.terminal` |
| `terminal/wait_for_exit` | request | optional | `WaitForTerminalExitRequest` | `WaitForTerminalExitResponse` | `clientCapabilities.terminal` |
| `terminal/kill` | request | optional | `KillTerminalRequest` | `KillTerminalResponse` (empty) | `clientCapabilities.terminal` |
| `terminal/release` | request | optional | `ReleaseTerminalRequest` | `ReleaseTerminalResponse` (empty) | `clientCapabilities.terminal` |

> baseline 요구사항(verified, `SessionCapabilities` 설명): 모든 Agent는 `session/new`, `session/prompt`, `session/cancel`, `session/update`를 **MUST** 지원. 나머지 session method/notification은 capability로 opt-in.

### session/update notification의 update variant (정본 13종 = 출처별 11/13 분기)

discriminator = `update.sessionUpdate` (snake_case). `SessionUpdate` oneOf의 variant 집합은 **같은 `protocolVersion = 1` wire인데도 조사한 schema artifact에 따라 개수가 다르다**(verified, 1차 소스 재검증 2026-06-25):

- agent-client-protocol 저장소 **`schema-v1.16.0`의 `schema/v1/schema.json`** → `SessionUpdate` oneOf **11종** (`plan_update`/`plan_removed` **없음**). verified: `gh api repos/agentclientprotocol/agent-client-protocol/contents/schema/v1/schema.json?ref=schema-v1.16.0`. 출처: https://github.com/agentclientprotocol/agent-client-protocol/blob/schema-v1.16.0/schema/v1/schema.json
- **`@agentclientprotocol/sdk@0.29.0`의 `schema/schema.json`** → `SessionUpdate` oneOf **13종** (위 11종 + `plan_update` + `plan_removed`). 이 SDK도 `PROTOCOL_VERSION = 1`을 협상한다(verified: `dist/schema/index.js:51 export const PROTOCOL_VERSION = 1;`). 출처: npm tarball `@agentclientprotocol/sdk@0.29.0` `schema/schema.json`.

**정본(CLCOMX 구현 기준)**: CLCOMX가 실제로 실행하는 어댑터 `@agentclientprotocol/claude-agent-acp@0.51.0`은 `@agentclientprotocol/sdk@0.29.0`에 의존하므로, 런타임 wire에 실제 등장할 수 있는 variant 집합은 **13종**이다. 단 `plan_update`/`plan_removed`는 **SDK 0.29.0 schema에만 존재**하고 protocol-repo `schema-v1.16.0` v1 schema.json에는 **없다**(같은 protocolVersion=1의 서로 다른 schema cut). 클라이언트 parser는 모르는 variant를 graceful하게 무시해야 한다.

| `sessionUpdate` 값 | merge되는 payload 타입 | 의미 | 출처 |
|---|---|---|---|
| `user_message_chunk` | `ContentChunk` | 사용자 메시지 스트리밍 청크 | 양쪽 schema 공통 |
| `agent_message_chunk` | `ContentChunk` | agent 응답 스트리밍 청크 | 양쪽 schema 공통 |
| `agent_thought_chunk` | `ContentChunk` | agent 내부 reasoning 청크 | 양쪽 schema 공통 |
| `tool_call` | `ToolCall` | 새 tool call 생성 | 양쪽 schema 공통 |
| `tool_call_update` | `ToolCallUpdate` | 기존 tool call 갱신 | 양쪽 schema 공통 |
| `plan` | `Plan` | 실행 계획(전체 교체) | 양쪽 schema 공통 |
| `plan_update` | `PlanUpdate` | plan 증분 갱신 | **sdk 0.29.0 schema 전용** (schema-v1.16.0 v1엔 없음) |
| `plan_removed` | `PlanRemoved` | plan 제거 | **sdk 0.29.0 schema 전용** (schema-v1.16.0 v1엔 없음) |
| `available_commands_update` | `AvailableCommandsUpdate` | slash command 목록 | 양쪽 schema 공통 |
| `current_mode_update` | `CurrentModeUpdate` | 현재 mode 변경 | 양쪽 schema 공통 |
| `config_option_update` | `ConfigOptionUpdate` | config option 값 갱신 | 양쪽 schema 공통 |
| `session_info_update` | `SessionInfoUpdate` | 세션 title/updatedAt 등 | 양쪽 schema 공통 |
| `usage_update` | `UsageUpdate` | context window/cost | 양쪽 schema 공통 |

---

## 3. Lifecycle: 정확한 params/result

### 3.1 initialize (verified)

**InitializeRequest** (`required: protocolVersion`)
- `protocolVersion: ProtocolVersion` (uint16) — Client가 지원하는 최신 버전
- `clientCapabilities: ClientCapabilities` (default `{ fs:{readTextFile:false,writeTextFile:false}, terminal:false }`)
- `clientInfo?: Implementation` (`{name, title?, version}`) — 현재는 optional, 향후 required 예정
- `_meta?`

**InitializeResponse** (`required: protocolVersion`)
- `protocolVersion: ProtocolVersion` — Client가 요청한 버전을 지원하면 그 값, 아니면 agent가 지원하는 최신 버전
- `agentCapabilities: AgentCapabilities`
- `authMethods: AuthMethod[]` (default `[]`)
- `agentInfo?: Implementation`
- `_meta?`

**버전 협상 규칙** (verified, 인용; 출처 https://agentclientprotocol.com/protocol/v1/overview.md & initialization 페이지):
- Client는 `initialize`에 자신이 지원하는 **최신** protocolVersion을 **MUST** 넣는다.
- Agent가 그 버전을 지원하면 같은 값으로 응답. 지원 안 하면 Agent가 지원하는 **최신** 버전으로 응답(**MUST**).
- Client가 Agent가 응답한 버전을 지원하지 않으면 연결을 **SHOULD** 닫는다.
- 누락된 capability는 전부 **UNSUPPORTED**로 취급(**MUST**).

요청 예시:
```json
{ "jsonrpc":"2.0","id":1,"method":"initialize","params":{
  "protocolVersion":1,
  "clientCapabilities":{"fs":{"readTextFile":true,"writeTextFile":true},"terminal":true},
  "clientInfo":{"name":"clcomx","version":"0.5.6"}
}}
```
응답 예시:
```json
{ "jsonrpc":"2.0","id":1,"result":{
  "protocolVersion":1,
  "agentCapabilities":{
    "loadSession":true,
    "promptCapabilities":{"image":true,"audio":false,"embeddedContext":true},
    "mcpCapabilities":{"http":true,"sse":false},
    "sessionCapabilities":{"resume":{},"list":{}},
    "auth":{}
  },
  "agentInfo":{"name":"claude-agent-acp","version":"0.51.0"},
  "authMethods":[]
}}
```

#### Capability 구조 (verified)

`ClientCapabilities`:
- `fs: FileSystemCapabilities { readTextFile: bool=false, writeTextFile: bool=false }`
- `terminal: bool=false` (모든 `terminal/*` 지원 여부)

`AgentCapabilities`:
- `loadSession: bool=false` (`session/load` 지원 — 주의: 이건 `sessionCapabilities`가 아니라 top-level)
- `promptCapabilities: { image:bool, audio:bool, embeddedContext:bool }` (전부 default false). baseline은 `text`/`resource_link`만 보장.
- `mcpCapabilities: { http:bool, sse:bool }` (stdio MCP는 항상 지원)
- `sessionCapabilities: SessionCapabilities` (아래)
- `auth: AgentAuthCapabilities { logout?: {} | null }`

`SessionCapabilities` (각 필드 `{} | null`; `{}` = 지원, null/생략 = 미지원):
- `list?`, `delete?`, `additionalDirectories?`, `resume?`, `close?`

### 3.2 authenticate (verified)

- **AuthenticateRequest**: `{ methodId: AuthMethodId, _meta? }` — `methodId`는 initialize의 `authMethods`에 광고된 것 중 하나(MUST).
- **AuthenticateResponse**: `{ _meta? }` (빈 객체)
- `AuthMethod`는 `anyOf`이며 현재 `agent`(`AuthMethodAgent`) variant만 가진다. `type` 생략 시 `agent`로 간주(verified: schema-v1.16.0 `$defs.AuthMethod` description "When no `type` is present, the method is treated as `agent`").
- `AuthMethodAgent` (verified, `required: id, name`): `{ id: AuthMethodId, name: string, description?: string|null, _meta? }`. `initialize` 응답의 `authMethods` 항목이 이 형태이며, `methodId`로 쓰는 값이 `id`다.
- auth가 필요한데 안 했으면 에러코드 `-32000 Authentication required` 반환.

### 3.3 session/new (verified)

**NewSessionRequest** (`required: cwd, mcpServers`)
- `cwd: string` (absolute MUST)
- `additionalDirectories?: string[]` (각 absolute)
- `mcpServers: McpServer[]`
- `_meta?`

**NewSessionResponse** (`required: sessionId`)
- `sessionId: SessionId` (string)
- `modes?: SessionModeState | null`
- `configOptions?: SessionConfigOption[] | null`
- `_meta?`

예시:
```json
{ "jsonrpc":"2.0","id":2,"method":"session/new","params":{
  "cwd":"/home/melbin/work/clcomx",
  "mcpServers":[],
  "additionalDirectories":[]
}}
```
```json
{ "jsonrpc":"2.0","id":2,"result":{
  "sessionId":"sess_01H...",
  "modes":{"currentModeId":"default","availableModes":[{"id":"default","name":"Default"}]}
}}
```

### 3.4 session/load (verified)

`loadSession` capability 필요. **LoadSessionRequest** (`required: mcpServers, cwd, sessionId`):
- `sessionId, cwd, mcpServers, additionalDirectories?, _meta?`

**LoadSessionResponse**: `{ modes?, configOptions?, _meta? }`

> 동작(verified, overview/session-setup): `session/load`는 과거 대화를 **replay**한다 — 즉 Agent는 응답 전에 `session/update` notification들을 보내 transcript를 재구성한다. CLCOMX adapter는 load 응답을 받기 전까지 들어오는 update를 transcript 재구성용으로 처리해야 한다.

### 3.5 session/resume (verified)

`sessionCapabilities.resume` 필요. `session/load`와 달리 **과거 메시지를 replay하지 않고** 세션만 재개.
**ResumeSessionRequest** (`required: sessionId, cwd`): `{ sessionId, cwd, additionalDirectories?, mcpServers?, _meta? }`
**ResumeSessionResponse**: `{ modes?, configOptions?, _meta? }`

> **구현 주의(capability 위치 비대칭)**: `session/load`의 게이트는 `AgentCapabilities.loadSession`(top-level bool)이고, `session/resume`의 게이트는 `AgentCapabilities.sessionCapabilities.resume`다. 두 메서드의 capability가 **서로 다른 위치**에 있으므로 adapter는 각 메서드마다 올바른 위치를 확인해야 한다 — `sessionCapabilities`에서 `load`를 찾거나 top-level에서 `resume`를 찾으면 항상 미지원으로 오판한다.

### 3.6 session/prompt + stopReason (verified)

**PromptRequest** (`required: sessionId, prompt`)
- `sessionId: SessionId`
- `prompt: ContentBlock[]` — baseline은 `text`, `resource_link`만 MUST. 나머지는 `promptCapabilities`로 opt-in. embedded context는 `ContentBlock::resource`(=`embeddedContext`).
- `_meta?`

**PromptResponse** (`required: stopReason`)
- `stopReason: StopReason`, `_meta?`

**StopReason** enum (verified, oneOf const):
| 값 | 의미 |
|---|---|
| `end_turn` | turn 정상 종료 |
| `max_tokens` | 토큰 한도 도달 |
| `max_turn_requests` | user turn 사이 최대 agent request 수 도달 |
| `refusal` | agent가 계속 진행을 거부. 이 user prompt 이후는 다음 prompt에 포함되지 않으므로 UI에 반영해야 함 |
| `cancelled` | `session/cancel`로 취소됨. cancel을 받으면 **MUST** 이 값을 반환(내부 예외가 나도 catch해서 이 값으로) |

> `StopReason`은 const string들의 닫힌 `oneOf`다(open-string fallback 없음; verified schema-v1.16.0 `$defs.StopReason`). 따라서 adapter는 위 5개 값을 exhaustive하게 match하면 되고 default branch가 따로 필요 없다(확장은 envelope의 `_meta`로만). 알 수 없는 stopReason string이 오면 그 자체가 프로토콜 위반이다.

요청 예시:
```json
{ "jsonrpc":"2.0","id":3,"method":"session/prompt","params":{
  "sessionId":"sess_01H...",
  "prompt":[{"type":"text","text":"refactor foo.ts"}]
}}
```
응답 예시(turn 종료):
```json
{ "jsonrpc":"2.0","id":3,"result":{"stopReason":"end_turn"}}
```

### 3.7 prompt turn lifecycle (verified)

출처: https://agentclientprotocol.com/protocol/v1/prompt-turn.md

1. **User Message**: Client가 `session/prompt` 전송.
2. **Agent Processing**: Agent가 LM에 전달, LM은 text/tool call 응답.
3. **Agent Reports Output**: `session/update` notification으로 plan, `agent_message_chunk`, tool call, usage 등 스트리밍.
4. **Completion Check**: pending tool call이 없으면 Agent는 원래 `session/prompt` request에 `StopReason`으로 **MUST** 응답.

tool 실행이 필요하면 3↔4 사이에서 permission 요청 → 실행 → 진행 보고 → 결과를 LM에 반환 후 다시 사이클.

### 3.8 cancellation: session/cancel (verified, 인용)

**CancelNotification** (`required: sessionId`): `{ sessionId, _meta? }` — notification이므로 응답 없음.

규칙(출처 prompt-turn.md):
- Client는 현재 turn의 끝나지 않은 모든 tool call을 미리(`cancelled`로) **SHOULD** 표시.
- Client는 pending된 모든 `session/request_permission` request에 `cancelled` outcome으로 **MUST** 응답.
- Agent는 받는 즉시 LM 요청과 tool 실행을 가능한 빨리 **SHOULD** 중단.
- Agent는 cancel로 인한 내부 에러를 catch하고 `cancelled` stop reason을 **MUST** 반환(실패와 구분). 응답 전 update를 더 보낼 수 있음.

> CLCOMX 매핑: pending approval table을 cancel 시 `cancelled`로 닫는 규칙(`04-...`의 store 규칙, `09-permissions-security.md`)이 이 MUST와 정확히 대응.

---

## 4. ContentBlock (verified)

`ContentBlock`은 `type` discriminator(snake_case)를 가진 oneOf. 5종.

| `type` | 타입 | 필드 (required) | 비고 |
|---|---|---|---|
| `text` | `TextContent` | `text` | `annotations?`, `_meta?` |
| `image` | `ImageContent` | `data`, `mimeType` | `data`=base64, `uri?`, `annotations?` |
| `audio` | `AudioContent` | `data`, `mimeType` | base64; `uri` 없음 |
| `resource_link` | `ResourceLink` | `name`, `uri` | `mimeType?`,`title?`,`description?`,`size?`(int64),`annotations?` |
| `resource` | `EmbeddedResource` | `resource` | embedded; `annotations?` |

`EmbeddedResource.resource` = `EmbeddedResourceResource` = anyOf:
- `TextResourceContents { text, uri, mimeType? }`
- `BlobResourceContents { blob(base64), uri, mimeType? }`

`Annotations { audience?: Role[], lastModified?: string, priority?: number, _meta? }`, `Role` = `assistant` | `user`.

`ContentChunk` (메시지 청크 wrapper, `user/agent/agent_thought_chunk`가 merge):
- `content: ContentBlock` (required)
- `messageId?: MessageId | null` — 같은 메시지의 모든 청크는 같은 `messageId`. 값이 바뀌면 새 메시지 시작.
- `_meta?`

예시 (`agent_message_chunk` notification):
```json
{ "jsonrpc":"2.0","method":"session/update","params":{
  "sessionId":"sess_01H...",
  "update":{
    "sessionUpdate":"agent_message_chunk",
    "content":{"type":"text","text":"Sure, I'll "},
    "messageId":"msg_1"
  }
}}
```

resource_link 예시:
```json
{"type":"resource_link","name":"foo.ts","uri":"file:///home/melbin/work/clcomx/foo.ts","mimeType":"text/x-typescript"}
```
embedded resource(text) 예시:
```json
{"type":"resource","resource":{"uri":"file:///abs/foo.ts","mimeType":"text/x-typescript","text":"export const x = 1;"}}
```

---

## 5. ToolCall / ToolCallUpdate (verified)

### ToolCall (`tool_call` notification에서 merge)
required: `toolCallId`, `title`
- `toolCallId: ToolCallId` (string)
- `title: string` (human-readable)
- `kind: ToolKind` (아래)
- `status: ToolCallStatus` (아래)
- `content: ToolCallContent[]`
- `locations: ToolCallLocation[]` (`{ path, line?:uint32 }`) — follow-along 용
- `rawInput: any` (스키마 제약 없음)
- `rawOutput: any`
- `_meta?`

### ToolCallUpdate (`tool_call_update` notification, permission request의 `toolCall`에서 merge)
required: `toolCallId`. **나머지 필드는 전부 optional/nullable** — 바뀐 필드만 보냄.
- `toolCallId`, `kind?`, `status?`, `title?`, `content?`, `locations?`, `rawInput?`, `rawOutput?`, `_meta?`
- `content`/`locations`는 **collection 전체 교체**(replace), partial append 아님.

### ToolCallStatus enum (verified)
| 값 | 의미 |
|---|---|
| `pending` | 아직 시작 안 함(입력 스트리밍 중 또는 승인 대기) |
| `in_progress` | 실행 중 |
| `completed` | 성공 |
| `failed` | 실패 |

> 주의: ACP v1 ToolCallStatus에는 **`cancelled`가 없다**. CLCOMX 모델의 `ToolCallUpdate.status`에는 `cancelled`가 있으므로, ACP→CLCOMX 매핑 시 cancel은 turn-level `stopReason: cancelled` 또는 client가 자체적으로 미완료 tool call을 `cancelled`로 표시하는 규칙으로만 발생한다(ACP wire에는 그 status가 직접 오지 않음).

### ToolKind enum (verified, 10종)
`read`, `edit`, `delete`, `move`, `search`, `execute`, `think`, `fetch`, `switch_mode`, `other`(default).

> 주의: CLCOMX `ToolCallUpdate.kind`에는 `switch_mode`가 없다. 매핑 시 `switch_mode` → CLCOMX `other`로 축약 권장(아래 매핑표 참조).

### ToolCallContent (verified, oneOf, discriminator `type`)
| `type` | merge 타입 | 필드 |
|---|---|---|
| `content` | `Content`(=ContentBlock) | 표준 content block |
| `diff` | `Diff` | `{ path, newText, oldText?:null }` (oldText=null이면 신규 파일) |
| `terminal` | `Terminal` | `terminal/create`로 만든 terminal을 id로 embed. `terminal/release` 전에 추가돼야 함 |

tool_call 예시:
```json
{ "jsonrpc":"2.0","method":"session/update","params":{
  "sessionId":"sess_01H...",
  "update":{
    "sessionUpdate":"tool_call",
    "toolCallId":"call_1",
    "title":"Edit foo.ts",
    "kind":"edit",
    "status":"in_progress",
    "locations":[{"path":"/abs/foo.ts","line":12}],
    "content":[{"type":"diff","path":"/abs/foo.ts","oldText":"a","newText":"b"}]
  }
}}
```

---

## 6. Permission: session/request_permission (verified)

A→C request. **RequestPermissionRequest** (`required: sessionId, toolCall, options`):
- `sessionId: SessionId`
- `toolCall: ToolCallUpdate` — 승인 대상 tool call 정보
- `options: PermissionOption[]`
- `_meta?`

`PermissionOption` (`required: optionId, name, kind`):
- `optionId: PermissionOptionId` (string)
- `name: string` (UI label)
- `kind: PermissionOptionKind`

`PermissionOptionKind` enum (verified): `allow_once`, `allow_always`, `reject_once`, `reject_always`.

**RequestPermissionResponse** (`required: outcome`):
- `outcome: RequestPermissionOutcome` — oneOf, discriminator `outcome`:
  - `{ "outcome": "cancelled" }` — turn이 응답 전에 cancel됨. cancel 시 모든 pending permission에 이 값으로 응답(MUST).
  - `{ "outcome": "selected", "optionId": "<PermissionOptionId>" }` — 사용자가 옵션 선택.

request 예시:
```json
{ "jsonrpc":"2.0","id":42,"method":"session/request_permission","params":{
  "sessionId":"sess_01H...",
  "toolCall":{"toolCallId":"call_1","title":"Run `rm -rf build`","kind":"execute","status":"pending"},
  "options":[
    {"optionId":"allow","name":"Allow","kind":"allow_once"},
    {"optionId":"allow_all","name":"Always allow","kind":"allow_always"},
    {"optionId":"reject","name":"Reject","kind":"reject_once"}
  ]
}}
```
response 예시:
```json
{ "jsonrpc":"2.0","id":42,"result":{"outcome":{"outcome":"selected","optionId":"allow"}}}
```
cancel response 예시:
```json
{ "jsonrpc":"2.0","id":42,"result":{"outcome":{"outcome":"cancelled"}}}
```

> 주의: ACP outcome에는 `failed`가 없다(CLCOMX `ApprovalDecision.outcome`에는 있음). CLCOMX의 `failed`는 client 내부 에러용으로만 쓰고 ACP wire로는 `selected`/`cancelled`만 보낸다.

---

## 7. File system client methods (verified)

`clientCapabilities.fs.*`가 true일 때만 Agent가 호출 가능.

**fs/read_text_file** — `ReadTextFileRequest` (`required: sessionId, path`):
- `path` (absolute MUST), `line?:uint32`(1-based), `limit?:uint32`(읽을 최대 줄 수)
- 응답 `ReadTextFileResponse`: `{ content: string, _meta? }`

**fs/write_text_file** — `WriteTextFileRequest` (`required: sessionId, path, content`):
- `path`(absolute), `content: string`
- 응답 `WriteTextFileResponse`: `{ _meta? }` (빈 객체)

read 예시:
```json
{ "jsonrpc":"2.0","id":7,"method":"fs/read_text_file","params":{
  "sessionId":"sess_01H...","path":"/abs/foo.ts","line":1,"limit":100}}
```

---

## 8. Terminal client methods (verified)

`clientCapabilities.terminal == true`일 때만. `terminal/output`/`wait_for_exit`/`kill`/`release`는 `required: sessionId, terminalId`. `terminal/create`는 `required: sessionId, command`만이고 `args`/`env`/`cwd`/`outputByteLimit`는 전부 **optional**(verified: schema-v1.16.0 `$defs.CreateTerminalRequest`, `required:["sessionId","command"]`). `args`/`env`는 생략 시 빈 배열로 취급되지만 wire 상 required가 아니다.

| Method | Request 필드 | Response |
|---|---|---|
| `terminal/create` | `sessionId`, `command`, `args?:string[]`, `env?:EnvVariable[]`, `cwd?:string\|null`, `outputByteLimit?:uint64\|null` | `{ terminalId }` |
| `terminal/output` | `sessionId`, `terminalId` | `{ output:string, truncated:bool, exitStatus?:TerminalExitStatus\|null }` |
| `terminal/wait_for_exit` | `sessionId`, `terminalId` | `{ exitCode?:uint32\|null, signal?:string\|null }` |
| `terminal/kill` | `sessionId`, `terminalId` | `{ _meta? }` (release 안 함) |
| `terminal/release` | `sessionId`, `terminalId` | `{ _meta? }` (리소스 해제) |

- `EnvVariable { name, value }`.
- `TerminalExitStatus { exitCode?:uint32\|null, signal?:string\|null }`.
- `outputByteLimit` 초과 시 Client는 앞에서부터 truncate하되 character boundary 유지(MUST).
- terminal은 `ToolCallContent { type:"terminal" }`로 tool call에 embed 가능(release 전에).

create 예시:
```json
{ "jsonrpc":"2.0","id":9,"method":"terminal/create","params":{
  "sessionId":"sess_01H...","command":"npm","args":["test"],"env":[],"cwd":"/abs","outputByteLimit":1048576}}
```

---

## 9. MCP server config (verified)

`NewSessionRequest.mcpServers` / `LoadSessionRequest.mcpServers` 항목인 `McpServer`는 anyOf, discriminator `type`. stdio는 `type` 생략 가능(default).

| transport | 타입 | gate | 필드 (required) |
|---|---|---|---|
| stdio (`type` 생략 또는 stdio) | `McpServerStdio` | 항상 (MUST 지원) | `name`, `command`, `args:string[]`, `env:EnvVariable[]` |
| `http` | `McpServerHttp` | `mcpCapabilities.http` | `name`, `url`, `headers:HttpHeader[]` |
| `sse` | `McpServerSse` | `mcpCapabilities.sse` | `name`, `url`, `headers:HttpHeader[]` |

`HttpHeader` (verified, schema-v1.16.0 `$defs.HttpHeader`, `required: name, value`): `{ name: string, value: string, _meta? }`.

---

## 10. Modes / Config options / Session info / Usage (verified)

### Session Modes
- `SessionModeState { currentModeId: SessionModeId, availableModes: SessionMode[] }`
- `SessionMode { id, name, description? }`
- `CurrentModeUpdate { currentModeId }` — `current_mode_update` notification payload
- `SetSessionModeRequest { sessionId, modeId }` → `SetSessionModeResponse { _meta? }` (method `session/set_mode`)

### Session Config Options
- `SetSessionConfigOptionRequest` (`required: sessionId, configId, value`): `{ sessionId: SessionId, configId: SessionConfigId, value: SessionConfigValueId, _meta? }`
- `SetSessionConfigOptionResponse` (`required: configOptions`): `{ configOptions: SessionConfigOption[], _meta? }` — **응답은 빈 객체가 아니다.** set 직후의 **전체 config option set과 현재 값**을 그대로 돌려준다(`ConfigOptionUpdate`와 동일 shape). adapter가 빈 result로 가정하면 set 직후의 config 상태를 유실한다. (verified: schema-v1.16.0 `$defs.SetSessionConfigOptionResponse`, `required:["configOptions"]`, `props:[configOptions,_meta]`)
- `ConfigOptionUpdate { configOptions: SessionConfigOption[] }` — `config_option_update` notification (전체 set 교체)
- `SessionConfigOption` 상세 구조 (verified, schema-v1.16.0 `$defs`): `required: id, name`. 필드 `{ id: SessionConfigId, name: string, description?: string|null, category?: SessionConfigOptionCategory|null, _meta? }`. 추가로 `type` discriminator(현재 `select`만)가 `oneOf`로 붙고 `select`일 때 `SessionConfigSelect`를 merge한다.
  - `SessionConfigSelect` (`required: currentValue, options`): `{ currentValue: SessionConfigValueId, options: SessionConfigSelectOptions }` — 단일 값 selector(dropdown).
  - `SessionConfigSelectOptions`는 plain `SessionConfigSelectOption[]` 또는 그룹핑된 `SessionConfigSelectGroup[]`를 담는다.
  - `SessionConfigSelectOption` (`required: value, name`): `{ value: SessionConfigValueId, name: string, description?: string|null, _meta? }`.
  - `SessionConfigSelectGroup` (`required: group, name, options`): `{ group: SessionConfigGroupId, name: string, options: SessionConfigSelectOption[], _meta? }`.

### Session Info
- `SessionInfoUpdate { title?:string\|null, updatedAt?:string\|null(ISO8601) }` — `session_info_update` notification. null = clear.
- `SessionInfo`(session/list 결과 item) `{ sessionId, cwd, additionalDirectories?, title?, updatedAt? }`

### Usage
- `UsageUpdate { used:uint64, size:uint64, cost?:Cost\|null }` — `usage_update` notification. used=context 내 토큰, size=context window 총량.
- `Cost { amount:number, currency:string(ISO4217) }`

### Available commands (slash commands)
- `AvailableCommandsUpdate { availableCommands: AvailableCommand[] }`
- `AvailableCommand { name, description, input?:AvailableCommandInput\|null }`
- `AvailableCommandInput` = `anyOf`. 현재 정의된 variant는 `unstructured`(`UnstructuredCommandInput { hint: string (required), _meta? }`, 명령 이름 뒤에 입력된 텍스트 전체를 input으로 받음)뿐이다(verified: schema-v1.16.0 `$defs.AvailableCommandInput` / `$defs.UnstructuredCommandInput`). `anyOf`이므로 향후 다른 input variant가 추가될 수 있다 — slash command 입력을 파싱하는 adapter는 알 수 없는 variant를 방어적으로(예: unstructured로 fallback 또는 무시) 처리해야 한다.

### Plan
- `Plan { entries: PlanEntry[] }` — 갱신 시 **전체 목록 재전송**(client가 통째 교체).
- `PlanEntry { content, priority: PlanEntryPriority, status: PlanEntryStatus }` (셋 다 required)
- `PlanEntryPriority`: `high` | `medium` | `low`
- `PlanEntryStatus`: `pending` | `in_progress` | `completed`

---

## 11. Error codes (verified)

`Error { code:int32, message:string, data?:any }`. `ErrorCode` (anyOf):

| code | 의미 |
|---|---|
| `-32700` | Parse error (invalid JSON) |
| `-32600` | Invalid request |
| `-32601` | Method not found |
| `-32602` | Invalid params |
| `-32603` | Internal error |
| `-32000` | **Authentication required** (ACP 전용) |
| `-32002` | **Resource not found** (ACP 전용) |
| (그 외 정수) | Other (implementation-defined; `-32000~-32099` 예약 범위) |

---

## 12. ID / scalar 타입 (verified)

전부 JSON string (RequestId 제외).

| 타입 | JSON | 비고 |
|---|---|---|
| `SessionId` | string | 세션 식별자 |
| `ToolCallId` | string | tool call 식별자(세션 내) |
| `PermissionOptionId` | string | |
| `SessionModeId` | string | |
| `AuthMethodId` | string | |
| `MessageId` | string | 메시지 식별자(청크 그룹핑) |
| `TerminalId` | string | |
| `SessionConfigId` / `SessionConfigValueId` | string | |
| `RequestId` | JSON-RPC id (number 또는 string) | JSON-RPC envelope의 `id` |
| `ProtocolVersion` | integer (uint16, 0–65535) | |

---

## 13. CLCOMX normalized model 매핑

CLCOMX 공통 모델은 `04-normalized-agent-model.md` 기준. 아래는 ACP v1 wire → CLCOMX `AgentEvent`/하위 타입 매핑.

### 13.1 Lifecycle / 상태

| ACP wire | CLCOMX | 비고 |
|---|---|---|
| `initialize` 협상 완료 | (내부) `ProviderRef.provider="claude"` 확정 | event 아님 |
| `session/new` result `sessionId` | `session_started { ref.sessionId, cwd }` | |
| `session/load` (replay 중 update들) | `session_loaded` + 각 update를 transcript 재구성 | load는 응답 전 update 스트림 |
| `session/resume` result | `session_loaded` (replay 없음) | |
| `session/prompt` 전송 | `session_status_changed: running` | accepted 개념은 response가 아니라 turn 시작 |
| `session/prompt` result `stopReason=end_turn/max_*` | `turn_completed { status:"completed" }` + `session_status_changed: idle` | |
| `session/prompt` result `stopReason=cancelled` | `turn_completed { status:"cancelled" }` | |
| `session/prompt` result `stopReason=refusal` | `turn_completed { status:"completed" }` + UI 거부 표시 | refusal은 CLCOMX status enum에 없음 → metadata 보존 |
| `current_mode_update` | (모드 상태 갱신; 직접 매핑 event 없음) | `ProviderRef.raw`/metadata에 보존 |

> **수정 권고**: `06-claude-acp-adapter.md`와 `04-...`가 `state_update: running/requires_action/idle`를 언급하지만, **ACP v1에는 `state_update` notification이 존재하지 않는다**. 상태는 (a) `session/prompt` 응답의 `stopReason`, (b) `tool_call`/`tool_call_update`의 `status`, (c) `session/request_permission` 수신(=requires_action 추론)으로만 도출된다. adapter는 이 신호들을 합성해 `AgentSessionStatus`를 만들어야 한다. `requires_action`은 ACP wire 신호가 아니라 "permission request pending" 상태를 client가 합성한 것.

### 13.2 메시지 / content

| ACP `session/update` variant | CLCOMX event |
|---|---|
| `user_message_chunk` | `user_message { mode: chunk면 append }` (messageId로 upsert) |
| `agent_message_chunk` | `agent_message_delta { delta }` 또는 `agent_message { mode:"append" }` |
| `agent_thought_chunk` | `agent_message_delta { delta, channel:"thought" }` 또는 `agent_message { mode:"replace", channel:"thought" }` — thought 채널 스트림에 append/reconcile (정본 해소됨, 04 §3.2.2 / 04 §3.3, 15 §3) |
| `plan` | `plan_updated { entries }` (전체 교체) |
| `tool_call` | `tool_call_updated { update }` (신규 upsert) |
| `tool_call_update` | `tool_call_updated { update }` (부분 갱신, 바뀐 필드만) |
| `available_commands_update` | (command palette 갱신) — 모델에 전용 event 없음 |
| `session_info_update` | (세션 title/updatedAt 갱신) — 전용 event 없음 |
| `usage_update` | `turn_completed.usage` 또는 별도 usage 반영 |

`ContentBlock` → `AgentContent` 매핑:
| ACP | CLCOMX `AgentContent` |
|---|---|
| `text` | `{ type:"text", text }` |
| `image` | `{ type:"image", uri?, mimeType }` (ACP는 base64 `data`; CLCOMX는 uri 중심 → adapter가 data URI 또는 저장 후 uri 생성) |
| `audio` | (CLCOMX 모델에 audio 없음 → unverified gap) |
| `resource_link` | `{ type:"resource", uri, mimeType? }` |
| `resource`(embedded text) | `{ type:"resource", uri, mimeType?, text }` |
| `resource`(embedded blob) | `{ type:"resource", uri, mimeType? }` (blob은 별도 보존) |
| ToolCallContent `diff` | `{ type:"diff", path, patch }` (ACP는 oldText/newText → adapter가 patch 생성) |
| ToolCallContent `terminal` | `{ type:"terminal", output }` (terminalId로 output 조회) |

### 13.3 Tool call

ACP `ToolCall`/`ToolCallUpdate` → CLCOMX `ToolCallUpdate`:
| ACP field | CLCOMX | 비고 |
|---|---|---|
| `toolCallId` | `id` | |
| `title` | `title` | |
| `kind` | `kind` | `switch_mode` → `other`로 축약 |
| `status` | `status` | ACP에 `cancelled` 없음; client 합성으로만 `cancelled` |
| `content[]` | `content[]` (replace) | |
| `locations[]` | `locations[]` (`{path,line?,column?}`; ACP엔 column 없음) | |
| `rawInput`/`rawOutput` | `rawInput`/`rawOutput` | 그대로 보존 |

### 13.4 Permission / approval

| ACP | CLCOMX |
|---|---|
| `session/request_permission` request | `approval_requested { request: ApprovalRequest }` |
| `RequestPermissionRequest.toolCall` | `ApprovalRequest.toolCallId` + 본문 |
| `PermissionOption{optionId,name,kind}` | `ApprovalOption{id:optionId,label:name,kind}` |
| `PermissionOptionKind` | `ApprovalOption.kind` (ACP엔 `cancel`/`other` 없음 → 1:1 사용) |
| response `{outcome:"selected",optionId}` | `ApprovalDecision{outcome:"selected",optionId}` |
| response `{outcome:"cancelled"}` | `ApprovalDecision{outcome:"cancelled"}` |
| (client 내부 에러) | `ApprovalDecision{outcome:"failed"}` — wire로는 안 보냄 |

### 13.5 Terminal / file

| ACP | CLCOMX |
|---|---|
| `terminal/create`+`terminal/output` | `terminal_output_delta { ptyId, seq, delta }` (adapter가 polling/streaming 합성) |
| `terminal/wait_for_exit` 결과 | `process_exited`/tool call 완료 신호 |
| `Diff { path, oldText, newText }` | `FileChangeSummary { path, operation, diff }` (operation은 oldText=null→create 추론) |
| `fs/read_text_file`/`fs/write_text_file` | client 측 실제 IO (event 아님; CLCOMX runtime이 처리) |

---

## 14. Open questions / unverified

- (해소됨) `HttpHeader` 필드 → Section 9에서 verified(`{name, value, _meta?}`).
- (해소됨) `SessionConfigOption`/`SessionConfigSelect*` 계열 필드 단위 구조 → Section 10에서 verified로 전개.
- (해소됨) `AuthMethodAgent` 필드 → Section 3.2에서 verified(`{id, name, description?, _meta?}`).
- v2(draft)의 정확한 params/result shape — `meta.json` 메서드 목록만 확인, draft이므로 본문 미전개(unverifiable as stable).
- (해소됨) `agent_thought_chunk`(thought): 전용 event variant 없이 `agent_message`/`agent_message_delta`의 `channel:"thought"`로 매핑한다(정본 04 §3.2.2 / 04 §3.3, 15 §3). 잔여 gap은 `audio`뿐이다.
- CLCOMX 모델 gap: `audio` content에 대응하는 CLCOMX content가 모델에 없음. v1은 미지원으로 두고 `raw` 보존만 함(15 §3 audio gap 주석). UI 처리 정책 결정 필요.
- `requires_action` / `running` / `idle` 상태는 ACP wire 신호가 아니라 client 합성. 합성 규칙(특히 permission pending↔requires_action) 확정 필요.

---

## 15. 출처

| 소스 | ref | 비고 |
|---|---|---|
| `schema/v1/schema.json` | `schema-v1.16.0` | wire 타입 전체(JSON Schema). 본 문서 2–12장의 모든 타입 verified 근거 |
| `schema/v1/meta.json` | `schema-v1.16.0` | method/notification 이름 verified |
| `schema/v2/meta.json` | `schema-v1.16.0` | v2 draft 메서드 목록(차이 확인용) |
| `agent-client-protocol-schema/src/version.rs` | `schema-v1.16.0` | `LATEST=V1`, V2 unstable 확인 |
| docs: transports.md | v1 (live, 2026-06 조사) | stdio/stdout purity 규칙 인용 |
| docs: overview.md | v1 | JSON-RPC, conventions, 메서드 목록, error handling |
| docs: prompt-turn.md | v1 | turn lifecycle, cancellation 규칙 인용 |
| docs: initialization 페이지 | v1 | 버전 협상 규칙 |
| `@agentclientprotocol/claude-agent-acp` `package.json` | commit `23626c9` | Claude ACP agent 구현체 버전 `0.51.0` 확인 |

- 프로토콜 저장소: https://github.com/agentclientprotocol/agent-client-protocol
- Claude ACP agent 구현체 저장소: https://github.com/agentclientprotocol/claude-agent-acp
- 문서 사이트: https://agentclientprotocol.com
- 조사 시점: 2026-06-25. protocol stable version = **1**, schema tag = **schema-v1.16.0**, Claude agent (`@agentclientprotocol/claude-agent-acp`) = **0.51.0** (commit `23626c9`).

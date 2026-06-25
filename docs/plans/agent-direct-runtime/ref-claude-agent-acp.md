# Reference: @agentclientprotocol/claude-agent-acp 어댑터 + Claude Agent SDK

> 이 문서는 CLCOMX가 Claude를 ACP agent로 직접 실행할 때 참조하는 외부 사실 모음이다.
> 다운스트림 구현 에이전트는 이 문서만 읽고도 어댑터 process를 launch하고 capability를
> 협상할 수 있어야 한다. 추정과 확인된 사실을 구분하며, 확인된 사실에는 출처와 git ref를 단다.

## 버전 고정(version pinning)

| 항목 | 값 | 출처 |
|---|---|---|
| npm 패키지 | `@agentclientprotocol/claude-agent-acp` | `npm view` |
| 문서 기준 버전 | **0.51.0** (조사 당시 latest) | `npm view @agentclientprotocol/claude-agent-acp version` → `0.51.0` |
| git ref | tag `v0.51.0`, commit `23626c9a43b4fa2b4e98cf1abb25c55985711075` | `gh api repos/agentclientprotocol/claude-agent-acp/tags` |
| 의존 `@anthropic-ai/claude-agent-sdk` | `0.3.187` | package.json dependencies |
| 의존 `@agentclientprotocol/sdk` | `0.29.0` | package.json dependencies |
| `zod` | `^3.25.0 \|\| ^4.0.0` | package.json dependencies |
| node engine | `>=22` | package.json `engines` |
| module type | ESM (`"type": "module"`) | package.json |

> 작업 지시는 "0.50.0 부근"을 언급했으나 실제 latest는 0.51.0이며 0.50.0도 tag로 존재한다
> (`v0.50.0` commit `07911601ccd2b8d8628aed545f7715c6aa0fa429`). 이 문서는 **0.51.0**을 기준으로
> 한다. **권고: package.json에 정확한 버전(예: `0.51.0`)으로 핀하고 caret 범위를 쓰지 말 것.**
> 0.x 단계라 minor 단위로 protocol/capability가 바뀐다(버전 히스토리 0.25.0~0.51.0).

### 구버전(deprecated)과의 관계

`@zed-industries/claude-code-acp`는 **rename되어 deprecated**되었다. 마지막 버전은 `0.16.2`이고,
npm `deprecated` 필드에 다음 메시지가 박혀 있다(출처: `npm view @zed-industries/claude-code-acp deprecated`):

> "This package has been renamed to @agentclientprotocol/claude-agent-acp. Please migrate to continue receiving updates."

차이 요약:

| 항목 | 구버전 `@zed-industries/claude-code-acp` | 신버전 `@agentclientprotocol/claude-agent-acp` |
|---|---|---|
| bin 이름 | `claude-code-acp` | `claude-agent-acp` |
| bin 경로 | `dist/index.js` | `dist/index.js` |
| repo | `github.com/zed-industries/claude-code-acp` | `github.com/agentclientprotocol/claude-agent-acp` |
| 상태 | deprecated, 업데이트 중단 | 활성 |

**새 dependency에는 신버전만 쓴다.** bin 이름이 다르므로 launch 커맨드를 그대로 옮기면 안 된다.

---

## 1. 어댑터 process 실행 방법

### bin 진입점

| 항목 | 값 | 출처 |
|---|---|---|
| bin 이름 | `claude-agent-acp` | package.json `bin` |
| bin 경로 | `dist/index.js` | package.json `bin` (`{ "claude-agent-acp": "dist/index.js" }`) |
| shebang | `#!/usr/bin/env node` | `src/index.ts` 1행 |
| library main | `dist/lib.js` | package.json `main` (`src/lib.ts`로 빌드) |
| 배포 파일 | `dist/`(단 `dist/tests/` 제외), `README.md`, `LICENSE`, `package.json` | package.json `files` |

### 실행 모드

`src/index.ts`는 `process.argv`에 `--cli`가 있는지로 두 갈래로 갈린다.

- **ACP agent 모드(기본, `--cli` 없음)**: stdio JSON-RPC ACP server로 동작한다.
  `runAcp()`를 호출하고 `process.stdin.resume()`로 event loop를 유지한다. `src/lib.ts`는
  `ClaudeAcpAgent`, `runAcp`, `planEntries`, `toolInfoFromToolUse`, `toolUpdateFromToolResult`,
  `toDisplayPath`, `SettingsManager`(+`SettingsManagerOptions`), `ClaudePlanEntry`,
  `isLocalCommandMetadata`, `stripLocalCommandMetadata`, `toAcpNotifications`,
  `streamEventToAcpNotifications` 등을 export한다(verified: `src/lib.ts`, ref `23626c9`).
  `console.log/info/warn/debug`를 모두 `console.error`로 redirect해서 **stdout에는 ACP
  message만** 흐르게 만든다(출처: `src/index.ts`). → CLCOMX는 stdout을 순수 JSON-RPC로,
  stderr를 log로 다뤄야 한다.
- **CLI passthrough 모드(`--cli`)**: `claudeCliPath()`로 native claude 바이너리를 찾아
  나머지 argv를 그대로 넘겨 `spawn(..., { stdio: "inherit" })`한다. 주로 **interactive
  login**(`claude /login`)에 쓰인다. auth method가 이 모드를 호출한다(아래 인증 절 참고).

### 실행 커맨드 예시 (executable + argv)

ACP transport는 **stdio**다. 별도 transport 인자가 없다.

```jsonc
// CLCOMX runtime이 subprocess로 launch (개념 예시)
{
  // 권장: dependency로 설치된 패키지의 bin 절대 경로를 직접 실행
  "command": "/usr/bin/node",                       // node 절대 경로 (which node)
  "args": [
    "/abs/path/to/node_modules/@agentclientprotocol/claude-agent-acp/dist/index.js"
  ],
  "env": {
    // 아래 "환경변수" 절 참고. 인증은 보통 ~/.claude 자격증명 또는 ANTHROPIC_API_KEY
  }
}
```

선택지별 trade-off:

| 방식 | 커맨드 | 비고 |
|---|---|---|
| 직접 node 실행(권장) | `node <abs>/dist/index.js` | shebang/PATH 의존 없음, WSL에서 가장 안정적 |
| bin 심볼릭 실행 | `<abs>/node_modules/.bin/claude-agent-acp` | shebang `env node`가 PATH의 node를 찾음 |
| npx | `npx -y @agentclientprotocol/claude-agent-acp` | 첫 실행에 네트워크/캐시 fetch 발생 가능, 지연·비결정성 → runtime launch엔 비권장 |

> **확인된 사실**: bin은 `dist/index.js` 하나뿐이고, transport 선택용 CLI 플래그는 stdio가
> 기본이다(코드상 transport 인자 없음). `--cli`, `--hide-claude-auth`만 argv로 해석된다
> (출처: `src/index.ts`, `src/acp-agent.ts` `shouldHideClaudeAuth`).

### claude native binary 해석

어댑터는 별도로 claude CLI를 PATH에서 찾지 않는다. `claudeCliPath()`가 다음 순서로 해석한다
(출처: `src/acp-agent.ts` 394–432행):

1. `process.env.CLAUDE_CODE_EXECUTABLE`가 있으면 그 값.
2. 없으면 `@anthropic-ai/claude-agent-sdk`의 platform별 optional dependency에 번들된 native
   바이너리를 `createRequire(import.meta.resolve(...))`로 resolve.
   - linux: libc 감지 후 `@anthropic-ai/claude-agent-sdk-linux-<arch>(-musl)/claude` 우선.
   - 못 찾으면 에러: *"Claude native binary not found ... Reinstall ... without --omit=optional,
     or set CLAUDE_CODE_EXECUTABLE."*

즉 **로컬에 별도 claude CLI 설치가 필수는 아니다.** SDK의 번들 바이너리를 쓴다. 단,
`npm install --omit=optional`로 설치하면 바이너리가 빠져 실패하므로 optional dep을 포함해 설치해야 한다.

> 로컬 환경 확인값(인용): `claude --version` → `2.1.187 (Claude Code)`; `node --version` →
> `v24.14.0`; `which node` → `/home/melbin/.nvm/versions/node/v24.14.0/bin/node`. (조사 머신 기준,
> CLCOMX 배포 대상과 다를 수 있음 — unverified for target.)

### 환경변수

| 환경변수 | 역할 | 출처 |
|---|---|---|
| `CLAUDE_CODE_EXECUTABLE` | claude native 바이너리 경로 강제 지정 | `claudeCliPath`, SDK `pathToClaudeCodeExecutable` |
| `CLAUDE_CONFIG_DIR` | 설정/자격증명 디렉터리(기본 `~/.claude`) | `src/acp-agent.ts` 108행 |
| `ANTHROPIC_API_KEY` | API key 인증(아래 인증 절) | Agent SDK overview 문서 |
| `CLAUDE_CODE_USE_BEDROCK` / `CLAUDE_CODE_USE_VERTEX` / `CLAUDE_CODE_USE_FOUNDRY` / `CLAUDE_CODE_USE_ANTHROPIC_AWS` | 서드파티 provider 라우팅 | Agent SDK overview 문서 |
| `ANTHROPIC_MODEL`, `CLAUDE_MODEL_CONFIG`, `ANTHROPIC_CUSTOM_MODEL_OPTION` | 모델 선택/커스텀 | `src/acp-agent.ts` (3826/3854행 등) |
| `MAX_THINKING_TOKENS` | thinking budget(legacy alias → SDK `thinking`) | `src/acp-agent.ts` 4585행 |
| `IS_SANDBOX` | root여도 bypassPermissions 허용 | `ALLOW_BYPASS` (454행) |
| `NO_BROWSER`, `SSH_CONNECTION`, `SSH_CLIENT`, `SSH_TTY`, `CLAUDE_CODE_REMOTE` | remote 환경 감지 → terminal login 방식 전환 | initialize (761–767행) |

추가로, ACP 모드 시작 시 `resolveSettings({ settingSources: [] })`로 managed-policy tier의
`env`를 읽어 `process.env`에 주입한 뒤 SDK를 호출한다(출처: `src/index.ts`). macOS MDM /
Windows HKLM·HKCU 정책 env도 이 경로로 들어온다.

### 인증(authentication) 전제

어댑터는 `initialize`에서 **클라이언트 capability에 따라 auth method 목록을 동적으로 제시**한다
(출처: `src/acp-agent.ts` 725–870행). 정리:

| auth method id | type | 조건 | 동작 |
|---|---|---|---|
| `claude-ai-login` | `terminal` | **non-remote** AND terminal auth 지원 AND `!shouldHideClaudeAuth()` | `args: ["--cli","auth","login","--claudeai"]`(구독 로그인) |
| `console-login` | `terminal` | **non-remote** AND terminal auth 지원 (`--hide-claude-auth` 게이트 **없음**) | `args: ["--cli","auth","login","--console"]`(Console API 과금) |
| `claude-login` | `terminal` | **remote 환경**(SSH 등) AND terminal auth 지원 AND `!shouldHideClaudeAuth()` | `args: ["--cli"]` → `claude /login` 안내 |
| `gateway` / `gateway-bedrock` | (meta) | client가 `auth._meta.gateway === true` 광고 | 커스텀 model gateway. `_meta.gateway.protocol`이 각각 `"anthropic"` / `"bedrock"` |

여기서 "terminal auth 지원"은 `clientCapabilities.auth.terminal === true` **또는**
`clientCapabilities._meta["terminal-auth"] === true`를 뜻한다(`supportsTerminalAuth` /
`supportsMetaTerminalAuth`, 754–755행). `_meta["terminal-auth"]`를 광고하면 어댑터는 각 method에
`_meta["terminal-auth"] = { command: process.execPath, args: [...process.argv.slice(1), ...subcommand], label }`을
추가로 채워 클라이언트가 직접 로그인 프로세스를 spawn할 수 있게 한다(775–832행).

> **remote 분기 주의**: SSH 등 remote 환경에서는 **`claude-login` 하나만** 제시되며,
> `claude-ai-login`/`console-login`은 제시되지 않는다(`isRemote` if-branch, 770–791행).
> non-remote(else)에서만 `claude-ai-login`/`console-login`이 나온다(792–832행).
> (출처: `src/acp-agent.ts`, ref `23626c9`.)

> **authenticate RPC의 실제 처리**: `authenticate(params)`는 `methodId`가 `gateway`/`gateway-bedrock`일
> 때만 `params`를 `gatewayAuthRequest`로 보관하고 return하며, 그 외(terminal method)는
> `throw new Error("Method not implemented.")`한다(946–952행). 즉 **terminal 로그인은 ACP
> `authenticate`로 수행되지 않고** `--cli` passthrough로 별도 실행한다. gateway는 `authenticate`로
> 자격을 등록한 뒤 query 호출 시 `createEnvForGateway`가 env를 합성한다(3096행, 3448–3470행):
> - `gateway`: `ANTHROPIC_BASE_URL = _meta.gateway.baseUrl`, `ANTHROPIC_CUSTOM_HEADERS`(=`_meta.gateway.headers`를 `key: value` 줄로 join), `ANTHROPIC_AUTH_TOKEN=" "`.
> - `gateway-bedrock`: `CLAUDE_CODE_USE_BEDROCK="1"`, `ANTHROPIC_BEDROCK_BASE_URL = _meta.gateway.baseUrl`, `AWS_BEARER_TOKEN_BEDROCK=" "`, `ANTHROPIC_CUSTOM_HEADERS`.
>
> 따라서 클라이언트는 gateway 인증 시 `authenticate` 요청의 `_meta.gateway.{baseUrl, headers}`를
> 채워 보내야 한다. (출처: `src/acp-agent.ts`, ref `23626c9`.)

핵심:

- **이미 `claude` 로그인이 되어 있으면**(`~/.claude` 또는 `CLAUDE_CONFIG_DIR`에 자격증명 존재)
  별도 ACP `authenticate` 없이 바로 `session/new`가 가능하다(일반 케이스).
- 로그인 안 된 상태에서 구독/Console 인증은 **terminal type auth method**다. 즉 CLCOMX 클라이언트가
  `terminal` 또는 `_meta["terminal-auth"]` capability를 광고해야 어댑터가 그 method를 제시하고,
  실제 로그인은 `--cli ...` passthrough를 별도 터미널에서 돌려 수행한다.
- **API key 경로**: `ANTHROPIC_API_KEY`(또는 Bedrock/Vertex/Foundry env)를 env로 주면 SDK가
  그 자격으로 동작한다. 이 경우 interactive login은 불필요.
- SDK 문서 주의: Anthropic은 서드파티 제품에서 claude.ai 로그인/rate limit 제공을 일반적으로
  허용하지 않으며 API key 방식을 권장한다(출처: Agent SDK overview, "branding/auth note").

> **확인된 사실**: ACP lifecycle은 `initialize` → (필요 시 `authenticate`) → `session/new`
> 또는 `session/load`(`loadSession: true`) → `session/prompt` → `session/update` 수신이다
> (capability는 §2, mode 매핑은 §3 참고).

---

## 2. 어댑터가 광고하는 ACP capability

`initialize`는 **항상** `protocolVersion: 1`을 반환한다(출처: `src/acp-agent.ts` 836행).
`agentCapabilities`는 다음과 같다(837–860행, 정확한 코드 인용):

```ts
agentCapabilities: {
  _meta: { claudeCode: { promptQueueing: true } },
  promptCapabilities: {
    image: true,
    embeddedContext: true,
  },
  mcpCapabilities: {
    http: true,
    sse: true,
  },
  loadSession: true,
  sessionCapabilities: {
    additionalDirectories: {},
    close: {},
    delete: {},
    fork: {},
    list: {},
    resume: {},
  },
}
```

### capability 표 (README 광고 vs 코드 근거)

| ACP capability | 지원 | 코드/README 근거 |
|---|---|---|
| **Image (prompt content)** | 예 | `promptCapabilities.image: true` (844행); README "Images" |
| **Context @-mention / embedded context** | 예 | `promptCapabilities.embeddedContext: true` (845행); README "Context @-mentions" |
| **Tool calls + permission request** | 예 | `canUseTool` → `session/request_permission` (2487행~); README "Tool calls (with permission requests)" |
| **Edit review** | 예 | README "Edit review"; tool_call content로 diff 전달(`src/tools.ts`) |
| **TODO / plan list** | 예 | README "TODO lists"; `planEntries`/`plan` update(`src/tools.ts`, `planEntries` export in `lib.ts`) |
| **Terminal (interactive·background)** | 예(클라이언트 capability 게이트) | README "Interactive (and background) terminals"; `_meta.terminal_info/terminal_output/terminal_exit`, `clientCapabilities._meta["terminal_output"]` 게이트(2490·4101·4253–4352행) |
| **Slash commands (custom)** | 예 | README "Custom Slash commands"; `availableCommands`/`getAvailableSlashCommands` (1422·2740행) |
| **Client MCP servers** | 예(http·sse) | `mcpCapabilities: { http: true, sse: true }` (847–850행); README "Client MCP servers"; mcp server env 매핑(3006행) |
| **loadSession (대화 복원)** | 예 | `loadSession: true` (851행) |
| **Session 관리(close/delete/fork/list/resume + additionalDirectories)** | 예 | `sessionCapabilities` (852–859행) |
| **Following** | 예 | README "Following" |
| **Elicitation (form / url)** | 예(클라이언트 capability 게이트) | `clientCapabilities.elicitation.form` / `.url`(2503·3053·1507행). MCP elicitation 및 `AskUserQuestion`을 form으로 surface |
| **Prompt queueing** | 예 | `_meta.claudeCode.promptQueueing: true` (840행) |
| **Gateway auth** | 조건부 | client가 `auth._meta.gateway` 광고 시 (730·868행) |

> **주의(게이트)**: terminal·elicitation·gateway는 **agent가 일방적으로 켜는 게 아니라
> 클라이언트가 `initialize`의 `clientCapabilities`에서 광고해야** 활성화된다. CLCOMX가 ACP
> client로서 다음을 광고해야 해당 기능이 동작한다:
> - terminal output: `clientCapabilities._meta["terminal_output"] === true`
> - terminal auth: `clientCapabilities.auth.terminal === true` 또는 `_meta["terminal-auth"]`
> - elicitation: `clientCapabilities.elicitation.form` / `.url`
> - gateway auth: `clientCapabilities.auth._meta.gateway === true`

### 어댑터가 바인딩하는 wire RPC method (verified)

어댑터는 `connect()` 시점에 다음 ACP method를 바인딩한다(`src/acp-agent.ts` 4515–4533행). wire
method 문자열은 `@agentclientprotocol/sdk@0.29.0`의 `dist/schema/schema.json`에 리터럴로 정의된 값과
일치하며(아래 출처), 어댑터는 SDK의 `methods.agent.*` 상수로 바인딩한다.

| wire method | kind | 방향 | 어댑터 핸들러 | verified |
|---|---|---|---|---|
| `initialize` | request | client→agent | `initialize` | 예 (schema.json) |
| `authenticate` | request | client→agent | `authenticate` (gateway만 구현, 그 외 throw) | 예 (schema.json) |
| `session/new` | request | client→agent | `newSession` | 예 (schema.json) |
| `session/load` | request | client→agent | `loadSession` | 예 (schema.json) |
| `session/prompt` | request | client→agent | `prompt`(`runPromptWithCancellation`) | 예 (schema.json) |
| `session/cancel` | notification | client→agent | `cancel` | 예 (schema.json) |
| `session/set_mode` | request | client→agent | `setSessionMode` → `{}` | 예 (schema.json, `methods.agent.session.setMode`) |
| `session/set_config_option` | request | client→agent | `setSessionConfigOption` → `{ configOptions }` | 예 (schema.json, `methods.agent.session.setConfigOption`) |
| `session/fork` | request | client→agent | `unstable_forkSession` | 예 (schema.json) |
| `session/list` | request | client→agent | `listSessions` | 예 (schema.json) |
| `session/delete` | request | client→agent | `deleteSession` | 예 (schema.json) |
| `session/resume` | request | client→agent | `resumeSession` | 예 (schema.json) |
| `session/close` | request | client→agent | `closeSession` | 예 (schema.json) |
| `session/request_permission` | request | **agent→client** | `canUseTool` 매핑(§3) | 예 (schema.json) |
| `session/update` | notification | **agent→client** | streaming(아래 variant 표) | 예 (schema.json) |

> 출처: `@agentclientprotocol/sdk` 0.29.0 `dist/schema/schema.json`(wire 문자열) + `src/acp-agent.ts`
> 4515–4533행(`.onRequest(methods.agent.session.setMode, ...)` 등 바인딩), ref `23626c9`.
> (이전 판에서 `session/set_mode`·`available_commands_update`를 "추정"으로 표기했으나, sdk
> 0.29.0 schema.json에 리터럴로 존재함이 확인되어 verified로 승격한다.)

#### `session/set_config_option` (verified)

- **요청 파라미터**: `{ sessionId, configId, value }`. schema의 `SetSessionConfigOptionRequest`는
  `sessionId`·`configId`를 required로 두고 `value`(`SessionConfigValue`: boolean 또는
  value_id string 다형)를 받는다(`additionalProperties: true`). 어댑터는 `params.value`를 후보
  `configOptions`에서 찾아 검증하고, `model` configId는 `resolveModelPreference`로 alias("opus"·"sonnet" 등)도
  허용한다(2330–2356행).
- **응답**: `SetSessionConfigOptionResponse = { configOptions }` — 갱신된 전체 옵션 배열을 돌려준다
  (2372행). 어댑터는 `configId === "mode"`면 `applySessionMode` 후 `current_mode_update`도 emit한다.
- **side-effect 주의**: ExitPlanMode로 mode가 바뀌거나 `setSessionMode`가 호출되면 어댑터는
  `updateConfigOption(sessionId, "mode", mode)`를 호출해 `config_option_update`(아래)를 emit한다.
  즉 **mode 변경은 `current_mode_update`와 `config_option_update` 양쪽으로 통지**될 수 있으므로,
  세션 config 상태를 추적하는 클라이언트는 둘 다 처리해야 한다(2298·2571·3138행).
- 출처: sdk 0.29.0 schema.json `SetSessionConfigOption{Request,Response}`, `SessionConfigOption`,
  `SessionConfigValue`; `src/acp-agent.ts` `setSessionConfigOption`/`updateConfigOption`, ref `23626c9`.

#### `session/update` SessionUpdate variant 집합 (verified)

`session/update` notification의 `update.sessionUpdate` discriminant는 **`@agentclientprotocol/sdk@0.29.0`의
`schema/schema.json`** `SessionUpdate` oneOf에 **13종**으로 정의된다(아래 전체). 이 SDK도
`PROTOCOL_VERSION = 1`을 협상한다(verified: `dist/schema/index.js:51 export const PROTOCOL_VERSION = 1;`).
CLCOMX가 실행하는 어댑터 `@agentclientprotocol/claude-agent-acp@0.51.0`이 이 SDK에 의존하므로 런타임
wire에 실제 등장할 수 있는 정본 variant 집합은 **이 13종**이다. 클라이언트 parser는 모르는 variant를
graceful하게 무시할 수 있어야 한다.

> **출처 분기 주의 (verified, 1차 소스 재검증 2026-06-25)**: 같은 `protocolVersion = 1`인데도
> agent-client-protocol 저장소 **`schema-v1.16.0`의 `schema/v1/schema.json`**은 `SessionUpdate`
> oneOf를 **11종**으로만 정의하며 `plan_update`/`plan_removed`가 **없다**. 즉 `plan_update`/`plan_removed`는
> **sdk 0.29.0 schema 전용 추가분**이고 protocol-repo schema-v1.16.0 v1 wire에는 존재하지 않는다
> (같은 protocolVersion=1의 서로 다른 schema cut). `ref-acp-protocol.md §2`와 이 표는 동일한 13종
> 정본 집합을 공유하며 출처 표기만 다르다. verified:
> `gh api repos/agentclientprotocol/agent-client-protocol/contents/schema/v1/schema.json?ref=schema-v1.16.0`(11종),
> npm tarball `@agentclientprotocol/sdk@0.29.0` `schema/schema.json`(13종).

| SessionUpdate variant | 출처 | 어댑터 emit | 비고 |
|---|---|---|---|
| `agent_message_chunk` | 양쪽 schema 공통 | 예 (1278·1290·1300·1346·1483·1608행) | assistant 텍스트 스트림. **`agent_message`가 아니라 `agent_message_chunk`** |
| `agent_thought_chunk` | 양쪽 schema 공통 | 예 (4157행) | thinking/extended-thinking 스트림 |
| `user_message_chunk` | 양쪽 schema 공통 | (replay 경로) | session/load 등 user 메시지 재생 |
| `tool_call` | 양쪽 schema 공통 | 예 (1394·4264행) | tool 호출 시작 |
| `tool_call_update` | 양쪽 schema 공통 | 예 (1447·2064·4218·4247·4342·4355행) | tool 진행/완료, terminal meta 동승 |
| `plan` | 양쪽 schema 공통 | 예 (3154·3173·4174·4315행) | TODO/plan 리스트 |
| `plan_update` | **sdk 0.29.0 schema 전용** (schema-v1.16.0 v1엔 없음) | (미관측) | plan 증분 갱신 |
| `plan_removed` | **sdk 0.29.0 schema 전용** (schema-v1.16.0 v1엔 없음) | (미관측) | plan 제거 |
| `available_commands_update` | 양쪽 schema 공통 | 예 (1421·2739행) | `availableCommands` 키, `getAvailableSlashCommands` |
| `current_mode_update` | 양쪽 schema 공통 | 예 (2359·2567·2857·3134행) | `currentModeId` 필드 |
| `config_option_update` | 양쪽 schema 공통 | 예 (2758행) | `configOptions` 전체 배열 |
| `session_info_update` | 양쪽 schema 공통 | (미관측) | schema에 존재 |
| `usage_update` | 양쪽 schema 공통 | 예 (1335·1576·1805·2082행) | `{ used, size }` 토큰 사용량 |

> 출처: sdk 0.29.0 `schema/schema.json` `SessionUpdate` oneOf(13 variant) + `src/acp-agent.ts`
> emit 지점(행번호), ref `23626c9`. "어댑터 emit (미관측)"은 schema에는 있으나 이 조사에서 어댑터
> emit 코드를 확인하지 못한 variant — 클라이언트는 무시 가능해야 한다.
> (참고: 이 표의 SDK schema 경로는 `dist/schema/schema.json`이 아니라 패키지 루트 `schema/schema.json`이다 — 재검증으로 정정.)

#### 로컬 처리 slash command (verified)

`LOCAL_ONLY_COMMANDS = new Set(["/context", "/heapdump", "/extra-usage"])`(458행). 이들은 SDK가
user 메시지를 replay하지 않고 모델 호출 없이 **로컬에서 처리**하는 slash command다. slash command를
UI에 노출하는 클라이언트는 이 셋을 별도 취급해야 한다(974행에서 prefix 매칭). 출처: `src/acp-agent.ts`,
ref `23626c9`.

---

## 3. Claude Agent SDK permission mode ↔ ACP session mode / request_permission 매핑

### SDK permission mode (출처: code.claude.com/docs/en/agent-sdk/permissions)

| mode | 의미 |
|---|---|
| `default` | 자동 승인 없음. 미매칭 tool은 `canUseTool` 콜백으로 |
| `acceptEdits` | 파일 편집/`mkdir·rm·mv·cp·sed` 등 fs 작업 자동 승인(working dir·additionalDirectories 한정) |
| `bypassPermissions` | 전부 자동 승인(deny rule·ask rule·hook은 여전히 우선). root에서는 비활성 |
| `plan` | 탐색·계획만. 파일 편집은 allow rule이 있어도 자동 승인 안 되고 `canUseTool`로 prompt |
| `dontAsk` | prompt 대신 거부. 사전 승인된 것만 통과, `canUseTool` 호출 안 함 |
| `auto` (TS 전용) | 모델 분류기가 호출별 승인/거부 |

평가 순서: **Hooks → deny rules → ask rules → permission mode → allow rules → `canUseTool`**.
`canUseTool`은 `{ behavior: "allow", updatedInput, updatedPermissions? }` 또는
`{ behavior: "deny", message }`를 반환한다(출처: permissions/user-input 문서, 코드의 반환 shape).

### 어댑터의 매핑 동작 (출처: `src/acp-agent.ts`)

**ACP session mode ↔ SDK permissionMode는 동일 id를 그대로 사용한다.** `setSessionMode`가
`modeId`를 받아 `applySessionMode`로 검증 후 `query.setPermissionMode(modeId)`를 호출한다
(`setSessionMode` 2285행, `applySessionMode` 2375–2407행). `applySessionMode`의 switch는 **여섯 개**
modeId를 받는다: `auto`, `default`, `acceptEdits`, `bypassPermissions`, `dontAsk`, `plan`. 그 외 값은
`throw new Error("Invalid Mode")`(2385행). 추가로 modeId는 **해당 세션의 `session.modes.availableModes`에
존재**해야 하며, 없으면 `Mode <id> is not available in this session`을 throw한다(2392행). `setSessionMode`는
성공 시 빈 객체 `{}`를 반환하고, 부수적으로 `updateConfigOption(sessionId, "mode", modeId)`를 호출해
`config_option_update`를 보낸다(2297–2298행, §아래 set_config_option 참조).
(출처: `src/acp-agent.ts`, ref `23626c9`.)

문자열 alias 정규화(`PERMISSION_MODE_ALIASES`, 541–549행 — **일곱 항목**):

| 입력 alias | → SDK PermissionMode |
|---|---|
| `auto` | `auto` |
| `default` | `default` |
| `acceptedits` | `acceptEdits` |
| `dontask` | `dontAsk` |
| `plan` | `plan` |
| `bypasspermissions` / `bypass` | `bypassPermissions` |

`resolvePermissionMode`는 인식 못 하는 값/허용 안 되는 값은 `default`로 떨어뜨리고, root에서
`bypassPermissions`는 거부(`ALLOW_BYPASS = !IS_ROOT || !!IS_SANDBOX`, 454행)한다.

**availableModes**는 `buildAvailableModes(modelInfo)`로 모델별로 산출된다(3477–3520행). 구성:
- **항상 포함**: `default`, `acceptEdits`, `plan`, `dontAsk` (이 순서로 push).
- `modelInfo?.supportsAutoMode === true`일 때만 `auto`를 맨 앞에 포함.
- `ALLOW_BYPASS`가 true일 때만 `bypassPermissions`를 맨 끝에 포함.

즉 `dontAsk`는 **정상적으로 항상 광고되는 ACP session mode**이며, `auto`는 모델 게이트, `bypassPermissions`는
root/sandbox 게이트다. 각 mode는 `{ id, name, description }` 형태로 광고된다(예: `dontAsk` →
name `"Don't Ask"`, description `"Don't prompt for permissions, deny if not pre-approved"`).
(출처: `src/acp-agent.ts` `buildAvailableModes`, ref `23626c9`.)

### request_permission 매핑 (canUseTool → ACP `session/request_permission`)

`canUseTool(sessionId)`는 tool별로 다음과 같이 ACP `session/request_permission`을 보낸다
(2487–2654행):

1. **`AskUserQuestion`** + client `elicitation.form` → permission이 아니라 **form elicitation**으로
   surface, 답을 tool `updatedInput`으로 환원(2503행).
2. **`ExitPlanMode`** → 다음 옵션 목록으로 request_permission 전송(2507–2585행):

   | optionId | kind | label | 선택 시 |
   |---|---|---|---|
   | `bypassPermissions` | `allow_always` | "Yes, and bypass permissions" | `ALLOW_BYPASS`일 때만 노출. mode 전환 |
   | `auto` | `allow_always` | 'Yes, and use "auto" mode' | mode 전환(모델이 지원할 때만) |
   | `acceptEdits` | `allow_always` | "Yes, and auto-accept edits" | mode 전환 |
   | `default` | `allow_once` | "Yes, and manually approve edits" | mode 전환 |
   | `plan` | `reject_once` | "No, keep planning" | 거부, plan 유지 |

   `ExitPlanMode` 옵션은 `session.modes.availableModes`로 필터링된다(2531행). 선택된 mode가
   `default/acceptEdits/auto/bypassPermissions`면 ACP `session/update`로 `current_mode_update`
   (`currentModeId`)를 보내고 `updatedPermissions: [{ type: "setMode", ... }]`로 SDK에 반영한다
   (2564–2579행). **추가로** `updateConfigOption(sessionId, "mode", selectedMode)`를 호출하므로
   `config_option_update`도 함께 emit된다(2571행). 즉 클라이언트는 plan 종료 후 mode 전환을
   `current_mode_update`와 `config_option_update` 양쪽에서 받을 수 있다.
3. **현재 mode가 `bypassPermissions`** → request 없이 즉시 `allow`, `updatedPermissions`는
   `addRules`(2588–2596행).
4. **그 외 일반 tool** → 3-option request_permission(2598–2653행):

   | optionId | kind | label | 결과 |
   |---|---|---|---|
   | `allow_always` | `allow_always` | (`describeAlwaysAllow`로 생성한 라벨) | `behavior: "allow"` + `addRules`(session) |
   | `allow` | `allow_once` | "Allow" | `behavior: "allow"` |
   | `reject` | `reject_once` | "Reject" | `behavior: "deny"` |

   응답 `outcome`이 `cancelled`이거나 signal abort면 "Tool use aborted"로 throw.

> CLCOMX가 ACP client로서 받는 `session/request_permission` request의 `options[].optionId`/`kind`는
> 위 표대로다. UI는 label을 그대로 보여주되 i18n key로 감싸고, turn cancel 시 `cancelled` outcome을
> 돌려줘야 한다(기존 `06-claude-acp-adapter.md`의 permission 규칙과 일치).

### SDK query 호출 시 어댑터가 넣는 permission 관련 옵션

`query(...)` options에 다음을 넣는다(출처: `src/acp-agent.ts` 3093–3116행 근방):

- `env: { ...process.env, ...userProvidedOptions?.env }`
- `allowDangerouslySkipPermissions: ALLOW_BYPASS`
- `pathToClaudeCodeExecutable: process.env.CLAUDE_CODE_EXECUTABLE ?? (await claudeCliPath())`
- `canUseTool`: 위의 콜백
- 설정 병합은 `SettingsManager`(SDK `resolveSettings` + `filterEscalatingDefaultMode`)로 처리해
  repo-committed 소스의 escalating `permissions.defaultMode`(예: 강제 bypass)는 무시(`src/settings.ts`).

---

## 4. ACP protocol version / 스키마 호환성

| 항목 | 값 | 출처 |
|---|---|---|
| `initialize` 응답 `protocolVersion` | `1` (정수 고정) | `src/acp-agent.ts` 836행 |
| `@agentclientprotocol/sdk` 버전 | `0.29.0` | package.json |
| ACP 사이트 | https://agentclientprotocol.com | README |

- **wire protocolVersion(=1)** 과 **npm 패키지 semver(0.51.0 / sdk 0.29.0)** 는 서로 다른 축이다.
  wire 버전은 정수 1로 협상하고, 어댑터/SDK 기능 차이는 npm semver로 추적된다.
- CLCOMX는 `initialize`에서 자신의 `protocolVersion`을 보내고 어댑터가 `1`을 회신하는지 확인,
  불일치 시 protocol error로 처리(기존 `06-claude-acp-adapter.md` "stdout에 ACP 아닌 text 섞이면
  protocol error" 원칙과 동일 선상).
- 0.x 라인이라 minor마다 capability·session mode·meta key가 바뀔 수 있다. **정확한 버전 핀 +
  CI에서 capability 회귀 테스트**를 권장.

---

## 5. WSL 환경에서 node 기반 bin 실행 전제

| 전제 | 설명 |
|---|---|
| node 위치 | bin shebang은 `#!/usr/bin/env node` → PATH의 node를 찾는다. nvm 등으로 node가 비표준 경로(예: `/home/<user>/.nvm/.../bin/node`)에 있으면, launch 시 그 node의 절대경로를 직접 쓰는 편이 안전 |
| node 버전 | `engines.node >= 22`. WSL의 node가 22 미만이면 실행 실패 |
| 직접 실행 vs npx | runtime launch는 **`node <abs>/dist/index.js`** 직접 실행 권장. npx는 첫 호출 시 fetch/resolve로 지연·비결정성 발생 |
| absolute path 요구 | 이 어댑터/스크립트 cwd가 호출 간 reset될 수 있으므로 bin·node 모두 **절대경로**로 지정. ACP wire의 file mention도 absolute path/file URI로 정규화(기존 `06-claude-acp-adapter.md`와 동일) |
| optional dependency | claude native 바이너리는 SDK의 platform별 optional dep. `--omit=optional` 설치 금지. linux는 glibc/musl 자동 감지 |
| 자격증명 경로 | `~/.claude`(또는 `CLAUDE_CONFIG_DIR`). WSL과 Windows는 홈이 다르므로 어느 쪽 claude로 로그인했는지 주의 |
| stdout 청결 | stdout=ACP JSON-RPC 전용, stderr=log. WSL에서 셸 startup 메시지가 stdout에 새지 않게 launch env를 깨끗이 |

---

## 6. 미확인 사항 (unverified)

> 아래 항목은 검증 시점(ref `23626c9`, sdk `0.29.0`)에 1차 소스에서 직접 확인하지 못한 것만 남긴다.
> wire method 문자열(`session/set_mode`·`session/set_config_option`·`available_commands_update` 등),
> SessionUpdate variant 집합, `src/lib.ts` export 표면, alias/mode 집합은 §2–§3에서 verified로 승격됨.

- `@agentclientprotocol/sdk` 0.29.0의 `request_permission` / `session/update` / `ClientCapabilities`
  **TypeScript 타입(.d.ts) 원문**은 직접 열람하지 않았다. wire method·discriminant·set_config_option
  요청/응답 shape는 동일 패키지의 `dist/schema/schema.json`으로 확정했으나, 정확한 TS 타입 import는
  구현 시 sdk `dist/schema/types.gen.d.ts`로 재확인 권장.
- ACP wire `protocolVersion: 1` 외에 client가 더 높은 버전을 보낼 때의 negotiation 분기는 어댑터
  코드(`src/acp-agent.ts`)에 명시적 분기를 확인하지 못했다 — sdk `Connection` 레벨 처리로 추정.
- `following`/`edit review`의 tool_call content/diff **세부 매핑**은 `src/tools.ts`
  (`toolInfoFromToolUse`, `toolUpdateFromToolResult`, `planEntries`) 전문을 이 조사에서 읽지 않았다.
  (export 존재는 `src/lib.ts`로 확인됨; 내부 content shape는 미확인.) 구현 시 `src/tools.ts` 확인 필요.
- `SettingsManager`의 `filterEscalatingDefaultMode`가 repo-committed 소스의 escalating
  `permissions.defaultMode`를 무시한다는 §3 마지막 항목의 동작은 `src/settings.ts`를 직접 열람해
  확정하지 않았다(export 존재만 `src/lib.ts`로 확인). 구현 시 `src/settings.ts` 확인 필요.
- Anthropic이 서드파티 제품에서 claude.ai 로그인/rate limit 제공을 일반적으로 허용하지 않는다는 §1
  "branding/auth note"는 fetch한 permissions 페이지에서 정확한 문구를 찾지 못했다 — overview 페이지로
  확인 필요(unverified wording).
- 로컬 `claude --version 2.1.187`, `node v24.14.0`, `which node` 경로는 조사 머신 값이며 CLCOMX
  배포 대상과 다를 수 있다. 어댑터가 실제 쓰는 바이너리는 SDK 번들
  (`@anthropic-ai/claude-agent-sdk-linux-*`)일 수 있어 버전이 다를 수 있다(unverified for target/runtime).
- 0.50.0 vs 0.51.0의 정확한 diff(capability 변화 여부)는 CHANGELOG를 본 문서에서 인용하지 않았다.

---

## 출처

| URL | ref | 비고 |
|---|---|---|
| https://github.com/agentclientprotocol/claude-agent-acp | tag `v0.51.0` / `23626c9` | repo, README, `src/*.ts` |
| https://www.npmjs.com/package/@agentclientprotocol/claude-agent-acp | 0.51.0 | `npm view` 메타(bin·main·deps·engines) |
| https://www.npmjs.com/package/@zed-industries/claude-code-acp | 0.16.2 | deprecated rename 메시지 |
| https://code.claude.com/docs/en/agent-sdk/overview | (조사일 2026-06-25) | SDK 개요·sessions·hooks·subagents·MCP·tools |
| https://code.claude.com/docs/en/agent-sdk/permissions | (조사일 2026-06-25) | permission mode·canUseTool·평가순서 |
| https://agentclientprotocol.com | - | ACP 프로토콜 |

# Codex App Server Adapter

> 이 문서는 Codex **app-server protocol v2**(thread/turn/item)를 CLCOMX `AgentRuntimePort`(15 §6)와 `AgentEvent`(15 §3)로 변환하는 어댑터를 **구현 가능 수준**으로 설계한다. 다운스트림 구현 에이전트는 이 문서 + [`15-data-contracts.md`](15-data-contracts.md)(타입 정본) + [`04-normalized-agent-model.md`](04-normalized-agent-model.md)(규칙 정본) + [`ref-codex-app-server-protocol.md`](ref-codex-app-server-protocol.md)(wire 정본, pinned `rust-v0.142.0`)만 읽고 어댑터를 작성할 수 있어야 한다.
>
> **역할 분리(엄수)**:
> - 모든 normalized 타입(`AgentEvent`/`ProviderRef`/`ToolCallUpdate`/`Approval*`/`AgentRuntimeStartParams`/`JsonRpcMessage` …)은 **재정의하지 않는다**. 15의 §번호로 인용한다.
> - 상태 전이·upsert/reconcile·approval 생명주기 규칙은 [04](04-normalized-agent-model.md)의 §번호로 인용한다.
> - Codex wire 사실(method/notification/payload/enum)은 [ref-codex](ref-codex-app-server-protocol.md)의 §번호로 인용한다.
> - 코드 현실(feature 레이어·transport 래퍼·host 분기)은 [`research/codebase-frontend.md`](research/codebase-frontend.md), [`research/codebase-backend.md`](research/codebase-backend.md)의 §번호로 인용한다.
> - 미확정 사항은 본문에서 `unverified` 또는 `결정 필요`로 표시하고 [13](13-risks-open-questions.md)으로 연결한다.

조사 시점: 2026-06-25. 코드 정합 기준 브랜치: `feat/claude-tui-fullscreen-option`. Codex wire 정본 ref: `rust-v0.142.0`(로컬 `codex-cli 0.142.0`).

---

## 0. 이 어댑터가 책임지는 것 / 책임지지 않는 것

CLCOMX는 hexagonal 경계를 둔다([03](03-target-architecture.md) §Provider Adapter). 책임 경계를 명확히 한다.

**Codex adapter가 책임지는 것 (이 문서)**:

1. Codex app-server lifecycle 오케스트레이션: `initialize` → `initialized` → `thread/start`|`thread/resume` → `turn/start`. (§2)
2. inbound Codex JSON-RPC(`JsonRpcMessage`, 15 §8.1) → `AgentEvent`(15 §3) 순수 변환. (§4, §5)
3. `(threadId, turnId, itemId)` 삼중 키 라우팅과 delta→completed reconcile([04](04-normalized-agent-model.md) §3). (§6)
4. approval server-request → `approval_requested`, `respondApproval` → Codex `JSONRPCResponse`, cancel cleanup([04](04-normalized-agent-model.md) §4). (§7)
5. command output delta(thread 채널/standalone 채널 구분), error/exit 처리. (§8, §9)
6. `AgentRuntimePort`(15 §6) 7개 메서드의 Codex 구현. (§3)

**책임지지 않는 것 (다른 문서/레이어)**:

- process spawn / stdio framing / stderr 캡처 / bounded queue: Rust backend(`agent_runtime_*` command, 15 §8 / [07](07-tauri-process-runtime.md)). 어댑터는 **raw JSON-RPC만** `agentRuntimeSend`로 내보내고 `agent-runtime-message`로 받는다(15 §8.3). protocol 의미 해석은 backend가 하지 않는다.
- transcript store 적용(upsert 실제 mutation): `agent-runtime-controller` + `transcript-reducer`([`research/codebase-frontend.md`](research/codebase-frontend.md) §8). 어댑터는 `AgentEvent`를 emit만 하고 store를 직접 만지지 않는다.
- WSL path canonicalize / executable resolve / allowlist: backend command handler([07](07-tauri-process-runtime.md) §8.1, §WSL/Windows 경계). **S1 정본**: 어댑터는 실행 파일 `command`를 **만들지 않는다** — backend가 `provider`로 신뢰 절대경로를 resolve한다. 어댑터는 `args`(검증 대상)와 `env`(non-secret)만 채운다(§2.2).
- UI 렌더(tool card/approval dialog): [08](08-ui-composition.md).

> 결론: 이 어댑터는 **순수 변환 + lifecycle 상태 기계**다. I/O는 transport 래퍼(15 §8.2의 `agentRuntimeSend`/`agentRuntimeStart` 등)를 통해서만 한다([`research/codebase-frontend.md`](research/codebase-frontend.md) §4.1). 직접 `@tauri-apps/api`를 import하지 않는다(15 §0.6).

---

## 1. 파일 배치와 모듈 경계

모듈 배치 정본은 [12](12-implementation-workstreams.md) §0.1(단일 출처, D4)이다. Codex 어댑터는 다음 파일로 구성한다(모두 신규 생성).

```
src/lib/features/agent-runtime/
├── contracts/
│   ├── normalized.ts                       # 15 §1–§5 정본 타입 (이 어댑터는 import만)
│   └── runtime-port.ts                     # 15 §6 AgentRuntimePort (이 어댑터가 구현)
├── service/
│   └── transport.ts                        # 15 §8.2 invoke 래퍼 (agentRuntimeStart/Send/Cancel/Shutdown/GetSnapshot)
├── generated/
│   └── codex-app-server/                   # codex app-server generate-ts 산출 타입(§11; mapper가 import)
└── adapters/
    └── codex/
        ├── codex-app-server-adapter.ts     # ★ 본 문서의 1차 산출물: AgentRuntimePort(Codex) + lifecycle
        ├── codex-wire-mapper.ts            # ★ 순수 함수: JsonRpcMessage → AgentEvent[] (테스트 핵심)
        ├── codex-launch.ts                 # buildCodexStartParams: AgentRuntimeStartParams(provider:"codex") 생성
        ├── codex-routing.ts                # (threadId,turnId,itemId) 라우팅 + pending request/approval table
        └── *.test.ts                       # vitest (mapper/routing 단독 테스트, §10)
```

> `adapters/<provider>/` 배치는 12 §0.1 정본이다. controller/service와 별개로 "provider wire ↔ normalized 변환"을 provider별 디렉토리에 모은다(03 §Provider Adapter 권위 — adapter는 service/가 아니라 adapters/codex/ 아래). 같은 규약으로 Claude ACP 어댑터는 `adapters/claude-acp/`([06](06-claude-acp-adapter.md)), legacy PTY는 `adapters/legacy-pty/`에 들어간다.

**레이어 규약 준수**([`research/codebase-frontend.md`](research/codebase-frontend.md) §1.2):

- `codex-wire-mapper.ts`는 **순수 함수만**(룬·I/O·side-effect 금지). `JsonRpcMessage` in → `AgentEvent[]` out. vitest로 단독 테스트(§10).
- `codex-routing.ts`는 라우팅/pending table 상태를 plain class로 보유(룬 불필요 — 어댑터 내부 상태이며 transcript store가 아니다). controller가 주입받아 사용.
- `codex-app-server-adapter.ts`는 `AgentRuntimePort` 구현체이며 transport 래퍼(`transport.ts`)와 mapper/routing을 DI로 받는다.

---

## 2. Lifecycle 오케스트레이션 (연결 → ready → turn)

### 2.1 연결 방식 (검증됨 / 미확정 분리)

ref-codex §1.1(로컬 `codex app-server --help` 0.142.0 실행 결과)에 근거한 **검증된 사실**:

- 권장 기동: `codex app-server`(기본 `--listen stdio://`) 또는 명시적으로 `codex app-server --stdio`.
- app-server 명령 자체는 `[experimental]` 라벨이 붙지만 **별도 experimental 플래그 없이 stdio로 동작**한다(ref-codex §1.1). 즉 `--experimental` 같은 전역 플래그는 기동에 필요하지 않다.
- 단, protocol 내 일부 *필드/메서드*는 `#[experimental("...")]` gating이 있고, client가 `initialize.capabilities`로 opt-in 해야 노출된다(ref-codex §1.4). 어댑터는 **안정 필드만 의존**하고 experimental 필드는 `ProviderRef.raw`에 보존한다(15 §0.2).

따라서 **CLCOMX v1 연결 결정**:

1. stdio + newline-delimited JSON-RPC를 **유일한 1차 transport**로 한다(`transportKind: "jsonrpc-stdio"`, 15 §8.1). websocket(`ws://`)은 검증 후 optional, 1차 미구현([07](07-tauri-process-runtime.md) §Runtime 종류, [13](13-risks-open-questions.md)).
2. `codex exec` JSONL SDK 경로는 fixture 참고로만 쓰고 런타임 경로로 쓰지 않는다(ref-codex §10 마지막 항목 — SDK는 app-server JSON-RPC와 1:1이 아닐 수 있음).
3. WSL 경계 유지: backend가 **로그인 셸 비경유(shell-less)** 정본으로 띄운다 — `wsl.exe -d <distro> --cd <wslWorkDir> -e env KEY=VAL … <codexAbsPath> app-server --stdio`(executable=**backend가 resolve한 codex 신뢰 절대경로(S1)**, argv=`["app-server","--stdio"]`). 07 §5.1 launch 정본(`wsl.exe -d <distro> --cd <wslWorkDir> -e env KEY=VAL … <executable> <argv...>`)과 동일 형태이며, non-secret env가 없으면 `env KEY=VAL` prefix 없이 `-e <codexAbsPath> …`로 직접 exec한다([07](07-tauri-process-runtime.md) §5.1, §8). 기존 PTY가 쓰던 `bash -li -c "<cmd>"` 형태(로그인 셸 경유)는 **쓰지 않는다** — rc 파일 stdout 출력이 JSON-RPC framing(purity)을 깨뜨릴 위험을 셸 비경유로 원천 차단한다(07 §5.1 OQ-28 해소 주석, 06 §2.3와 일치). **S1 정본**: executable은 renderer가 넘기지 않으며 backend가 `provider="codex"`로 신뢰 절대경로를 resolve해 R4 절대경로 allowlist로 재검증한다(07 §8.1 — basename 비교 폐지; 동명 `/tmp/codex` 거부). args는 backend가 정확히 `["app-server","--stdio"]`로 재검증한다(07 §8.1).

**미확정 → [13](13-risks-open-questions.md)**:

- `ClientInfo` / `InitializeCapabilities`의 정확한 필드와 capability opt-in 키(experimental 노출 제어 방식)는 ref-codex §10에서 unverified로 남아 있다. v1은 `capabilities: null`(ref-codex §2.1 예시)로 보내고 experimental 표면을 opt-in하지 않는다.
- `initialize`→`initialized` 핸드셰이크가 thread/start 전 **필수**인지는 ref-codex §10/§2.2에서 unverified(권장 순서일 뿐). v1은 안전하게 핸드셰이크를 항상 수행한다.

### 2.2 launch params 생성 (`codex-launch.ts`)

**S1 정본**: 어댑터/renderer는 **실행 파일 `command`를 생성하지 않는다**. renderer는 untrusted이므로 `AgentRuntimeStartParams`(15 §8.1)에서 `command` 필드가 제거되었고, backend가 `provider`로 **신뢰 절대경로를 resolve**한다(`codex` → backend가 resolve·캐시한 `codex` app-server 절대경로). 동명 바이너리(`/tmp/codex`) 우회는 불가하다(07 §8.1 R4 — basename 비교 폐지, 절대경로·정확 args·env key allowlist). 어댑터는 `provider`/`distro`/`workDir`/`args`(검증 대상)/`env`(non-secret)만 넘기고, backend가 provider별 allowlist로 재검증한다([07](07-tauri-process-runtime.md) §8.1, [`research/codebase-backend.md`](research/codebase-backend.md) §6·§10 권고 6).

```ts
// adapters/codex/codex-launch.ts
import type { AgentRuntimeStartParams } from "../../service/transport";

export interface CodexLaunchInput {
  distro: string;
  workDir: string;            // WSL absolute path (backend가 canonicalize, 07 §WSL 경계)
  extraEnv?: Record<string, string>;  // ⚠️ non-secret env 전용(07 §5.1·09). secret(API key/token/header)은
                                      //    argv 경유 금지 — env() + WSLENV passthrough만(07/09, OQ-28).
}

export function buildCodexStartParams(input: CodexLaunchInput): AgentRuntimeStartParams {
  return {
    transportKind: "jsonrpc-stdio",
    provider: "codex",
    distro: input.distro,
    workDir: input.workDir,
    // S1 정본: command 미생성. backend가 provider="codex"로 신뢰 절대경로(codex app-server)를
    //   resolve·재검증한다(07 §8.1 validate_and_extract; renderer 비제어).
    // ref-codex §1.1: stdio 기본. 명시적으로 --stdio 부여(실험 플래그 불필요).
    // 07 §5.1 정본: backend는 셸 비경유로
    //   `wsl.exe -d <distro> --cd <workDir> -e env … <codexAbsPath> app-server --stdio`로 exec한다.
    args: ["app-server", "--stdio"],   // 07 §8.1: backend가 정확히 ["app-server","--stdio"]로 재검증.
    env: input.extraEnv,               // non-secret 전용(07 §5.1·09). secret은 argv 비경유(env()+WSLENV).
  };
}
```

> **S1 — `command` 미생성 (정본)**: codex 실행 파일은 backend가 `provider`로 resolve한 신뢰 절대경로를 사용한다(07 §8.1 `resolve_trusted_executable`/`validate_and_extract`: backend resolve 또는 사전 등록 절대경로 화이트리스트와 정확 일치). renderer가 `command`/`codexBin`을 넣을 경로 자체가 없어 동명 바이너리(`/tmp/codex`) 우회가 불가하다. resolve 주체·캐시 무효화·`codex` 탐색 방식은 [13](13-risks-open-questions.md) "command/entry resolve 주체"에 결정 필요로 등록.
> `args`에 `--experimental`을 넣지 않는다(ref-codex §1.1: 기동에 불필요). experimental 필드가 필요해지면 `initialize.capabilities`로 opt-in해야 하며 이는 v1 범위 밖([13](13-risks-open-questions.md)).
> codex 절대경로/버전 확인은 backend resolve 시점·startup preflight에서 수행한다([11](11-testing-acceptance.md), [09](09-permissions-security.md)). 로컬 `codex --version`과 pinned ref 일치(`0.142.0`)는 ref-codex §0에 기록.

### 2.3 핸드셰이크 시퀀스 (의사코드)

상태 전이는 [04](04-normalized-agent-model.md) §2.1을 따른다. process spawn과 protocol initialize는 분리한다([07](07-tauri-process-runtime.md) §Process lifecycle, [04](04-normalized-agent-model.md) §2.1 규칙 1).

```text
startSession(params):
  // 1) process spawn (transport만; 아직 starting)
  runtimeId = await agentRuntimeStart(buildCodexStartParams({distro, workDir}))
  bind agent-runtime-message/stderr/exit/error/backpressure listeners (§3.2)
  emit AgentEvent(session_status_changed, status="starting")    // 04 §2.1: process 떴지만 initialize 전

  // 2) initialize handshake (ref-codex §2.1, §2.2)
  initResp = await rpcRequest(runtimeId, "initialize",
                { clientInfo: { name: "clcomx", version: <appVersion> }, capabilities: null })
  //   initResp: { userAgent, codexHome, platformFamily, platformOs }  (ref-codex §2.1)
  store initResp into AgentRuntimeMetadata.providerVersion 후보 (15 §7.1; userAgent 파싱)
  sendNotification(runtimeId, "initialized")                    // ref-codex §2.2, params 없음

  // 3) thread/start (ref-codex §3.1) — 새 thread
  startResp = await rpcRequest(runtimeId, "thread/start",
                { cwd: workDir /*, model?, sandbox? — §2.4 */ })
  //   startResp: { thread: Thread, ... }  (ref-codex §9 시퀀스)
  threadId = startResp.thread.id
  routing.setThread(threadId, startResp.thread.sessionId)       // §6
  emit AgentEvent(session_started, ref{provider:"codex", threadId, sessionId}, cwd=thread.cwd)
  emit AgentEvent(session_status_changed, status="ready")       // 04 §2.1 규칙 1
  return { ref: { provider:"codex", threadId, sessionId } }     // SessionStartResult (15 §6)
```

> `thread/started` notification(ref-codex §5.1)은 `thread/start` response와 **별개로** 도착할 수 있다(ref-codex §9 시퀀스, §10 ordering unverified). 어댑터는 `session_started`를 **response 기준**으로 emit하고, 뒤따르는 `thread/started` notification은 동일 threadId면 멱등 처리(중복 emit 금지). 매핑표(ref-codex §8)는 `thread/started`→`session_started`지만, response가 먼저 threadId를 확정하므로 v1은 response를 권위로 삼고 notification은 thread 메타 보강용으로만 쓴다.

### 2.4 turn 시작 (`sendPrompt`)

```text
sendPrompt(sessionHandle, input: SendPromptInput):       // 15 §6
  threadId = routing.threadIdOf(sessionHandle)
  codexInput = mapAgentContentToUserInput(input.content) // §5.3d outbound (AgentContent → UserInput[])
  resp = await rpcRequest(runtimeId, "turn/start",
           { threadId, input: codexInput })              // ref-codex §6.5 TurnStartParams (안정 필드만)
  turnId = resp.turn.id                                  // ref-codex §3.2 TurnStartResponse {turn}
  routing.setActiveTurn(threadId, turnId)                // §6
  // session_status_changed(running)는 turn/started notification 또는 resp 둘 중 먼저 도착하는 것으로 emit(멱등)
```

`turn/start` params는 **안정 필드만** 채운다(ref-codex §6.5): `threadId`, `input`. `model`/`effort`/`sandboxPolicy`/`approvalPolicy` 등 override는 settings 연동 시 추가하되 experimental 필드(`environments`/`permissions`/`collaborationMode` 등)는 넣지 않는다(ref-codex §6.5 주석, §1.4). approval 정책 키는 `approvalPolicy`(타입 `AskForApproval`, kebab-case: `untrusted`/`on-failure`/`on-request`/`never`)이며, sandbox 키는 `sandboxPolicy`(타입 `SandboxPolicy`)임에 주의(ref-codex §6.5 주석). v1 기본값/노출 여부는 [09](09-permissions-security.md)와 [13](13-risks-open-questions.md)에서 확정(결정 필요).

### 2.5 resume / load (`resumeSession`)

ref-codex §3.1: `thread/resume`(`ThreadResumeParams`)는 기존 thread 재개, `thread/read`(`ThreadReadParams { threadId, includeTurns? }`)는 thread 내용 읽기(replay).

```text
resumeSession(params: ResumeSessionParams):              // 15 §6
  runtimeId = await agentRuntimeStart(buildCodexStartParams(...))
  bind listeners; initialize/initialized handshake (§2.3 1~2단계)
  if params.replay:
    // replay: 과거 transcript 복원 (10 §replay)
    readResp = await rpcRequest(runtimeId, "thread/read",
                 { threadId: params.providerThreadId, includeTurns: true })  // ref-codex §3.1
    threadId = readResp.thread.id
    routing.setThread(threadId, readResp.thread.sessionId)
    emit AgentEvent(session_loaded, ref{threadId, sessionId})
    replayThread(readResp.thread)   // §5.4: Thread.turns[].items[] → AgentEvent[] 재생
  else:
    resumeResp = await rpcRequest(runtimeId, "thread/resume",
                   { threadId: params.providerThreadId /*, ThreadResumeParams 잔여 필드 */ })
    threadId = resumeResp.thread.id
    routing.setThread(threadId, resumeResp.thread.sessionId)
    emit AgentEvent(session_loaded, ref{threadId, sessionId})
  emit AgentEvent(session_status_changed, status="ready")
  return { ref: { provider:"codex", threadId } }
```

> `ThreadResumeParams`/`ThreadReadResponse`의 정확한 필드는 ref-codex §3.1에 method 카탈로그로만 있다. v1은 `threadId`(persist된 `providerThreadId`, 15 §7.1)와 `includeTurns`만 사용하고 잔여 필드는 미설정(unverified는 [13](13-risks-open-questions.md)). resume 키 영속화·scrub은 [10](10-persistence-migration.md) §저장 모델, 15 §7.3.

---

## 3. `AgentRuntimePort` (Codex 구현) 시그니처

정본 interface는 15 §6. Codex 어댑터는 이를 구현하며, transport 래퍼·mapper·routing을 DI로 받는다(테스트 가능성, [`research/codebase-frontend.md`](research/codebase-frontend.md) §1.5).

```ts
// adapters/codex/codex-app-server-adapter.ts
import type {
  AgentRuntimePort, AgentSessionHandle, StartSessionParams, ResumeSessionParams,
  SendPromptInput, SessionStartResult,
} from "../../contracts/runtime-port";
import type { AgentEvent, ApprovalDecision } from "../../contracts/normalized";
import type { UnlistenFn } from "$lib/tauri/event";
import type { JsonRpcMessage, RuntimeId, AgentRuntimeEvent } from "../../service/transport";
import {
  agentRuntimeStart, agentRuntimeSend, agentRuntimeCancel, agentRuntimeShutdown,
} from "../../service/transport";
import { listen } from "$lib/tauri/event";
import { mapCodexMessage } from "./codex-wire-mapper";
import { CodexRouting } from "./codex-routing";

/** 어댑터 DI. transport·listen·시간/난수 등 I/O를 주입해 vitest로 모킹(1.5 패턴). */
export interface CodexAdapterDeps {
  start: typeof agentRuntimeStart;
  send: typeof agentRuntimeSend;
  cancel: typeof agentRuntimeCancel;
  shutdown: typeof agentRuntimeShutdown;
  listenRuntime: <T = AgentRuntimeEvent>(event: string, h: (e: { payload: T }) => void) => Promise<UnlistenFn>;
  appVersion: string;
  /** JSON-RPC request id 생성기(단조 증가). 테스트에서 결정적으로 주입. */
  nextRpcId: () => number;
}

/** 세션 1개의 Codex 런타임 상태(어댑터 내부, transcript store 아님). */
interface CodexSessionRuntime {
  runtimeId: RuntimeId;
  routing: CodexRouting;                         // §6
  pendingRpc: Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>;
  listeners: Set<(e: AgentEvent) => void>;       // subscribeEvents 구독자
  unlistens: UnlistenFn[];
  closed: boolean;
}

export function createCodexAppServerAdapter(deps: CodexAdapterDeps): AgentRuntimePort {
  const sessions = new Map<AgentSessionHandle, CodexSessionRuntime>();
  // ... §2.3~§2.5 lifecycle, §3.2 listener wiring, §7 approval 구현 ...

  return {
    startSession(params: StartSessionParams): Promise<SessionStartResult> { /* §2.3 */ },
    resumeSession(params: ResumeSessionParams): Promise<SessionStartResult> { /* §2.5 */ },
    sendPrompt(handle: AgentSessionHandle, input: SendPromptInput): Promise<void> { /* §2.4 */ },
    cancelTurn(handle: AgentSessionHandle, turnId?: string): Promise<void> { /* §7.3 */ },
    respondApproval(handle: AgentSessionHandle, decision: ApprovalDecision): Promise<void> { /* §7.2 */ },
    subscribeEvents(handle: AgentSessionHandle, listener: (e: AgentEvent) => void): UnlistenFn { /* §3.2 */ },
    shutdown(handle: AgentSessionHandle): Promise<void> { /* §9 */ },
  };
}
```

### 3.1 RPC request/response 헬퍼

Codex JSON-RPC는 `jsonrpc` 필드를 보내지도 기대하지도 않는다(ref-codex §1.2). request id는 `string | number`(ref-codex §1.2). 어댑터는 number 단조 증가 id를 쓰고 pending table로 매칭한다.

```text
rpcRequest(runtimeId, method, params) -> Promise<result>:
  id = deps.nextRpcId()
  store pendingRpc[id] = {resolve, reject}
  await deps.send(runtimeId, { id, method, params })          // jsonrpc 필드 없음 (15 §8.1, ref-codex §1.2)
  return promise (resolved when JSONRPCResponse{id,result} 도착, §3.2)

sendNotification(runtimeId, method, params?) -> void:
  await deps.send(runtimeId, { method, params })              // id 없음 → notification
```

> `agentRuntimeSend`는 `JsonRpcMessage`(15 §8.1)를 받는다. Codex variant는 `jsonrpc`를 **생략**(Rust 측 `Option`이라 직렬화 제외, 15 §8.2 `JsonRpcMessage::Request`의 `skip_serializing_if`)한다. ACP는 `jsonrpc:"2.0"`을 채운다 — provider별 envelope 차이는 어댑터가 책임진다(15 §8.1 주석).

### 3.2 inbound message 라우팅 (listener wiring)

backend는 `agent-runtime-message`로 raw `JsonRpcMessage`를 올린다(15 §8.3). 어댑터는 runtimeId로 필터하고, message 종류로 분기한다(기존 PTY가 `event.id !== livePtyId`면 무시하는 멀티플렉싱 선례와 동일, [`research/codebase-frontend.md`](research/codebase-frontend.md) §4.2).

```text
onRuntimeEvent(payload: AgentRuntimeEvent):
  if payload.runtimeId !== this.runtimeId: return            // 멀티플렉싱 필터
  switch payload.type:                                       // 15 §8.3
    case "message":  handleMessage(payload.message)
    case "stderr":   (diagnostic only; transcript 비표시 — 07 §Framing)
    case "exit":     handleExit(payload.code, payload.signal) // §9
    case "error":    emit AgentEvent(error, recoverable=payload.recoverable) // §8
    case "backpressure": emit AgentEvent(error, recoverable=true, "backpressure") // §8

handleMessage(msg: JsonRpcMessage):
  if "result" in msg or "error" in msg:                      // JSONRPCResponse / JSONRPCError (ref-codex §1.2)
     resolveRpc(msg.id, msg.result | msg.error)              // §3.1 pending table
     return
  if "id" in msg and "method" in msg:                        // server→client REQUEST (approval 등, ref-codex §4)
     events = mapCodexMessage(msg, routing)                  // → approval_requested (§7.1)
     for e in events: emitToListeners(e)
     return
  if "method" in msg:                                        // server→client NOTIFICATION (ref-codex §5)
     events = mapCodexMessage(msg, routing)                  // → AgentEvent[] (§4, §5)
     for e in events: emitToListeners(e)
```

> **request vs notification 구분 규칙**(ref-codex §1.2): `id` 있고 `method` 있으면 server→client **request**(응답 필요, §7). `method`만 있고 `id` 없으면 **notification**(응답 없음). `id` 있고 `result|error` 있으면 우리가 보낸 request의 **response**.

---

## 4. wire → AgentEvent 매퍼 시그니처 (`codex-wire-mapper.ts`)

핵심 순수 함수. 하나의 inbound `JsonRpcMessage`(notification 또는 server request)를 0개 이상의 `AgentEvent`(15 §3)로 변환한다. routing 상태(§6)를 읽어 `ProviderRef`를 채우고, reconcile 판단을 한다. **side-effect 없음**(emit/store mutation은 호출자가).

```ts
// adapters/codex/codex-wire-mapper.ts
import type { AgentEvent } from "../../contracts/normalized";
import type { JsonRpcMessage } from "../../service/transport";
import type { CodexRouting } from "./codex-routing";

/**
 * 하나의 Codex inbound message → AgentEvent[]. 매핑 정본: ref-codex §8.
 * - notification(method only) 또는 server request(method+id) 모두 처리.
 * - routing은 (threadId,turnId,itemId) 라우팅과 reconcile 판단에 필요(읽기 전용 + item 상태 기록).
 * - 매핑 불가/experimental payload는 ref.raw에 보존(15 §0.2). 미지원 method는 [] 반환(드롭 아님 — 로깅).
 */
export function mapCodexMessage(msg: JsonRpcMessage, routing: CodexRouting): AgentEvent[];

/** 개별 notification 디스패치(테스트 단위 작게 쪼갬). method 문자열로 분기. */
export function mapCodexNotification(method: string, params: unknown, routing: CodexRouting): AgentEvent[];

/**
 * server→client request(approval/elicitation) → approval_requested (§7.1).
 * 미지원 method는 silent-drop 금지(04 §5 / 13 RD-10): pending 정리 후 JSON-RPC error(-32601) 또는
 * 명시적 decline 응답을 wire로 **반드시** 보낸다(§7.1 default·§7.2 sendUnsupportedServerRequest).
 * 무응답 폐기는 server를 영구 대기시켜 deadlock을 유발한다.
 */
export function mapCodexServerRequest(method: string, id: string | number, params: unknown, routing: CodexRouting): AgentEvent[];
```

### 4.1 `ProviderRef` 생성 규칙

모든 Codex `AgentEvent`의 `ref`는 `provider:"codex"`이며, payload에서 `threadId`/`turnId`/`itemId`를 그대로 보존한다(15 §0.1, §1.1). 매핑 안 된 payload는 `raw`에 둔다(15 §0.2).

```ts
function refOf(params: { threadId?: string; turnId?: string; itemId?: string }, raw?: unknown): ProviderRef {
  return {
    provider: "codex",
    threadId: params.threadId,
    turnId: params.turnId,
    itemId: params.itemId,
    // approval일 때만 requestId(=JSON-RPC id) 추가(§7.1)
    raw,
  };
}
```

---

## 5. Notification/Item → AgentEvent 변환 (의사코드)

매핑 정본은 ref-codex §8 표. 아래는 각 method별 변환 알고리즘. **모든 `delta`/`completed` 처리는 [04](04-normalized-agent-model.md) §3 규칙을 따른다.**

### 5.1 thread/turn lifecycle

```text
mapCodexNotification(method, p, routing):
  switch method:

  case "thread/started":                                   // ref-codex §5.1
     routing.ensureThread(p.thread.id, p.thread.sessionId)
     // §2.3 주석: response가 이미 session_started를 emit했으면 멱등(중복 금지)
     return routing.alreadyStarted(p.thread.id) ? []
            : [{ type:"session_started", ref: refOf({threadId:p.thread.id}, p.thread),
                 cwd: p.thread.cwd }]

  case "thread/status/changed":                            // ref-codex §5.1, §8
     return [{ type:"session_status_changed",
               ref: refOf({threadId:p.threadId}),
               status: mapThreadStatus(p.status) }]        // §5.5

  case "turn/started":                                     // ref-codex §5.1
     routing.setActiveTurn(p.threadId, p.turn.id)
     return [{ type:"session_status_changed",
               ref: refOf({threadId:p.threadId, turnId:p.turn.id}),
               status:"running" }]                         // 멱등(sendPrompt와 중복 가능)

  case "turn/completed":                                   // ref-codex §5.1, §8
     routing.clearActiveTurn(p.threadId, p.turn.id)
     usage = routing.takeTokenUsage(p.threadId, p.turn.id) // §5.6 tokenUsage 결합(있으면)
     return [{ type:"turn_completed",
               ref: refOf({threadId:p.threadId, turnId:p.turn.id}),
               status: mapTurnStatus(p.turn.status), usage }] // §5.5

  case "turn/plan/updated":                                // ref-codex §5.1, §6.8
     return [{ type:"plan_updated",
               ref: refOf({threadId:p.threadId, turnId:p.turnId}),
               entries: p.plan.map(mapPlanStep) }]         // §5.5

  case "thread/tokenUsage/updated":                        // ref-codex §5.1, §6.7
     routing.recordTokenUsage(p.threadId, p.turnId, mapTokenUsage(p.tokenUsage)) // §5.6
     return []                                             // turn_completed에 결합(별도 event 안 냄)

  case "error":                                            // ref-codex §5.1, §6.9
     return [{ type:"error",
               ref: refOf({threadId:p.threadId, turnId:p.turnId}, p.error),
               message: p.error.message,
               recoverable: p.willRetry === true }]        // 04 §5; codexErrorInfo는 raw 보존
```

### 5.2 item lifecycle + delta (reconcile)

[04](04-normalized-agent-model.md) §3.2 reconcile 규칙을 그대로 구현한다. reconcile 키는 `itemId`(ref-codex §7).

```text
  case "item/started":                                     // ref-codex §5.2
     return mapItemStarted(p.item, p.threadId, p.turnId)   // §5.3

  case "item/completed":                                   // ref-codex §5.2
     return mapItemCompleted(p.item, p.threadId, p.turnId) // §5.3

  case "item/agentMessage/delta":                          // ref-codex §5.2
     // 04 §3.2 규칙1: 메시지 delta는 append. completed.text가 권위.
     return [{ type:"agent_message_delta",
               ref: refOf({threadId:p.threadId, turnId:p.turnId, itemId:p.itemId}),
               delta: p.delta }]

  case "item/commandExecution/outputDelta":                // ref-codex §5.2 (평문 delta)
     // 04 §3.2 규칙3: thread 채널, 평문. stream 구분 정보 없음 → 기본 stdout.
     return [{ type:"command_output_delta",
               ref: refOf({threadId:p.threadId, turnId:p.turnId, itemId:p.itemId}),
               stream:"stdout", delta: p.delta }]          // §8.1 주석: stream 미구분(unverified)

  case "item/fileChange/patchUpdated":                     // ref-codex §5.2
     return p.changes.map(ch => ({
       type:"file_change_updated",
       ref: refOf({threadId:p.threadId, turnId:p.turnId, itemId:p.itemId}),
       change: mapFileChange(ch) }))                       // §5.3 FileUpdateChange→FileChangeSummary

  case "item/plan/delta":            // EXPERIMENTAL — 04 §3.2.2 (concat ≠ completed)
     // plan delta는 completed가 권위, delta는 점진 렌더링용. v1은 점진 텍스트를
     // 흘리지 않고 completed item에서만 plan_updated로 반영(드롭 아님 — raw 로깅).
     return []

  // reasoning(thought) v1 정책(D11): thought 채널 delta로 흘린다(15 §3 channel 필드).
  // 04 §3.2.2/§3.2.5: thought 채널 delta는 messageId/contentIndex별 append,
  //   completed reasoning item이 thought 채널의 권위(reconcile).
  case "item/reasoning/textDelta":   // ref-codex §5.2, 04 §3.2.5 (contentIndex 누적)
  case "item/reasoning/summaryTextDelta":
     return [{ type:"agent_message_delta",
               ref: refOf({threadId:p.threadId, turnId:p.turnId, itemId:p.itemId}),
               channel:"thought",                          // 15 §3 (D11)
               delta: p.delta }]

  case "serverRequest/resolved":                           // ref-codex §4.4
     // 04 §4.2 규칙3: 해당 requestId의 pending approval을 cancelled로 닫음(사용자 응답 불필요).
     // C4 단계4(멱등 무시): cancelTurn이 이미 closing/closed로 만든 뒤 늦게 도착하면
     //   hasPendingApproval가 false라 [] 반환 → 중복 emit/이중 응답 없음(04 §4.2).
     reqId = String(p.requestId)
     if routing.hasPendingApproval(reqId):
        routing.resolveApproval(reqId)
        return [{ type:"approval_resolved",
                  ref: refOf({threadId:p.threadId}, {requestId:reqId}),
                  decision: { requestId:reqId, outcome:"cancelled" } }]
     return []

  default:
     // 미지원 method(5.4 기타·realtime·hook 등): 드롭하지 않고 debug 로깅, [] 반환. raw는 보존 불가(전역).
     return []
```

### 5.3 ThreadItem → AgentEvent (item type별)

ref-codex §6.3 `ThreadItem`(내부 태그 `type`, camelCase). 매핑 후보는 ref-codex §6.3/§8.

```text
mapItemStarted(item, threadId, turnId):
  ref = refOf({threadId, turnId, itemId: item.id})
  switch item.type:                                        // ref-codex §6.3
    case "userMessage":
       return [{ type:"user_message", ref,
                 content: item.content.map(mapUserInput), mode:"replace" }] // §5.3a
    case "agentMessage":
       routing.beginMessage(item.id)
       return [{ type:"agent_message", ref, content: [], mode:"replace" }]  // 빈 메시지 시작(04 §3.2)
    case "commandExecution":
       return [{ type:"tool_call_updated", ref,
                 update: mapCommandExec(item) }]            // §5.3b
    case "fileChange":
       return [{ type:"tool_call_updated", ref, update: mapFileChangeTool(item) }] // kind:"edit"
    case "mcpToolCall": case "dynamicToolCall": case "webSearch":
       return [{ type:"tool_call_updated", ref, update: mapGenericTool(item) }]     // §5.3c
    case "reasoning":
       // D11: thought 채널 메시지 시작(빈 메시지). delta는 §5.2가 channel:"thought"로 append.
       return [{ type:"agent_message", ref, channel:"thought", content: [], mode:"replace" }]
    case "plan":
       return []                                           // plan delta는 completed가 권위(§5.2)
    default:
       return []                                           // imageView/sleep/collabAgent 등 v1 밖

mapItemCompleted(item, threadId, turnId):
  ref = refOf({threadId, turnId, itemId: item.id})
  switch item.type:
    case "agentMessage":
       // 04 §3.2 규칙1: completed.text가 권위 → replace로 reconcile
       return [{ type:"agent_message", ref,
                 content: [{ type:"text", text: item.text }], mode:"replace" }]
    case "commandExecution":
       // status/exitCode/aggregatedOutput로 tool card 마감
       return [{ type:"tool_call_updated", ref, update: mapCommandExec(item) }]
    case "fileChange":
       return [{ type:"tool_call_updated", ref, update: mapFileChangeTool(item) },
               ...item.changes.map(ch => ({ type:"file_change_updated", ref,
                                            change: mapFileChange(ch) }))]
    case "mcpToolCall": case "dynamicToolCall": case "webSearch":
       return [{ type:"tool_call_updated", ref, update: mapGenericTool(item) }]
    case "userMessage":
       return [{ type:"user_message", ref, content: item.content.map(mapUserInput), mode:"replace" }]
    case "reasoning":
       // D11: completed reasoning item이 thought 채널의 권위 → replace로 reconcile(04 §3.2.2/§3.2.5)
       return [{ type:"agent_message", ref, channel:"thought",
                 content: [{ type:"text", text: item.text }], mode:"replace" }]
    default:
       return []
```

**5.3a `UserInput` → `AgentContent`** (ref-codex §6.4, tagged `type` camelCase):

```text
mapUserInput(u):                          // ref-codex §6.4
  switch u.type:
    case "text":
       // ref-codex §6.4 ⚠️: wire 키는 평문 u.text가 아니라 u.text_elements(snake_case,
       //   타입 TextElement[], 필수). 텍스트 span을 추출·join해 AgentContent text를 만든다.
       return { type:"text",
                text: joinTextElements(u.text_elements),   // span 추출+join (아래)
                raw: u.text_elements }                      // 원본 span 보존(15 §0.2/§4)
    case "image":      return { type:"image", uri: u.url }                  // detail은 raw 보존 가능
    case "localImage": return { type:"image", uri: "file://"+u.path }       // 07 §file path 규칙
    case "skill":      return { type:"text", text: "/"+u.name }             // 근사(결정 필요 13)
    case "mention":    return { type:"text", text: "@"+u.name }

joinTextElements(elements: TextElement[]):  // ref-codex §6.4 TextElement[]
  // 각 element에서 텍스트 span을 뽑아 순서대로 이어붙인다. 텍스트 span이 없는
  // element(있을 경우)는 건너뛰고 원본은 위 raw로 보존(드롭 아님).
  return elements.map(extractTextSpan).filter(Boolean).join("")
```

**5.3d outbound: `AgentContent[]` → `UserInput[]`** (`sendPrompt`에서 호출, §2.4):

5.3a가 **inbound**(Codex `UserInput` → `AgentContent`, item 재생용)라면, 이 절은 **outbound** 정본이다 — composer가 만든 `AgentContent[]`(15 §4)를 `turn/start`의 `input: UserInput[]`(ref-codex §6.5)로 변환한다. 5.3a와 반대 방향이며 **순수 함수**다(side-effect 없음). adapter capability(ref-codex §1.4 `initialize.capabilities`) 미opt-in 상황에서 미지원 content는 **드롭하지 않고** `[]` 자리에서 raw 보존 + debug 로깅으로 처리한다(15 §0.2).

```ts
// adapters/codex/codex-wire-mapper.ts (또는 codex-launch.ts와 공유)
import type { AgentContent } from "../../contracts/normalized";
// UserInput은 generated/codex-app-server/ 의 generate-ts 산출 타입을 import(§11, 수동 string literal 금지).

/**
 * composer content(15 §4) → Codex turn/start input(ref-codex §6.5/§6.4).
 * - text  → UserInput text item
 * - image → capability 확인 후 image input; 미지원이면 drop + raw 보존
 * - resource → reference 매핑(아래 의사코드)
 * - 그 외(terminal/diff/json 등 composer 비입력 variant) → drop + raw 보존(로깅).
 * caps: initialize 응답/capability opt-in 상태(ref-codex §1.4). 없으면 보수적(image 미전송).
 */
export function mapAgentContentToUserInput(content: AgentContent[], caps?: CodexInputCaps): UserInput[];
```

```text
mapAgentContentToUserInput(content, caps):
  out = []
  for c in content:
    switch c.type:
    case "text":
       // ⚠️ outbound text variant 필드 결정 필요(아래 주석·13 OQ-33).
       //   가능성 A(우선): { type:"text", text: c.text }
       //     — ref-codex §6.5 TurnStartParams 예시는 outbound input에 평문 text만 보인다.
       //   가능성 B(필요 시 동반): { type:"text", text: c.text, text_elements: toTextElements(c.text) }
       //     — ref-codex §6.4 inbound item은 text_elements(snake_case, TextElement[], 필수)다.
       //   둘 중 무엇이 schema 통과하는지 generate-ts(UserInput.ts)/실측 wire로 구현 전 확정(13 OQ-33).
       out.push(makeTextUserInput(c.text))     // A 우선; B 필요 시 text_elements 동반
       break
    case "image":
       if caps?.imageInput:                    // ref-codex §1.4 capability opt-in 확인
          // data URI vs file path: file:// 스킴이면 localImage, 그 외 url(15 §4 image.uri)
          out.push(c.uri.startsWith("file://")
                   ? { type:"localImage", path: stripFileScheme(c.uri) }   // ref-codex §6.4
                   : { type:"image", url: c.uri })                         // detail은 미설정(옵셔널)
       else:
          logDropped("image", c)               // 미지원 → drop + raw 보존(15 §0.2, 드롭 아님)
       break
    case "resource":
       // ref-codex §6.4: 전용 resource variant 없음 → mention(reference)으로 근사 매핑.
       //   uri/text를 mention name/path로 싣고 원본은 raw 보존(정확 매핑은 결정 필요, 13 OQ-33).
       out.push({ type:"mention", name: c.text ?? c.uri, path: c.uri })   // reference 매핑(근사)
       break
    default:
       // terminal/diff/json 등 composer 입력이 아닌 variant: drop + raw 보존(로깅).
       logDropped(c.type, c)
  return out
```

> **outbound text variant 필드 — 결정 필요(13 OQ-33)**: ref-codex §6.5 `TurnStartParams` 예시는 outbound `input`에 `{type:"text", text}`(평문 text만)을 보이지만, §6.4 inbound `UserInput.text`는 `text_elements`(snake_case, `TextElement[]`, **필수**)다. 어느 쪽을 보내야 server schema가 통과하는지는 **양립 가능성이 있어 구현 전 확정**한다 — 가능성 A(text only) 우선, 실측에서 거부되면 가능성 B(text_elements 동반). `codex app-server generate-ts`(§11)의 `UserInput.ts`와 실측 wire로 확정하고 13에 verify-at-impl로 등록한다.
> image/resource 매핑의 capability opt-in 키와 resource→reference 정확 매핑도 동일 OQ로 묶는다(ref-codex §1.4·§6.4 unverified, [13](13-risks-open-questions.md) OQ-33).

**5.3b `commandExecution` → `ToolCallUpdate`** (15 §5, ref-codex §6.3/§8):

```text
mapCommandExec(item):                     // ToolCallUpdate (15 §5)
  return {
    id: item.id,                          // toolCallId = itemId (15 §1.1)
    title: item.command,
    kind: "execute",
    status: mapCommandStatus(item.status),// §5.5: inProgress→in_progress, completed→completed,
                                          //        failed→failed, declined→failed (15 §5 주의)
    content: item.aggregatedOutput
             ? [{ type:"terminal", command:item.command, output:item.aggregatedOutput }]
             : undefined,                 // 15 §4 terminal content
    rawInput: { command:item.command, cwd:item.cwd, commandActions:item.commandActions },
    rawOutput: { exitCode:item.exitCode, durationMs:item.durationMs }, // 15 §0.2
  }
```

**5.3c generic tool(mcp/dynamic/webSearch) → `ToolCallUpdate`**:

```text
mapGenericTool(item):
  kind = item.type === "webSearch" ? "fetch" : "other"   // ref-codex §8
  return {
    id: item.id, kind, title: toolTitle(item),
    status: mapToolStatus(item.status),                  // §5.5
    rawInput: item.arguments ?? item.query,              // 15 §0.2
    rawOutput: item.result ?? item.error,
  }
```

**파일 변경**: `FileUpdateChange{path, kind, diff}` → `FileChangeSummary`(15 §5). `PatchChangeKind`(ref-codex §6.3): `{type:"add"}`→`create`, `{type:"delete"}`→`delete`, `{type:"update", movePath?}`→`update`(movePath 있으면 `move`, `oldPath=path`).

### 5.5 enum 변환표 (정본은 15 §5 매핑 주의 + ref-codex)

| Codex enum (값) | CLCOMX | 근거 |
|---|---|---|
| `ThreadStatus.notLoaded` | status `starting` | ref-codex §8, 04 §2.2 |
| `ThreadStatus.idle` | status `idle` | ref-codex §8 |
| `ThreadStatus.active`(activeFlags 없음) | status `running` | ref-codex §8 |
| `ThreadStatus.active`(flag `waitingOnApproval`/`waitingOnUserInput`) | status `requires_action` | ref-codex §8, 04 §2.1 규칙3 |
| `ThreadStatus.systemError` | status `failed` | ref-codex §8, 04 §2.1 규칙6 |
| `TurnStatus.completed` | turn_completed `completed` | ref-codex §6.2/§8 |
| `TurnStatus.failed` | turn_completed `failed` | ref-codex §8 (세션은 idle 가능, 04 §2.1 규칙6) |
| `TurnStatus.interrupted` | turn_completed `cancelled` | ref-codex §8 |
| `TurnStatus.inProgress` | (turn 진행; turn_completed 미emit) | ref-codex §6.2 |
| `CommandExecutionStatus.inProgress` | ToolCallUpdate.status `in_progress` | 15 §5, ref-codex §6.3 |
| `...completed` / `failed` | `completed` / `failed` | 15 §5 |
| `...declined` | `failed` | 15 §5 주의 (cancelled 아님) |
| `TurnPlanStepStatus.pending` | AgentPlanEntry.status `pending` | ref-codex §6.8 |
| `...inProgress` | `in_progress` | ref-codex §6.8, 15 §5 주의 (camelCase→snake) |
| `...completed` | `completed` | ref-codex §6.8 |

```text
mapPlanStep(s): { content: s.step, status: { pending:"pending",
                  inProgress:"in_progress", completed:"completed" }[s.status] } // ref-codex §6.8
```

### 5.6 token usage 결합

`thread/tokenUsage/updated`(ref-codex §6.7)는 별도 `AgentEvent`로 내지 않고 routing이 `(threadId,turnId)`별로 보관했다가 `turn/completed`의 `usage`로 결합한다(15 §3 `turn_completed.usage?`, ref-codex §8). 매핑:

```text
mapTokenUsage(tu):                         // ThreadTokenUsage (ref-codex §6.7)
  b = tu.total ?? tu.last                  // total 우선
  return { inputTokens:b.inputTokens, cachedInputTokens:b.cachedInputTokens,
           outputTokens:b.outputTokens, reasoningOutputTokens:b.reasoningOutputTokens }
           // totalTokens는 버림(15 §5 매핑 주의)
```

---

## 6. 라우팅 (`codex-routing.ts`) — `(threadId, turnId, itemId)` 삼중 키

Codex는 한 connection에서 여러 thread/turn이 인터리빙될 수 있다(ref-codex §7.1, 04 §1). 따라서 삼중 키 라우팅이 **필수**다(15 §1.1).

```ts
// adapters/codex/codex-routing.ts
export class CodexRouting {
  private sessionIdByThread = new Map<string, string>();     // threadId → sessionId
  private activeTurnByThread = new Map<string, string>();    // threadId → turnId
  private startedThreads = new Set<string>();                // session_started 멱등 가드(§2.3)
  private messageItems = new Set<string>();                  // beginMessage 추적
  private tokenUsage = new Map<string, TokenUsage>();        // `${threadId}:${turnId}` → usage (§5.6)
  private pendingApprovals = new Map<string, PendingApproval>(); // requestId → {rpcId,method,threadId,turnId,itemId} (§7)

  ensureThread(threadId: string, sessionId?: string): void;
  alreadyStarted(threadId: string): boolean;                 // §2.3 멱등
  markStarted(threadId: string): void;
  setActiveTurn(threadId: string, turnId: string): void;
  clearActiveTurn(threadId: string, turnId: string): void;
  activeTurnOf(threadId: string): string | undefined;        // cancelTurn 기본값(§7.3)
  recordTokenUsage(threadId: string, turnId: string, u: TokenUsage): void;   // §5.6
  takeTokenUsage(threadId: string, turnId: string): TokenUsage | undefined;  // §5.6

  // approval pending table (§7, 04 §4)
  // D12: 원본 JSON-RPC id의 실제 타입(string|number)과 server request method를 함께 보관해
  //   응답 시 id 타입을 복원하고(ref-codex §1.3) permissions 분기를 판단한다.
  addPendingApproval(
    requestId: string,
    rpcId: string | number,          // 원본 JSON-RPC id (타입 보존; 응답 시 그대로 사용)
    method: string,                  // server request method(예: "item/permissions/requestApproval")
    ref: { threadId?: string; turnId?: string; itemId?: string },
  ): void;
  hasPendingApproval(requestId: string): boolean;            // closing/closed면 false(멱등 가드)
  resolveApproval(requestId: string): PendingApproval | undefined;
  pendingApprovalsForTurn(threadId: string, turnId: string): string[]; // cancel cleanup(§7.3)
  // C4(04 §4.2 단계1): cancel 시 해당 turn의 pending approval을 원자적으로 closing으로 표시(이중 응답 방지).
  //   이미 closing/closed인 항목은 제외하고, 새로 closing 표시한 requestId 목록만 반환(멱등).
  markTurnApprovalsClosing(threadId: string, turnId: string): string[]; // §7.3
  allPendingApprovalIds(): string[];                         // process exit cleanup(§9)
}

// PendingApproval: requestId(정규화 string) 외에 원본 id 타입과 method를 보존(D12).
interface PendingApproval {
  requestId: string;                 // String(id) 정규화 값(15 §1)
  rpcId: string | number;            // 원본 JSON-RPC id — 응답 { id: rpcId, ... }로 복원(ref-codex §1.3)
  method: string;                    // server request method(permissions 분기 판단)
  threadId?: string;
  turnId?: string;
  itemId?: string;
}
```

> `approvalId`(ref-codex §4.1, zsh-exec-bridge 분기)는 한 `itemId`에 복수 approval이 붙을 때 구분용이다. v1은 JSON-RPC `id`(=`requestId`)를 1차 키로 쓰고 `approvalId`는 `ProviderRef.raw`에 보존한다(15 §1.1 주석, 04 §1). 같은 itemId의 복수 approval도 requestId가 다르므로 pending table에서 충돌하지 않는다.

---

## 7. Approval (server→client request) 변환·응답·cleanup

정본 규칙은 04 §4(approval 생명주기). wire는 ref-codex §4.

### 7.1 inbound: approval request → `approval_requested`

ref-codex §4의 server request 3종을 매핑한다(`item/commandExecution/requestApproval`, `item/fileChange/requestApproval`, `item/permissions/requestApproval`). 각 request는 `id`(JSON-RPC)를 가지며 동일 id로 응답한다(ref-codex §1.3, §4).

```text
mapCodexServerRequest(method, id, p, routing):              // §3.2 request 분기에서 호출
  reqId = String(id)
  // §6 D12: 원본 id 타입과 method를 함께 보관(응답 시 id 타입 복원·permissions 분기)
  routing.addPendingApproval(reqId, id, method, {threadId:p.threadId, turnId:p.turnId, itemId:p.itemId}) // 04 §4.1
  ref = { provider:"codex", threadId:p.threadId, turnId:p.turnId, itemId:p.itemId,
          toolCallId:p.itemId, requestId:reqId, raw:p }      // 15 §1: requestId/raw 보존

  switch method:                                            // ref-codex §4
    case "item/commandExecution/requestApproval":           // ref-codex §4.1
       return [{ type:"approval_requested", ref, request: {
         id: reqId, title: i18nKey("agentRuntime.approval.command"),  // label은 UI에서 i18n(04 §4.1)
         body: p.command, toolCallId: p.itemId,
         options: COMMAND_OPTIONS } }]                       // §7.1 표
    case "item/fileChange/requestApproval":                 // ref-codex §4.2
       return [{ type:"approval_requested", ref, request: {
         id: reqId, title: i18nKey("agentRuntime.approval.fileChange"),
         body: p.reason, toolCallId: p.itemId,
         options: FILECHANGE_OPTIONS } }]
    case "item/permissions/requestApproval":                // ref-codex §4.3
       // D12 v1 기본값: permission-profile escalation은 자동 decline(+raw 보존).
       //   command/fileChange 승인만 1차 지원하므로 사용자에게 띄우지 않고 즉시 거절 응답한다.
       //   GrantedPermissionProfile 구성이 미확정이라(ref-codex §4.3, [13] OQ) 보수적으로 decline.
       routing.resolveApproval(reqId)                        // pending에서 제거(사용자 노출 안 함)
       autoDeclinePermissions(reqId, id, p)                  // §7.2: { permissions:{}, scope:"turn" } 거절 응답
       return [{ type:"approval_resolved",
                 ref: refOf({threadId:p.threadId, turnId:p.turnId, itemId:p.itemId}, p),
                 decision: { requestId:reqId, outcome:"failed" } }]  // 내부 전용(04 §4.2 규칙4)
    default:
       // item/tool/requestUserInput(EXPERIMENTAL), mcpServer/elicitation/request, item/tool/call 등
       // v1 미지원 server REQUEST(id 있음). 04 §5 / 13 RD-10 정본: server→client request의 미지원
       //   method는 **silent-drop 금지**다. 무응답으로 폐기하면 server가 응답을 영구히 기다려 turn이
       //   deadlock된다. 따라서 pending에서 제거한 뒤 **반드시 응답을 먼저 보낸다** — 표준 JSON-RPC error
       //   (code -32601 method not found) 또는 명시적 decline. payload는 raw 보존 + 카운터 가시화(15 §0.2, 13 RD-10).
       routing.resolveApproval(reqId)                        // pending에서 제거(이미 닫혔으면 no-op)
       // (a) 미지원 method 응답 — JSONRPCError(jsonrpc 필드 없음, ref-codex §1.2/§4). approval 계열이 아닌
       //     server request(elicitation/tool call 등)는 method-not-found가 의미상 맞다.
       sendUnsupportedServerRequest(originalRpcId=id, method, p)  // §7.2 보조: error/decline 응답 후 raw 로깅+카운터
       return []                                             // event는 없음(응답은 위에서 wire로 송신)
```

`ApprovalOption.kind`(15 §5) → Codex decision(ref-codex §4.1/§8.1):

| option `kind` | label i18n 키 | Codex `decision`(command/fileChange) | 근거 |
|---|---|---|---|
| `allow_once` | `agentRuntime.approval.allowOnce` | `accept` | ref-codex §8.1 |
| `allow_always` | `agentRuntime.approval.allowAlways` | `acceptForSession` | ref-codex §8.1 |
| `reject_once` | `agentRuntime.approval.rejectOnce` | `decline` | ref-codex §8.1 |
| `cancel` | `agentRuntime.approval.cancel` | `cancel` | ref-codex §8.1 |

> v1은 단위 enum 4종(`accept`/`acceptForSession`/`decline`/`cancel`)만 전송한다(ref-codex §4.1 ⚠️, §8.1, §10). `acceptWithExecpolicyAmendment`/`applyNetworkPolicyAmendment`(데이터 variant)는 보내지 않는다. `reject_always`는 Codex에 정확한 등가물이 없어 `decline`으로 매핑(ref-codex §8.1, §10, [13](13-risks-open-questions.md)).

### 7.2 outbound: `respondApproval` → JSON-RPC response

`ApprovalDecision`(15 §5)을 Codex `JSONRPCResponse`로 변환해 보낸다(04 §4.1 단계3). `jsonrpc` 필드 없음(ref-codex §4.1 응답, §1.2).

```text
respondApproval(handle, decision: ApprovalDecision):       // 15 §6
  pending = routing.resolveApproval(decision.requestId)    // §6, 없으면 이미 닫힘 → no-op
  if !pending: return
  if decision.outcome === "failed": return                 // 04 §4.2 규칙4: wire로 안 보냄
  if decision.outcome === "cancelled":
     codexDecision = "cancel"
  else: // "selected"
     codexDecision = OPTION_KIND_TO_DECISION[optionKindOf(decision.optionId)] // §7.1 표
  // D12 v1: command/fileChange approval만 respondApproval 경로를 탄다(decision variant).
  //   permissions(item/permissions/requestApproval)는 §7.1에서 이미 자동 decline되어
  //   여기 도달하지 않는다. ref-codex §4.3의 { permissions, scope } 응답 구성은 후속.
  result = { decision: codexDecision }                            // ref-codex §4.1/§4.2
  await deps.send(runtimeId, { id: pending.rpcId, result })       // JSONRPCResponse, jsonrpc 없음; 원본 id 타입 복원(§6)
  emitToListeners({ type:"approval_resolved",
                    ref:{provider:"codex", threadId:pending.threadId, requestId:decision.requestId},
                    decision })                                   // 04 §4.1 단계4

// D12: permission-profile escalation 자동 decline(§7.1에서 호출). 사용자 노출 없음.
autoDeclinePermissions(reqId, originalRpcId, p):              // ref-codex §4.3
  // PermissionsRequestApprovalResponse { permissions, scope } 형태로 거절.
  //   GrantedPermissionProfile 구성이 미확정이라 보수적으로 빈 권한 + scope:"turn".
  await deps.send(runtimeId, { id: originalRpcId,            // 원본 JSON-RPC id 타입(string|number) 그대로
    result: { permissions: {}, scope: "turn" } })            // ref-codex §4.3 (granted 구성 후속, [13] OQ)

// R5(04 §5 / 13 RD-10): 미지원 server REQUEST(id 있음)에 대한 의무 응답(§7.1 default에서 호출).
//   무응답 silent-drop은 server를 영구 대기시켜 deadlock을 만들므로 금지. 반드시 응답을 먼저 보낸다.
sendUnsupportedServerRequest(originalRpcId, method, p):      // ref-codex §1.2/§4
  // JSONRPCError 응답(ref-codex §1.2 표: JSONRPCError { id, error:{code,message,data?} }, jsonrpc 필드 없음).
  //   표준 코드 -32601(method not found)로 미지원임을 명시한다(ref-acp §13의 -32601과 동일 의미).
  //   approval 계열이면 명시적 decline 응답을 대신 보낼 수도 있으나(§7.2 decision/permissions),
  //   default 분기는 비-approval(elicitation/tool call 등)이라 method-not-found가 의미상 맞다.
  await deps.send(runtimeId, { id: originalRpcId,            // 원본 JSON-RPC id 타입(string|number) 그대로(§6 rpcId)
    error: { code: -32601, message: "method not found", data: { method } } }) // ref-codex §1.2
  logDropped("server-request:" + method, p)                 // raw 보존 + unknown-request 카운터 증가(15 §0.2, 13 RD-10)
```

> response의 `id`는 server가 보낸 request의 `id`와 **정확히 동일 타입/값**이어야 한다(ref-codex §1.3). server request id가 number였으면 number로 되돌린다. 어댑터는 `requestId`를 string으로 정규화(15 §1)하지만 **원본 JSON-RPC id의 실제 타입(`string|number`)을 routing pending에 함께 보관**해 응답 시 복원한다(§6 `rpcId`).
> **D12 v1 확정**: permissions approval(`item/permissions/requestApproval`, ref-codex §4.3)은 **자동 decline**한다(command/fileChange 승인만 1차 지원). `{permissions, scope}` 응답의 `GrantedPermissionProfile` 구성은 미확정이라 보수적으로 빈 권한으로 거절하고 원본 payload는 raw 보존한다([13](13-risks-open-questions.md) OQ). permission-profile escalation 정식 지원은 후속.

### 7.3 cancel cleanup (불변식)

04 §4.2 불변식: turn cancel/process exit 시 **unresolved approval은 반드시 cancelled로 닫는다**. cleanup **순서**는 04 §4.2 정본을 그대로 따른다 — **(1) closing 표시 → (2) approval cancelled 응답 먼저 → (3) turn/interrupt 나중 → (4) 늦은 응답 멱등 무시**. approval을 turn cancel보다 **먼저** 닫는 이유: provider가 turn을 interrupt하면 곧 도착할 `serverRequest/resolved`(ref-codex §4.4)·`turn/completed`와 race가 생기는데, pending을 미리 `closing`으로 표시하고 cancelled 응답을 wire로 보내두면 이중 응답·중복 emit이 멱등하게 차단된다(04 §4.2).

```text
cancelTurn(handle, turnId?):                               // 15 §6
  threadId = routing.threadIdOf(handle)
  tid = turnId ?? routing.activeTurnOf(threadId)

  // (1) 04 §4.2: 이 turn의 pending approval을 원자적으로 closing으로 표시(이중 응답 방지).
  reqIds = routing.markTurnApprovalsClosing(threadId, tid)  // §6; 이미 closing/closed면 제외(멱등)

  // (2) 04 §4.2 규칙1: 각 pending approval에 cancelled 응답을 wire로 **먼저** 보낸다(turn/interrupt 전).
  for reqId in reqIds:
     pending = routing.resolveApproval(reqId)               // pending table에서 제거(closing→closed)
     await deps.send(runtimeId, { id: pending.rpcId, result: { decision: "cancel" } }) // Codex; 원본 id 타입(§6, ref-codex §4.1)
     emitToListeners({ type:"approval_resolved",
                       ref:{provider:"codex", threadId, turnId:tid, requestId:reqId},
                       decision: { requestId:reqId, outcome:"cancelled" } })            // 04 §4.2 단계2

  // (3) 04 §4.2: 그 다음 provider turn cancel(turn/interrupt request)을 보낸다.
  //    D5: turn/request cancel은 protocol 의미라 어댑터가 직접 보낸다(backend agent_runtime_cancel은
  //        {type:"process"}만 처리, turn/request는 no-op; 07 §6.3·14 §5 정본).
  await rpcRequest(runtimeId, "turn/interrupt", { threadId, turnId: tid }) // ref-codex §3.2 TurnInterruptParams

  // (4) 04 §4.2: cancel 이후 도착하는 늦은 serverRequest/resolved·turn/completed·동일 requestId 응답은
  //     이미 closing/closed이므로 멱등하게 무시한다(§5.2 serverRequest/resolved case의 hasPendingApproval 가드).
```

> **순서 정본(04 §4.2)**: closing 표시(1) → approval cancelled 응답 먼저(2) → `turn/interrupt` 나중(3) → 늦은 응답 멱등 무시(4). 기존 초안은 `turn/interrupt`를 먼저 보냈으나, 04 §4.2 정본은 approval 정리를 **선행**한다(race·이중 응답 차단). Claude(ACP)는 동일 순서에서 (2)가 `{jsonrpc:"2.0", id, result:{outcome:{outcome:"cancelled"}}}`, (3)이 `session/cancel` notification이다(04 §4.2, 06 §4.3).
>
> **D5 정본**: `turn/interrupt`(ref-codex §3.2, `{threadId, turnId}`)는 protocol 의미라 **frontend 어댑터가 직접** `agentRuntimeSend`(=`rpcRequest`)로 보낸다. backend `agent_runtime_cancel`은 `{type:"process"}`(프로세스 kill)만 처리하고 `turn`/`request` cancel은 **no-op**이다(07 §6.3·14 §5가 정본). 어댑터는 `deps.cancel`을 turn cancel에 사용하지 않는다. approval cancel 응답(JSONRPCResponse)도 마찬가지로 protocol 의미라 **어댑터가 직접** `send`로 보낸다(backend는 framing만, 03 §).
>
> `serverRequest/resolved`(ref-codex §4.4)로도 닫힘 — §5.2 case 참조. 사용자 응답 없이 server가 먼저 해결한 경우 pending에서 제거하고 `approval_resolved{cancelled}` emit(04 §4.2 규칙3). cancel 이후(closing/closed) 도착하는 `serverRequest/resolved`는 `hasPendingApproval`가 false라 멱등 무시된다(단계4).

---

## 8. command output / error 처리

### 8.1 command output 두 채널 (구분 필수)

ref-codex §5.3 ⚠️: thread 안 명령 출력과 standalone `command/exec` 출력은 **다른 채널**이다.

| 채널 | notification | payload | 디코드 | CLCOMX |
|---|---|---|---|---|
| thread 내 | `item/commandExecution/outputDelta` | `{itemId, delta}` 평문 | 불필요 | `command_output_delta{stream:"stdout", delta}` (15 §3) |
| standalone | `command/exec/outputDelta` | `{processId, stream:"stdout"\|"stderr", deltaBase64, capReached}` | **base64 디코드** | `command_output_delta{stream, delta=atob}` 또는 `terminal_output_delta` |

v1은 **thread 채널만** 1차 지원한다(turn 안에서 agent가 실행하는 명령). standalone `command/exec`(thread 없이 sandbox 실행, ref-codex §3.3)는 v1 범위 밖([13](13-risks-open-questions.md)). thread 채널 delta는 stream 구분 정보가 없어 `stdout`으로 고정한다(ref-codex §5.2; stderr 구분은 unverified, [13](13-risks-open-questions.md)). 출력은 전체 terminal surface가 아니라 tool card 내부 terminal embed로 렌더한다([08](08-ui-composition.md), 15 §4 `{type:"terminal"}`). bounded buffer/full log 분리는 [08](08-ui-composition.md).

### 8.2 error / backpressure

```text
// §3.2 onRuntimeEvent에서:
case "error":         emit { type:"error", ref:{provider:"codex"}, message, recoverable }
case "backpressure":  emit { type:"error", ref:{provider:"codex"},
                             message:i18n("agentRuntime.errors.backpressure"), recoverable:true }
```

- Codex notification `error`(ref-codex §5.1, §6.9): `willRetry`→`recoverable`(04 §5). `error.codexErrorInfo`(`usageLimitExceeded`/`contextWindowExceeded` 등, ref-codex §6.9)는 `ref.raw`에 보존하고 UI 에러 코드 분류에 쓸 수 있다(15 §3 error, 04 §5).
- backpressure(15 §8.3): pending approval을 자동 방치하지 않는다(기존 05 초안 유지). recoverable warning으로 표시([08](08-ui-composition.md), [13](13-risks-open-questions.md) approval deadlock).

---

## 9. process exit / shutdown

```text
handleExit(code?, signal?):                                // §3.2 "exit"
  // S3 정본(04 §5): process exit으로 인한 pending 종료는 shutdown과 공용 루틴·멱등 가드를 공유한다.
  //   process가 이미 죽었으므로 wire 응답 불가 → 내부 전용 outcome으로 닫는다(reason="exit").
  closePending(handle, "exit")                             // 아래 공용 루틴(rt.closed 가드로 정확히 한 번)
  emitToListeners({ type:"process_exited", ref:{provider:"codex"}, code, signal })

shutdown(handle):                                          // 15 §6
  // S3 정본(04 §5·14): agent_runtime_shutdown을 authoritative cleanup 경계로 본다.
  //   (a) shutdown 호출 **전에** 모든 pending을 어댑터가 정확히 한 번 닫는다(멱등).
  //   (b) 그 다음에야 graceful shutdown(backend)·unlisten·세션 삭제를 한다.
  rt = sessions.get(handle); if !rt or rt.closed: return   // 멱등: 이미 닫힌 세션이면 no-op(이중 종료 금지)

  // (a) shutdown 전에 pending 정리 — closePending(handle, reason="shutdown") (아래)
  //     이미 handleExit이 닫았으면(rt.closed) 위 가드로 진입 안 함 → 정확히 한 번만 수행.
  closePending(handle, "shutdown")

  // (b) graceful: backend가 stdin close → timeout → kill → child reap 까지 끝낸 뒤 반환(07 §5.2).
  //     최종 exit이 반영·계상된 후에만 teardown이 일어나도록 backend가 reap 후 반환한다.
  await deps.shutdown(runtimeId)

  // (c) reap 이후에만 listener 해제·세션 삭제(pending은 이미 (a)에서 닫힘 → 늦은 exit로도 누락 없음).
  for u in unlistens: u()                                  // listener 해제
  rt.closed = true                                         // 멱등 가드 확정
  sessions.delete(handle)

// S3 정본: exit/shutdown 공용 pending 종료 루틴. 정확히 한 번·멱등(04 §5·§4.2 규칙2).
//   handleExit(§위)과 shutdown(여기)이 같은 루틴을 호출하며, rt.closed 가드로 이중 종료/누락을 막는다.
closePending(handle, reason):                              // reason: "exit" | "shutdown"
  rt = sessions.get(handle); if !rt or rt.closed: return   // 멱등(이미 닫힘이면 no-op)
  // (1) 모든 pending approval을 닫는다(server→client request; pending RPC와 별개).
  //   - reason="shutdown": process가 아직 살아있으므로 cancelled 응답을 wire로 보낼 수 있다(04 §4.2).
  //       단 shutdown은 곧 stdin close→kill이므로, wire 응답 송신은 best-effort이고 내부 종료가 권위.
  //   - reason="exit": process가 이미 죽어 wire 응답 불가 → 내부 전용 outcome:"failed"만(04 §4.2 규칙4).
  outcome = reason == "shutdown" ? "cancelled" : "failed"  // 04 §4.2 규칙2(shutdown) / 규칙4·§5(exit, 내부 전용)
  for reqId in routing.allPendingApprovalIds():
     routing.resolveApproval(reqId)                         // closing→closed(멱등 가드)
     emitToListeners({ type:"approval_resolved",
                       ref:{provider:"codex", requestId:reqId},
                       decision:{ requestId:reqId, outcome } })
  // (2) pending RPC를 로컬에서 reject(§3.1) — 응답이 영구히 안 오므로.
  for [id, p] in pendingRpc: p.reject(new Error(reason + ": runtime closing"))
  pendingRpc.clear()
```

> **S3 — shutdown cleanup 경계 (정본, 04 §5·14)**: `agent_runtime_shutdown`은 authoritative cleanup 경계다. **(a)** 어댑터는 shutdown 호출 **전에** 모든 pending approval을 cancelled로 닫고(04 §4.2) pending RPC를 로컬에서 reject한 뒤, **(b)** backend shutdown(graceful stdin close → timeout → kill → **child reap 후 반환**, 07 §5.2)을 await하고, **(c)** 그 다음에 listener 해제·세션 삭제를 한다. 이렇게 해야 최종 exit이 반영·계상된 후에만 teardown이 일어나 늦은 exit로 인한 pending 누락이 없다. **(c-멱등)** exit/shutdown 어느 경로로 pending이 닫히든 `rt.closed` 가드로 정확히 한 번만 수행한다(이중 종료/누락 없음, 04 §5). `handleExit`(§위)도 `closePending(handle, "exit")` 공용 루틴을 거치며 동일 가드를 공유한다.

에러 처리 시나리오(기존 05 초안 보존·확장):

- **initialize 실패**: `startSession`의 `rpcRequest("initialize")` reject → 세션 status `failed` emit, legacy PTY fallback 제안([08](08-ui-composition.md) §fallback, [13](13-risks-open-questions.md) experimental surface).
- **schema mismatch**: 알 수 없는 notification은 드롭하지 않고 debug 로깅(§5.2 default). 치명적이지 않으면 runtime 유지. version drift는 [13](13-risks-open-questions.md) Protocol drift.
- **app-server process exit**: 위 `handleExit`. active turn은 `turn_completed{cancelled}`로 닫지 않고 `process_exited`로 세션 `exited` 전이(04 §2.1 규칙7).

---

## 10. 테스트 (수용 기준 연결)

mapper/routing은 순수 함수/plain class라 vitest로 단독 테스트([`research/codebase-frontend.md`](research/codebase-frontend.md) §1.6). 상세 시나리오는 [11](11-testing-acceptance.md).

`adapters/codex/codex-wire-mapper.test.ts` 필수 케이스:

1. **lifecycle**: `initialize` response → `thread/start` response 흐름이 `session_started`+`ready` emit. `thread/started` notification 중복 시 멱등(§2.3, 1회만 emit).
2. **message reconcile**(04 §3.2 규칙1): `item/started`(빈 agentMessage) → delta×N → `item/completed` → 마지막이 `agent_message{replace, text=completed.text}`.
3. **command**(04 §3.2 규칙3): `item/started`(commandExecution inProgress) → `outputDelta`×N(`command_output_delta`) → `item/completed`(completed, exitCode) → `tool_call_updated{status:completed}`.
4. **interleaved**(ref-codex §7.1, 04 §1): 두 thread 또는 두 turn의 delta가 동시에 와도 `(threadId,turnId,itemId)`로 분리되어 섞이지 않음 — 기존 05 초안의 핵심 요구.
5. **approval 정상**(04 §4.1): `item/commandExecution/requestApproval`(id=7) → `approval_requested{request.id="7"}` → `respondApproval{selected, allow_once}` → `send({id:7, result:{decision:"accept"}})`(jsonrpc 없음) + `approval_resolved`.
6. **approval cancel cleanup**(04 §4.2): pending approval 있는 상태에서 `cancelTurn` → 해당 turn 모든 pending에 `{id, result:{decision:"cancel"}}` + `approval_resolved{cancelled}`.
7. **serverRequest/resolved**(ref-codex §4.4): pending approval을 사용자 응답 없이 닫고 `approval_resolved{cancelled}`.
8. **enum 변환**(§5.5): ThreadStatus/TurnStatus/CommandExecutionStatus/TurnPlanStepStatus 전 분기 매핑.
9. **token usage 결합**(§5.6): `thread/tokenUsage/updated` 후 `turn/completed`에 `usage` 동승.
10. **process exit**(04 §5): pending approval/RPC 모두 닫히고 `process_exited` emit. exit과 shutdown은 공용 `closePending` 루틴 + `rt.closed` 가드를 공유해 **정확히 한 번**만 닫는다(이중 종료/누락 없음).
11. **shutdown 경계**(S3, 04 §5·14): pending approval 있는 상태에서 `shutdown` → (a) `agent_runtime_shutdown` 호출 **전에** pending approval이 `approval_resolved{cancelled}`로 닫히고 pending RPC가 reject된 뒤, (b) `deps.shutdown` await, (c) 그 다음 unlisten·세션 삭제 순서. shutdown 후 늦은 exit이 도착해도 `rt.closed` 가드로 pending이 **재차 닫히거나 누락되지 않음**(멱등).

수용 기준: 위 10케이스 + `jsonrpc` 필드 미포함 검증(ref-codex §1.2) + raw 보존 검증(15 §0.2). [11](11-testing-acceptance.md)에 통합.

---

## 11. 구현 전 체크리스트 (기존 05 초안 보존·갱신)

- [ ] 로컬 `codex --version`이 ref pin(`0.142.0`)과 일치하는지 확인(ref-codex §0). 불일치 시 schema diff 검토([13](13-risks-open-questions.md) Protocol drift).
- [ ] `codex app-server generate-ts --out <DIR>`로 protocol type 생성, 수동 string literal 구현 금지(ref-codex §1.1, drift 위험). 생성물은 `src/lib/features/agent-runtime/generated/codex-app-server/`(D4 정본 경로, 12 §0.1)에 두고 mapper(`adapters/codex/codex-wire-mapper.ts`)가 import.
- [ ] `codex app-server --help`로 experimental flag 기동 불필요 재확인(ref-codex §1.1; 이미 검증, 환경 변동 시 재확인).
- [ ] `ClientInfo`/`InitializeCapabilities` 실제 필드 확인 후 `capabilities:null` 유지 여부 결정(ref-codex §10, [13](13-risks-open-questions.md)).
- [ ] `initialize`→`initialized` 필수 여부 server handler로 확인(ref-codex §10, [13](13-risks-open-questions.md)). 미확인 동안 항상 핸드셰이크 수행.
- [ ] permissions approval: D12 v1 기본값 **자동 decline** 확정(§7.1/§7.2). `{permissions, scope}`의 `GrantedPermissionProfile` 정식 구성은 후속이며 구현 전 ref-codex §4.3/generate-ts로 실측([13](13-risks-open-questions.md) OQ).
- [ ] standalone `command/exec` 채널·thread 채널 stream 구분 v1 범위 확정([13](13-risks-open-questions.md)).
- [ ] auth token/websocket 사용 시 저장 위치·redaction 정책을 [09](09-permissions-security.md)에 반영.

---

## 12. 교차 참조

| 대상 | 문서 | 절 |
|---|---|---|
| Codex wire(method/notification/payload/enum/매핑표/reconcile) | [ref-codex-app-server-protocol.md](ref-codex-app-server-protocol.md) | §1, §2, §4, §5, §6, §7, §8, §9, §10 |
| normalized 타입 정본(AgentEvent/ProviderRef/ToolCallUpdate/Approval*/JsonRpcMessage/AgentRuntimeStartParams) | [15-data-contracts.md](15-data-contracts.md) | §1–§8 |
| 상태머신·reconcile·approval 생명주기·라우팅 규칙 | [04-normalized-agent-model.md](04-normalized-agent-model.md) | §1–§5 |
| Tauri command/event·framing·process lifecycle·WSL 경계 | [07-tauri-process-runtime.md](07-tauri-process-runtime.md) | 전체 |
| feature 레이어·transport 래퍼·host 분기·테스트 컨벤션 | [research/codebase-frontend.md](research/codebase-frontend.md) | §1, §4, §8 |
| backend 상태 모델·등록·allowlist·scrub | [research/codebase-backend.md](research/codebase-backend.md) | §1, §2, §6, §10 |
| UI 렌더(tool card/approval dialog/fallback) | [08-ui-composition.md](08-ui-composition.md) | 전체 |
| 권한·보안·redaction·auth | [09-permissions-security.md](09-permissions-security.md) | 전체 |
| persistence·resume/load·scrub | [10-persistence-migration.md](10-persistence-migration.md) | 전체 |
| 테스트·수용 기준 | [11-testing-acceptance.md](11-testing-acceptance.md) | 전체 |
| 미확정·결정 필요 항목 | [13-risks-open-questions.md](13-risks-open-questions.md) | 전체 |

# Data Contracts (정본 / single source of truth)

> 이 문서는 CLCOMX "Direct Agent Runtime"의 **공통 데이터 계약 정본**이다. normalized agent model, Agent Runtime Port, persistence, Tauri command/event의 **모든 TypeScript/Rust 타입 정의**가 여기 있다. 다운스트림 구현 에이전트(Codex adapter, Claude ACP adapter, Tauri runtime, frontend store)는 이 파일을 복사해서 바로 쓸 수 있어야 한다.
>
> **역할 분리**: 이 문서(15)는 **정본 타입**이다. 개념·규칙·불변식(상태 머신, upsert/reconcile, 순서 보존, approval 생명주기)은 [`04-normalized-agent-model.md`](04-normalized-agent-model.md)에 있다. 04는 규칙을 설명하고 타입은 여기로 링크한다. 두 문서가 충돌하면 **타입은 이 문서가, 규칙은 04가** 권위를 갖는다.
>
> **provider 매핑 정본**: Codex/ACP wire → normalized 변환표는 protocol ref 문서에 있다. 이 문서는 타입만 정의하고 매핑은 ref로 교차 참조한다.
> - Codex: [`ref-codex-app-server-protocol.md`](ref-codex-app-server-protocol.md) §8 (매핑표), §6 (핵심 타입), §7 (reconcile 규칙). pinned ref `rust-v0.142.0`.
> - ACP: [`ref-acp-protocol.md`](ref-acp-protocol.md) §13 (매핑표), §4–§6 (content/tool/permission). wire `protocolVersion = 1`; schema artifact는 T0.0/OQ-41에서 확정(`schema-v1.16.0`은 baseline 후보, 구현 핀 아님).
> - Claude ACP 구현체: [`ref-claude-agent-acp.md`](ref-claude-agent-acp.md). pinned `@agentclientprotocol/claude-agent-acp@0.51.0` (commit `23626c9`).

조사 시점: 2026-06-25. 코드 스냅샷 기준: commit `e7a5f9e`; 구현 전 현재 작업트리와 대조. 실제 코드 타입 컨벤션 출처: `src/lib/types.ts`, `src/lib/agents/types.ts`, `src/lib/pty.ts`.

---

## 0. 컨벤션 규칙 (모든 타입에 적용)

이 규칙들은 본 문서의 모든 타입에 무조건 적용된다.

> **권위 경계**: 본 §0은 **데이터/serde 직렬화 컨벤션**(camelCase, rename, optional 호환)의 정본이다. **코드 조직(파일 분리)·주석(doc-comment)** 규약은 [`17-coding-conventions.md`](17-coding-conventions.md)가 정본이다. 본 문서의 타입 정의에 다는 JSDoc 한글 주석도 17 §B.1을 따른다(타입 자체는 본 문서가 정본).


1. **provider 원본 id 보존**: provider가 준 `threadId`/`turnId`/`itemId`/`sessionId`/`messageId`/`toolCallId`/`requestId`는 **절대 덮어쓰지 않고** `ProviderRef`의 대응 필드에 그대로 보존한다. CLCOMX가 내부 id를 따로 만들더라도 원본을 잃지 않는다 (04 §"핵심 식별자", `03-target-architecture.md` §설계 원칙).
2. **raw 필드 보존**: normalized 타입으로 매핑되지 않은 provider-specific payload는 `ProviderRef.raw`, `ToolCallUpdate.rawInput`, `ToolCallUpdate.rawOutput`에 원본 그대로 보존한다. experimental/unstable 필드(Codex `#[experimental]`, ACP `_meta`)는 raw에만 둔다 (ref-codex §1.4, ref-acp §extensibility).
3. **TS 직렬화**: frontend 타입은 camelCase. discriminated union은 `type` 또는 `sessionUpdate` 같은 string discriminator(값은 snake_case 가능).
4. **Rust 직렬화 미러**: Tauri 경계를 넘는 Rust struct는 `#[serde(rename_all = "camelCase")]`로 TS와 1:1 미러링한다. 이는 `PtyRuntimeSnapshot`/`PtyOutputDelta`가 이미 따르는 backend 컨벤션이다 (`research/codebase-backend.md` §3.3). optional 필드는 `#[serde(default)]` 또는 `Option<T>`로 forward/backward 호환을 유지한다.
5. **에러 컨벤션**: 모든 Rust `#[tauri::command]`는 `Result<T, String>`을 반환한다 (`research/codebase-backend.md` §2.1, §7).
6. **transport 래퍼 경유**: frontend는 `src/lib/tauri/core.ts`의 `invoke`, `src/lib/tauri/event.ts`의 `listen`만 사용한다. `@tauri-apps/api`를 직접 import하지 않는다 (`research/codebase-frontend.md` §4.1).

---

## 1. Normalized model — 식별자

위치(권장): `src/lib/features/agent-runtime/contracts/normalized.ts`

```ts
/** 한 세션을 구동하는 provider 종류. legacy-pty는 기존 PTY를 공통 모델로 감쌀 때만 쓴다. */
export type AgentProvider = "codex" | "claude" | "legacy-pty";

/**
 * provider별 원본 식별자 보존 컨테이너. 모든 AgentEvent가 들고 다니는 라우팅 키.
 * 어느 provider냐에 따라 채워지는 필드가 다르다(아래 §1.1 라우팅 키 표).
 * 매핑 안 된 payload는 raw에 보존(컨벤션 §0.2).
 */
export interface ProviderRef {
  provider: AgentProvider;
  /** ACP SessionId / Codex Thread.sessionId(세션 트리 공유 id). */
  sessionId?: string;
  /** Codex thread id (v2 thread/turn/item 모델의 thread). ACP에는 없음. */
  threadId?: string;
  /** Codex turn id / ACP는 turn 개념이 wire id로 없음(prompt 1회 = 1 turn). */
  turnId?: string;
  /** ACP ContentChunk.messageId(청크 그룹핑). Codex는 itemId가 메시지 역할. */
  messageId?: string;
  /** Codex ThreadItem.id. ACP에는 message-level item id 없음. */
  itemId?: string;
  /** ACP ToolCallId / Codex commandExecution·fileChange item id 재사용. */
  toolCallId?: string;
  /** approval/permission 요청을 응답에 매칭하는 JSON-RPC request id(문자열화). */
  requestId?: string;
  /** 매핑 안 된 원본 payload 전체(experimental 필드 포함). */
  raw?: unknown;
}
```

### 1.1 provider별 식별자 의미와 라우팅 키 (정본)

| 개념 | Codex (v2) | ACP (v1) | CLCOMX `ProviderRef` 필드 | 비고 |
|---|---|---|---|---|
| 세션 트리 | `Thread.sessionId` | `SessionId` | `sessionId` | persistence resume 키 후보 |
| 대화 thread | `Thread.id` (`threadId`) | (없음) | `threadId` | Codex 라우팅 1차 키 |
| turn | `Turn.id` (`turnId`) | (wire id 없음; prompt 1회=turn) | `turnId` | cancel 대상 |
| transcript item | `ThreadItem.id` (`itemId`) | (message는 `messageId`로 그룹핑) | `itemId` | Codex upsert 키 |
| 메시지 청크 그룹 | (itemId가 역할) | `ContentChunk.messageId` | `messageId` | ACP upsert 키 |
| tool call | `commandExecution`/`fileChange`/`mcpToolCall` item id | `ToolCallId` | `toolCallId` | tool card upsert 키 |
| approval 요청 | JSON-RPC `id`(+`approvalId?`) | JSON-RPC `id` | `requestId` | 응답 매칭 키(pending table key는 `(sessionHandle, requestId)` — 아래 참조) |

- **Codex 라우팅 삼중 키**: `(threadId, turnId, itemId)`. 동시에 여러 thread/turn이 흐를 수 있으므로 반드시 삼중 키로 upsert한다 (ref-codex §7.1). zsh-exec-bridge 분기 시 한 `itemId`에 복수 approval이 붙으면 `approvalId`로 구분(원본은 `raw`).
- **ACP 라우팅 키**: 메시지는 `(sessionId, messageId)`, tool call은 `(sessionId, toolCallId)`. ACP는 turn id가 wire에 없으므로 `turnId`는 CLCOMX가 prompt 단위로 합성한 값을 넣는다(합성 규칙은 04 §"provider별 식별자").
- **approval pending key (H-C4)**: `requestId`(JSON-RPC `id`)는 **runtime/connection 단위로만 유일**하므로, approval pending request table의 키는 전역 단독 `requestId`가 아니라 **`(sessionHandle, requestId)` 복합 키**다. 두 runtime이 같은 `id`(예: 42)를 동시에 받아도 서로의 approval에 오응답하지 않는다(불변식). 이 table은 Event Router가 단일 소유하며 **정본 정의는 03 §2.3**이다(이 문서는 pending table을 새로 정의하지 않고 키 정합만 명시).

---

## 2. Normalized model — 세션 상태

```ts
/**
 * CLCOMX 공통 세션 상태. provider 원본 status는 축약 전 ProviderRef.raw 또는 metadata에 남긴다.
 * - starting: process 시작·protocol initialize 진행 중(아직 ready 아님)
 * - ready: initialize/session 생성 완료, prompt 가능
 * - running: turn 진행 중(agent가 작업 중)
 * - requires_action: pending approval/user input으로 사용자 응답 대기(ACP는 client 합성)
 * - idle: turn 종료, 다음 prompt 대기
 * - failed: 복구 불가 에러(systemError 등)
 * - exited: process 종료
 */
export type AgentSessionStatus =
  | "starting"
  | "ready"
  | "running"
  | "requires_action"
  | "idle"
  | "failed"
  | "exited";
```

상태 전이 규칙·provider status 합성 규칙은 [`04-normalized-agent-model.md`](04-normalized-agent-model.md) §"상태 머신"에 정의한다. provider→CLCOMX status 매핑은 Codex는 ref-codex §8 (`ThreadStatus` 변환), ACP는 ref-acp §13.1 (stopReason/tool status/permission pending 합성)을 따른다.

> **ACP 주의**: ACP v1에는 `state_update` notification이 **없다**. `running`/`requires_action`/`idle`는 (a) `session/prompt` 응답 `stopReason`, (b) tool call `status`, (c) `session/request_permission` 수신을 합성한 값이다 (ref-acp §13.1).

---

## 3. Normalized model — 이벤트 (AgentEvent)

모든 provider event는 adapter에서 이 union으로 변환되어 Event Router로 들어간다. 각 variant는 `ProviderRef ref`를 들고 다닌다(라우팅 키).

```ts
/** adapter가 provider wire를 변환해 내보내는 공통 이벤트. discriminator = type. */
export type AgentEvent =
  /** 새 세션 시작. Codex thread/started, ACP session/new result. */
  | { type: "session_started"; ref: ProviderRef; cwd: string }
  /** 과거 세션 로드(replay). ACP session/load·session/resume, Codex thread/resume·thread/read. */
  | { type: "session_loaded"; ref: ProviderRef }
  /** 세션 상태 전이. reason은 provider 원본 사유(선택). */
  | { type: "session_status_changed"; ref: ProviderRef; status: AgentSessionStatus; reason?: string }
  /** 사용자 메시지. mode=replace(전체 교체) | append(청크 누적). */
  | { type: "user_message"; ref: ProviderRef; content: AgentContent[]; mode: "replace" | "append" }
  /**
   * agent 응답 메시지. mode 의미는 user_message와 동일.
   * channel: "response"(기본, 미지정 시) = 일반 응답, "thought" = reasoning/thinking.
   * thought 채널은 별도 스트림으로 누적하며 completed reasoning item이 권위(§5 reconcile 주의).
   */
  | {
      type: "agent_message";
      ref: ProviderRef;
      content: AgentContent[];
      mode: "replace" | "append";
      channel?: "response" | "thought";
    }
  /**
   * agent 응답 스트리밍 delta(텍스트 조각). ref.itemId/messageId 기준 append.
   * channel: "response"(기본) | "thought". thought delta는 response와 별도 스트림으로 누적.
   */
  | { type: "agent_message_delta"; ref: ProviderRef; delta: string; channel?: "response" | "thought" }
  /** 실행 계획 전체 교체(ACP plan, Codex turn/plan/updated). */
  | { type: "plan_updated"; ref: ProviderRef; entries: AgentPlanEntry[] }
  /** tool call 신규 생성 또는 부분 갱신(id 기준 upsert). */
  | { type: "tool_call_updated"; ref: ProviderRef; update: ToolCallUpdate }
  /** tool call에 붙는 content 증분(예: streaming output). */
  | { type: "tool_call_content_delta"; ref: ProviderRef; content: AgentContent }
  /** 승인 요청(server→client request). request.id로 pending 관리. */
  | { type: "approval_requested"; ref: ProviderRef; request: ApprovalRequest }
  /** 승인 해결(사용자 응답 또는 serverRequest/resolved로 닫힘). */
  | { type: "approval_resolved"; ref: ProviderRef; decision: ApprovalDecision }
  /** legacy PTY 또는 embedded terminal byte stream. transcript가 아닌 terminal surface 전용. */
  | { type: "terminal_output_delta"; ref: ProviderRef; ptyId: number; seq: number; delta: string }
  /** 명령 실행 stdout/stderr 증분(thread 채널). */
  | { type: "command_output_delta"; ref: ProviderRef; stream: "stdout" | "stderr"; delta: string }
  /** 파일 변경 요약 갱신. */
  | { type: "file_change_updated"; ref: ProviderRef; change: FileChangeSummary }
  /** turn 종료. status로 정상/실패/취소 구분, usage 동승 가능. */
  | { type: "turn_completed"; ref: ProviderRef; usage?: TokenUsage; status: "completed" | "failed" | "cancelled" }
  /** provider process 종료. */
  | { type: "process_exited"; ref: ProviderRef; code?: number; signal?: string }
  /** 에러. recoverable=재시도 가능 여부(Codex willRetry / ACP error 분류). */
  | { type: "error"; ref: ProviderRef; message: string; recoverable: boolean };
```

매핑 정본: Codex notification/request → 위 variant는 ref-codex §8 표, ACP `session/update` variant → 위 variant는 ref-acp §13.2/§13.3/§13.4 표.

> **reasoning/thinking (정본, 해소됨)**: ACP `agent_thought_chunk`(reasoning)와 Codex `reasoning` item은 전용 event variant를 만들지 않고 `agent_message`/`agent_message_delta`의 `channel: "thought"`로 흘린다(미지정 시 `"response"`). thought 채널은 response와 **별도 스트림**으로 messageId/contentIndex별 누적하며, completed reasoning item이 thought 채널의 권위(reconcile)다. 누적 규칙·권위 규칙은 04 §3.2.2/§3.2.5 + §3 "이벤트", provider 매핑은 Codex ref-codex §6.3·05 §5.2, ACP ref-acp §13.2·06 §5. UI는 thought 채널을 접이식 'thinking' 블록(기본 collapsed)으로 렌더한다(08).
>
> **audio gap (unverified, 결정 필요)**: ACP `audio` content에 대응하는 AgentContent variant가 없다 (ref-acp §13.2, §14). v1은 audio를 미지원으로 두고 `raw` 보존만 한다.
>
> **transcript 메모리 관리 (신규 타입 없음 — 정책 위치 명시)**: 긴 세션에서 frontend in-memory transcript가 unbounded로 증가하는 문제의 해법(shallow 반응형 표면 + sealed-turn 윈도우 eviction + 3-상태 turn residency)은 **view-model/reducer 내부 정책**이며 **wire 계약을 바꾸지 않는다**. `AgentEvent`(§3)·Agent Runtime Port(§6)·Tauri command/event 계약(§8)은 **변경 없음**이다. seal/eviction은 reducer가 들고 다니는 view-model 상태일 뿐 adapter가 내보내는 event 형태에 영향을 주지 않는다. 따라서 본 문서(15)는 이와 관련해 **신규 타입을 정의하지 않는다**. `TranscriptModel`·`TranscriptTurnResidency`(view-model 타입) 정본은 [`08-ui-composition.md`](08-ui-composition.md) §5, seal 불변식·3-상태·late-event 규칙 정본은 [`04-normalized-agent-model.md`](04-normalized-agent-model.md) §3.7, 위험·윈도우/cap 수치는 [`13-risks-open-questions.md`](13-risks-open-questions.md) §1.12(S2)/OQ-52에 있다.

---

## 4. Normalized model — Content block

```ts
/** transcript/tool card가 렌더링하는 공통 content 블록. discriminator = type. */
export type AgentContent =
  | { type: "text"; text: string }
  | { type: "image"; uri: string; mimeType?: string }
  | { type: "resource"; uri: string; mimeType?: string; text?: string }
  | { type: "terminal"; command?: string; output: string }
  | { type: "diff"; path: string; patch: string }
  | { type: "json"; value: unknown };
```

ACP `ContentBlock`(text/image/audio/resource_link/resource) → `AgentContent` 매핑은 ref-acp §13.2. 주의: ACP image는 base64 `data`라서 adapter가 data URI 또는 저장 후 `uri`를 만든다. ACP `Diff{oldText,newText}` → `{type:"diff", patch}`는 adapter가 patch를 생성한다. Codex `UserInput`/`FileUpdateChange` → 매핑은 ref-codex §6.4, §8.

---

## 5. Normalized model — 하위 타입

provider가 더 풍부한 정보를 줘도 v1 UI가 반드시 처리해야 하는 **최소 계약**이다. 초과 정보는 `raw`/`rawInput`/`rawOutput`에 보존(컨벤션 §0.2).

```ts
/** 실행 계획 항목. ACP PlanEntry / Codex TurnPlanStep을 정규화. */
export interface AgentPlanEntry {
  id?: string;
  content: string;
  status: "pending" | "in_progress" | "completed";
  priority?: "low" | "medium" | "high";
}

/**
 * tool call 상태/내용 갱신(id 기준 upsert). 부분 갱신 시 바뀐 필드만 채운다.
 * content/locations는 전체 교체(replace) 의미(ACP ToolCallUpdate와 동일).
 */
export interface ToolCallUpdate {
  id: string;
  title?: string;
  kind: "read" | "edit" | "delete" | "move" | "search" | "execute" | "think" | "fetch" | "other";
  status: "pending" | "in_progress" | "completed" | "failed" | "cancelled";
  content?: AgentContent[];
  locations?: FileLocation[];
  rawInput?: unknown;
  rawOutput?: unknown;
}

/** 승인 요청. options 중 하나를 선택해 응답한다. */
export interface ApprovalRequest {
  id: string;
  title: string;
  body?: string;
  toolCallId?: string;
  options: ApprovalOption[];
  /**
   * UI 표현 분기 신호: "normal"(기본) = inline 카드, "escalation" = blocking modal.
   * adapter가 provider escalation 신호로 채운다. **v1 기본은 normal이되, 09 §8.3 고위험 집합
   * (Claude `bypassPermissions`, Codex `danger-full-access`/sandbox 우회(`Agent (Full Access)`))은
   * v1부터 "escalation"** 이다(OQ-47 재정의 — "전부 normal"로 단정하지 않는다). 05/06 approval 매핑이
   * 이 신호를 감지해 escalation을 부여하며, 감지 가능한 wire 신호가 불명확한 잔여만 OQ-47로 남긴다.
   * 09(보안 정본)·08 §4.4(inline vs modal 분기)·05/06 approval 매핑이 사용. */
  severity?: "normal" | "escalation";
}

/** 승인 선택지. kind로 의미를 정규화(provider 원본 label은 label에 보존). */
export interface ApprovalOption {
  id: string;
  label: string;
  kind: "allow_once" | "allow_always" | "reject_once" | "reject_always" | "cancel" | "other";
}

/** 승인 결정 결과. failed는 client 내부 에러용(wire로 안 보냄). */
export interface ApprovalDecision {
  requestId: string;
  outcome: "selected" | "cancelled" | "failed";
  optionId?: string;
}

/** 파일 내 위치. column은 ACP에 없음(Codex/내부 보강용). line/column 1-based. */
export interface FileLocation {
  path: string;
  line?: number;
  column?: number;
}

/** 파일 변경 요약. oldPath는 move일 때만. */
export interface FileChangeSummary {
  path: string;
  operation: "create" | "update" | "delete" | "move";
  oldPath?: string;
  diff?: string;
}

/** 토큰 사용량. Codex TokenUsageBreakdown / ACP UsageUpdate를 정규화. */
export interface TokenUsage {
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
  reasoningOutputTokens?: number;
  /** ACP usage_update `{used,size}` 매핑(context window 축, Codex 토큰 축과 분리).
   *  06 §3.6이 매핑, 08 contextUsage 게이지가 사용. OQ-02 해소. */
  contextUsed?: number;
  /** ACP usage_update `{used,size}`의 size(context window 총량). OQ-02 해소. */
  contextSize?: number;
}
```

매핑 주의(정본은 ref):
- `ToolCallUpdate.kind`: ACP `ToolKind`는 10종(`switch_mode` 포함) → `switch_mode`는 `other`로 축약 (ref-acp §5, §13.3). Codex item type → kind는 ref-codex §6.3/§8.
- `ToolCallUpdate.status`: ACP `ToolCallStatus`에는 `cancelled`가 **없다**. `cancelled`는 turn cancel 시 client가 미완료 tool call에 합성한다 (ref-acp §5). Codex `CommandExecutionStatus`(`inProgress`/`completed`/`failed`/`declined`) → `declined`는 `failed`로 매핑(ref-codex §6.3).
- `ApprovalOption.kind`: ACP `PermissionOptionKind`는 4종(`allow_once`/`allow_always`/`reject_once`/`reject_always`)으로 1:1 (ref-acp §6). `cancel`/`other`는 Codex/내부용. Codex decision → kind는 ref-codex §8.1 표.
- `ApprovalDecision.outcome`: ACP wire는 `selected`/`cancelled`만(ref-acp §6). `failed`는 CLCOMX 내부 전용.
- `AgentPlanEntry.status`: Codex `TurnPlanStepStatus`는 `inProgress`(camelCase) → `in_progress` (ref-codex §6.8). ACP `PlanEntryStatus`는 이미 snake_case (ref-acp §10).
- `TokenUsage`: Codex `TokenUsageBreakdown`의 `inputTokens`/`cachedInputTokens`/`outputTokens`/`reasoningOutputTokens` 직접 매핑(`totalTokens`는 버림) (ref-codex §6.7). ACP `UsageUpdate{used,size}`는 Codex 토큰 축과 분리된 context window 축이므로 `used`→`contextUsed`, `size`→`contextSize`로 매핑한다(ref-acp §10, 06 §3.6, 08 contextUsage 게이지; **OQ-02 해소**). `cost` 등 잔여 필드는 raw 보존.
- **`agent_message`/`agent_message_delta`의 `channel` 누적·권위 (reconcile)**: `channel` 미지정은 `"response"`로 간주한다. `"response"`와 `"thought"`는 **별도 스트림**으로, 같은 messageId/contentIndex 안에서 각 채널별로 독립 append한다(두 채널을 한 본문에 섞지 않는다). `"thought"` 채널은 streaming delta를 점진 렌더용으로만 쓰고, completed reasoning item(`agent_message{channel:"thought", mode:"replace"}`)이 **권위**다 — delta 누적과 일치를 가정하지 않는다(메시지 reconcile 규칙은 `"response"` 한정). 누적·권위 규칙 정본은 04 §3.2.2/§3.2.5, provider 매핑은 Codex 05 §5.2 / ACP 06 §5.

---

## 6. Agent Runtime Port (TypeScript interface 정본)

위치(권장): `src/lib/features/agent-runtime/contracts/runtime-port.ts`

provider별 구현(Codex/Claude/Legacy adapter)을 숨기는 TS-facing interface. UI/store는 이 interface만 본다 (`03-target-architecture.md` §Agent Runtime Port).

```ts
import type { AgentEvent, AgentContent, ApprovalDecision, ProviderRef, AgentProvider } from "./normalized";
import type { UnlistenFn } from "$lib/tauri/event"; // 실제 경로는 src/lib/tauri/event.ts

/** 세션을 식별하는 CLCOMX 내부 핸들(=live-session-store의 session.id). provider id 아님. */
export type AgentSessionHandle = string;

/** startSession 입력. provider별 기동 파라미터는 adapter가 검증된 형태로만 채운다. */
export interface StartSessionParams {
  /** CLCOMX 세션 핸들(tab id와 동일). */
  sessionHandle: AgentSessionHandle;
  provider: Exclude<AgentProvider, "legacy-pty">;
  distro: string;
  /** WSL absolute path. ACP는 absolute 필수(adapter 입력 직전 canonicalize). */
  workDir: string;
  /** provider별 추가 옵션(모델/approval policy 등). adapter가 해석. */
  options?: Record<string, unknown>;
}

/** resumeSession 입력. provider session/thread id로 재개. */
export interface ResumeSessionParams {
  sessionHandle: AgentSessionHandle;
  provider: Exclude<AgentProvider, "legacy-pty">;
  distro: string;
  workDir: string;
  /** provider 원본 session/thread id(resume 토큰). */
  providerSessionId?: string;
  providerThreadId?: string;
  /** true면 replay(ACP session/load, Codex thread/read), false면 replay 없이 재개. */
  replay: boolean;
  options?: Record<string, unknown>;
}

/** sendPrompt 입력. composer가 만든 content를 그대로 넘긴다. */
export interface SendPromptInput {
  content: AgentContent[];
}

/** 시작/재개 결과. provider 원본 id를 ref로 돌려준다. */
export interface SessionStartResult {
  ref: ProviderRef;
}

/**
 * Agent Runtime Port. 모든 메서드는 비동기. 이벤트 스트림은 subscribeEvents로 구독.
 * 구현체는 provider adapter(Codex/Claude/Legacy)이며 Tauri command(§8)를 호출한다.
 */
export interface AgentRuntimePort {
  /** 새 세션 시작: process spawn + protocol initialize + session 생성. */
  startSession(params: StartSessionParams): Promise<SessionStartResult>;

  /** 기존 세션 재개. replay 여부는 params.replay. */
  resumeSession(params: ResumeSessionParams): Promise<SessionStartResult>;

  /** 프롬프트 전송(1 turn 시작). turn 진행은 subscribeEvents로 관찰. */
  sendPrompt(sessionHandle: AgentSessionHandle, input: SendPromptInput): Promise<void>;

  /** 진행 중 turn 취소. turnId 생략 시 현재 active turn. */
  cancelTurn(sessionHandle: AgentSessionHandle, turnId?: string): Promise<void>;

  /** 승인 요청에 응답. requestId로 pending request에 매칭. */
  respondApproval(sessionHandle: AgentSessionHandle, decision: ApprovalDecision): Promise<void>;

  /**
   * 세션 이벤트 구독. 반환된 UnlistenFn으로 해제.
   * adapter가 provider wire → AgentEvent 변환 후 listener에 전달.
   */
  subscribeEvents(sessionHandle: AgentSessionHandle, listener: (event: AgentEvent) => void): UnlistenFn;

  /** 세션 종료: graceful shutdown(stdin close → timeout → kill). */
  shutdown(sessionHandle: AgentSessionHandle): Promise<void>;
}
```

> 메서드 시그니처는 `03-target-architecture.md` §Agent Runtime Port의 7개(startSession/resumeSession/sendPrompt/cancelTurn/respondApproval/subscribeEvents/shutdown)를 정본화한 것이다. `subscribeEvents`는 push 콜백 + `UnlistenFn` 형태로, frontend `listen` 래퍼 패턴(`research/codebase-frontend.md` §4.1)과 일치시켰다.

---

## 7. Persistence 계약

위치: 기존 `src/lib/types.ts` 확장 + Rust `features/workspace/types.rs`.

### 7.1 SessionRuntimeKind / AgentRuntimeMetadata (TS 정본)

```ts
/** 세션이 어떤 runtime으로 구동되는지. 기존 PTY는 "pty". */
export type SessionRuntimeKind = "pty" | "direct-codex" | "direct-claude";

/** direct runtime 세션 metadata. transcript 전체가 아닌 재개·복원용 메타만 저장. */
export interface AgentRuntimeMetadata {
  sessionRuntimeKind: SessionRuntimeKind;
  provider: AgentProvider; // "codex" | "claude" | "legacy-pty"
  /** provider 원본 session id(resume 키). 평문 영속화 금지 — scrub 대상(§7.3). */
  providerSessionId?: string;
  /** Codex thread id. scrub 대상. */
  providerThreadId?: string;
  /** 마지막 turn id. */
  lastTurnId?: string;
  /** provider별 resume 토큰. scrub 대상. */
  providerResumeToken?: string;
  /** 협상된 protocol 버전(Codex/ACP wire 버전). */
  protocolVersion?: string;
  /** adapter/provider 바이너리 버전(호환성 추적). */
  adapterVersion?: string;
  providerVersion?: string;
  /** replay 없는 재개 가능 여부(ACP resume / Codex thread/resume). */
  canResume?: boolean;
  /** replay 가능 여부(ACP loadSession / Codex thread/read). */
  canLoad?: boolean;
}
```

> 위 두 타입은 [`10-persistence-migration.md`](10-persistence-migration.md) §저장 모델을 정본화한 것이다. transcript persistence 정책(초기엔 metadata만, full cache는 후속)도 10 문서 §Transcript persistence를 따른다.

### 7.2 기존 타입 확장 (src/lib/types.ts)

기존 `SessionPersistedState`/`WorkspaceTabSnapshot`에 runtime kind와 metadata를 **optional 확장**으로 추가한다. optional + default로 기존 `workspace.json`과 forward/backward 호환된다 (`research/codebase-backend.md` §4.2).

```ts
// src/lib/types.ts — SessionCore 확장 (신규 필드)
export interface SessionCore {
  id: string;
  agentId: AgentId;
  resumeToken: string | null;
  title: string;
  pinned: boolean;
  locked: boolean;
  distro: string;
  workDir: string;
  // ── 신규 ──
  /** 미지정(기존 세션)이면 "pty"로 normalize. */
  runtimeKind?: SessionRuntimeKind;
}

// WorkspaceTabSnapshot 확장 (Rust WorkspaceTabSnapshot와 미러). 모두 optional.
export interface WorkspaceTabSnapshot {
  sessionId: string;
  agentId: AgentId;
  distro: string;
  workDir: string;
  title: string;
  pinned: boolean;
  locked: boolean;
  resumeToken?: string | null; // 디스크 저장 시 scrub
  ptyId?: number | null;       // 디스크 저장 시 scrub
  auxPtyId?: number | null;
  auxVisible?: boolean;
  auxHeightPercent?: number | null;
  viewMode?: SessionViewMode;
  editorRootDir?: string;
  openEditorTabs?: EditorTabRef[];
  activeEditorPath?: string | null;
  // ── 신규 ──
  /** 미지정이면 "pty"로 normalize. */
  runtimeKind?: SessionRuntimeKind;
  /** direct runtime metadata. resume 키류는 디스크 저장 시 scrub(§7.3). */
  agentRuntime?: AgentRuntimeMetadata;
}
```

> **주의(frontend 정합)**: `SessionViewMode`(`"terminal"|"editor"`)를 `"agent"`로 확장하지 **않는다**. viewMode는 한 host 내부의 surface 토글이고 runtimeKind는 host 종류 자체다 (`research/codebase-frontend.md` §5, §9). 새 필드는 `session-factory.buildSession`, `createSessionHostProps`, `SessionShell.svelte` 분기로 전파한다(같은 문서 §10 체크리스트).

### 7.3 Rust 미러 (features/workspace/types.rs)

기존 `WorkspaceTabSnapshot`(serde camelCase, `research/codebase-backend.md` §4.2)에 동일 필드를 `#[serde(default)]`로 추가한다.

```rust
// features/workspace/types.rs — 신규 필드 (기존 struct에 추가)
#[serde(default = "default_runtime_kind")] // 기본 "pty"
pub runtime_kind: String,                  // "pty" | "direct-codex" | "direct-claude"
#[serde(default, skip_serializing_if = "Option::is_none")]
pub agent_runtime: Option<AgentRuntimeMetadataRecord>,

#[derive(Clone, Debug, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct AgentRuntimeMetadataRecord {
    pub session_runtime_kind: String,        // SessionRuntimeKind
    pub provider: String,                    // AgentProvider
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider_session_id: Option<String>, // scrub
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider_thread_id: Option<String>,  // scrub
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_turn_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider_resume_token: Option<String>, // scrub
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub protocol_version: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub adapter_version: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider_version: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub can_resume: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub can_load: Option<bool>,
}
```

> **보안 경계 (정본)**: `provider_session_id`/`provider_thread_id`/`provider_resume_token`은 기존 `pty_id`/`resume_token`과 동일하게 **디스크 저장 직전 scrub**한다. `sanitize_workspace_for_persist`(store.rs)에 이 3필드 제거를 추가하고, history에는 저장하지 않는다 (`research/codebase-backend.md` §4.2, §4.4, §10 권고 7). 새 비밀을 평문 영속화하면 기존 보안 경계가 깨진다.

---

## 8. Tauri command / event 계약

위치: TS `src/lib/features/agent-runtime/service/transport.ts`, Rust `commands/agent_runtime.rs` + `features/agent_runtime/`.

`agent_runtime_*` command는 direct runtime 전용이며 기존 `pty_*`와 네임스페이스가 분리된다 (`07-tauri-process-runtime.md` §, `research/codebase-backend.md` §10 권고 1·2).

### 8.1 공통 wire 타입

```ts
// src/lib/features/agent-runtime/service/transport.ts
export type RuntimeId = number;
export type JsonRpcId = string | number | null;

/**
 * JSON-RPC 메시지 4종. 주의: Codex app-server는 `jsonrpc` 필드를 보내지도 기대하지도 않는다
 * (ref-codex §1.2). ACP는 JSON-RPC 2.0 정식이라 `jsonrpc:"2.0"`를 쓴다(ref-acp §1).
 * adapter가 provider별로 envelope를 맞춘다. 이 union은 둘을 모두 표현(jsonrpc optional).
 */
export type JsonRpcMessage =
  | { jsonrpc?: "2.0"; id: JsonRpcId; method: string; params?: unknown }
  | { jsonrpc?: "2.0"; method: string; params?: unknown }
  | { jsonrpc?: "2.0"; id: JsonRpcId; result: unknown }
  | { jsonrpc?: "2.0"; id: JsonRpcId; error: JsonRpcError };

export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

/**
 * process/transport 기동 파라미터. provider별 variant.
 *
 * **command 비제어 (S1 정본 — R4 allowlist 충돌 해소)**: renderer/adapter는 **실행 파일
 * command를 넘기지 않는다**. backend가 `provider`로 신뢰 절대경로를 resolve한다(codex →
 * resolve된 codex app-server 절대경로; claude → resolve된 node 절대경로). 동명 바이너리
 * (`/tmp/codex`, `/tmp/node`) 우회를 원천 차단한다. adapter는 provider/distro/workDir/args/env만
 * 채우며, 이 중 `args`만 검증 대상이고 `env`는 non-secret 전용이다(07 §5.1·§8.1, secret 경계는 09).
 * - codex `args`: backend가 정확히 `["app-server","--stdio"]`로 검증(07 §8.1).
 * - claude `args`: `args.length == 1` 이고 `args[0]`이 backend가 검증한 `adapterEntryPath`
 *   절대경로(`claude-agent-acp` `dist/index.js`). adapterEntryPath는 renderer 자유 입력이 아니라
 *   backend가 고정 npm 의존 위치에서 resolve(또는 사전 등록 절대경로)한다(06 §2.2, 07 §8.1).
 * - command resolve 주체·캐시 무효화·adapterEntryPath 탐색 방식은 결정 필요(13).
 */
export type AgentRuntimeStartParams =
  | {
      transportKind: "jsonrpc-stdio";
      provider: "codex";
      distro: string;
      workDir: string;
      args: string[];   // backend 검증: 정확히 ["app-server","--stdio"]
      env?: Record<string, string>; // non-secret 전용
    }
  | {
      transportKind: "jsonrpc-stdio";
      provider: "claude";
      distro: string;
      workDir: string;
      args: string[];   // backend 검증: [adapterEntryPath](절대경로, backend resolve)
      env?: Record<string, string>; // non-secret 전용
    }
  | {
      // Codex websocket, 검증 후 optional(1차 미구현 권고). **future-sketch — 타입만 유지**.
      // v1 미사용: backend handler가 이 variant를 **로깅/스냅샷 노출 전 reject**(07 §8.1 reject-before-log,
      //   13 RD-2). `authToken`은 redaction 집합(09 §5.1)에 포함 — 평문 로그/스냅샷/디스크 금지.
      //   "token 로깅 없이 reject"는 11에서 테스트한다. stdio-only 강제는 타입이 아니라 handler 책임이므로
      //   variant 타입 자체는 제거하지 않는다(07이 거부 책임 보유, 13 RD-2).
      transportKind: "websocket";
      provider: "codex";
      distro: string;
      workDir: string;
      url: string;
      authToken?: string; // v1 미사용 — redaction 집합(09 §5.1), reject-before-log(07 §8.1)
    };

/** cancel 대상. request=approval 요청, turn=진행 turn, process=전체. */
export type AgentRuntimeCancelTarget =
  | { type: "request"; requestId: string }
  | { type: "turn"; turnId: string }
  | { type: "process" };

/** runtime 상태 스냅샷(late-attach/진단용). */
export interface AgentRuntimeSnapshot {
  runtimeId: RuntimeId;
  provider: "codex" | "claude";
  status: "starting" | "running" | "exited" | "failed";
  startedAt: number;
  exitedAt?: number;
  pendingRequestIds: string[];
}
```

> `transportKind`(process/transport 실행 방식)와 `SessionRuntimeKind`(persistence)는 **별개 축**이다 (`07-tauri-process-runtime.md` §). **command는 renderer가 넘기지 않는다(S1 정본)**: backend가 `provider`로 신뢰 절대경로를 resolve하므로, adapter는 `args`/`env`만 채운다. `args`는 adapter가 생성하되 Rust handler가 provider별로 **정확 일치 재검증**하고(codex `["app-server","--stdio"]`, claude `[adapterEntryPath]`), `env`는 non-secret 전용 + key allowlist로 재검증한다(임의 executable/shell string 차단; 07 §8.1, 신뢰 경계 정본 09). 이는 PTY 대비 의도적 강화 지점으로 현 코드에 선례가 없다 (`research/codebase-backend.md` §6, §10 권고 6).

### 8.2 Command 시그니처 (TS ↔ Rust 미러)

| TS (invoke 래퍼) | Rust `#[tauri::command]` | 반환 |
|---|---|---|
| `agentRuntimeStart(params: AgentRuntimeStartParams): Promise<RuntimeId>` | `agent_runtime_start(state, app, params: AgentRuntimeStartParams) -> Result<RuntimeId, String>` | `RuntimeId` |
| `agentRuntimeSend(runtimeId: RuntimeId, message: JsonRpcMessage): Promise<void>` | `agent_runtime_send(state, runtime_id: u32, message: JsonRpcMessage) -> Result<(), String>` | `void` |
| `agentRuntimeCancel(runtimeId: RuntimeId, target: AgentRuntimeCancelTarget): Promise<void>` | `agent_runtime_cancel(state, runtime_id: u32, target: AgentRuntimeCancelTarget) -> Result<(), String>` | `void` |
| `agentRuntimeShutdown(runtimeId: RuntimeId): Promise<void>` | `agent_runtime_shutdown(state, runtime_id: u32) -> Result<(), String>` | `void` |
| `agentRuntimeGetSnapshot(runtimeId: RuntimeId): Promise<AgentRuntimeSnapshot>` | `agent_runtime_get_snapshot(state, runtime_id: u32) -> Result<AgentRuntimeSnapshot, String>` | `AgentRuntimeSnapshot` |

```ts
// TS invoke 래퍼 (src/lib/tauri/core.ts의 invoke 경유)
import { invoke } from "$lib/tauri/core";

export async function agentRuntimeStart(params: AgentRuntimeStartParams): Promise<RuntimeId> {
  return await invoke<RuntimeId>("agent_runtime_start", { params });
}
export async function agentRuntimeSend(runtimeId: RuntimeId, message: JsonRpcMessage): Promise<void> {
  await invoke("agent_runtime_send", { runtimeId, message });
}
export async function agentRuntimeCancel(runtimeId: RuntimeId, target: AgentRuntimeCancelTarget): Promise<void> {
  await invoke("agent_runtime_cancel", { runtimeId, target });
}
export async function agentRuntimeShutdown(runtimeId: RuntimeId): Promise<void> {
  await invoke("agent_runtime_shutdown", { runtimeId });
}
export async function agentRuntimeGetSnapshot(runtimeId: RuntimeId): Promise<AgentRuntimeSnapshot> {
  return await invoke<AgentRuntimeSnapshot>("agent_runtime_get_snapshot", { runtimeId });
}
```

```rust
// Rust struct 미러 (commands/agent_runtime.rs / features/agent_runtime/types.rs)
// 모두 #[serde(rename_all = "camelCase")]로 TS와 1:1.

pub type RuntimeId = u32;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JsonRpcError {
    pub code: i64,
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub data: Option<serde_json::Value>,
}

// JsonRpcMessage: serde untagged로 4종 표현. jsonrpc는 Option(Codex는 생략).
// S2 note: variant 필드(jsonrpc/id/method/params/result/error)는 모두 단일어 lowercase라
//   camelCase와 동일하므로 직렬화 불일치가 없다. 그래도 다른 enum 미러와 일관성을 위해
//   #[serde(rename_all_fields = "camelCase")](serde >= 1.0.181)를 명시한다(JSON-RPC wire
//   필드명은 고정이므로 동작 변화 없음).
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(untagged, rename_all_fields = "camelCase")]
pub enum JsonRpcMessage {
    Request {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        jsonrpc: Option<String>,
        id: serde_json::Value, // string | number | null
        method: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        params: Option<serde_json::Value>,
    },
    Notification {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        jsonrpc: Option<String>,
        method: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        params: Option<serde_json::Value>,
    },
    Response {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        jsonrpc: Option<String>,
        id: serde_json::Value,
        result: serde_json::Value,
    },
    Error {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        jsonrpc: Option<String>,
        id: serde_json::Value,
        error: JsonRpcError,
    },
}

// S2: variant 내부 필드(work_dir/auth_token)를 camelCase로 직렬화하려면 enum 레벨
//     #[serde(rename_all = ...)](variant 이름만 변환)만으로는 부족하다 →
//     #[serde(rename_all_fields = "camelCase")] 추가(serde >= 1.0.181).
//     이게 없으면 TS workDir/authToken ↔ Rust work_dir/auth_token 역직렬화가 실패한다.
//     S1: command 필드 제거(renderer 비제어). backend가 provider로 신뢰 절대경로를 resolve한다.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "transportKind", rename_all = "kebab-case", rename_all_fields = "camelCase")]
pub enum AgentRuntimeStartParams {
    #[serde(rename = "jsonrpc-stdio")]
    JsonrpcStdio {
        provider: String, // "codex" | "claude"
        distro: String,
        work_dir: String,       // → "workDir"
        // command 없음(S1): backend가 provider로 신뢰 절대경로 resolve(07 §8.1).
        args: Vec<String>,      // backend 정확 검증(codex/claude provider별)
        #[serde(default, skip_serializing_if = "Option::is_none")]
        env: Option<std::collections::HashMap<String, String>>, // non-secret 전용
    },
    // future-sketch — 타입만 유지. v1 미사용: handler가 **로깅/스냅샷 노출 전 reject**(07 §8.1, 13 RD-2).
    // auth_token은 redaction 집합(09 §5.1) — 평문 로그/스냅샷/디스크 금지. "token 로깅 없이 reject" 테스트는 11.
    // stdio-only 강제는 handler 책임이므로 variant 타입은 제거하지 않는다.
    #[serde(rename = "websocket")]
    Websocket {
        provider: String, // "codex"
        distro: String,
        work_dir: String,       // → "workDir"
        url: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        auth_token: Option<String>, // → "authToken" — v1 미사용, redaction(09 §5.1)·reject-before-log(07 §8.1)
    },
}

// S2: variant 필드 request_id/turn_id를 camelCase(requestId/turnId)로 직렬화하려면
//     rename_all_fields 필요(serde >= 1.0.181). tag/variant rename_all만으로는 필드명이 안 바뀐다.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum AgentRuntimeCancelTarget {
    Request { request_id: String }, // → "requestId"
    Turn { turn_id: String },       // → "turnId"
    Process,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentRuntimeSnapshot {
    pub runtime_id: RuntimeId,
    pub provider: String,
    pub status: String, // "starting" | "running" | "exited" | "failed"
    pub started_at: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub exited_at: Option<i64>,
    pub pending_request_ids: Vec<String>,
}
```

> Rust 등록은 `commands/mod.rs`에 `pub mod agent_runtime;`, `lib.rs`에 `use` + `.manage(AgentRuntimeState::default())` + `generate_handler![]` 3곳을 손댄다 (`research/codebase-backend.md` §3.2). `AgentRuntimeState`는 PTY `PtyState`와 별도(`Mutex<HashMap<RuntimeId, AgentRuntime>>` + `next_id`)로 둔다(같은 문서 §10 권고 1).
>
> **S2 — enum variant 필드 camelCase (역직렬화 정합 정본)**: enum 레벨 `#[serde(rename_all = ...)]`은 **variant 이름만** 바꾸고 variant 내부 필드는 snake_case로 남는다. 따라서 variant 필드를 가진 enum 미러(`AgentRuntimeStartParams`의 `work_dir`/`auth_token`, `AgentRuntimeCancelTarget`의 `request_id`/`turn_id`, `AgentRuntimeEvent`의 `runtime_id`/`dropped_messages`, `JsonRpcMessage`)는 추가로 **`#[serde(rename_all_fields = "camelCase")]`**(또는 필드별 `#[serde(rename = "...")]`)를 붙여야 TS의 `workDir`/`requestId`/`runtimeId`/`droppedMessages` 등과 Tauri command/event payload가 1:1 역직렬화된다. 이게 없으면 역직렬화가 조용히 실패한다. `rename_all_fields`는 **serde >= 1.0.181**에서만 지원되므로 구현 전 `src-tauri/Cargo.toml`의 serde 버전을 확인한다(미만이면 필드별 `rename`으로 대체; 결정 필요 항목 [13](13-risks-open-questions.md) "serde 버전 확인"). **struct 미러**(`AgentRuntimeSnapshot`, `JsonRpcError`, `AgentRuntimeMetadataRecord`(§7.3))는 struct 레벨 `#[serde(rename_all = "camelCase")]`가 필드까지 적용되므로 추가 속성이 **불필요**하다(유지). round-trip(TS↔Rust) 테스트는 11이 필수화한다.

### 8.3 Event 계약 (Rust emit → frontend listen)

event 이름은 kebab-case 문자열 리터럴, payload는 `#[serde(rename_all="camelCase")]` (`research/codebase-backend.md` §3.3). frontend는 `listen` 래퍼로 구독.

| event 이름 | 의미 | payload variant |
|---|---|---|
| `agent-runtime-message` | JSON-RPC response/notification/request | `{ type:"message", runtimeId, message }` (Rust emit은 `message: serde_json::Value`, TS 수신은 `JsonRpcMessage` — §8.3 비대칭 주석) |
| `agent-runtime-stderr` | stderr 로그 라인 | `{ type:"stderr", runtimeId, line }` |
| `agent-runtime-exit` | process 종료 | `{ type:"exit", runtimeId, code?, signal? }` |
| `agent-runtime-error` | framing/runtime 에러 | `{ type:"error", runtimeId, message, recoverable }` |
| `agent-runtime-backpressure` | bounded queue saturation | `{ type:"backpressure", runtimeId, droppedMessages }` |

```ts
// src/lib/features/agent-runtime/service/transport.ts
export type AgentRuntimeEvent =
  | { type: "message"; runtimeId: RuntimeId; message: JsonRpcMessage }
  | { type: "stderr"; runtimeId: RuntimeId; line: string }
  | { type: "exit"; runtimeId: RuntimeId; code?: number; signal?: string }
  | { type: "error"; runtimeId: RuntimeId; message: string; recoverable: boolean }
  | { type: "backpressure"; runtimeId: RuntimeId; droppedMessages: number };
```

```rust
// Rust emit payload 미러 (features/agent_runtime/types.rs)
// S2: variant 필드 runtime_id/dropped_messages를 camelCase(runtimeId/droppedMessages)로
//     직렬화하려면 rename_all_fields 필요(serde >= 1.0.181). tag/variant rename_all만으로는
//     필드명이 snake_case로 남아 frontend listen payload 역직렬화가 깨진다.
// M-4: Message variant의 message는 **Rust `serde_json::Value`로 무손실 통과**시키고(아래 주석),
//     TS 측은 `JsonRpcMessage`로 받는다. JsonRpcMessage가 untagged라 동일 JSON이므로 비대칭이어도 wire-compat.
#[derive(Clone, Debug, Serialize)]
#[serde(tag = "type", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum AgentRuntimeEvent {
    Message { runtime_id: RuntimeId, message: serde_json::Value }, // → "runtimeId"; TS는 JsonRpcMessage로 수신(M-4 비대칭)
    Stderr { runtime_id: RuntimeId, line: String },
    Exit { runtime_id: RuntimeId, #[serde(skip_serializing_if = "Option::is_none")] code: Option<i32>, #[serde(skip_serializing_if = "Option::is_none")] signal: Option<String> },
    Error { runtime_id: RuntimeId, message: String, recoverable: bool },
    Backpressure { runtime_id: RuntimeId, dropped_messages: u64 }, // → "droppedMessages"
}
```

> `agent-runtime-message`는 **raw JSON-RPC**를 그대로 올린다. provider wire → `AgentEvent`(§3) 변환은 frontend adapter(Codex/Claude)가 담당한다. backend는 framing/transport만 책임지고 protocol 의미를 해석하지 않는다 (`07-tauri-process-runtime.md` §Framing, `03-target-architecture.md` §Provider Adapter).
>
> **M-4 — emit payload 비대칭 (정본)**: `Message` variant의 `message`는 **Rust 측 `serde_json::Value`** 로 두고 **TS 측은 `JsonRpcMessage`** 로 받는다. backend는 protocol 의미를 해석하지 않으므로(§0) `JsonRpcMessage` untagged enum이 어느 variant인지 판정하는 비용을 frontend로 미루고, Rust는 디코드한 `Value`를 그대로 무손실 통과시켜 round-trip 손실을 없앤다. untagged라 동일 JSON으로 직렬화/수신되므로 이 비대칭은 wire-compat하다(07 §4.2 권고와 일치). **send 방향**(`agent_runtime_send`의 `message: JsonRpcMessage`, §8.2)은 renderer가 구성한 메시지를 받으므로 `JsonRpcMessage`를 유지한다.
>
> **M-1 — seq 미도입 (정본)**: v1은 **event-level `seq`를 도입하지 않는다**(§3 AgentEvent union에 추가 안 함; `terminal_output_delta.seq`는 PTY byte-stream 전용으로 별개). per-(라우팅 키) receive-order가 v1 정렬 권위다(04 §3.4). late-attach 신뢰성을 위한 **backend transport message seq + snapshot/delta-since**(PTY와 동일 원리)는 **후속 enhancement**이며, 도입 시 message payload에 단조 증가 seq를 추가한다(`research/codebase-backend.md` §2.3, §10 권고 3, 13 OQ-17).

---

## 9. 정본 type 인덱스 (다른 문서가 인용해야 하는 이름)

다른 문서/구현은 이 타입들을 **재정의하지 말고** 이 파일을 import/링크한다.

- normalized: `AgentProvider`, `ProviderRef`, `AgentSessionStatus`, `AgentEvent`, `AgentContent`, `ToolCallUpdate`, `ApprovalRequest`, `ApprovalOption`, `ApprovalDecision`, `AgentPlanEntry`, `FileLocation`, `FileChangeSummary`, `TokenUsage`
- port: `AgentRuntimePort`, `AgentSessionHandle`, `StartSessionParams`, `ResumeSessionParams`, `SendPromptInput`, `SessionStartResult`
- persistence: `SessionRuntimeKind`, `AgentRuntimeMetadata` (+ Rust `AgentRuntimeMetadataRecord`)
- tauri: `RuntimeId`, `JsonRpcId`, `JsonRpcMessage`, `JsonRpcError`, `AgentRuntimeStartParams`, `AgentRuntimeCancelTarget`, `AgentRuntimeSnapshot`, `AgentRuntimeEvent`

---

## 10. 교차 참조

| 대상 | 문서 | 절 |
|---|---|---|
| 상태 머신·upsert/reconcile·approval 생명주기·식별자 라우팅 규칙 | [`04-normalized-agent-model.md`](04-normalized-agent-model.md) | 전체 |
| Codex wire → normalized 매핑·핵심 타입·reconcile | [`ref-codex-app-server-protocol.md`](ref-codex-app-server-protocol.md) | §6, §7, §8 |
| ACP wire → normalized 매핑·content/tool/permission | [`ref-acp-protocol.md`](ref-acp-protocol.md) | §4, §5, §6, §13 |
| Claude ACP 구현체 capability/launch/auth | [`ref-claude-agent-acp.md`](ref-claude-agent-acp.md) | §1, §2, §3 |
| hexagonal 구조·Port·Adapter·Router·Store 역할 | [`03-target-architecture.md`](03-target-architecture.md) | 전체 |
| Tauri command/event·framing·process lifecycle·WSL 경계 | [`07-tauri-process-runtime.md`](07-tauri-process-runtime.md) | 전체 |
| persistence migration·transcript 정책·호환성·scrub | [`10-persistence-migration.md`](10-persistence-migration.md) | 전체 |
| backend 코드 현실(상태 모델·등록·scrub·allowlist) | [`research/codebase-backend.md`](research/codebase-backend.md) | §2, §3, §4, §6, §10 |
| frontend 코드 현실(feature 레이어·host 분기·타입 확장) | [`research/codebase-frontend.md`](research/codebase-frontend.md) | §1, §5, §8, §9, §10 |

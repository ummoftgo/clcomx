# Normalized Agent Model

## 목표

Codex app-server와 Claude ACP의 event shape는 다르다. UI와 persistence가 두 protocol에 직접 결합되지 않도록 CLCOMX 내부 공통 모델을 둔다.

## 핵심 식별자

```ts
type AgentProvider = "codex" | "claude" | "legacy-pty";

interface ProviderRef {
  provider: AgentProvider;
  sessionId?: string;
  threadId?: string;
  turnId?: string;
  messageId?: string;
  itemId?: string;
  toolCallId?: string;
  requestId?: string;
  raw?: unknown;
}
```

원본 id는 provider별 field로 보존한다. 공통 id를 만들더라도 원본 id를 덮어쓰지 않는다.

## 세션 상태

```ts
type AgentSessionStatus =
  | "starting"
  | "ready"
  | "running"
  | "requires_action"
  | "idle"
  | "failed"
  | "exited";
```

ACP의 `state_update`와 Codex의 thread/turn status를 이 상태로 축약한다. 축약 전 원본 status는 `ProviderRef.raw` 또는 metadata에 남긴다.

## 이벤트

```ts
type AgentEvent =
  | { type: "session_started"; ref: ProviderRef; cwd: string }
  | { type: "session_loaded"; ref: ProviderRef }
  | { type: "session_status_changed"; ref: ProviderRef; status: AgentSessionStatus; reason?: string }
  | { type: "user_message"; ref: ProviderRef; content: AgentContent[]; mode: "replace" | "append" }
  | { type: "agent_message"; ref: ProviderRef; content: AgentContent[]; mode: "replace" | "append" }
  | { type: "agent_message_delta"; ref: ProviderRef; delta: string }
  | { type: "plan_updated"; ref: ProviderRef; entries: AgentPlanEntry[] }
  | { type: "tool_call_updated"; ref: ProviderRef; update: ToolCallUpdate }
  | { type: "tool_call_content_delta"; ref: ProviderRef; content: AgentContent }
  | { type: "approval_requested"; ref: ProviderRef; request: ApprovalRequest }
  | { type: "approval_resolved"; ref: ProviderRef; decision: ApprovalDecision }
  | { type: "terminal_output_delta"; ref: ProviderRef; ptyId: number; seq: number; delta: string }
  | { type: "command_output_delta"; ref: ProviderRef; stream: "stdout" | "stderr"; delta: string }
  | { type: "file_change_updated"; ref: ProviderRef; change: FileChangeSummary }
  | { type: "turn_completed"; ref: ProviderRef; usage?: TokenUsage; status: "completed" | "failed" | "cancelled" }
  | { type: "process_exited"; ref: ProviderRef; code?: number; signal?: string }
  | { type: "error"; ref: ProviderRef; message: string; recoverable: boolean };
```

## Upsert와 append 규칙

- message와 tool call은 id 기준 upsert를 지원한다.
- `mode: "replace"`는 기존 content를 통째로 교체한다.
- `mode: "append"`는 기존 content 뒤에 chunk를 붙인다.
- Codex delta는 `agent_message_delta`로 먼저 반영하고, completion item이 오면 message 최종본으로 reconcile한다.
- ACP `user_message`, `agent_message`, `agent_thought`, `tool_call_update`는 upsert 규칙을 그대로 반영한다.
- Legacy PTY output은 전체 agent transcript가 아니라 `terminal_output_delta`로 보존하고, UI는 legacy/fallback terminal surface에만 렌더링한다.

## Content block

```ts
type AgentContent =
  | { type: "text"; text: string }
  | { type: "image"; uri: string; mimeType?: string }
  | { type: "resource"; uri: string; mimeType?: string; text?: string }
  | { type: "terminal"; command?: string; output: string }
  | { type: "diff"; path: string; patch: string }
  | { type: "json"; value: unknown };
```

## 하위 타입

```ts
interface AgentPlanEntry {
  id?: string;
  content: string;
  status: "pending" | "in_progress" | "completed";
  priority?: "low" | "medium" | "high";
}

interface ToolCallUpdate {
  id: string;
  title?: string;
  kind: "read" | "edit" | "delete" | "move" | "search" | "execute" | "think" | "fetch" | "other";
  status: "pending" | "in_progress" | "completed" | "failed" | "cancelled";
  content?: AgentContent[];
  locations?: FileLocation[];
  rawInput?: unknown;
  rawOutput?: unknown;
}

interface ApprovalRequest {
  id: string;
  title: string;
  body?: string;
  toolCallId?: string;
  options: ApprovalOption[];
}

interface ApprovalOption {
  id: string;
  label: string;
  kind: "allow_once" | "allow_always" | "reject_once" | "reject_always" | "cancel" | "other";
}

interface ApprovalDecision {
  requestId: string;
  outcome: "selected" | "cancelled" | "failed";
  optionId?: string;
}

interface FileLocation {
  path: string;
  line?: number;
  column?: number;
}

interface FileChangeSummary {
  path: string;
  operation: "create" | "update" | "delete" | "move";
  oldPath?: string;
  diff?: string;
}

interface TokenUsage {
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
  reasoningOutputTokens?: number;
}
```

하위 타입은 provider가 더 풍부한 정보를 주더라도 v1 UI가 반드시 처리해야 하는 최소 계약이다. provider-specific payload는 `ProviderRef.raw`, `rawInput`, `rawOutput`에 보존한다.

## Store 적용 규칙

- event apply는 순서 보존이 중요하다.
- 같은 session 안에서 message id별 append/replace 순서를 보존한다.
- provider가 순서를 보장하지 않는 event는 adapter에서 sequence를 부여한다.
- pending approval은 request id로 관리하고, turn cancel 시 unresolved request를 cancelled로 닫는다.

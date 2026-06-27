/**
 * Direct Agent Runtime — normalized agent model 타입 정본 복사처.
 *
 * 정본: `docs/plans/agent-direct-runtime/15-data-contracts.md` §1–§5.
 * 이 파일은 15의 타입을 **그대로** 복사한 것이며 재정의·축약하지 않는다.
 * 규칙(상태 전이·upsert/reconcile·approval 생명주기)은 04, wire 매핑은 ref-* 가 정본이다.
 */

// ─────────────────────────────────────────────────────────────────────────────
// §1. Normalized model — 식별자
// ─────────────────────────────────────────────────────────────────────────────

/** 한 세션을 구동하는 provider 종류. legacy-pty는 기존 PTY를 공통 모델로 감쌀 때만 쓴다. */
export type AgentProvider = "codex" | "claude" | "legacy-pty";

/**
 * provider별 원본 식별자 보존 컨테이너. 모든 AgentEvent가 들고 다니는 라우팅 키.
 * 어느 provider냐에 따라 채워지는 필드가 다르다(15 §1.1 라우팅 키 표).
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

// ─────────────────────────────────────────────────────────────────────────────
// §2. Normalized model — 세션 상태
// ─────────────────────────────────────────────────────────────────────────────

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

// ─────────────────────────────────────────────────────────────────────────────
// §3. Normalized model — 이벤트 (AgentEvent)
// ─────────────────────────────────────────────────────────────────────────────

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
  /** 사용 가능한 슬래시 커맨드 목록 갱신(ACP available_commands_update). 최신 목록 전체 교체. */
  | { type: "available_commands_updated"; ref: ProviderRef; commands: AgentCommand[] }
  /** 에러. recoverable=재시도 가능 여부(Codex willRetry / ACP error 분류). */
  | { type: "error"; ref: ProviderRef; message: string; recoverable: boolean };

/** 슬래시 커맨드 1건(composer 팔레트 소스). provider가 알린 server-side 커맨드. */
export interface AgentCommand {
  /** 커맨드 이름(선두 `/` 없이). 예: "resume", "compact". */
  name: string;
  /** 짧은 설명(팔레트 보조 텍스트). */
  description?: string;
  /** 입력 힌트(예: 인자 형식). UnstructuredCommandInput.hint에서 추출. */
  inputHint?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// §4. Normalized model — Content block
// ─────────────────────────────────────────────────────────────────────────────

/** transcript/tool card가 렌더링하는 공통 content 블록. discriminator = type. */
export type AgentContent =
  | { type: "text"; text: string }
  | { type: "image"; uri: string; mimeType?: string }
  | { type: "resource"; uri: string; mimeType?: string; text?: string }
  | { type: "terminal"; command?: string; output: string }
  | { type: "diff"; path: string; patch: string }
  | { type: "json"; value: unknown };

// ─────────────────────────────────────────────────────────────────────────────
// §5. Normalized model — 하위 타입
// ─────────────────────────────────────────────────────────────────────────────

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
   * adapter가 provider escalation 신호로 채운다. v1 기본은 normal이되, 09 §8.3 고위험 집합
   * (Claude `bypassPermissions`, Codex `danger-full-access`/sandbox 우회)은 v1부터 "escalation"이다(OQ-47).
   */
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
  /** ACP usage_update `{used,size}` 매핑(context window 축, Codex 토큰 축과 분리). OQ-02 해소. */
  contextUsed?: number;
  /** ACP usage_update `{used,size}`의 size(context window 총량). OQ-02 해소. */
  contextSize?: number;
}

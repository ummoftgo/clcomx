/**
 * Direct Agent Runtime — Codex wire → AgentEvent 순수 매퍼(05 §4·§5).
 *
 * 하나의 inbound Codex `JsonRpcMessage`(notification 또는 server request)를 0개 이상의
 * `AgentEvent`(15 §3)로 변환한다. routing 상태(§6)를 읽어 ProviderRef를 채우고 reconcile을 판단한다.
 * **side-effect 없음**(emit/store mutation은 호출자가). 매핑 정본: ref-codex §8.
 *
 * 규약: 타입은 15(normalized) + generated/codex-app-server(wire 정본)만 import한다(재정의 금지).
 */

import type {
  AgentEvent,
  AgentContent,
  AgentPlanEntry,
  FileChangeSummary,
  ProviderRef,
  TokenUsage,
  ToolCallUpdate,
} from "../../contracts/normalized";
import type { JsonRpcMessage } from "../../service/transport";
import type { CodexRouting } from "./codex-routing";

// ── wire 정본 타입(generated; 수동 string literal 금지) ──
import type { ThreadItem } from "../../generated/codex-app-server/v2/ThreadItem";
import type { ThreadStatus } from "../../generated/codex-app-server/v2/ThreadStatus";
import type { TurnStatus } from "../../generated/codex-app-server/v2/TurnStatus";
import type { TurnPlanStep } from "../../generated/codex-app-server/v2/TurnPlanStep";
import type { FileUpdateChange } from "../../generated/codex-app-server/v2/FileUpdateChange";
import type { CommandExecutionStatus } from "../../generated/codex-app-server/v2/CommandExecutionStatus";
import type { ThreadTokenUsage } from "../../generated/codex-app-server/v2/ThreadTokenUsage";
import type { UserInput } from "../../generated/codex-app-server/v2/UserInput";
import type { TextElement } from "../../generated/codex-app-server/v2/TextElement";
import type { AgentSessionStatus } from "../../contracts/normalized";

// ─────────────────────────────────────────────────────────────────────────────
// 매핑 불가/미지원 method 가시화용 카운터(15 §0.2, RD-10). 모듈 전역 진단.
// ─────────────────────────────────────────────────────────────────────────────

/** 미지원 notification(id 없음) 카운터 — drop이 아니라 가시화(RD-10). */
let unknownNotificationCount = 0;

/** 미지원 notification 누계(진단/테스트용). */
export function getUnknownNotificationCount(): number {
  return unknownNotificationCount;
}

/** 미지원 notification 카운터 리셋(테스트 격리용). */
export function resetUnknownNotificationCount(): void {
  unknownNotificationCount = 0;
}

// ─────────────────────────────────────────────────────────────────────────────
// ProviderRef 생성(§4.1)
// ─────────────────────────────────────────────────────────────────────────────

/** Codex AgentEvent의 ref를 만든다. 매핑 안 된 payload는 raw에 보존(15 §0.2). */
function refOf(
  params: { threadId?: string; turnId?: string; itemId?: string },
  raw?: unknown,
): ProviderRef {
  return {
    provider: "codex",
    threadId: params.threadId,
    turnId: params.turnId,
    itemId: params.itemId,
    raw,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// enum 변환(§5.5)
// ─────────────────────────────────────────────────────────────────────────────

/** ThreadStatus(tagged) → 세션 status. active+waitingOn* flag면 requires_action(04 §2.1 규칙3). */
function mapThreadStatus(s: ThreadStatus): AgentSessionStatus {
  if (s.type === "active") {
    // 핵심 분기: approval/userInput 대기 flag면 requires_action.
    const waiting = s.activeFlags?.some(
      (f) => f === "waitingOnApproval" || f === "waitingOnUserInput",
    );
    return waiting ? "requires_action" : "running";
  }
  if (s.type === "notLoaded") return "starting";
  if (s.type === "idle") return "idle";
  return "failed"; // systemError
}

/** TurnStatus → turn_completed.status. interrupted→cancelled(15 §5 주의). */
function mapTurnStatus(s: TurnStatus): "completed" | "failed" | "cancelled" {
  if (s === "completed") return "completed";
  if (s === "interrupted") return "cancelled";
  // failed / inProgress(비정상 도달) → failed.
  return "failed";
}

/** CommandExecutionStatus / PatchApplyStatus → ToolCallUpdate.status. declined→failed(15 §5 주의). */
function mapCommandStatus(s: CommandExecutionStatus): ToolCallUpdate["status"] {
  if (s === "inProgress") return "in_progress";
  if (s === "completed") return "completed";
  // failed / declined → failed(declined는 cancelled 아님, 15 §5 주의).
  return "failed";
}

/** mcp/dynamic tool 상태(inProgress/completed/failed) → ToolCallUpdate.status. */
function mapGenericToolStatus(s: "inProgress" | "completed" | "failed"): ToolCallUpdate["status"] {
  if (s === "inProgress") return "in_progress";
  if (s === "completed") return "completed";
  return "failed";
}

/** TurnPlanStep → AgentPlanEntry. inProgress→in_progress casing 변환(15 §5 주의). */
function mapPlanStep(s: TurnPlanStep): AgentPlanEntry {
  const status: AgentPlanEntry["status"] =
    s.status === "inProgress" ? "in_progress" : s.status === "completed" ? "completed" : "pending";
  return { content: s.step, status };
}

/** ThreadTokenUsage → TokenUsage. total 우선, totalTokens는 버림(15 §5 주의). */
function mapTokenUsage(tu: ThreadTokenUsage): TokenUsage {
  const b = tu.total ?? tu.last;
  return {
    inputTokens: b.inputTokens,
    cachedInputTokens: b.cachedInputTokens,
    outputTokens: b.outputTokens,
    reasoningOutputTokens: b.reasoningOutputTokens,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// content / item 변환(§5.3)
// ─────────────────────────────────────────────────────────────────────────────

/** TextElement[]에서 placeholder span을 이어붙인다(span 없으면 빈 문자열). raw는 호출자가 보존. */
function joinTextElements(elements: TextElement[]): string {
  return elements.map((e) => e.placeholder ?? "").join("");
}

/** inbound UserInput → AgentContent(item 재생용, ref-codex §6.4). */
function mapUserInput(u: UserInput): AgentContent {
  // 핵심 매핑: text variant의 wire 키는 text + text_elements(span). 평문 text가 권위, span은 raw 보존.
  if (u.type === "text") {
    const text = u.text && u.text.length > 0 ? u.text : joinTextElements(u.text_elements);
    return { type: "text", text };
  }
  if (u.type === "image") return { type: "image", uri: u.url };
  if (u.type === "localImage") return { type: "image", uri: "file://" + u.path };
  if (u.type === "skill") return { type: "text", text: "/" + u.name };
  // mention
  return { type: "text", text: "@" + u.name };
}

/** FileUpdateChange → FileChangeSummary. PatchChangeKind 변환(move_path 있으면 move). */
function mapFileChange(ch: FileUpdateChange): FileChangeSummary {
  const kind = ch.kind;
  if (kind.type === "add") return { path: ch.path, operation: "create", diff: ch.diff };
  if (kind.type === "delete") return { path: ch.path, operation: "delete", diff: ch.diff };
  // update: move_path 있으면 move(oldPath=현재 path, path=move 대상).
  if (kind.move_path != null) {
    return { path: kind.move_path, operation: "move", oldPath: ch.path, diff: ch.diff };
  }
  return { path: ch.path, operation: "update", diff: ch.diff };
}

/** commandExecution item → ToolCallUpdate(15 §5). */
function mapCommandExec(item: Extract<ThreadItem, { type: "commandExecution" }>): ToolCallUpdate {
  const content: AgentContent[] | undefined =
    item.aggregatedOutput != null
      ? [{ type: "terminal", command: item.command, output: item.aggregatedOutput }]
      : undefined;
  return {
    id: item.id, // toolCallId = itemId(15 §1.1)
    title: item.command,
    kind: "execute",
    status: mapCommandStatus(item.status),
    content,
    rawInput: { command: item.command, cwd: item.cwd, commandActions: item.commandActions },
    rawOutput: { exitCode: item.exitCode, durationMs: item.durationMs },
  };
}

/** fileChange item → ToolCallUpdate(kind:"edit"). */
function mapFileChangeTool(item: Extract<ThreadItem, { type: "fileChange" }>): ToolCallUpdate {
  const status: ToolCallUpdate["status"] =
    item.status === "inProgress"
      ? "in_progress"
      : item.status === "completed"
        ? "completed"
        : "failed"; // failed / declined
  return {
    id: item.id,
    kind: "edit",
    status,
    rawInput: { changes: item.changes },
  };
}

/** mcp/dynamic/webSearch tool item → ToolCallUpdate(15 §5). */
function mapGenericTool(
  item: Extract<ThreadItem, { type: "mcpToolCall" | "dynamicToolCall" | "webSearch" }>,
): ToolCallUpdate {
  if (item.type === "webSearch") {
    return {
      id: item.id,
      kind: "fetch",
      title: item.query,
      status: "completed", // webSearch item은 status 필드 없음 → completed로 마감
      rawInput: { query: item.query, action: item.action },
    };
  }
  if (item.type === "mcpToolCall") {
    return {
      id: item.id,
      kind: "other",
      title: `${item.server}/${item.tool}`,
      status: mapGenericToolStatus(item.status),
      rawInput: item.arguments,
      rawOutput: item.result ?? item.error,
    };
  }
  // dynamicToolCall
  return {
    id: item.id,
    kind: "other",
    title: item.namespace != null ? `${item.namespace}/${item.tool}` : item.tool,
    status: mapGenericToolStatus(item.status),
    rawInput: item.arguments,
    rawOutput: item.contentItems,
  };
}

/** reasoning item 권위 텍스트 = 보수적 [...summary, ...content].join("\n")(OQ-46). */
function reasoningText(item: Extract<ThreadItem, { type: "reasoning" }>): string {
  return [...(item.summary ?? []), ...(item.content ?? [])].join("\n");
}

/** item/started → AgentEvent[](§5.3). */
export function mapItemStarted(item: ThreadItem, threadId: string, turnId: string): AgentEvent[] {
  const ref = refOf({ threadId, turnId, itemId: item.id }, item);
  switch (item.type) {
    case "userMessage":
      return [{ type: "user_message", ref, content: item.content.map(mapUserInput), mode: "replace" }];
    case "agentMessage":
      // 04 §3.2 규칙1: 빈 메시지 시작. delta는 §5.2가 append, completed.text가 권위.
      return [{ type: "agent_message", ref, content: [], mode: "replace" }];
    case "commandExecution":
      return [{ type: "tool_call_updated", ref, update: mapCommandExec(item) }];
    case "fileChange":
      return [{ type: "tool_call_updated", ref, update: mapFileChangeTool(item) }];
    case "mcpToolCall":
    case "dynamicToolCall":
    case "webSearch":
      return [{ type: "tool_call_updated", ref, update: mapGenericTool(item) }];
    case "reasoning":
      // D11: thought 채널 메시지 시작(빈 메시지). delta는 channel:"thought"로 append.
      return [{ type: "agent_message", ref, channel: "thought", content: [], mode: "replace" }];
    default:
      // plan/imageView/sleep/collabAgent 등 v1 밖: drop 아님, raw는 ref에 보존(빈 배열 반환).
      return [];
  }
}

/** item/completed → AgentEvent[](§5.3). */
export function mapItemCompleted(item: ThreadItem, threadId: string, turnId: string): AgentEvent[] {
  const ref = refOf({ threadId, turnId, itemId: item.id }, item);
  switch (item.type) {
    case "agentMessage":
      // 04 §3.2 규칙1: completed.text가 권위 → replace로 reconcile.
      return [{ type: "agent_message", ref, content: [{ type: "text", text: item.text }], mode: "replace" }];
    case "commandExecution":
      return [{ type: "tool_call_updated", ref, update: mapCommandExec(item) }];
    case "fileChange":
      // tool card 마감 + 각 변경을 file_change_updated로 노출.
      return [
        { type: "tool_call_updated", ref, update: mapFileChangeTool(item) },
        ...item.changes.map(
          (ch): AgentEvent => ({ type: "file_change_updated", ref, change: mapFileChange(ch) }),
        ),
      ];
    case "mcpToolCall":
    case "dynamicToolCall":
    case "webSearch":
      return [{ type: "tool_call_updated", ref, update: mapGenericTool(item) }];
    case "userMessage":
      return [{ type: "user_message", ref, content: item.content.map(mapUserInput), mode: "replace" }];
    case "reasoning":
      // D11/OQ-46: completed reasoning item이 thought 채널 권위 → replace.
      return [
        {
          type: "agent_message",
          ref,
          channel: "thought",
          content: [{ type: "text", text: reasoningText(item) }],
          mode: "replace",
        },
      ];
    default:
      return [];
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// outbound: AgentContent[] → UserInput[](§5.3d, sendPrompt)
// ─────────────────────────────────────────────────────────────────────────────

/** outbound text content → Codex UserInput capability(image 등 opt-in 상태). */
export interface CodexInputCaps {
  /** image input opt-in 여부(ref-codex §1.4). 없으면 보수적으로 image 미전송. */
  imageInput?: boolean;
}

/**
 * composer text → Codex turn/start의 UserInput text variant(05 §5.3d, OQ-33 해소).
 * impl-log.md H4: `text` variant는 `text_elements: Array<TextElement>`가 필수다.
 * plain text는 span이 없으므로 `text_elements: []`(빈 배열)로 보낸다.
 * @param text composer가 만든 평문.
 */
export function makeTextUserInput(text: string): UserInput {
  // 검증된 schema(H4): { type:"text", text, text_elements:[] }. 빈 배열 = span 없음(필수 필드 충족).
  return { type: "text", text, text_elements: [] };
}

/** file:// 스킴 제거(localImage path 추출). */
function stripFileScheme(uri: string): string {
  return uri.startsWith("file://") ? uri.slice("file://".length) : uri;
}

/**
 * composer content(15 §4) → Codex turn/start input(ref-codex §6.5/§6.4). 순수 함수.
 * - text → UserInput text(text_elements:[] 동반, H4).
 * - image → capability opt-in이면 image/localImage, 아니면 drop(raw 보존 — 카운터).
 * - resource → mention(reference) 근사 매핑(OQ-33 잔여).
 * - 그 외(terminal/diff/json) → composer 비입력 variant, drop.
 * @param caps image opt-in 상태(없으면 보수적).
 */
export function mapAgentContentToUserInput(
  content: AgentContent[],
  caps?: CodexInputCaps,
): UserInput[] {
  const out: UserInput[] = [];
  for (const c of content) {
    switch (c.type) {
      case "text":
        out.push(makeTextUserInput(c.text));
        break;
      case "image":
        if (caps?.imageInput) {
          // 핵심 매핑: file:// 스킴이면 localImage, 그 외 url.
          out.push(
            c.uri.startsWith("file://")
              ? { type: "localImage", path: stripFileScheme(c.uri) }
              : { type: "image", url: c.uri },
          );
        }
        // 미지원이면 drop(raw 보존은 composer 측; 여기선 단순 미전송).
        break;
      case "resource":
        // ref-codex §6.4: 전용 resource variant 없음 → mention 근사(OQ-33 잔여).
        out.push({ type: "mention", name: c.text ?? c.uri, path: c.uri });
        break;
      default:
        // terminal/diff/json: composer 입력 아님 → drop.
        break;
    }
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// notification 디스패치(§5.1·§5.2)
// ─────────────────────────────────────────────────────────────────────────────

/** params를 method별 타입으로 받기 위한 느슨한 접근(generated 타입은 호출부 캐스팅). */
type AnyParams = Record<string, unknown>;

/**
 * 개별 Codex notification(method only) → AgentEvent[]. method 문자열로 분기(ref-codex §8).
 * 미지원 method는 drop이 아니라 [] + counter 증가(RD-10).
 */
export function mapCodexNotification(
  method: string,
  params: unknown,
  routing: CodexRouting,
): AgentEvent[] {
  const p = (params ?? {}) as AnyParams;

  switch (method) {
    // ── thread/turn lifecycle(§5.1) ──
    case "thread/started": {
      const thread = p.thread as { id: string; sessionId?: string; cwd?: string };
      routing.ensureThread(thread.id, thread.sessionId);
      // §2.3: response가 이미 session_started를 emit했으면 멱등(중복 금지).
      if (routing.alreadyStarted(thread.id)) return [];
      routing.markStarted(thread.id);
      return [
        {
          type: "session_started",
          ref: refOf({ threadId: thread.id }, thread),
          cwd: thread.cwd ?? "",
        },
      ];
    }

    case "thread/status/changed": {
      const threadId = p.threadId as string;
      const status = p.status as ThreadStatus;
      return [
        { type: "session_status_changed", ref: refOf({ threadId }), status: mapThreadStatus(status) },
      ];
    }

    case "turn/started": {
      const threadId = p.threadId as string;
      const turn = p.turn as { id: string };
      routing.setActiveTurn(threadId, turn.id);
      // 멱등(sendPrompt running 전이와 중복 가능).
      return [
        {
          type: "session_status_changed",
          ref: refOf({ threadId, turnId: turn.id }),
          status: "running",
        },
      ];
    }

    case "turn/completed": {
      const threadId = p.threadId as string;
      const turn = p.turn as { id: string; status: TurnStatus };
      // §5.6: 보관된 tokenUsage가 있으면 결합(takeTokenUsage는 turn 닫기 전에 호출).
      const usage = routing.takeTokenUsage(threadId, turn.id);
      routing.clearActiveTurn(threadId, turn.id);
      return [
        {
          type: "turn_completed",
          ref: refOf({ threadId, turnId: turn.id }),
          status: mapTurnStatus(turn.status),
          usage,
        },
      ];
    }

    case "turn/plan/updated": {
      const threadId = p.threadId as string;
      const turnId = p.turnId as string;
      const plan = (p.plan as TurnPlanStep[]) ?? [];
      return [{ type: "plan_updated", ref: refOf({ threadId, turnId }), entries: plan.map(mapPlanStep) }];
    }

    case "thread/tokenUsage/updated": {
      const threadId = p.threadId as string;
      const turnId = p.turnId as string;
      const usage = mapTokenUsage(p.tokenUsage as ThreadTokenUsage);
      // M4: turn이 이미 닫혔으면(ordering unverified) usage-only 보강 emit, 아니면 보관.
      if (routing.isTurnClosed(threadId, turnId)) {
        return [
          { type: "turn_completed", ref: refOf({ threadId, turnId }), status: "completed", usage },
        ];
      }
      routing.recordTokenUsage(threadId, turnId, usage);
      return []; // turn_completed에 결합(별도 event 안 냄).
    }

    case "error": {
      const threadId = p.threadId as string;
      const turnId = p.turnId as string;
      const error = p.error as { message: string; codexErrorInfo?: unknown };
      return [
        {
          type: "error",
          ref: refOf({ threadId, turnId }, error),
          message: error.message,
          recoverable: p.willRetry === true,
        },
      ];
    }

    // ── item lifecycle + delta(§5.2) ──
    case "item/started": {
      const item = p.item as ThreadItem;
      return mapItemStarted(item, p.threadId as string, p.turnId as string);
    }

    case "item/completed": {
      const item = p.item as ThreadItem;
      return mapItemCompleted(item, p.threadId as string, p.turnId as string);
    }

    case "item/agentMessage/delta": {
      // 04 §3.2 규칙1: 메시지 delta는 append. completed.text가 권위.
      return [
        {
          type: "agent_message_delta",
          ref: refOf({
            threadId: p.threadId as string,
            turnId: p.turnId as string,
            itemId: p.itemId as string,
          }),
          delta: p.delta as string,
        },
      ];
    }

    case "item/commandExecution/outputDelta": {
      // 04 §3.2 규칙3: thread 채널 평문. stream 구분 정보 없음 → stdout 고정(§8.1).
      return [
        {
          type: "command_output_delta",
          ref: refOf({
            threadId: p.threadId as string,
            turnId: p.turnId as string,
            itemId: p.itemId as string,
          }),
          stream: "stdout",
          delta: p.delta as string,
        },
      ];
    }

    case "item/fileChange/patchUpdated": {
      const ref = refOf({
        threadId: p.threadId as string,
        turnId: p.turnId as string,
        itemId: p.itemId as string,
      });
      const changes = (p.changes as FileUpdateChange[]) ?? [];
      return changes.map(
        (ch): AgentEvent => ({ type: "file_change_updated", ref, change: mapFileChange(ch) }),
      );
    }

    case "item/plan/delta":
      // EXPERIMENTAL(04 §3.2.2): completed가 권위, delta는 점진 렌더링용. v1은 흘리지 않음(raw drop 아님).
      return [];

    case "item/reasoning/textDelta":
    case "item/reasoning/summaryTextDelta": {
      // D11/04 §3.2.5: thought 채널 delta로 흘린다(contentIndex/summaryIndex별 append).
      return [
        {
          type: "agent_message_delta",
          ref: refOf({
            threadId: p.threadId as string,
            turnId: p.turnId as string,
            itemId: p.itemId as string,
          }),
          channel: "thought",
          delta: p.delta as string,
        },
      ];
    }

    case "serverRequest/resolved": {
      // 04 §4.2 규칙3: 해당 requestId의 pending approval을 cancelled로 닫음(사용자 응답 불필요).
      // C4 단계4: cancelTurn이 이미 닫은 뒤 늦게 도착하면 pending 부재 → [](멱등).
      const reqId = String(p.requestId);
      // resolveApproval이 돌려준 pending의 (threadId,turnId,itemId)로 ref를 구성한다.
      // threadId만 쓰면 store가 turnKey를 잘못 계산해 해당 turn의 pendingRequestCount가 0으로
      // 내려가지 않아 seal 조건 (c)가 영구 실패하고 eviction이 막힌다(long-session 메모리 경계 붕괴).
      const pending = routing.resolveApproval(reqId);
      if (pending) {
        return [
          {
            type: "approval_resolved",
            ref: refOf(
              { threadId: pending.threadId, turnId: pending.turnId, itemId: pending.itemId },
              { requestId: reqId },
            ),
            decision: { requestId: reqId, outcome: "cancelled" },
          },
        ];
      }
      return [];
    }

    default:
      // 미지원 notification(realtime/hook/account 등): drop 아님, counter 증가(RD-10, 15 §0.2).
      unknownNotificationCount += 1;
      return [];
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// server→client request(approval/elicitation) → AgentEvent[](§7.1)
// ─────────────────────────────────────────────────────────────────────────────

/** ApprovalOption.kind → Codex command/fileChange decision(§7.1 표, ref-codex §8.1). */
export const OPTION_KIND_TO_DECISION: Record<string, string> = {
  allow_once: "accept",
  allow_always: "acceptForSession",
  reject_once: "decline",
  // reject_always: 영구 거부 등가물 부재 → decline(OQ-14).
  reject_always: "decline",
  cancel: "cancel",
};

/** command/fileChange approval 공용 4-option(15 §5; label은 UI i18n 키). */
function commandApprovalOptions() {
  return [
    { id: "allow_once", label: "agentRuntime.approval.allowOnce", kind: "allow_once" as const },
    { id: "allow_always", label: "agentRuntime.approval.allowAlways", kind: "allow_always" as const },
    { id: "reject_once", label: "agentRuntime.approval.rejectOnce", kind: "reject_once" as const },
    { id: "cancel", label: "agentRuntime.approval.cancel", kind: "cancel" as const },
  ];
}

/**
 * approval severity 분류기(D-ESCALATION, 09 §8.3). 기본 normal, 고위험 신호면 escalation.
 * @param method server request method.
 * @param p server request params.
 */
export function codexApprovalSeverity(method: string, p: AnyParams): "normal" | "escalation" {
  // (1) 권한/sandbox 상승 요청 자체 → 고위험.
  if (method === "item/permissions/requestApproval") return "escalation";
  // (2) command approval이 exec/network policy 우회 동반 → 고위험.
  if (
    method === "item/commandExecution/requestApproval" &&
    (p.proposedExecpolicyAmendment != null ||
      p.proposedNetworkPolicyAmendments != null ||
      p.networkApprovalContext != null)
  ) {
    return "escalation";
  }
  // (3) fileChange가 sandbox writable root 밖 쓰기를 요구(grantRoot) → 고위험.
  if (method === "item/fileChange/requestApproval" && p.grantRoot != null) return "escalation";
  return "normal";
}

/** mapCodexServerRequest 결과: emit할 event + (미지원 시) 보내야 할 wire 응답. */
export interface ServerRequestResult {
  events: AgentEvent[];
  /**
   * 어댑터가 wire로 보내야 할 응답(미지원 request의 error/decline). 없으면 undefined.
   * - kind:"error": JSON-RPC error(-32601) 응답(비-approval 미지원 request).
   * - kind:"auto-decline": permissions approval 자동 거절({permissions,scope}).
   * id는 원본 JSON-RPC id 타입 그대로(R3).
   */
  reply?:
    | { kind: "error"; id: string | number; method: string }
    | { kind: "auto-decline"; id: string | number };
}

/**
 * server→client request(method+id) → approval_requested 또는 미지원 응답(§7.1).
 * 미지원 method는 silent-drop 금지(RD-10): 호출자가 reply를 wire로 **반드시** 보내 deadlock을 막는다.
 * @param routing pending approval 등록(D12: 원본 id 타입·method 보존).
 */
export function mapCodexServerRequest(
  method: string,
  id: string | number,
  params: unknown,
  routing: CodexRouting,
): ServerRequestResult {
  const p = (params ?? {}) as AnyParams;
  const reqId = String(id);
  const threadId = p.threadId as string | undefined;
  const turnId = p.turnId as string | undefined;
  const itemId = p.itemId as string | undefined;

  switch (method) {
    case "item/commandExecution/requestApproval": {
      routing.addPendingApproval(reqId, id, method, { threadId, turnId, itemId });
      const ref: ProviderRef = {
        provider: "codex",
        threadId,
        turnId,
        itemId,
        toolCallId: itemId,
        requestId: reqId,
        raw: p,
      };
      return {
        events: [
          {
            type: "approval_requested",
            ref,
            request: {
              id: reqId,
              title: "agentRuntime.approval.command",
              body: (p.command as string | undefined) ?? undefined,
              toolCallId: itemId,
              severity: codexApprovalSeverity(method, p),
              options: commandApprovalOptions(),
            },
          },
        ],
      };
    }

    case "item/fileChange/requestApproval": {
      routing.addPendingApproval(reqId, id, method, { threadId, turnId, itemId });
      const ref: ProviderRef = {
        provider: "codex",
        threadId,
        turnId,
        itemId,
        toolCallId: itemId,
        requestId: reqId,
        raw: p,
      };
      return {
        events: [
          {
            type: "approval_requested",
            ref,
            request: {
              id: reqId,
              title: "agentRuntime.approval.fileChange",
              body: (p.reason as string | undefined) ?? undefined,
              toolCallId: itemId,
              severity: codexApprovalSeverity(method, p),
              options: commandApprovalOptions(),
            },
          },
        ],
      };
    }

    case "item/permissions/requestApproval": {
      // D12 v1: permission-profile escalation은 자동 decline(사용자 노출 안 함).
      //   command/fileChange 승인만 1차 지원. 보수적 거절({permissions:{},scope:"turn"}).
      return {
        events: [
          {
            type: "approval_resolved",
            ref: refOf({ threadId, turnId, itemId }, p),
            decision: { requestId: reqId, outcome: "failed" }, // 내부 전용(04 §4.2 규칙4)
          },
        ],
        reply: { kind: "auto-decline", id },
      };
    }

    default:
      // 미지원 server REQUEST(id 있음): silent-drop 금지(RD-10). error(-32601) 응답 필수(deadlock 방지).
      //   raw 보존 + counter 증가는 카운터에 합산(미지원 가시화).
      unknownNotificationCount += 1;
      return { events: [], reply: { kind: "error", id, method } };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 단일 inbound message → AgentEvent[](§4; notification만 처리; request는 어댑터가 응답 필요)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 하나의 Codex inbound message → AgentEvent[](매핑 정본 ref-codex §8).
 * - notification(method only) 또는 server request(method+id) 모두 처리.
 * - server request는 reply(미지원 응답)를 버리고 events만 반환하므로, **응답이 필요한 경로는
 *   어댑터가 mapCodexServerRequest를 직접 호출**한다. 이 함수는 mapper 단위 테스트(replay)용 편의.
 */
export function mapCodexMessage(msg: JsonRpcMessage, routing: CodexRouting): AgentEvent[] {
  // request: id + method 둘 다 있음(approval 등).
  if ("id" in msg && "method" in msg && msg.id != null) {
    const r = mapCodexServerRequest(msg.method, msg.id, msg.params, routing);
    return r.events;
  }
  // notification: method만(id 없음).
  if ("method" in msg) {
    return mapCodexNotification(msg.method, msg.params, routing);
  }
  // result/error는 mapper 대상이 아님(어댑터 resolveRpc가 처리).
  return [];
}

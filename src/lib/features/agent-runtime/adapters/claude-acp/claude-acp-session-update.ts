/**
 * Claude ACP 어댑터 — session/update variant → AgentEvent 변환(06 §5).
 *
 * 핵심 불변식(04 §3.3): ACP는 **chunk=append, update=replace** 두 의미가 섞인다.
 * - *_chunk(user/agent/thought): messageId 기준 append(값 바뀌면 새 메시지).
 * - tool_call_update.content/locations, plan: **전체 교체(replace)**.
 * 미지원 variant(notification, id 없음)는 raw 보존 + counter로 가시화 후 무시(응답 불필요).
 */

import type { AgentCommand, AgentEvent, AgentPlanEntry, ProviderRef, ToolCallUpdate, TokenUsage } from "../../contracts/normalized";
import type {
  AcpContentChunk,
  AcpPlan,
  AcpSessionUpdate,
  AcpToolCall,
  AcpToolCallUpdate,
  AcpUsageUpdate,
} from "../../contracts/claude-acp";
import { mapContentBlock, mapToolCallContent, mapToolKind } from "./claude-acp-content";

/** mapSessionUpdate가 읽고/쓰는 어댑터 런타임 상태(부분). */
export interface SessionUpdateRuntime {
  providerSessionId?: string;
  activeTurnId?: string;
  /** ContentChunk.messageId 그룹핑(04 §3.3). */
  currentMessageId?: string;
  /** usage_update 누적(turn_completed.usage 동승용, §3.6). */
  lastUsage?: TokenUsage;
  /** current mode 추적(§8, severity 분류 보강). */
  currentModeId?: string;
  /** 미지원 variant 가시화 counter(04 §5). */
  unknownCounter: number;
}

/**
 * session/update의 update 페이로드를 AgentEvent[]로 변환(§5.1 변환표).
 * 13종 variant를 처리하되 8개 핵심은 event를 만들고, mode/config/session_info/available_commands는
 * 상태만 갱신(전용 event 없음), plan_update/plan_removed는 방어적 무시.
 */
export function mapSessionUpdate(rt: SessionUpdateRuntime, update: AcpSessionUpdate): AgentEvent[] {
  switch (update.sessionUpdate) {
    case "agent_message_chunk":
      return mapMessageChunk(rt, update, "agent");
    case "user_message_chunk":
      return mapMessageChunk(rt, update, "user");
    case "agent_thought_chunk":
      return mapThoughtChunk(rt, update);
    case "tool_call":
      return [mapToolCall(rt, update, true)];
    case "tool_call_update":
      return [mapToolCall(rt, update, false)];
    case "plan":
      return [mapPlan(rt, update)];
    case "usage_update":
      // usage는 event를 만들지 않고 lastUsage에 보관(turn_completed에 동승, §3.6).
      mapUsage(rt, update);
      return [];
    case "current_mode_update":
      // 전용 event 없음 → mode 상태만 갱신(§8). severity 분류 보강에 쓰인다.
      rt.currentModeId = update.currentModeId;
      return [];
    case "config_option_update":
    case "session_info_update":
      // 전용 event 없음(ref-acp §13.2) → 1차는 상태 보관만(어댑터 메인이 처리). 여기선 no-op.
      return [];
    case "available_commands_update":
      // 슬래시 커맨드 목록 → composer 팔레트 소스(available_commands_updated event).
      return [mapAvailableCommands(rt, update)];
    case "plan_update":
    case "plan_removed":
      // 어댑터 미관측(ref-claude-agent-acp §2) → 방어적 무시 + counter.
      rt.unknownCounter += 1;
      return [];
    default:
      // 알 수 없는 variant → raw 보존 + counter(04 §5). notification이므로 응답 불필요.
      rt.unknownCounter += 1;
      return [];
  }
}

/** agent/user 메시지 chunk → delta(text) 또는 append message(비텍스트). messageId 그룹핑(§5.2). */
function mapMessageChunk(
  rt: SessionUpdateRuntime,
  chunk: AcpContentChunk,
  kind: "agent" | "user",
): AgentEvent[] {
  const msgId = chunk.messageId ?? rt.currentMessageId; // null이면 직전 유지(방어).
  if (msgId !== rt.currentMessageId) rt.currentMessageId = msgId ?? undefined; // 바뀌면 새 메시지 시작(04 §3.3).
  const ref: ProviderRef = {
    provider: "claude",
    sessionId: rt.providerSessionId,
    messageId: msgId ?? undefined,
    turnId: rt.activeTurnId,
    raw: chunk._meta,
  };
  const content = mapContentBlock(chunk.content);
  if (kind === "agent" && content.type === "text") {
    return [{ type: "agent_message_delta", ref, delta: content.text }];
  }
  return [
    {
      type: kind === "agent" ? "agent_message" : "user_message",
      ref,
      content: [content],
      mode: "append",
    },
  ];
}

/** thought chunk → agent_message_delta{channel:"thought"}(text) 또는 append(비텍스트). 별도 스트림(§5.3, D11). */
function mapThoughtChunk(rt: SessionUpdateRuntime, chunk: AcpContentChunk): AgentEvent[] {
  const msgId = chunk.messageId ?? rt.currentMessageId;
  if (msgId !== rt.currentMessageId) rt.currentMessageId = msgId ?? undefined;
  const ref: ProviderRef = {
    provider: "claude",
    sessionId: rt.providerSessionId,
    messageId: msgId ?? undefined,
    turnId: rt.activeTurnId,
    raw: chunk._meta,
  };
  const content = mapContentBlock(chunk.content);
  if (content.type === "text") {
    return [{ type: "agent_message_delta", ref, delta: content.text, channel: "thought" }];
  }
  return [{ type: "agent_message", ref, content: [content], mode: "append", channel: "thought" }];
}

/**
 * tool_call(신규) / tool_call_update(부분) → tool_call_updated AgentEvent(§5.4).
 * content/locations는 **replace 의미**(04 §3.3). 변경 안 된 필드(undefined)는 store가 upsert로 기존값 유지.
 */
function mapToolCall(
  rt: SessionUpdateRuntime,
  raw: AcpToolCall | AcpToolCallUpdate,
  isNew: boolean,
): AgentEvent {
  const ref: ProviderRef = {
    provider: "claude",
    sessionId: rt.providerSessionId,
    toolCallId: raw.toolCallId,
    turnId: rt.activeTurnId,
    raw: raw._meta,
  };
  const update: ToolCallUpdate = {
    id: raw.toolCallId,
    // tool_call_update는 title optional → undefined면 그대로 전달(store upsert가 유지).
    title: raw.title ?? undefined,
    kind: mapToolKind(raw.kind ?? undefined),
    // status: ACP 4종(cancelled 없음 — client 합성). undefined면 store가 기존값 유지(04 §3.1).
    status: (raw.status ?? undefined) as ToolCallUpdate["status"],
    // content/locations는 오면 전체 교체(04 §3.3).
    content: raw.content ? raw.content.map(mapToolCallContent) : undefined,
    locations: raw.locations
      ? raw.locations.map((l) => ({ path: l.path, ...(l.line != null ? { line: l.line } : {}) }))
      : undefined,
    rawInput: raw.rawInput,
    rawOutput: raw.rawOutput,
  };
  // isNew(tool_call)는 신규 upsert, tool_call_update는 부분 갱신 — 둘 다 동일 event(store가 id 기준 upsert).
  void isNew;
  return { type: "tool_call_updated", ref, update };
}

/** plan → plan_updated(전체 교체, §5.5). status/priority는 ACP 이미 snake_case. */
function mapPlan(rt: SessionUpdateRuntime, plan: AcpPlan): AgentEvent {
  const entries: AgentPlanEntry[] = plan.entries.map((e) => ({
    content: e.content,
    status: e.status,
    priority: e.priority,
  }));
  const ref: ProviderRef = {
    provider: "claude",
    sessionId: rt.providerSessionId,
    turnId: rt.activeTurnId,
    raw: plan._meta,
  };
  return { type: "plan_updated", ref, entries };
}

/**
 * available_commands_update → available_commands_updated(§composer 팔레트).
 * 각 항목에서 name(필수)·description·input.hint(UnstructuredCommandInput)만 방어적으로 추출하고,
 * name 없는/미지 항목은 무시한다(ref-acp §13.2 느슨한 wire).
 */
function mapAvailableCommands(
  rt: SessionUpdateRuntime,
  update: { availableCommands?: unknown[] },
): AgentEvent {
  const commands: AgentCommand[] = [];
  for (const raw of update.availableCommands ?? []) {
    if (!raw || typeof raw !== "object") continue;
    const rec = raw as Record<string, unknown>;
    if (typeof rec.name !== "string" || rec.name.length === 0) continue;
    const description = typeof rec.description === "string" ? rec.description : undefined;
    const input = rec.input;
    const inputHint =
      input && typeof input === "object" && typeof (input as Record<string, unknown>).hint === "string"
        ? ((input as Record<string, unknown>).hint as string)
        : undefined;
    commands.push({ name: rec.name, description, inputHint });
  }
  const ref: ProviderRef = {
    provider: "claude",
    sessionId: rt.providerSessionId,
    turnId: rt.activeTurnId,
  };
  return { type: "available_commands_updated", ref, commands };
}

/**
 * usage_update → rt.lastUsage 누적(§3.6, OQ-02 해소).
 * used→contextUsed, size→contextSize(context window 축, Codex 토큰 축과 분리 — inputTokens에 섞지 않음).
 */
function mapUsage(rt: SessionUpdateRuntime, usage: AcpUsageUpdate): void {
  rt.lastUsage = {
    ...rt.lastUsage,
    contextUsed: usage.used,
    contextSize: usage.size,
  };
}

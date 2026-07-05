/**
 * Direct Agent Runtime — Claude ACP 어댑터 내부 전용 타입(부분 wire 미러 + deps interface).
 *
 * 정본 경계(06 §1.2):
 * - CLCOMX 공통 타입(AgentEvent/ProviderRef/ToolCallUpdate/Approval·JsonRpcMessage 등)은 재정의 금지 —
 *   `contracts/normalized.ts`(15 §1–§5)·`service/transport.ts`(15 §8)에서 import.
 * - 이 파일은 **ACP wire shape 중 어댑터가 직접 다루는 부분 미러**(SessionUpdate discriminant,
 *   RequestPermission shape, initialize 응답 등)와 `PendingApproval`/`PendingRequest` 내부 상태,
 *   deps interface만 둔다. wire 권위는 `@agentclientprotocol/sdk@0.29.0`
 *   `dist/schema/types.gen.d.ts`이며 여기 정의는 그 부분 미러일 뿐 CLCOMX 공통 타입이 아니다(OQ-42 부분 미러).
 */

import type { ApprovalRequest, ProviderRef } from "./normalized";

// ───────────────────────── ACP wire 부분 미러(ref-acp / sdk schema) ─────────────────────────

/** ACP ContentBlock(ref-acp §4). 어댑터가 수신·송신에서 다루는 5종 discriminant. */
export type AcpContentBlock =
  | { type: "text"; text: string; _meta?: unknown }
  | { type: "image"; data: string; mimeType: string; uri?: string | null; _meta?: unknown }
  | { type: "audio"; data: string; mimeType: string; _meta?: unknown }
  | { type: "resource_link"; name: string; uri: string; mimeType?: string | null; _meta?: unknown }
  | { type: "resource"; resource: AcpEmbeddedResource; _meta?: unknown };

/** EmbeddedResource.resource: text 또는 blob(ref-acp §4). */
export type AcpEmbeddedResource =
  | { uri: string; mimeType?: string | null; text: string }
  | { uri: string; mimeType?: string | null; blob: string };

/** ContentChunk(ref-acp §4): messageId 기준 그룹핑. */
export interface AcpContentChunk {
  content: AcpContentBlock;
  messageId?: string | null;
  _meta?: unknown;
}

/** ToolCallContent(ref-acp §5): content / diff / terminal 3종. */
export type AcpToolCallContent =
  | { type: "content"; content: AcpContentBlock; _meta?: unknown }
  | { type: "diff"; path: string; oldText?: string | null; newText: string; _meta?: unknown }
  | { type: "terminal"; terminalId: string; _meta?: unknown };

/** ToolCallLocation(ref-acp §5): {path, line?}. column 없음. */
export interface AcpToolCallLocation {
  path: string;
  line?: number | null;
  _meta?: unknown;
}

/** ACP ToolKind 10종(sdk schema). switch_mode 포함. */
export type AcpToolKind =
  | "read"
  | "edit"
  | "delete"
  | "move"
  | "search"
  | "execute"
  | "think"
  | "fetch"
  | "switch_mode"
  | "other";

/** ACP ToolCallStatus 4종(sdk schema). cancelled 없음 — client 합성(04 §4.3). */
export type AcpToolCallStatus = "pending" | "in_progress" | "completed" | "failed";

/** ToolCall(ref-acp §5, 신규 upsert). */
export interface AcpToolCall {
  toolCallId: string;
  title: string;
  kind?: AcpToolKind;
  status?: AcpToolCallStatus;
  content?: AcpToolCallContent[] | null;
  locations?: AcpToolCallLocation[] | null;
  rawInput?: unknown;
  rawOutput?: unknown;
  _meta?: unknown;
}

/** ToolCallUpdate(ref-acp §5, 부분 갱신 — toolCallId 제외 전부 optional). */
export interface AcpToolCallUpdate {
  toolCallId: string;
  title?: string | null;
  kind?: AcpToolKind | null;
  status?: AcpToolCallStatus | null;
  content?: AcpToolCallContent[] | null;
  locations?: AcpToolCallLocation[] | null;
  rawInput?: unknown;
  rawOutput?: unknown;
  _meta?: unknown;
}

/** PlanEntry(ref-acp §10). ACP status/priority는 이미 snake_case. */
export interface AcpPlanEntry {
  content: string;
  status: "pending" | "in_progress" | "completed";
  priority: "high" | "medium" | "low";
  _meta?: unknown;
}

/** Plan(ref-acp §10): entries 전체 교체. */
export interface AcpPlan {
  entries: AcpPlanEntry[];
  _meta?: unknown;
}

/** UsageUpdate(ref-acp §10): used→contextUsed, size→contextSize(OQ-02). */
export interface AcpUsageUpdate {
  used: number;
  size: number;
  cost?: unknown;
  _meta?: unknown;
}

/** PermissionOptionKind 4종(ref-acp §6). cancel/other 없음. */
export type AcpPermissionOptionKind = "allow_once" | "allow_always" | "reject_once" | "reject_always";

/** PermissionOption(ref-acp §6). */
export interface AcpPermissionOption {
  optionId: string;
  name: string;
  kind: AcpPermissionOptionKind;
  _meta?: unknown;
}

/** RequestPermissionRequest.params(ref-acp §6). toolCall은 ToolCallUpdate shape. */
export interface AcpRequestPermissionParams {
  sessionId: string;
  toolCall: AcpToolCallUpdate;
  options: AcpPermissionOption[];
  _meta?: unknown;
}

/** SessionMode(ref-acp §10). */
export interface AcpSessionMode {
  id: string;
  name: string;
  description?: string | null;
}

/** SessionModeState(ref-acp §10): session/new|load|resume result.modes. */
export interface AcpSessionModeState {
  currentModeId: string;
  availableModes: AcpSessionMode[];
}

/**
 * session/update notification의 update 페이로드 부분 미러(13종 discriminant = `sessionUpdate`).
 * 각 variant는 base shape를 spread한다. 어댑터는 discriminant로 분기(§5).
 */
export type AcpSessionUpdate =
  | ({ sessionUpdate: "user_message_chunk" } & AcpContentChunk)
  | ({ sessionUpdate: "agent_message_chunk" } & AcpContentChunk)
  | ({ sessionUpdate: "agent_thought_chunk" } & AcpContentChunk)
  | ({ sessionUpdate: "tool_call" } & AcpToolCall)
  | ({ sessionUpdate: "tool_call_update" } & AcpToolCallUpdate)
  | ({ sessionUpdate: "plan" } & AcpPlan)
  | ({ sessionUpdate: "plan_update"; [k: string]: unknown })
  | ({ sessionUpdate: "plan_removed"; [k: string]: unknown })
  | ({ sessionUpdate: "available_commands_update"; availableCommands?: unknown[]; [k: string]: unknown })
  | ({ sessionUpdate: "current_mode_update"; currentModeId: string; [k: string]: unknown })
  | ({ sessionUpdate: "config_option_update"; configOptions?: unknown[]; [k: string]: unknown })
  | ({ sessionUpdate: "session_info_update"; title?: string | null; updatedAt?: string | null; [k: string]: unknown })
  | ({ sessionUpdate: "usage_update" } & AcpUsageUpdate);

/** session/update notification params(ref-acp §3 SessionNotification). */
export interface AcpSessionNotificationParams {
  sessionId: string;
  update: AcpSessionUpdate;
  _meta?: unknown;
}

/** session/prompt result.stopReason(ref-acp §3.6, closed enum 5종). */
export type AcpStopReason = "end_turn" | "max_tokens" | "max_turn_requests" | "refusal" | "cancelled";

// ───────────────────────── initialize 파싱 결과(§3.2) ─────────────────────────

/**
 * parseInitializeResponse 산출. capability **위치 비대칭** 정확 판독:
 * - canLoad: `agentCapabilities.loadSession`(loadSession 직속 bool)
 * - canResume: `agentCapabilities.sessionCapabilities.resume`(존재=지원)
 */
export interface ParsedInitialize {
  protocolVersion: number;
  /** loadSession capability(direct bool). */
  canLoad: boolean;
  /** sessionCapabilities.resume(존재=지원). */
  canResume: boolean;
  /** promptCapabilities.image. */
  promptImage: boolean;
  /** promptCapabilities.embeddedContext. */
  promptEmbeddedContext: boolean;
  /** authMethods(ref-acp §3.2). 비어있지 않으면 인증 미완 가능성. */
  authMethods: Array<{ id: string; name: string; description?: string }>;
  /** agentInfo.version 등 — metadata 보존용 raw. */
  agentInfo?: { name?: string; version?: string };
  /** 매핑 안 된 agentCapabilities 원본(raw 보존). */
  rawAgentCapabilities?: unknown;
}

// ───────────────────────── pending 테이블(§4.2, §6.3) ─────────────────────────

/** client→agent 요청 응답 매칭(§3.1a rpcRequest). */
export interface PendingRequest {
  resolve: (result: unknown) => void;
  reject: (err: unknown) => void;
  method: string;
}

/**
 * agent→client request_permission pending(§6.1).
 * rpcId는 **원본 JSON-RPC id 타입 보존**(R3) — wire 응답에 그대로 쓴다. String화 금지.
 */
export interface PendingApproval {
  /** 원본 JSON-RPC id — 타입 보존, wire 응답 { id: rpcId, ... }에 그대로 사용(R3). */
  rpcId: string | number;
  /** ref.requestId는 String(rpcId) — 문자열 키 전용. */
  ref: ProviderRef;
  /** request.id도 String(rpcId) — UI/store 키 전용. */
  request: ApprovalRequest;
  /** cancel/shutdown cleanup 멱등 플래그(§4.3). */
  closing?: boolean;
}

// ───────────────────────── deps interface(§4.1, DI) ─────────────────────────

import type {
  AgentRuntimeCancelTarget,
  AgentRuntimeEvent,
  AgentRuntimeStartParams,
  JsonRpcMessage,
  RuntimeId,
} from "../service/transport";
import type { ResumeSessionParams, StartSessionParams } from "./runtime-port";
import type { UnlistenFn } from "../../../tauri/event";

/** backend가 resolve해 돌려주는 launch 입력(§2.2). command(node)는 backend 비제어이므로 미포함(S1). */
export interface ResolvedLaunch {
  /** backend가 resolve/검증한 claude-agent-acp dist/index.js 절대경로(launch args[0]). */
  adapterEntryPath: string;
  /** non-secret env 전용(C1). */
  env?: Record<string, string>;
  /**
   * claude.ai 구독 크레덴셜 사용 허용(agentRuntime.claudeAllowSubscriptionAuth 설정).
   * true면 launch args에서 `--hide-claude-auth`를 생략한다. 새로 시작하는 세션부터 적용.
   */
  allowSubscriptionAuth?: boolean;
}

/**
 * Claude ACP 어댑터 deps(DI). 어댑터는 invoke/listen을 직접 부르지 않고 transport client(15 §8)를
 * deps로 받아 vitest에서 vi.fn() 모킹 가능하게 한다(research §1.6/§8).
 */
export interface ClaudeAcpAdapterDeps {
  /** 15 §8.2 agentRuntimeStart 래퍼. */
  startRuntime(params: AgentRuntimeStartParams): Promise<RuntimeId>;
  /** 15 §8.2 agentRuntimeSend 래퍼. */
  sendMessage(runtimeId: RuntimeId, message: JsonRpcMessage): Promise<void>;
  /** 15 §8.2 agentRuntimeCancel 래퍼(backend는 process target만 처리). */
  cancelRuntime(runtimeId: RuntimeId, target: AgentRuntimeCancelTarget): Promise<void>;
  /** 15 §8.2 agentRuntimeShutdown 래퍼. */
  shutdownRuntime(runtimeId: RuntimeId): Promise<void>;
  /** 15 §8.3 agent-runtime-* 이벤트 구독. */
  subscribeRuntime(runtimeId: RuntimeId, handler: (e: AgentRuntimeEvent) => void): UnlistenFn;
  /**
   * WSL entry 경로 resolve(§2.2). S1 정본: node 절대경로(command)는 backend가 resolve하고 start params에
   * 싣지 않으므로 여기서 돌려주지 않는다 — adapterEntryPath + non-secret env만 돌려준다.
   */
  resolveLaunch(p: StartSessionParams | ResumeSessionParams): Promise<ResolvedLaunch>;
  /** 단조 증가 JSON-RPC id 발급기. */
  nextRequestId(): number;
  /** 앱 버전(initialize clientInfo). */
  appVersion: string;
  /** 현재 시각(ms). */
  now(): number;
}

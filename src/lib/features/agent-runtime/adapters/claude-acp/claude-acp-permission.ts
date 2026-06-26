/**
 * Claude ACP 어댑터 — request_permission 매핑 + 응답 생성(06 §6).
 *
 * - mapRequestPermission: session/request_permission(agent→client request) → approval_requested AgentEvent + PendingApproval.
 * - buildPermissionResponse: 응답 wire 생성. **원본 rpcId 타입 보존(R3)**.
 * - classifySeverity: 09 §8.3 고위험 신호면 "escalation", 그 외 "normal"(OQ-47).
 */

import type { AgentEvent, ApprovalOption, ApprovalRequest, ProviderRef } from "../../contracts/normalized";
import type { JsonRpcMessage } from "../../service/transport";
import type {
  AcpPermissionOption,
  AcpRequestPermissionParams,
  PendingApproval,
} from "../../contracts/claude-acp";

/** PermissionOptionKind 4종 → ApprovalOption.kind 1:1(ref-acp §6, 15 §5). ACP엔 cancel/other 없음. */
function mapOptionKind(kind: AcpPermissionOption["kind"]): ApprovalOption["kind"] {
  switch (kind) {
    case "allow_once":
      return "allow_once";
    case "allow_always":
      return "allow_always";
    case "reject_once":
      return "reject_once";
    case "reject_always":
      return "reject_always";
    default:
      return "other";
  }
}

/**
 * approval severity 분류(OQ-47, 09 §8.3). 기본 "normal"(inline). 고위험 신호면 "escalation"(modal):
 * - 현재 permission mode가 bypassPermissions(어댑터가 §8 mode 추적으로 전달).
 * - ExitPlanMode에서 bypassPermissions 옵션이 노출된 승인(optionId에 bypassPermissions 존재).
 */
export function classifySeverity(
  params: AcpRequestPermissionParams,
  ctx: { currentModeId?: string },
): ApprovalRequest["severity"] {
  // 신호 1: 현재 mode가 bypassPermissions(고위험 모드 하의 승인).
  if (ctx.currentModeId === "bypassPermissions") return "escalation";
  // 신호 2: 옵션에 bypassPermissions 노출(ExitPlanMode ALLOW_BYPASS, ref-claude-agent-acp §3).
  const exposesBypass = params.options.some(
    (o) => o.optionId === "bypassPermissions" || /bypass/i.test(o.optionId),
  );
  if (exposesBypass) return "escalation";
  return "normal";
}

/**
 * session/request_permission request → approval_requested AgentEvent + PendingApproval 생성(§6.1).
 * 원본 JSON-RPC id는 **타입 보존**(R3): rpcId에 원본(string|number), ref.requestId/request.id는 String(id) 문자열 키.
 */
export function mapRequestPermission(
  rt: { providerSessionId?: string; activeTurnId?: string; currentModeId?: string },
  msg: JsonRpcMessage,
): { event: AgentEvent; pending: PendingApproval } {
  const m = msg as { id: string | number; params: AcpRequestPermissionParams };
  const id = m.id;
  const params = m.params;
  const toolCallId = params.toolCall?.toolCallId;
  // requestId(=String(id))는 UI·store·pending 키 전용. wire 응답에는 보존한 원본 rpcId(타입 유지)를 쓴다.
  const ref: ProviderRef = {
    provider: "claude",
    sessionId: params.sessionId ?? rt.providerSessionId,
    requestId: String(id),
    toolCallId,
    turnId: rt.activeTurnId,
    raw: params._meta,
  };
  const options: ApprovalOption[] = params.options.map((o) => ({
    id: o.optionId,
    label: o.name,
    kind: mapOptionKind(o.kind),
  }));
  const request: ApprovalRequest = {
    id: String(id), // 문자열 키 전용. wire 응답에 쓰지 않는다.
    title: params.toolCall?.title ?? "",
    toolCallId,
    options,
    severity: classifySeverity(params, { currentModeId: rt.currentModeId }),
  };
  const pending: PendingApproval = { rpcId: id, ref, request };
  return { event: { type: "approval_requested", ref, request }, pending };
}

/**
 * RequestPermissionResponse wire 생성(ref-acp §6).
 * id = 보존한 원본 rpcId(타입 유지, R3). outcome은 wire로 보낼 수 있는 selected/cancelled만 받는다 —
 * failed는 process-exit 경로에서만 발생하므로 이 builder에 미도달(§6.2 가드).
 */
export function buildPermissionResponse(
  id: string | number,
  decision: { outcome: "selected" | "cancelled"; optionId?: string },
): JsonRpcMessage {
  const outcome =
    decision.outcome === "selected"
      ? { outcome: "selected" as const, optionId: decision.optionId }
      : { outcome: "cancelled" as const };
  return { jsonrpc: "2.0", id, result: { outcome } };
}

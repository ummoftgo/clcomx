/**
 * Claude ACP 어댑터 — stopReason → normalized turn lifecycle 매핑(06 §3.6).
 *
 * session/prompt 응답의 stopReason을 CLCOMX 공통 turn_completed/status event로 변환한다.
 * refusal/max_tokens 같은 UI notice용 사유는 ProviderRef.raw에 보존한다.
 */

import type { AgentEvent, ProviderRef, TokenUsage } from "../../contracts/normalized";
import type { AcpStopReason } from "../../contracts/claude-acp";

/** stopReason 매핑에 필요한 ACP 세션 런타임 상태의 최소 부분. */
export interface ClaudeStopReasonRuntime {
  /** ACP sessionId. */
  providerSessionId?: string;
  /** 현재 prompt turn id. fixture replay처럼 없을 수도 있다. */
  activeTurnId?: string;
  /** 직전 usage_update가 누적한 context usage. */
  lastUsage?: TokenUsage;
}

/** ACP stopReason closed enum에 속하는지 확인한다(ref-acp §3.6). */
function isAcpStopReason(stopReason: unknown): stopReason is AcpStopReason {
  return (
    stopReason === "end_turn" ||
    stopReason === "max_tokens" ||
    stopReason === "max_turn_requests" ||
    stopReason === "refusal" ||
    stopReason === "cancelled"
  );
}

/** 로그와 notice에 넣을 수 있도록 알 수 없는 stopReason을 짧은 문자열로 포맷한다. */
function formatUnknownStopReason(stopReason: unknown): string {
  if (typeof stopReason === "string") return stopReason;
  if (stopReason === undefined) return "undefined";
  try {
    return JSON.stringify(stopReason) ?? String(stopReason);
  } catch {
    return String(stopReason);
  }
}

/**
 * ACP stopReason을 turn_completed + idle status event로 변환한다.
 * CLCOMX status에 없는 refusal/max_tokens류 세부 사유는 raw metadata로 보존한다.
 */
export function mapClaudeStopReason(
  rt: ClaudeStopReasonRuntime,
  stopReason: unknown,
): AgentEvent[] {
  const baseRef: ProviderRef = {
    provider: "claude",
    sessionId: rt.providerSessionId,
    turnId: rt.activeTurnId,
  };
  const ref: ProviderRef =
    stopReason === undefined ? baseRef : { ...baseRef, raw: { stopReason } };
  const usage = rt.lastUsage;

  if (!isAcpStopReason(stopReason)) {
    return [
      { type: "turn_completed", ref, status: "failed", usage },
      {
        type: "error",
        ref,
        message: `Unsupported ACP stopReason: ${formatUnknownStopReason(stopReason)}`,
        recoverable: false,
      },
    ];
  }

  switch (stopReason) {
    case "cancelled":
      return [{ type: "turn_completed", ref, status: "cancelled", usage }];
    case "refusal":
      // refusal은 CLCOMX status에 없음 → completed로 표시 + metadata 보존(ref-acp §13.1).
      return [
        { type: "turn_completed", ref, status: "completed", usage },
        { type: "session_status_changed", ref, status: "idle", reason: "refusal" },
      ];
    case "end_turn":
    case "max_tokens":
    case "max_turn_requests":
      return [
        { type: "turn_completed", ref, status: "completed", usage },
        { type: "session_status_changed", ref, status: "idle" },
      ];
  }
}

/**
 * Direct Agent Runtime — 세션 상태 전이 헬퍼(04 §2.1).
 *
 * AgentSessionStatus 전이 규칙을 순수 함수로 구현한다. 규칙 정본 = 04 §2.1,
 * 타입 정본 = 15(`./contracts/normalized`). store가 event를 받아 이 함수로 다음 status를 계산한다.
 */

import type { AgentEvent, AgentSessionStatus } from "../contracts/normalized";

/**
 * pending approval 잔존 여부를 함께 받아 event 적용 후 다음 status를 계산한다(04 §2.1).
 * pendingApprovalCount는 event 적용 **후** 시점의 값(approval 등록/해소가 반영된 뒤)이다.
 *
 * 규칙(04 §2.1):
 * 1. session_started → ready (starting → ready)
 * 2. turn 시작(running) → running
 * 3. running → requires_action (pending approval 발생)
 * 4. requires_action → running (approval resolve로 재개)
 * 5. turn_completed(any) → idle (실패/취소 포함; 세션 failed와 구분)
 * 6. error(systemError) → failed
 * 7. process_exited → exited
 */
export function nextSessionStatus(
  current: AgentSessionStatus,
  event: AgentEvent,
  pendingApprovalCount: number,
): AgentSessionStatus {
  switch (event.type) {
    case "session_started":
      // 규칙 1: process spawn + initialize 완료 → ready
      return "ready";
    case "session_loaded":
      return current === "starting" ? "ready" : current;
    case "session_status_changed":
      // provider가 합성한 명시 status를 그대로 채택(04 §2.2 합성표는 adapter가 적용).
      return event.status;
    case "user_message":
    case "agent_message":
    case "agent_message_delta":
    case "tool_call_updated":
    case "tool_call_content_delta":
    case "command_output_delta":
    case "plan_updated":
    case "file_change_updated":
      // 규칙 2: 종료/실패 상태가 아니면 turn 진행 중(running). pending 있으면 requires_action 유지.
      if (current === "failed" || current === "exited") return current;
      if (pendingApprovalCount > 0) return "requires_action";
      return "running";
    case "approval_requested":
      // 규칙 3: running → requires_action
      if (current === "failed" || current === "exited") return current;
      return "requires_action";
    case "approval_resolved":
      // 규칙 4: 남은 pending 없으면 running 복귀, 있으면 requires_action 유지
      if (current === "failed" || current === "exited") return current;
      return pendingApprovalCount > 0 ? "requires_action" : "running";
    case "turn_completed":
      // 규칙 5: turn 종료(실패/취소 포함) → idle (세션 failed와 구분)
      if (current === "exited" || current === "failed") return current;
      return "idle";
    case "process_exited":
      // 규칙 7
      return "exited";
    case "error":
      // 규칙 6: 복구 불가 에러 → failed. recoverable이면 status 유지.
      return event.recoverable ? current : "failed";
    case "terminal_output_delta":
      return current;
    default:
      return current;
  }
}

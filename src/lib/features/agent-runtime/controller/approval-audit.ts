/**
 * Direct Agent Runtime — approval audit (T1.6, 09 §3.4).
 *
 * 모든 approval 결정(user/auto/cleanup)이 닫힐 때 in-memory audit entry 1건을 남긴다.
 * **비밀(명령 전문/credential/파일 내용/raw label)은 절대 포함하지 않는다** — requestId/optionId/kind/outcome/
 * 시각/decidedBy 같은 메타만 담는다(NM-20c). OQ-51 결론에 따라 v1 기본은 in-memory만이며,
 * redacted 영속 로그는 후속 enhancement에서 별도 결정한다.
 */

import type { AgentProvider, ApprovalDecidedBy, ApprovalOption } from "../contracts/normalized";

/**
 * approval audit entry. 비밀 비포함(메타만). label/명령 전문/credential/파일 내용은 담지 않는다(09 §3.4).
 */
export interface ApprovalAuditEntry {
  /** JSON-RPC request id(문자열화). */
  requestId: string;
  /** CLCOMX 세션 핸들. */
  sessionHandle: string;
  provider: AgentProvider;
  /** 선택된 option id(없으면 cancelled/failed). label은 저장 금지. */
  optionId?: string;
  /** 선택된 option kind(allow_once 등). label과 달리 비밀 아님. */
  optionKind?: ApprovalOption["kind"];
  /** 연관 tool call id(있으면). */
  toolCallId?: string;
  outcome: "selected" | "cancelled" | "failed";
  /** epoch ms. */
  decidedAt: number;
  decidedBy: ApprovalDecidedBy;
}

/** audit entry 생성 입력(비밀 차단 경계 — 이 타입에 명령/credential/label 필드를 두지 않는다). */
export interface ApprovalAuditInput {
  requestId: string;
  sessionHandle: string;
  provider: AgentProvider;
  optionId?: string;
  optionKind?: ApprovalOption["kind"];
  toolCallId?: string;
  outcome: "selected" | "cancelled" | "failed";
  decidedBy: ApprovalDecidedBy;
  /** 테스트 결정성용 주입 가능 시각(기본 Date.now()). */
  decidedAt?: number;
}

/**
 * in-memory approval audit trail. 결정 1건당 entry 1건(NM-20b). 비밀 비포함(NM-20c).
 */
export class ApprovalAuditTrail {
  private entries: ApprovalAuditEntry[] = [];

  /** 닫힌 approval 결정 1건을 기록한다. 메타만 저장하며 label/명령/credential은 받지 않는다. */
  record(input: ApprovalAuditInput): ApprovalAuditEntry {
    const entry: ApprovalAuditEntry = {
      requestId: input.requestId,
      sessionHandle: input.sessionHandle,
      provider: input.provider,
      optionId: input.optionId,
      optionKind: input.optionKind,
      toolCallId: input.toolCallId,
      outcome: input.outcome,
      decidedAt: input.decidedAt ?? Date.now(),
      decidedBy: input.decidedBy,
    };
    this.entries.push(entry);
    return entry;
  }

  /** 기록된 모든 entry(복사본 — 외부 변형 방지). */
  list(): ApprovalAuditEntry[] {
    return [...this.entries];
  }

  /** 기록 건수. */
  get size(): number {
    return this.entries.length;
  }

  /** 전체 비우기(세션 teardown). */
  clear(): void {
    this.entries = [];
  }
}

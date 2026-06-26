/**
 * Direct Agent Runtime — pending approval table (04 §4, 03 §2.3).
 *
 * approval 요청의 **권위 보관처**. key = **`(sessionHandle, requestId)`** 복합 키(불변식):
 * JSON-RPC `id`는 runtime/connection 단위로만 유일하므로 두 runtime이 같은 id를 받아도 오응답하지
 * 않도록 세션 핸들과 묶는다(NM-15b). approval은 **정확히 1회 멱등 종료**(user/auto/cleanup)한다(04 §4.2·§5.0).
 *
 * 규칙 정본 = 04 §4·§5.0, 타입 정본 = 15(`./contracts/normalized`). audit는 `./approval-audit`.
 */

import type {
  ApprovalDecision,
  ApprovalRequest,
  AgentProvider,
} from "../contracts/normalized";
import type { ApprovalDecidedBy } from "./approval-audit";

/** 세션 핸들 + JSON-RPC request id 복합 키를 문자열로 직렬화한다(table key). */
export function pendingKey(sessionHandle: string, requestId: string): string {
  // 구분자가 핸들/requestId에 섞이지 않도록 길이 prefix로 안전 인코딩.
  return `${sessionHandle.length}:${sessionHandle}|${requestId}`;
}

/** pending approval의 내부 상태. closing/closed는 wire로 나가지 않는 내부 표식(04 §4.2). */
export type PendingState = "pending" | "closing" | "closed";

/** pending table 1개 엔트리. */
export interface PendingEntry {
  sessionHandle: string;
  requestId: string;
  provider: AgentProvider;
  request: ApprovalRequest;
  /** 이 approval이 매인 turn 라우팅 키(seal 조건 (c)·cancel cleanup 대상 식별). */
  turnKey: string;
  state: PendingState;
}

/** 종료 결과(멱등 — 이미 닫혔으면 closed=false 반환). */
export interface CloseResult {
  /** 이번 호출로 실제로 닫혔는지(정확히 1회 보장의 근거). */
  closed: boolean;
  entry?: PendingEntry;
  decision?: ApprovalDecision;
  decidedBy?: ApprovalDecidedBy;
}

/**
 * pending approval table. `(sessionHandle, requestId)` 키로 등록/조회/종료한다.
 * 종료는 정확히 1회 멱등(04 §5.0 규칙 2). audit 기록은 store가 CloseResult를 보고 1:1로 남긴다.
 */
export class PendingApprovalTable {
  private entries = new Map<string, PendingEntry>();

  /** approval 등록(04 §4.1 규칙 1). 같은 키 재등록은 기존을 유지(멱등). */
  register(
    sessionHandle: string,
    provider: AgentProvider,
    request: ApprovalRequest,
    turnKey: string,
  ): PendingEntry {
    const key = pendingKey(sessionHandle, request.id);
    const existing = this.entries.get(key);
    if (existing) return existing;
    const entry: PendingEntry = {
      sessionHandle,
      requestId: request.id,
      provider,
      request,
      turnKey,
      state: "pending",
    };
    this.entries.set(key, entry);
    return entry;
  }

  /** key로 엔트리 조회(테스트/라우팅용). */
  get(sessionHandle: string, requestId: string): PendingEntry | undefined {
    return this.entries.get(pendingKey(sessionHandle, requestId));
  }

  /** 한 세션의 pending(closed 제외) 엔트리들. UI 파생(pendingApprovals)·turn 매핑용. */
  listForSession(sessionHandle: string): PendingEntry[] {
    const out: PendingEntry[] = [];
    for (const e of this.entries.values()) {
      if (e.sessionHandle === sessionHandle && e.state !== "closed") out.push(e);
    }
    return out;
  }

  /** 한 turn(라우팅 키)에 매인 pending 엔트리들(cancel cleanup·seal 조건 (c)). */
  listForTurn(sessionHandle: string, turnKey: string): PendingEntry[] {
    return this.listForSession(sessionHandle).filter((e) => e.turnKey === turnKey);
  }

  /**
   * 정상 resolve(user/auto, 04 §4.1 규칙 4). 정확히 1회 멱등 — 이미 closing/closed면 closed=false.
   * @param decidedBy "user"(사용자 선택) 또는 "auto"(자동 승인).
   */
  resolve(
    sessionHandle: string,
    requestId: string,
    outcome: "selected" | "cancelled" | "failed",
    optionId: string | undefined,
    decidedBy: ApprovalDecidedBy,
  ): CloseResult {
    const key = pendingKey(sessionHandle, requestId);
    const entry = this.entries.get(key);
    if (!entry || entry.state === "closed" || entry.state === "closing") {
      // 멱등 무시(04 §4.2 규칙 4 / §5.0 규칙 2): 늦은 응답·이중 종료 차단.
      return { closed: false, entry };
    }
    entry.state = "closed";
    const decision: ApprovalDecision = { requestId, outcome, optionId };
    return { closed: true, entry, decision, decidedBy };
  }

  /**
   * cancel cleanup 1단계(04 §4.2 정본 순서 1): turn의 모든 pending을 원자적으로 `closing` 표시한다.
   * 이 표식이 동시 도착한 사용자 응답과 cancel의 이중 응답을 막는다(wire 응답 전에 잠금).
   * @returns closing으로 표시된 엔트리들(아직 닫히지 않음 — 2단계에서 cancelled로 닫는다).
   */
  markClosingForTurn(sessionHandle: string, turnKey: string): PendingEntry[] {
    const marked: PendingEntry[] = [];
    for (const e of this.listForTurn(sessionHandle, turnKey)) {
      if (e.state === "pending") {
        e.state = "closing";
        marked.push(e);
      }
    }
    return marked;
  }

  /** 세션의 모든 pending을 `closing` 표시(shutdown/exit 경로). */
  markClosingForSession(sessionHandle: string): PendingEntry[] {
    const marked: PendingEntry[] = [];
    for (const e of this.listForSession(sessionHandle)) {
      if (e.state === "pending") {
        e.state = "closing";
        marked.push(e);
      }
    }
    return marked;
  }

  /**
   * cleanup 종료(04 §4.2 정본 순서 2 / §5.0): closing 표시된 엔트리를 cancelled(또는 exit이면 failed)로 닫는다.
   * 정확히 1회 멱등 — 이미 closed면 closed=false.
   * @param outcome cancel/shutdown(process 생존)=cancelled, exit(process 사망)=failed(04 §5.0 규칙 1).
   */
  closeCleanup(
    sessionHandle: string,
    requestId: string,
    outcome: "cancelled" | "failed",
  ): CloseResult {
    const key = pendingKey(sessionHandle, requestId);
    const entry = this.entries.get(key);
    if (!entry || entry.state === "closed") {
      return { closed: false, entry };
    }
    entry.state = "closed";
    const decision: ApprovalDecision = { requestId, outcome };
    return { closed: true, entry, decision, decidedBy: "cleanup" };
  }

  /**
   * turn cancel cleanup 전체(04 §4.2): 표시 → cancelled 종료를 묶어 수행한다.
   * 호출부(store/adapter)가 wire 응답을 보내고 audit/emit을 처리한다.
   * @returns 실제로 닫힌 CloseResult들(closed=true만).
   */
  cancelTurn(sessionHandle: string, turnKey: string): CloseResult[] {
    const marked = this.markClosingForTurn(sessionHandle, turnKey);
    const results: CloseResult[] = [];
    for (const e of marked) {
      const r = this.closeCleanup(sessionHandle, e.requestId, "cancelled");
      if (r.closed) results.push(r);
    }
    return results;
  }

  /**
   * process exit cleanup(04 §5.0 규칙 3): 세션의 모든 pending을 failed로 정확히 1회 닫는다.
   * 늦은 중복 exit은 멱등 무시(NM-18c/18d).
   */
  closeAllOnExit(sessionHandle: string): CloseResult[] {
    const marked = this.markClosingForSession(sessionHandle);
    const results: CloseResult[] = [];
    for (const e of marked) {
      const r = this.closeCleanup(sessionHandle, e.requestId, "failed");
      if (r.closed) results.push(r);
    }
    return results;
  }

  /**
   * shutdown cleanup(process 생존, 04 §5.0 규칙 4): 세션의 모든 pending을 cancelled로 정확히 1회 닫는다.
   */
  closeAllOnShutdown(sessionHandle: string): CloseResult[] {
    const marked = this.markClosingForSession(sessionHandle);
    const results: CloseResult[] = [];
    for (const e of marked) {
      const r = this.closeCleanup(sessionHandle, e.requestId, "cancelled");
      if (r.closed) results.push(r);
    }
    return results;
  }

  /** closed 엔트리를 table에서 제거(메모리 정리). pending/closing은 유지. */
  prune(): void {
    for (const [key, e] of this.entries) {
      if (e.state === "closed") this.entries.delete(key);
    }
  }

  /** 한 세션의 모든 엔트리 제거(window-close 격리·세션 teardown). */
  removeSession(sessionHandle: string): void {
    for (const [key, e] of this.entries) {
      if (e.sessionHandle === sessionHandle) this.entries.delete(key);
    }
  }
}

/**
 * Direct Agent Runtime — Codex 라우팅/pending table(05 §6).
 *
 * Codex는 한 connection에서 여러 thread/turn이 인터리빙될 수 있어
 * `(threadId, turnId, itemId)` 삼중 키 라우팅이 필수다(ref-codex §7.1, 04 §1).
 * 이 클래스는 어댑터 내부 상태(plain class, 룬 불필요 — transcript store 아님)이며,
 * 원본 JSON-RPC id의 실제 타입(string|number)을 보존해 응답 시 복원한다(R3, ref-codex §1.3).
 */

import type { TokenUsage } from "../../contracts/normalized";

/** approval pending 항목의 생명주기 상태(이중 응답/멱등 가드용, 04 §4.2). */
type PendingApprovalState = "pending" | "responding" | "closing" | "closed";

/**
 * pending approval 1건. requestId(정규화 string) 외에 **원본 JSON-RPC id 타입**과
 * server request method를 보존한다(D12). 응답 `{ id: rpcId, ... }`로 원본 타입 복원.
 */
export interface PendingApproval {
  /** String(id) 정규화 값(15 §1, UI/store 문자열 키). */
  requestId: string;
  /** 원본 JSON-RPC id — 응답 시 그대로 사용(타입 보존, R3·ref-codex §1.3). */
  rpcId: string | number;
  /** server request method(permissions 분기 판단). */
  method: string;
  threadId?: string;
  turnId?: string;
  itemId?: string;
  /** 생명주기 상태(멱등 가드). */
  state: PendingApprovalState;
}

/**
 * Codex 어댑터 1개 세션의 라우팅 상태. threadId/turnId 매핑, session_started 멱등 가드,
 * tokenUsage 보관, approval pending table을 모두 보유한다.
 */
export class CodexRouting {
  /** threadId → sessionId. */
  private sessionIdByThread = new Map<string, string>();
  /** sessionHandle → threadId(sendPrompt/cancelTurn 역조회, C2). */
  private threadIdByHandle = new Map<string, string>();
  /** threadId → 현재 active turnId. */
  private activeTurnByThread = new Map<string, string>();
  /** session_started 멱등 가드(§2.3): thread/started notification 중복 차단. */
  private startedThreads = new Set<string>();
  /** 닫힌 turn 집합(`${threadId}:${turnId}`) — late usage 분기(§5.6 M4). */
  private closedTurns = new Set<string>();
  /** `${threadId}:${turnId}` → 보관된 tokenUsage(§5.6). */
  private tokenUsageByTurn = new Map<string, TokenUsage>();
  /** requestId → pending approval(§7, 04 §4). */
  private pendingApprovals = new Map<string, PendingApproval>();

  /** `${threadId}:${turnId}` 합성 키. */
  private turnKey(threadId: string, turnId: string): string {
    return `${threadId}:${turnId}`;
  }

  // ───────────── thread ─────────────

  /** thread를 등록한다(sessionId 보강 가능). 멱등. */
  ensureThread(threadId: string, sessionId?: string): void {
    if (sessionId !== undefined) this.sessionIdByThread.set(threadId, sessionId);
    else if (!this.sessionIdByThread.has(threadId)) this.sessionIdByThread.set(threadId, "");
  }

  /** thread의 sessionId 조회. */
  sessionIdOf(threadId: string): string | undefined {
    const s = this.sessionIdByThread.get(threadId);
    return s === "" ? undefined : s;
  }

  /** session_started를 이미 emit했는지(§2.3 멱등 가드). */
  alreadyStarted(threadId: string): boolean {
    return this.startedThreads.has(threadId);
  }

  /** session_started emit 후 호출(멱등 가드 마킹). */
  markStarted(threadId: string): void {
    this.startedThreads.add(threadId);
  }

  // ───────────── handle ↔ thread ─────────────

  /** sessionHandle↔threadId 바인딩(startSession/resumeSession에서 threadId 확정 시). */
  bindHandle(handle: string, threadId: string): void {
    this.threadIdByHandle.set(handle, threadId);
  }

  /** sessionHandle로 threadId 역조회(§2.4·§7.3; 미바인딩이면 undefined). */
  threadIdOf(handle: string): string | undefined {
    return this.threadIdByHandle.get(handle);
  }

  // ───────────── turn ─────────────

  /** active turn 설정(turn/started 또는 turn/start response). */
  setActiveTurn(threadId: string, turnId: string): void {
    this.activeTurnByThread.set(threadId, turnId);
    // 재시작된 turnId면 closed 집합에서 제거(동일 id 재사용 방어).
    this.closedTurns.delete(this.turnKey(threadId, turnId));
  }

  /** turn 종료 처리: active 해제 + closedTurns 기록(§5.6 M4). */
  clearActiveTurn(threadId: string, turnId: string): void {
    if (this.activeTurnByThread.get(threadId) === turnId) {
      this.activeTurnByThread.delete(threadId);
    }
    this.closedTurns.add(this.turnKey(threadId, turnId));
  }

  /** thread의 active turnId(cancelTurn 기본값, §7.3). */
  activeTurnOf(threadId: string): string | undefined {
    return this.activeTurnByThread.get(threadId);
  }

  /** turn이 이미 닫혔는지(§5.6 M4: clearActiveTurn 후면 true). */
  isTurnClosed(threadId: string, turnId: string): boolean {
    return this.closedTurns.has(this.turnKey(threadId, turnId));
  }

  // ───────────── token usage(§5.6) ─────────────

  /** tokenUsage 선행 도착분 보관(turn_completed에 결합). */
  recordTokenUsage(threadId: string, turnId: string, u: TokenUsage): void {
    this.tokenUsageByTurn.set(this.turnKey(threadId, turnId), u);
  }

  /** 보관된 tokenUsage를 꺼낸다(꺼내면서 제거). 없으면 undefined. */
  takeTokenUsage(threadId: string, turnId: string): TokenUsage | undefined {
    const key = this.turnKey(threadId, turnId);
    const u = this.tokenUsageByTurn.get(key);
    if (u !== undefined) this.tokenUsageByTurn.delete(key);
    return u;
  }

  // ───────────── approval pending table(§7, 04 §4) ─────────────

  /**
   * pending approval 등록(04 §4.1). 원본 id 타입·method를 함께 보관(D12).
   * @param rpcId 원본 JSON-RPC id(타입 보존; 응답 시 그대로 사용).
   * @param method server request method.
   */
  addPendingApproval(
    requestId: string,
    rpcId: string | number,
    method: string,
    ref: { threadId?: string; turnId?: string; itemId?: string },
  ): void {
    this.pendingApprovals.set(requestId, {
      requestId,
      rpcId,
      method,
      threadId: ref.threadId,
      turnId: ref.turnId,
      itemId: ref.itemId,
      state: "pending",
    });
  }

  /** pending이 아직 살아 있는지(closing/closed/부재면 false — 멱등 가드). */
  hasPendingApproval(requestId: string): boolean {
    const p = this.pendingApprovals.get(requestId);
    return p !== undefined && p.state === "pending";
  }

  /** pending을 삭제하지 않고 조회만 한다(wire 성공 전 peek용). 없으면 undefined. */
  getPendingApproval(requestId: string): PendingApproval | undefined {
    return this.pendingApprovals.get(requestId);
  }

  /**
   * 사용자 응답 전송을 위해 pending을 원자적으로 선점한다(compare-and-set, New-F1 race).
   * state==="pending"일 때만 "responding"으로 전이하고 항목을 돌려준다. 이미 responding/closing/closed/부재면
   * undefined(다른 경로가 선점·종료 중 → respondApproval no-op). 선점 후 cancelTurn(markTurnApprovalsClosing)·
   * serverRequest/resolved(hasPendingApproval)는 "pending"만 보므로 이 항목을 건너뛴다 → 이중 wire 응답 방지.
   */
  claimForResponse(requestId: string): PendingApproval | undefined {
    const p = this.pendingApprovals.get(requestId);
    if (p === undefined || p.state !== "pending") return undefined;
    p.state = "responding";
    return p;
  }

  /** wire 전송 실패 시 선점을 되돌린다(responding→pending) — 재시도·cleanup 재대상화. */
  revertResponse(requestId: string): void {
    const p = this.pendingApprovals.get(requestId);
    if (p !== undefined && p.state === "responding") p.state = "pending";
  }

  /** pending을 제거(closing/closed → 완전 제거)하고 항목을 돌려준다. 없으면 undefined. */
  resolveApproval(requestId: string): PendingApproval | undefined {
    const p = this.pendingApprovals.get(requestId);
    if (p === undefined) return undefined;
    this.pendingApprovals.delete(requestId);
    return p;
  }

  /** 특정 turn의 pending approval requestId 목록(cancel cleanup, §7.3). */
  pendingApprovalsForTurn(threadId: string, turnId: string): string[] {
    const out: string[] = [];
    for (const p of this.pendingApprovals.values()) {
      if (p.threadId === threadId && p.turnId === turnId) out.push(p.requestId);
    }
    return out;
  }

  /**
   * C4(04 §4.2 단계1): 해당 turn의 pending approval을 원자적으로 closing으로 표시(이중 응답 방지).
   * 이미 closing/closed인 항목은 제외하고, 새로 closing 표시한 requestId만 반환(멱등).
   */
  markTurnApprovalsClosing(threadId: string, turnId: string): string[] {
    const out: string[] = [];
    for (const p of this.pendingApprovals.values()) {
      if (p.threadId === threadId && p.turnId === turnId && p.state === "pending") {
        p.state = "closing";
        out.push(p.requestId);
      }
    }
    return out;
  }

  /** 모든 pending approval requestId(process exit/shutdown cleanup, §9). */
  allPendingApprovalIds(): string[] {
    return [...this.pendingApprovals.keys()];
  }

  /**
   * exit/shutdown cleanup 대상 requestId(New-F1 race): "responding"(respondApproval이 wire 전송 중)
   * 인 항목은 **제외**한다 — 그 경로가 단일 wire 응답을 완료하도록 두어 이중 wire(accept+cancel)를 막는다.
   * 나머지(pending/closing)는 closing으로 선점해 반환한다(CAS, 멱등).
   */
  pendingApprovalIdsForCleanup(): string[] {
    const out: string[] = [];
    for (const p of this.pendingApprovals.values()) {
      if (p.state === "responding") continue;
      p.state = "closing";
      out.push(p.requestId);
    }
    return out;
  }
}

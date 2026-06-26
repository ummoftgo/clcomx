/**
 * Direct Agent Runtime — 세션 단위 store (T1.3, FE §1.3 class 패턴).
 *
 * 한 세션의 transcript·status·pending approval을 권위 있게 보관한다(03 §2.2).
 * **반응형 표면(룬 `$state`)은 visibleItemIds/itemVersions/status/pendingApprovals/escalationApproval/
 * error/composer 입력만**이다. transcript body(itemsById)·turnsById·tombstones는 plain(비반응형)이며
 * streaming은 body 갱신 + itemVersions bump으로만 렌더를 트리거한다(08 §5 shallow 반응형 표면).
 *
 * reducer(`../controller/agent-event-reducer`)·status(`../controller/session-status`)·
 * pending table(`../controller/pending-approval-table`)·audit(`../controller/approval-audit`)를 조합한다.
 */

import type {
  AgentEvent,
  AgentProvider,
  AgentSessionStatus,
  ApprovalDecision,
  ApprovalRequest,
  TokenUsage,
} from "../contracts/normalized";
import type {
  ComposerCapabilities,
  TranscriptItem,
  TranscriptModel,
  TranscriptResidencyConfig,
} from "../contracts/transcript";
import { DEFAULT_TRANSCRIPT_RESIDENCY_CONFIG } from "../contracts/transcript";
import {
  applyEvent,
  createEmptyTranscriptModel,
  evictOverflow,
  sealEligibleTurns,
  setTurnPending,
  turnKeyOf,
} from "../controller/agent-event-reducer";
import { nextSessionStatus } from "../controller/session-status";
import {
  PendingApprovalTable,
  type CloseResult,
} from "../controller/pending-approval-table";
import {
  ApprovalAuditTrail,
  type ApprovalAuditEntry,
  type ApprovalDecidedBy,
} from "../controller/approval-audit";

/** store 생성 옵션. */
export interface AgentRuntimeStoreOptions {
  sessionHandle: string;
  provider: AgentProvider;
  providerLabel?: string;
  capabilities?: ComposerCapabilities;
  residencyConfig?: TranscriptResidencyConfig;
}

/** store가 외부에 노출하는 인터페이스(plain interface — FE §1.3). */
export interface AgentRuntimeStore {
  readonly sessionHandle: string;
  readonly provider: AgentProvider;
  /** 반응형 표면 — 순서·표시 대상. */
  readonly visibleItemIds: string[];
  /** 반응형 표면 — itemId별 렌더 트리거 버전. */
  readonly itemVersions: Record<string, number>;
  readonly status: AgentSessionStatus;
  readonly streamingItemId: string | null;
  /** severity!=="escalation" inline approval 파생. */
  readonly pendingApprovals: ApprovalRequest[];
  /** severity==="escalation" modal approval 파생. */
  readonly escalationApproval: ApprovalRequest | null;
  readonly usage: TokenUsage | null;
  readonly contextUsage: { used: number; size: number } | null;
  readonly providerLabel: string;
  readonly capabilities: ComposerCapabilities;
  readonly autoFollow: boolean;

  /** transcript body(plain Map) 직접 조회 — 비반응형, 렌더는 itemVersions로 트리거(08 §5). */
  getItem(id: string): TranscriptItem | undefined;
  /** 진단/테스트용 transcript 모델 스냅샷(plain). */
  getTranscript(): TranscriptModel;
  /** evicted-tombstone 구간(이전 기록) 존재 여부 — replay affordance 노출용(T5.6, 08 §7.2). */
  hasEvictedHistory(): boolean;
  /** audit trail 조회(비밀 비포함, T1.6). */
  getAuditEntries(): ApprovalAuditEntry[];

  /** AgentEvent 1개를 적용한다(reducer + status + pending table). */
  dispatch(event: AgentEvent): void;
  /** 사용자/자동 approval 응답을 기록한다(04 §4.1). 정확히 1회 멱등. */
  respondApproval(decision: ApprovalDecision, decidedBy?: ApprovalDecidedBy): void;
  /** turn cancel cleanup(04 §4.2): pending approval을 cancelled로 정확히 1회 닫는다. */
  cancelTurn(turnKey: string): CloseResult[];
  /** process exit cleanup(04 §5.0 규칙 3): 모든 pending을 failed로 정확히 1회 닫는다. */
  closePendingOnExit(): CloseResult[];
  /** shutdown cleanup(04 §5.0 규칙 4): 모든 pending을 cancelled로 정확히 1회 닫는다. */
  closePendingOnShutdown(): CloseResult[];
  /** quiescence grace 경과 후 seal+eviction 트리거(04 §3.7 (e)). */
  flushSealAndEvict(): void;
  /** auto-follow 토글(08 §7.2 — 스크롤 추종 on/off). */
  setAutoFollow(value: boolean): void;
  /** 세션 teardown(table/audit 정리). */
  dispose(): void;
}

class AgentRuntimeStoreImpl implements AgentRuntimeStore {
  readonly sessionHandle: string;
  readonly provider: AgentProvider;
  readonly providerLabel: string;
  readonly residencyConfig: TranscriptResidencyConfig;

  // 반응형 표면(룬 $state) — 08 §5 shallow 반응형 표면 한정.
  visibleItemIds = $state<string[]>([]);
  itemVersions = $state<Record<string, number>>({});
  status = $state<AgentSessionStatus>("starting");
  streamingItemId = $state<string | null>(null);
  pendingApprovals = $state<ApprovalRequest[]>([]);
  escalationApproval = $state<ApprovalRequest | null>(null);
  usage = $state<TokenUsage | null>(null);
  contextUsage = $state<{ used: number; size: number } | null>(null);
  capabilities = $state<ComposerCapabilities>({ image: false, embeddedContext: false, audio: false });
  autoFollow = $state(true);

  // plain(비반응형) — body·turn·tombstone은 TranscriptModel에 둔다(heap 경계 대상).
  private transcript: TranscriptModel = createEmptyTranscriptModel();
  private readonly pending = new PendingApprovalTable();
  private readonly audit = new ApprovalAuditTrail();

  constructor(options: AgentRuntimeStoreOptions) {
    this.sessionHandle = options.sessionHandle;
    this.provider = options.provider;
    this.providerLabel = options.providerLabel ?? options.provider;
    this.residencyConfig = options.residencyConfig ?? DEFAULT_TRANSCRIPT_RESIDENCY_CONFIG;
    if (options.capabilities) this.capabilities = options.capabilities;
  }

  getItem(id: string): TranscriptItem | undefined {
    return this.transcript.itemsById.get(id);
  }

  getTranscript(): TranscriptModel {
    return this.transcript;
  }

  hasEvictedHistory(): boolean {
    // tombstone LRU에 항목이 있으면 evict된 이전 기록 구간이 존재한다(04 §3.7).
    return this.transcript.tombstones.lru.length > 0;
  }

  getAuditEntries(): ApprovalAuditEntry[] {
    return this.audit.list();
  }

  /** 반응형 표면을 transcript 모델 결과로 동기화한다(plain → $state 단방향 반영). */
  private syncReactiveSurface(): void {
    this.visibleItemIds = this.transcript.visibleItemIds;
    this.itemVersions = this.transcript.itemVersions;
  }

  /** pendingApprovals/escalationApproval/status를 pending table에서 파생한다(08 §5 파생 관계). */
  private syncApprovalSurface(): void {
    const entries = this.pending
      .listForSession(this.sessionHandle)
      .filter((e) => e.state === "pending");
    const inline: ApprovalRequest[] = [];
    let escalation: ApprovalRequest | null = null;
    for (const e of entries) {
      if (e.request.severity === "escalation") escalation = e.request;
      else inline.push(e.request);
    }
    this.pendingApprovals = inline;
    this.escalationApproval = escalation;
  }

  dispatch(event: AgentEvent): void {
    // transcript 모델 reduce(순수). terminal/ session_* 는 모델 불변.
    this.transcript = applyEvent(this.transcript, event);

    // approval table 반영(정식 경로).
    this.applyApprovalEvent(event);

    // pending 수를 turn 메타에 반영(seal 조건 (c)).
    this.refreshTurnPending(event);

    // status 전이(04 §2.1) — pending 반영 후 카운트로 계산.
    const pendingCount = this.pending
      .listForSession(this.sessionHandle)
      .filter((e) => e.state === "pending").length;
    this.status = nextSessionStatus(this.status, event, pendingCount);

    // usage 보강.
    if (event.type === "turn_completed" && event.usage) this.usage = event.usage;

    // exit 시 pending 전부 failed 종료(04 §5.0 규칙 3) — store 자체에서 처리.
    if (event.type === "process_exited") {
      this.closePendingOnExit();
    }

    // streaming item 추적(가상화 강제 포함 대상).
    this.updateStreamingItemId(event);

    this.syncReactiveSurface();
    this.syncApprovalSurface();
  }

  /** approval_requested/resolved를 pending table에 반영한다(04 §4.1). */
  private applyApprovalEvent(event: AgentEvent): void {
    if (event.type === "approval_requested") {
      const turnKey = turnKeyOf(event.ref);
      this.pending.register(this.sessionHandle, this.provider, event.request, turnKey);
    } else if (event.type === "approval_resolved") {
      // wire에서 온 resolved(serverRequest/resolved 등) — user 결정으로 멱등 종료.
      const r = this.pending.resolve(
        this.sessionHandle,
        event.decision.requestId,
        event.decision.outcome,
        event.decision.optionId,
        "user",
      );
      this.recordAudit(r);
    }
  }

  /** turn 메타의 pendingRequestCount를 pending table 현황과 일치시킨다(seal 조건 (c)). */
  private refreshTurnPending(event: AgentEvent): void {
    if (event.type !== "approval_requested" && event.type !== "approval_resolved") return;
    // 영향 turn만 재계산(전체 순회 회피).
    const turnKey = turnKeyOf(event.ref);
    const count = this.pending
      .listForTurn(this.sessionHandle, turnKey)
      .filter((e) => e.state === "pending").length;
    const current = this.transcript.turnsById.get(turnKey)?.pendingRequestCount ?? 0;
    if (count !== current) {
      this.transcript = setTurnPending(this.transcript, turnKey, count - current);
    }
  }

  /** streaming 중인 message item id를 추적한다(08 §3 가상화 강제 포함). */
  private updateStreamingItemId(event: AgentEvent): void {
    if (event.type === "agent_message_delta") {
      const base = event.ref.itemId ?? event.ref.messageId;
      if (base !== undefined) {
        const channel = event.channel ?? "response";
        this.streamingItemId = channel === "thought" ? `thought:${base}` : base;
      }
    } else if (event.type === "turn_completed" || event.type === "process_exited") {
      this.streamingItemId = null;
    }
  }

  /** CloseResult를 audit으로 1:1 기록한다(닫힌 경우만 — 정확히 1건/결정). */
  private recordAudit(r: CloseResult): void {
    if (!r.closed || !r.entry || !r.decision || !r.decidedBy) return;
    const selectedOption = r.decision.optionId
      ? r.entry.request.options.find((o) => o.id === r.decision!.optionId)
      : undefined;
    this.audit.record({
      requestId: r.entry.requestId,
      sessionHandle: r.entry.sessionHandle,
      provider: r.entry.provider,
      optionId: r.decision.optionId,
      optionKind: selectedOption?.kind,
      toolCallId: r.entry.request.toolCallId,
      outcome: r.decision.outcome,
      decidedBy: r.decidedBy,
    });
  }

  respondApproval(decision: ApprovalDecision, decidedBy: ApprovalDecidedBy = "user"): void {
    const r = this.pending.resolve(
      this.sessionHandle,
      decision.requestId,
      decision.outcome,
      decision.optionId,
      decidedBy,
    );
    this.recordAudit(r);
    if (r.closed && r.entry) {
      // approval_resolved 합성 event로 transcript/status 동기화(turn pending 갱신 + status 복귀).
      const resolvedEvent: AgentEvent = {
        type: "approval_resolved",
        ref: { provider: this.provider, requestId: decision.requestId, turnId: undefined, raw: undefined },
        decision: r.decision!,
      };
      // ref에 turnKey 정보를 보존하기 위해 entry의 turnKey를 복원할 수 없으므로 직접 turn pending 갱신.
      this.refreshTurnPendingForKey(r.entry.turnKey);
      const pendingCount = this.pending
        .listForSession(this.sessionHandle)
        .filter((e) => e.state === "pending").length;
      this.status = nextSessionStatus(this.status, resolvedEvent, pendingCount);
    }
    this.syncReactiveSurface();
    this.syncApprovalSurface();
  }

  /** 특정 turnKey의 pendingRequestCount를 table 현황과 동기화. */
  private refreshTurnPendingForKey(turnKey: string): void {
    const count = this.pending
      .listForTurn(this.sessionHandle, turnKey)
      .filter((e) => e.state === "pending").length;
    const current = this.transcript.turnsById.get(turnKey)?.pendingRequestCount ?? 0;
    if (count !== current) {
      this.transcript = setTurnPending(this.transcript, turnKey, count - current);
    }
  }

  cancelTurn(turnKey: string): CloseResult[] {
    const results = this.pending.cancelTurn(this.sessionHandle, turnKey);
    for (const r of results) this.recordAudit(r);
    this.refreshTurnPendingForKey(turnKey);
    this.syncApprovalSurface();
    this.syncReactiveSurface();
    return results;
  }

  closePendingOnExit(): CloseResult[] {
    const results = this.pending.closeAllOnExit(this.sessionHandle);
    for (const r of results) this.recordAudit(r);
    // 영향 turn들 pending 동기화
    for (const r of results) if (r.entry) this.refreshTurnPendingForKey(r.entry.turnKey);
    this.syncApprovalSurface();
    this.syncReactiveSurface();
    return results;
  }

  closePendingOnShutdown(): CloseResult[] {
    const results = this.pending.closeAllOnShutdown(this.sessionHandle);
    for (const r of results) this.recordAudit(r);
    for (const r of results) if (r.entry) this.refreshTurnPendingForKey(r.entry.turnKey);
    this.syncApprovalSurface();
    this.syncReactiveSurface();
    return results;
  }

  flushSealAndEvict(): void {
    // grace 경과 신호 = 이 호출 자체. seal → eviction 순서로 적용(04 §3.7).
    let next = sealEligibleTurns(this.transcript);
    next = evictOverflow(next, this.residencyConfig);
    this.transcript = next;
    this.syncReactiveSurface();
  }

  setAutoFollow(value: boolean): void {
    this.autoFollow = value;
  }

  dispose(): void {
    this.pending.removeSession(this.sessionHandle);
    this.audit.clear();
    this.transcript = createEmptyTranscriptModel();
    this.syncReactiveSurface();
  }
}

/** store 팩토리(FE §1.3). */
export function createAgentRuntimeStore(options: AgentRuntimeStoreOptions): AgentRuntimeStore {
  return new AgentRuntimeStoreImpl(options);
}

/**
 * Direct Agent Runtime — UI view-model 타입 정본 복사처.
 *
 * 정본: `docs/plans/agent-direct-runtime/08-ui-composition.md` §5.
 * 도메인 타입(15 §1–§5)은 `./normalized`에서 import해 쓰고 **절대 재정의하지 않는다**.
 * 이 파일은 transcript 렌더링을 위해 UI가 추가로 필요로 하는 view-model만 정의한다.
 * 메모리 residency·seal 규칙(3-상태 turn residency·eviction·late-event)의 규칙 정본은 04 §3.7이다.
 */

import type {
  AgentContent,
  AgentPlanEntry,
  ApprovalRequest,
  ToolCallUpdate,
  FileChangeSummary,
  AgentSessionStatus,
  ProviderRef,
  TokenUsage,
} from "./normalized";

// ─────────────────────────────────────────────────────────────────────────────
// transcript item (렌더 단위)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * transcript에 순서대로 쌓이는 렌더 단위. discriminator = type.
 * role="reasoning"은 channel:"thought"(15 §3) 누적 스트림 → 접이식 thinking 블록(08 §6.2, 기본 collapsed).
 */
export type TranscriptItem =
  | {
      type: "message";
      id: string;
      role: "user" | "agent" | "reasoning";
      content: AgentContent[];
      streaming: boolean;
      collapsed?: boolean;
      ref: ProviderRef;
    }
  // replace-only(04 §3.3)
  | { type: "plan"; id: string; entries: AgentPlanEntry[] }
  | {
      type: "tool_call";
      id: string;
      update: ToolCallUpdate;
      expanded: boolean;
      approval?: ApprovalRequest;
    }
  | { type: "file_change"; id: string; change: FileChangeSummary }
  | {
      type: "notice";
      id: string;
      level: "info" | "warning" | "error";
      messageKey: string;
      raw?: unknown;
    };

// ─────────────────────────────────────────────────────────────────────────────
// turn 단위 메모리 거주 상태(memory residency)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * turn 단위 메모리 거주 상태(=memory residency). protocol lifecycle(15 §3 event)와 **별개** 축으로,
 * 긴 세션에서 frontend in-memory transcript가 unbounded로 커지는 문제(13 §1.12)를 막기 위한 heap 경계 정책이다.
 * 3-상태 정의·전이·late-event 규칙의 정본은 04 §3.7이다.
 * - `unsealed`: turn이 아직 종료 신호를 못 받았거나 quiescence grace 중. 모든 event를 그대로 apply.
 * - `sealed-retained`: seal 완료, body는 메모리에 유지. 늦게 도착한 same-turn event는 unseal→patch→reseal.
 * - `evicted-tombstone`: body가 evict됨(작은 tombstone만 보존). 늦은 event는 apply 금지하고 droppedLateEventCount만 증가.
 */
export type TranscriptTurnResidency = "unsealed" | "sealed-retained" | "evicted-tombstone";

/**
 * turn 메타데이터. residency + 소속 item id + seal 불변식 추적용 플래그.
 * (08 §5 `turnsById` 값 모양 + 04 §3.7 seal 조건 추적에 필요한 내부 필드를 합친 형태.)
 */
export interface TranscriptTurnState {
  /** 메모리 거주 상태(3-상태). */
  residency: TranscriptTurnResidency;
  /** 이 turn에 소속된 transcript item id(생성 순서 보존). */
  itemIds: string[];
  /** 종료 신호(turn_completed / stopReason) 수신 여부 — seal 조건 (a). */
  terminated: boolean;
  /** 이 turn에 매인 미해결 open item 수(streaming/미완료) — seal 조건 (b). */
  openItemCount: number;
  /** 이 turn에 매인 pending approval/request 수 — seal 조건 (c). */
  pendingRequestCount: number;
  /** unseal→patch→reseal이 일어난 횟수(telemetry). */
  resealCount: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// transcript model (shallow 반응형 id-index)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * transcript의 **shallow 반응형 id-index 모델**(08 §5 정본). 긴 세션에서도 반응성 오버헤드와 heap을
 * 세션 길이와 무관하게 bounded로 유지한다.
 *
 * **shallow 반응형 표면**: 룬 `$state`로 두는 것은 `visibleItemIds`/`itemVersions`만이다(store가 이를
 * 반응형 표면으로 노출). item body(`itemsById`)는 **plain Map(비반응형)**이며, streaming은 body를 직접
 * 갱신하고 `itemVersions[itemId]`를 bump해 렌더만 트리거한다.
 *
 * reducer 시그니처 = `applyEvent(prev: TranscriptModel, event: AgentEvent): TranscriptModel`.
 */
export interface TranscriptModel {
  /** 반응형 표면 — 순서·표시 대상(가상화 소싱). */
  visibleItemIds: string[];
  /** 반응형 표면 — itemId별 렌더 트리거 버전(streaming 시 bump). */
  itemVersions: Record<string, number>;
  /** 비반응형 plain Map — item body(heap 경계 대상). */
  itemsById: Map<string, TranscriptItem>;
  /** turn별 residency + 소속 item + seal 추적. */
  turnsById: Map<string, TranscriptTurnState>;
  /** evicted turn의 작은 LRU + 늦은 event 폐기 카운터. */
  tombstones: { lru: string[]; droppedLateEventCount: number };
}

// ─────────────────────────────────────────────────────────────────────────────
// view state / composer capabilities
// ─────────────────────────────────────────────────────────────────────────────

/** AgentRuntimeShell 세션 인스턴스 상태(룬 class, FE §1.3). */
export interface AgentRuntimeViewState {
  transcript: TranscriptModel;
  status: AgentSessionStatus;
  streamingItemId: string | null;
  /** severity!=="escalation" 파생(inline). */
  pendingApprovals: ApprovalRequest[];
  /** severity==="escalation" 파생(modal). */
  escalationApproval: ApprovalRequest | null;
  capabilities: ComposerCapabilities;
  providerLabel: string;
  usage: TokenUsage | null;
  contextUsage?: { used: number; size: number } | null;
  autoFollow: boolean;
}

/** composer가 capability에 따라 활성/비활성하는 입력 기능(08 §6.4). */
export interface ComposerCapabilities {
  image: boolean;
  embeddedContext: boolean;
  /** v1 미지원(15 §4 주의) → 항상 false. */
  audio: boolean;
}

/**
 * sealed-turn 윈도우 / tombstone 경계 config. 수치는 OQ-52에서 확정된 보수적 기본값을 쓴다(impl-log.md).
 */
export interface TranscriptResidencyConfig {
  /** hot window에 body를 유지할 최근 sealed turn 수. */
  HOT_WINDOW_SEALED_TURNS: number;
  /** evicted-tombstone LRU 슬롯 수. */
  TOMBSTONE_LRU: number;
  /** seal 전 quiescence grace(ms). reducer는 동기 함수라 grace 경과는 외부가 트리거한다. */
  SEAL_QUIESCENCE_GRACE_MS: number;
}

/**
 * TranscriptResidencyConfig 기본값(OQ-52 보수적 기본값, impl-log.md 확정 — 재결정 금지).
 * 정확 수치는 실측 후속이며 v1은 이 보수적 기본값을 쓴다.
 */
export const DEFAULT_TRANSCRIPT_RESIDENCY_CONFIG: TranscriptResidencyConfig = {
  HOT_WINDOW_SEALED_TURNS: 50,
  TOMBSTONE_LRU: 200,
  SEAL_QUIESCENCE_GRACE_MS: 250,
};

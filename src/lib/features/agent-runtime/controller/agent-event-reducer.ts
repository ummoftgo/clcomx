/**
 * Direct Agent Runtime — transcript reducer (순수 함수, 룬 미사용).
 *
 * `applyEvent(prev: TranscriptModel, event: AgentEvent): TranscriptModel`로
 * 04 §3 (upsert/append/replace·Codex reconcile·ACP chunk vs replace·notice dedup)과
 * 04 §3.7 (seal/eviction/3-상태 residency·late-event)을 구현한다.
 *
 * 규칙 정본 = 04, 타입 정본 = 15(`./contracts/normalized`) + 08(`./contracts/transcript`).
 * 이 reducer는 vitest 단위 테스트 대상이며 룬(`$state`)을 쓰지 않는다 — 반응형 표면 갱신은
 * store(`agent-runtime-store.svelte.ts`)가 reducer 결과를 받아 처리한다.
 */

import type { AgentContent, AgentEvent, ProviderRef } from "../contracts/normalized";
import type {
  TranscriptItem,
  TranscriptModel,
  TranscriptResidencyConfig,
  TranscriptTurnState,
} from "../contracts/transcript";
import { DEFAULT_TRANSCRIPT_RESIDENCY_CONFIG } from "../contracts/transcript";

// ─────────────────────────────────────────────────────────────────────────────
// 라우팅 키 / item id 결정 (04 §1)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * turn 라우팅 키(04 §3.4: Codex `(threadId, turnId)`, ACP 합성 `turnId`).
 * turn 정보가 전혀 없으면 세션 단위 단일 turn 버킷(`session:<sessionId>`)으로 떨어뜨려
 * turn id 없는 provider에서도 seal/residency가 동작하게 한다.
 */
export function turnKeyOf(ref: ProviderRef): string {
  if (ref.threadId && ref.turnId) return `${ref.threadId}:${ref.turnId}`;
  if (ref.turnId) return ref.turnId;
  if (ref.threadId) return `${ref.threadId}:_`;
  if (ref.sessionId) return `session:${ref.sessionId}`;
  return "session:_";
}

/**
 * message item id 결정. Codex는 `itemId`, ACP는 `messageId`가 메시지 식별자다(04 §1).
 * channel:"thought"는 동일 식별자 공간에서 별도 스트림이므로 prefix로 분리한다(04 §3.2.2).
 */
function messageItemId(ref: ProviderRef, channel: "response" | "thought"): string | undefined {
  const base = ref.itemId ?? ref.messageId;
  if (base === undefined) return undefined;
  return channel === "thought" ? `thought:${base}` : base;
}

/** tool call item id. ACP `toolCallId` / Codex item id 재사용. */
function toolItemId(ref: ProviderRef): string | undefined {
  return ref.toolCallId ?? ref.itemId;
}

// ─────────────────────────────────────────────────────────────────────────────
// 불변 갱신 헬퍼 (shallow clone — 반응형 표면 식별성 유지)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 다음 모델 작업본을 만든다. plain Map은 얕은 복제(식별성 변경 → store가 변경을 감지),
 * 반응형 표면(visibleItemIds/itemVersions)도 새 배열/객체로 복제한다.
 */
function draft(prev: TranscriptModel): TranscriptModel {
  return {
    visibleItemIds: [...prev.visibleItemIds],
    itemVersions: { ...prev.itemVersions },
    itemsById: new Map(prev.itemsById),
    turnsById: new Map(prev.turnsById),
    tombstones: {
      lru: [...prev.tombstones.lru],
      droppedLateEventCount: prev.tombstones.droppedLateEventCount,
    },
  };
}

/** itemVersions[id] 1 bump(렌더 트리거). */
function bump(model: TranscriptModel, id: string): void {
  model.itemVersions[id] = (model.itemVersions[id] ?? 0) + 1;
}

/** 빈 turn 메타를 생성한다(처음 보는 turn 키). */
function freshTurn(): TranscriptTurnState {
  return {
    residency: "unsealed",
    itemIds: [],
    terminated: false,
    openItemCount: 0,
    pendingRequestCount: 0,
    resealCount: 0,
  };
}

/** turn 메타를 가져오거나 생성한다(tombstone은 그대로 반환 — 호출부가 분기). */
function ensureTurn(model: TranscriptModel, turnKey: string): TranscriptTurnState {
  let turn = model.turnsById.get(turnKey);
  if (!turn) {
    turn = freshTurn();
    model.turnsById.set(turnKey, turn);
  }
  return turn;
}

/**
 * item을 turn에 등록하고 visibleItemIds 순서에 추가한다(신규일 때만).
 * sealed-retained turn에 신규 item이 붙으면 late-event 규칙(§3.7)에 따라 unseal 후 추가한다.
 */
function attachItem(
  model: TranscriptModel,
  turnKey: string,
  item: TranscriptItem,
): void {
  const isNew = !model.itemsById.has(item.id);
  model.itemsById.set(item.id, item);
  if (isNew) {
    model.visibleItemIds.push(item.id);
    const turn = ensureTurn(model, turnKey);
    turn.itemIds.push(item.id);
  }
  bump(model, item.id);
}

// ─────────────────────────────────────────────────────────────────────────────
// late-event 분기 (3-상태 residency, 04 §3.7)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * event를 apply하기 전 residency를 점검한다.
 * - evicted-tombstone: apply 금지 → droppedLateEventCount 증가하고 false 반환(호출부가 즉시 종료).
 * - sealed-retained: unseal(→unsealed) 후 patch 진행. reseal은 grace/quiescence 트리거로 store가 처리.
 * - unsealed/신규: 그대로 진행.
 *
 * @returns apply 가능 여부.
 */
function admitForPatch(model: TranscriptModel, turnKey: string): boolean {
  const turn = model.turnsById.get(turnKey);
  if (!turn) return true; // 신규 turn — 정상 apply
  if (turn.residency === "evicted-tombstone") {
    // tombstone late-event: body 재구성 불가 → drop + 카운터만 증가(silent corruption 방지)
    model.tombstones.droppedLateEventCount += 1;
    return false;
  }
  if (turn.residency === "sealed-retained") {
    // 늦은 same-turn event: unseal → patch → (외부 트리거로) reseal. telemetry 1 증가.
    turn.residency = "unsealed";
    turn.terminated = false; // patch 동안 다시 진행 상태로 본다
    turn.resealCount += 1;
  }
  return true;
}

// ─────────────────────────────────────────────────────────────────────────────
// content 누적 헬퍼
// ─────────────────────────────────────────────────────────────────────────────

/** text content append(같은 message 본문에 텍스트 조각 누적). */
function appendText(content: AgentContent[], delta: string): AgentContent[] {
  const next = [...content];
  const last = next[next.length - 1];
  if (last && last.type === "text") {
    next[next.length - 1] = { type: "text", text: last.text + delta };
  } else {
    next.push({ type: "text", text: delta });
  }
  return next;
}

// ─────────────────────────────────────────────────────────────────────────────
// notice 생성·dedup (04 §3.6)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * notice를 (생성 사유, 라우팅 키) 1쌍당 1건으로 dedup해 append한다.
 * dedup 키를 notice item id로 직접 써서 같은 키의 재emit을 멱등 무시한다.
 */
function appendNotice(
  model: TranscriptModel,
  turnKey: string,
  noticeId: string,
  level: "info" | "warning" | "error",
  messageKey: string,
  raw: unknown,
): void {
  if (model.itemsById.has(noticeId)) return; // 멱등: 동일 (사유,키) notice 1건만
  attachItem(model, turnKey, { type: "notice", id: noticeId, level, messageKey, raw });
}

/** djb2 해시(error notice dedup용 — message 폭주 반복을 1건으로 접음). */
function hashString(input: string): string {
  let h = 5381;
  for (let i = 0; i < input.length; i++) {
    h = ((h << 5) + h + input.charCodeAt(i)) | 0;
  }
  return (h >>> 0).toString(36);
}

// ─────────────────────────────────────────────────────────────────────────────
// 개별 event 처리
// ─────────────────────────────────────────────────────────────────────────────

function applyMessage(
  model: TranscriptModel,
  ev: Extract<AgentEvent, { type: "user_message" | "agent_message" }>,
): void {
  const channel: "response" | "thought" =
    ev.type === "agent_message" ? ev.channel ?? "response" : "response";
  const id = messageItemId(ev.ref, channel);
  if (id === undefined) return;
  const turnKey = turnKeyOf(ev.ref);
  if (!admitForPatch(model, turnKey)) return;

  const role: "user" | "agent" | "reasoning" =
    ev.type === "user_message" ? "user" : channel === "thought" ? "reasoning" : "agent";

  const existing = model.itemsById.get(id);
  const prevContent =
    existing && existing.type === "message" ? existing.content : [];
  // replace = 통째 교체(reconcile 권위), append = 기존 content 뒤에 붙임(§3.1)
  const content = ev.mode === "replace" ? ev.content : [...prevContent, ...ev.content];

  const turn = ensureTurn(model, turnKey);
  // replace(=completed reconcile)는 streaming 종료로 본다 → open item 감소.
  const wasStreaming =
    existing && existing.type === "message" ? existing.streaming : false;
  const streaming = ev.mode !== "replace";
  if (!existing) {
    if (streaming) turn.openItemCount += 1;
  } else if (wasStreaming && !streaming) {
    turn.openItemCount = Math.max(0, turn.openItemCount - 1);
  }

  attachItem(model, turnKey, {
    type: "message",
    id,
    role,
    content,
    streaming,
    collapsed: channel === "thought" ? true : undefined,
    ref: ev.ref,
  });
}

function applyMessageDelta(
  model: TranscriptModel,
  ev: Extract<AgentEvent, { type: "agent_message_delta" }>,
): void {
  const channel = ev.channel ?? "response";
  const id = messageItemId(ev.ref, channel);
  if (id === undefined) return;
  const turnKey = turnKeyOf(ev.ref);
  if (!admitForPatch(model, turnKey)) return;

  const existing = model.itemsById.get(id);
  const prevContent = existing && existing.type === "message" ? existing.content : [];
  const role: "user" | "agent" | "reasoning" =
    channel === "thought" ? "reasoning" : "agent";

  const turn = ensureTurn(model, turnKey);
  if (!existing) turn.openItemCount += 1; // 새 streaming item 시작

  attachItem(model, turnKey, {
    type: "message",
    id,
    role,
    content: appendText(prevContent, ev.delta),
    streaming: true,
    collapsed: channel === "thought" ? true : undefined,
    ref: ev.ref,
  });
}

function applyToolCallUpdated(
  model: TranscriptModel,
  ev: Extract<AgentEvent, { type: "tool_call_updated" }>,
): void {
  const id = toolItemId(ev.ref) ?? ev.update.id;
  const turnKey = turnKeyOf(ev.ref);
  if (!admitForPatch(model, turnKey)) return;

  const existing = model.itemsById.get(id);
  const prevUpdate =
    existing && existing.type === "tool_call" ? existing.update : undefined;
  // 부분 갱신: 바뀐 필드만 온다(15 §5). content/locations는 전체 교체(04 §3.3).
  const merged = prevUpdate ? { ...prevUpdate, ...ev.update } : ev.update;

  const turn = ensureTurn(model, turnKey);
  const wasOpen = prevUpdate
    ? prevUpdate.status === "pending" || prevUpdate.status === "in_progress"
    : false;
  const isOpen = merged.status === "pending" || merged.status === "in_progress";
  if (!existing) {
    if (isOpen) turn.openItemCount += 1;
  } else if (wasOpen && !isOpen) {
    turn.openItemCount = Math.max(0, turn.openItemCount - 1);
  } else if (!wasOpen && isOpen) {
    turn.openItemCount += 1;
  }

  attachItem(model, turnKey, {
    type: "tool_call",
    id,
    update: merged,
    expanded: existing && existing.type === "tool_call" ? existing.expanded : false,
    approval: existing && existing.type === "tool_call" ? existing.approval : undefined,
  });
}

function applyToolContentDelta(
  model: TranscriptModel,
  ev: Extract<AgentEvent, { type: "tool_call_content_delta" }>,
): void {
  const id = toolItemId(ev.ref);
  if (id === undefined) return;
  const turnKey = turnKeyOf(ev.ref);
  if (!admitForPatch(model, turnKey)) return;

  const existing = model.itemsById.get(id);
  if (!existing || existing.type !== "tool_call") return; // tool call 없으면 무시
  const prevContent = existing.update.content ?? [];
  // 비-execute tool content 증분(append 의미, 04 §3.2.3·§3.3)
  attachItem(model, turnKey, {
    ...existing,
    update: { ...existing.update, content: [...prevContent, ev.content] },
  });
}

function applyCommandOutputDelta(
  model: TranscriptModel,
  ev: Extract<AgentEvent, { type: "command_output_delta" }>,
): void {
  const id = toolItemId(ev.ref);
  if (id === undefined) return;
  const turnKey = turnKeyOf(ev.ref);
  if (!admitForPatch(model, turnKey)) return;

  const existing = model.itemsById.get(id);
  if (!existing || existing.type !== "tool_call") return;
  const prevContent = existing.update.content ?? [];
  // execute kind stdout/stderr 전용(04 §3.2.3). stream별로 terminal content에 누적.
  const next = [...prevContent];
  const last = next[next.length - 1];
  if (last && last.type === "terminal") {
    next[next.length - 1] = { type: "terminal", command: last.command, output: last.output + ev.delta };
  } else {
    next.push({ type: "terminal", output: ev.delta });
  }
  attachItem(model, turnKey, {
    ...existing,
    update: { ...existing.update, content: next },
  });
}

function applyPlanUpdated(
  model: TranscriptModel,
  ev: Extract<AgentEvent, { type: "plan_updated" }>,
): void {
  const turnKey = turnKeyOf(ev.ref);
  if (!admitForPatch(model, turnKey)) return;
  // plan은 turn당 1개 항목으로 전체 교체(04 §3.3 replace-only).
  const id = `plan:${turnKey}`;
  attachItem(model, turnKey, { type: "plan", id, entries: ev.entries });
}

function applyFileChange(
  model: TranscriptModel,
  ev: Extract<AgentEvent, { type: "file_change_updated" }>,
): void {
  const turnKey = turnKeyOf(ev.ref);
  if (!admitForPatch(model, turnKey)) return;
  // 같은 itemId의 tool_call diff와 합쳐 렌더되지만(08), 모델에서는 별도 file_change item으로 둔다.
  const id = `file_change:${toolItemId(ev.ref) ?? ev.change.path}`;
  attachItem(model, turnKey, { type: "file_change", id, change: ev.change });
}

function applyTurnCompleted(
  model: TranscriptModel,
  ev: Extract<AgentEvent, { type: "turn_completed" }>,
): void {
  const turnKey = turnKeyOf(ev.ref);
  const turn = model.turnsById.get(turnKey);
  if (turn && turn.residency === "evicted-tombstone") {
    model.tombstones.droppedLateEventCount += 1;
    return;
  }
  const t = ensureTurn(model, turnKey);
  t.terminated = true; // seal 조건 (a) 종료신호

  // notice 생성(04 §3.6 규칙 1): failed 또는 보존된 max_*/refusal stopReason.
  if (ev.status === "failed") {
    appendNotice(model, turnKey, `notice:turn_completed:${turnKey}`, "warning", "agentRuntime.errors.turnFailed", ev.ref.raw);
  } else {
    const stopReason = extractStopReason(ev.ref.raw);
    if (stopReason === "refusal" || stopReason === "max_tokens" || stopReason === "max_turn_requests") {
      const messageKey =
        stopReason === "refusal"
          ? "agentRuntime.errors.refusal"
          : stopReason === "max_tokens"
            ? "agentRuntime.errors.maxTokens"
            : "agentRuntime.errors.maxTurnRequests";
      appendNotice(model, turnKey, `notice:turn_completed:${turnKey}`, "warning", messageKey, ev.ref.raw);
    }
  }
}

/** ProviderRef.raw에 보존된 stopReason을 best-effort로 추출(04 §3.6). */
function extractStopReason(raw: unknown): string | undefined {
  if (raw && typeof raw === "object" && "stopReason" in raw) {
    const v = (raw as { stopReason?: unknown }).stopReason;
    return typeof v === "string" ? v : undefined;
  }
  return undefined;
}

function applyProcessExited(
  model: TranscriptModel,
  ev: Extract<AgentEvent, { type: "process_exited" }>,
): void {
  // 비정상 종료(code != 0 또는 signal)만 error notice(04 §3.6 규칙 2). 세션당 1건.
  const abnormal = (ev.code !== undefined && ev.code !== 0) || ev.signal !== undefined;
  if (!abnormal) return;
  const sessionKey = ev.ref.sessionId ?? "_";
  const turnKey = turnKeyOf(ev.ref);
  appendNotice(
    model,
    turnKey,
    `notice:process_exited:${sessionKey}`,
    "error",
    "agentRuntime.errors.processExited",
    ev.ref.raw,
  );
}

function applyError(
  model: TranscriptModel,
  ev: Extract<AgentEvent, { type: "error" }>,
): void {
  // error notice(04 §3.6 규칙 3). dedup 키 = 라우팅 키 + message 해시(폭주 반복 1건으로 접음).
  const turnKey = turnKeyOf(ev.ref);
  const noticeId = `notice:error:${turnKey}:${hashString(ev.message)}`;
  appendNotice(model, turnKey, noticeId, "error", "agentRuntime.errors.generic", {
    message: ev.message,
    recoverable: ev.recoverable,
    raw: ev.ref.raw,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// applyEvent — reducer 진입점
// ─────────────────────────────────────────────────────────────────────────────

/**
 * transcript event 1개를 모델에 apply한 **새 모델**을 반환한다(순수 함수, prev 비변형).
 * 04 §3.1~§3.7 규칙을 따른다. terminal_output_delta·session_* 등 transcript에 쌓지 않는
 * event는 모델을 그대로(변형 없이) 반환한다 — legacy PTY는 transcript로 끌어올리지 않는다(04 §3.5).
 */
export function applyEvent(prev: TranscriptModel, event: AgentEvent): TranscriptModel {
  switch (event.type) {
    case "user_message":
    case "agent_message": {
      const next = draft(prev);
      applyMessage(next, event);
      return next;
    }
    case "agent_message_delta": {
      const next = draft(prev);
      applyMessageDelta(next, event);
      return next;
    }
    case "tool_call_updated": {
      const next = draft(prev);
      applyToolCallUpdated(next, event);
      return next;
    }
    case "tool_call_content_delta": {
      const next = draft(prev);
      applyToolContentDelta(next, event);
      return next;
    }
    case "command_output_delta": {
      const next = draft(prev);
      applyCommandOutputDelta(next, event);
      return next;
    }
    case "plan_updated": {
      const next = draft(prev);
      applyPlanUpdated(next, event);
      return next;
    }
    case "file_change_updated": {
      const next = draft(prev);
      applyFileChange(next, event);
      return next;
    }
    case "turn_completed": {
      const next = draft(prev);
      applyTurnCompleted(next, event);
      return next;
    }
    case "process_exited": {
      const next = draft(prev);
      applyProcessExited(next, event);
      return next;
    }
    case "error": {
      const next = draft(prev);
      applyError(next, event);
      return next;
    }
    // transcript에 쌓지 않는 event(라우팅·상태는 store/router가 처리).
    case "session_started":
    case "session_loaded":
    case "session_status_changed":
    case "approval_requested":
    case "approval_resolved":
    case "terminal_output_delta":
      return prev;
    default:
      return prev;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// seal / eviction (04 §3.7 — store가 quiescence grace 경과 후 호출)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 빈 transcript 모델을 만든다.
 */
export function createEmptyTranscriptModel(): TranscriptModel {
  return {
    visibleItemIds: [],
    itemVersions: {},
    itemsById: new Map(),
    turnsById: new Map(),
    tombstones: { lru: [], droppedLateEventCount: 0 },
  };
}

/**
 * seal 조건(04 §3.7 (a)~(e))을 점검해 충족 turn을 `unsealed → sealed-retained`로 전이한다.
 * grace((e))는 reducer가 동기 함수라 직접 잴 수 없으므로 store가 quiescence grace 경과 후 호출한다
 * (=호출 자체가 grace 충족 신호). 호출 시 (a)종료신호·(b)open item 0·(c)pending 0을 점검한다.
 * (d)turn-level 슬롯 settle은 v1에서 별도 강제 슬롯이 없으므로 (a)~(c)로 충분하다.
 *
 * @returns seal이 발생했으면 새 모델, 아니면 동일 참조.
 */
export function sealEligibleTurns(prev: TranscriptModel): TranscriptModel {
  let changed = false;
  let next = prev;
  for (const [turnKey, turn] of prev.turnsById) {
    if (turn.residency !== "unsealed") continue;
    if (!turn.terminated) continue;
    if (turn.openItemCount > 0) continue;
    if (turn.pendingRequestCount > 0) continue;
    if (!changed) {
      next = draft(prev);
      changed = true;
    }
    const t = next.turnsById.get(turnKey)!;
    next.turnsById.set(turnKey, { ...t, residency: "sealed-retained" });
  }
  return next;
}

/**
 * hot window cap(최근 N개 sealed-retained turn) 초과 시 가장 오래된 sealed turn body를 evict한다.
 * eviction = body(`itemsById`) 제거 + 메타 인덱스(itemVersions/visibleItemIds) pruning +
 * turnsById를 `evicted-tombstone`으로 전이 + tombstone LRU 추가(04 §3.7 eviction 윈도우).
 * tombstone LRU도 cap을 넘으면 oldest tombstone 메타를 제거한다(bounded).
 *
 * @returns eviction이 발생했으면 새 모델, 아니면 동일 참조.
 */
export function evictOverflow(
  prev: TranscriptModel,
  config: TranscriptResidencyConfig = DEFAULT_TRANSCRIPT_RESIDENCY_CONFIG,
): TranscriptModel {
  // 삽입 순서 = Map iteration 순서이므로 oldest sealed turn이 앞쪽에 온다.
  const sealedKeys: string[] = [];
  for (const [turnKey, turn] of prev.turnsById) {
    if (turn.residency === "sealed-retained") sealedKeys.push(turnKey);
  }
  const overflow = sealedKeys.length - config.HOT_WINDOW_SEALED_TURNS;
  if (overflow <= 0) return prev;

  const next = draft(prev);
  const toEvict = sealedKeys.slice(0, overflow);
  for (const turnKey of toEvict) {
    const turn = next.turnsById.get(turnKey);
    if (!turn) continue;
    // body·메타 pruning
    for (const itemId of turn.itemIds) {
      next.itemsById.delete(itemId);
      delete next.itemVersions[itemId];
      const idx = next.visibleItemIds.indexOf(itemId);
      if (idx !== -1) next.visibleItemIds.splice(idx, 1);
    }
    // tombstone으로 전이(메타만, itemIds는 비움)
    next.turnsById.set(turnKey, {
      residency: "evicted-tombstone",
      itemIds: [],
      terminated: turn.terminated,
      openItemCount: 0,
      pendingRequestCount: 0,
      resealCount: turn.resealCount,
    });
    next.tombstones.lru.push(turnKey);
  }
  // tombstone LRU cap — oldest tombstone 메타 제거(turnsById에서도 삭제)
  while (next.tombstones.lru.length > config.TOMBSTONE_LRU) {
    const dropped = next.tombstones.lru.shift();
    if (dropped !== undefined) next.turnsById.delete(dropped);
  }
  return next;
}

/**
 * patch 후 reseal: late-event로 unseal됐던 turn 중 다시 seal 조건을 만족하는 것을 reseal한다.
 * `sealEligibleTurns`와 동일 규칙이지만 의미상 reseal 경로를 명시한다(telemetry는 unseal 시 이미 기록).
 */
export function resealAfterPatch(prev: TranscriptModel): TranscriptModel {
  return sealEligibleTurns(prev);
}

/** pending approval/request 수를 turn 메타에 반영한다(seal 조건 (c)). store가 호출. */
export function setTurnPending(
  prev: TranscriptModel,
  turnKey: string,
  delta: number,
): TranscriptModel {
  const turn = prev.turnsById.get(turnKey);
  if (!turn) {
    const next = draft(prev);
    const t = freshTurn();
    t.pendingRequestCount = Math.max(0, delta);
    next.turnsById.set(turnKey, t);
    return next;
  }
  const next = draft(prev);
  next.turnsById.set(turnKey, {
    ...turn,
    pendingRequestCount: Math.max(0, turn.pendingRequestCount + delta),
  });
  return next;
}

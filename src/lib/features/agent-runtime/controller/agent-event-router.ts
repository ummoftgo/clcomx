/**
 * Direct Agent Runtime — Event Router + module-level registry (T1.4, 03 §2.3).
 *
 * AgentEvent를 ref 기준 올바른 세션 store로 dispatch한다(id-index 라우팅: itemsById/turnsById는
 * store 내부, router는 sessionHandle 기준 라우팅 + runtimeId↔window 바인딩 소유).
 *
 * **OQ-48(impl-log.md 확정, 재결정 금지)**: registry = 단일 윈도우 소유 + runtimeId↔window 바인딩 +
 * window-close 시 소유 엔트리만 정리 + **cross-window dispatch 금지**. pending request table key =
 * `(sessionHandle, requestId)` 복합 키(store의 PendingApprovalTable이 보유 — 전역 단독 requestId 금지).
 */

import type { AgentEvent } from "../contracts/normalized";
import type { AgentRuntimeStore } from "../state/agent-runtime-store.svelte";

/** registry 엔트리: 한 세션의 store + 소유 window + provider runtime id 바인딩. */
interface RegistryEntry {
  store: AgentRuntimeStore;
  /** 이 runtime을 소유한 window label(OQ-48 단일 윈도우 소유). */
  windowLabel: string;
  /** provider/backend runtime id(runtimeId↔window 바인딩). */
  runtimeId?: string;
}

/**
 * module-level registry. 한 renderer process(=한 window) 안에서 sessionHandle → 세션 store를 매핑한다.
 * 다른 window가 소유한 세션으로는 dispatch하지 않는다(cross-window dispatch 금지, OQ-48).
 */
const registry = new Map<string, RegistryEntry>();

/** runtimeId → sessionHandle 역인덱스(backend event가 runtimeId로 올 때 라우팅). */
const runtimeIdIndex = new Map<string, string>();

/**
 * 세션 store를 registry에 등록한다(이 window 소유). 같은 sessionHandle 재등록은 덮어쓴다.
 * @param windowLabel 소유 window label(OQ-48 바인딩). 기본은 단일 윈도우 가정값.
 */
export function registerSession(
  sessionHandle: string,
  store: AgentRuntimeStore,
  windowLabel = "main",
  runtimeId?: string,
): void {
  registry.set(sessionHandle, { store, windowLabel, runtimeId });
  if (runtimeId !== undefined) runtimeIdIndex.set(runtimeId, sessionHandle);
}

/** runtimeId ↔ sessionHandle 바인딩을 갱신한다(start/resume 완료 후 backend runtime id 확정 시). */
export function bindRuntimeId(sessionHandle: string, runtimeId: string): void {
  const entry = registry.get(sessionHandle);
  if (!entry) return;
  entry.runtimeId = runtimeId;
  runtimeIdIndex.set(runtimeId, sessionHandle);
}

/** sessionHandle로 store 조회(소유 window 안에서만). */
export function getSessionStore(sessionHandle: string): AgentRuntimeStore | undefined {
  return registry.get(sessionHandle)?.store;
}

/** runtimeId로 sessionHandle 조회(backend event 라우팅). */
export function sessionHandleForRuntime(runtimeId: string): string | undefined {
  return runtimeIdIndex.get(runtimeId);
}

/**
 * AgentEvent를 sessionHandle 기준 올바른 store로 dispatch한다.
 * 소유 window가 다르거나 미등록이면 **무시**한다(cross-window dispatch 금지, OQ-48).
 * @returns dispatch 성공 여부.
 */
export function dispatchEvent(sessionHandle: string, event: AgentEvent): boolean {
  const entry = registry.get(sessionHandle);
  if (!entry) return false;
  entry.store.dispatch(event);
  return true;
}

/**
 * window-close 시 그 window가 소유한 세션 엔트리만 정리한다(OQ-48 소유 엔트리만 정리).
 * @returns 정리된 sessionHandle 목록.
 */
export function disposeWindow(windowLabel: string): string[] {
  const disposed: string[] = [];
  for (const [sessionHandle, entry] of registry) {
    if (entry.windowLabel !== windowLabel) continue;
    entry.store.dispose();
    if (entry.runtimeId !== undefined) runtimeIdIndex.delete(entry.runtimeId);
    registry.delete(sessionHandle);
    disposed.push(sessionHandle);
  }
  return disposed;
}

/**
 * 단일 세션 정리(세션 종료/shutdown 완료 후).
 * expectedStore가 있으면 현재 registry entry가 그 store일 때만 정리한다. retry처럼 같은 sessionHandle이
 * 새 controller/store로 재등록된 뒤 오래된 controller의 dispose가 늦게 도착해도 새 entry를 지우지 않는다.
 */
export function unregisterSession(sessionHandle: string, expectedStore?: AgentRuntimeStore): boolean {
  const entry = registry.get(sessionHandle);
  if (!entry) return false;
  if (expectedStore && entry.store !== expectedStore) return false;
  entry.store.dispose();
  if (entry.runtimeId !== undefined) runtimeIdIndex.delete(entry.runtimeId);
  registry.delete(sessionHandle);
  return true;
}

/** 테스트 격리용 — registry 전체 비우기(dispose 호출 없이). */
export function resetRegistry(): void {
  registry.clear();
  runtimeIdIndex.clear();
}

/** 현재 등록된 세션 핸들 수(테스트/진단). */
export function registrySize(): number {
  return registry.size;
}

/**
 * Direct Agent Runtime — bounded transcript 캐시 직렬화(OQ-16).
 * TranscriptModel의 Map을 array로 평탄화해 저장하고, sealed-retained/unsealed turn 본문만·redaction 적용해
 * 재시작 즉시 표시용 read-only 히스토리로 쓴다. 권위 히스토리는 provider replay다(이 캐시는 즉시표시+폴백용).
 */
import type { TranscriptItem, TranscriptModel, TranscriptTurnState } from "../contracts/transcript";
import { redactDisplayText } from "./display-redaction";
import { invoke } from "../../../tauri/core";

/** 파일 저장 가능한 TranscriptModel 스냅샷(schemaVersion으로 호환성 판별). */
export interface TranscriptCacheSnapshot {
  schemaVersion: 1;
  visibleItemIds: string[];
  items: [string, TranscriptItem][];
  turns: [string, TranscriptTurnState][];
}

/**
 * TranscriptModel을 파일 저장 가능한 스냅샷으로 직렬화한다(순수 함수, model 비변형).
 * tombstone(evicted-tombstone) turn은 본문이 이미 evict된 상태이므로 통째로 제외하고,
 * 남는 turn에 속한 item만 표시 redaction을 적용해 담는다.
 */
export function serializeTranscript(model: TranscriptModel): TranscriptCacheSnapshot {
  const turns: [string, TranscriptTurnState][] = [];
  const keepItemIds = new Set<string>();
  for (const [turnId, turn] of model.turnsById) {
    if (turn.residency === "evicted-tombstone") continue; // 본문 없는 tombstone 제외
    turns.push([turnId, { ...turn, itemIds: [...turn.itemIds] }]);
    for (const id of turn.itemIds) keepItemIds.add(id);
  }
  const items: [string, TranscriptItem][] = [];
  for (const [id, item] of model.itemsById) {
    if (!keepItemIds.has(id)) continue;
    items.push([id, redactItem(item)]);
  }
  const visibleItemIds = model.visibleItemIds.filter((id) => keepItemIds.has(id));
  return { schemaVersion: 1, visibleItemIds, items, turns };
}

/**
 * 저장된 스냅샷을 array→Map으로 복원해 read-only 표시용 TranscriptModel을 만든다(순수 함수).
 * schemaVersion이 1이 아니면(손상/구버전) null을 반환해 호출자가 캐시를 무시하고 폴백하게 한다.
 * itemVersions/tombstones는 store가 syncReactiveSurface로 다시 채우므로 빈 상태로 복원한다.
 */
export function deserializeTranscript(snap: TranscriptCacheSnapshot): TranscriptModel | null {
  if (!snap || snap.schemaVersion !== 1) return null;
  return {
    visibleItemIds: [...snap.visibleItemIds],
    itemVersions: {},
    itemsById: new Map(snap.items),
    turnsById: new Map(snap.turns),
    tombstones: { lru: [], droppedLateEventCount: 0 },
  };
}

/** item을 deep clone한 뒤 표시 문자열류 필드에 redaction을 적용한다(구조는 보존). */
function redactItem(item: TranscriptItem): TranscriptItem {
  const clone = structuredClone(item);
  redactStringsDeep(clone);
  return clone;
}

/** object 그래프를 재귀 순회하며 string 값을 표시 redaction으로 치환한다(제자리 수정). */
function redactStringsDeep(value: unknown): void {
  if (!value || typeof value !== "object") return;
  const record = value as Record<string, unknown>;
  for (const [key, val] of Object.entries(record)) {
    if (typeof val === "string") {
      record[key] = redactDisplayText(val);
    } else if (val && typeof val === "object") {
      redactStringsDeep(val);
    }
  }
}

/** scrub된 스냅샷을 저장한다. */
export function saveTranscriptCache(
  sessionHandle: string,
  snapshot: TranscriptCacheSnapshot,
): Promise<void> {
  return invoke("agent_runtime_save_transcript_cache", { sessionHandle, json: JSON.stringify(snapshot) });
}

/** 저장된 스냅샷을 로드한다. 없음/파싱 실패 → null. */
export async function loadTranscriptCache(sessionHandle: string): Promise<TranscriptCacheSnapshot | null> {
  const json = await invoke<string | null>("agent_runtime_load_transcript_cache", { sessionHandle });
  if (!json) return null;
  try {
    return JSON.parse(json) as TranscriptCacheSnapshot;
  } catch {
    return null;
  }
}

/** 캐시 파일을 삭제한다. */
export function clearTranscriptCache(sessionHandle: string): Promise<void> {
  return invoke("agent_runtime_clear_transcript_cache", { sessionHandle });
}

/**
 * Direct Agent Runtime — 격리 scrollback replay 조회(read-only history inspection, T5.6).
 *
 * 정본: `docs/plans/agent-direct-runtime/10-persistence-migration.md` §4.7, `08-ui-composition.md` §7.2.
 *
 * evicted-tombstone 구간을 사용자가 명시적으로 열 때만(자동 아님) 동작하는 read-only 조회 경로다.
 * provider replay(ACP `session/load`, Codex `thread/read(includeTurns)`)를 **별도 scratch 세션**으로
 * 1회 돌려 해당 구간을 조회하고, 결과를 **별도 scratch TranscriptModel**에 담아 read-only 인스펙션으로만
 * 보여준다. live store에 **병합하지 않으며**(복원/캐시 아님), 뷰를 닫으면 scratch를 폐기한다.
 *
 * **경계 주의**(10 §4.7): 복원(restore)·full transcript cache·디스크 영속이 아니다. running 세션과
 * 비충돌이며 sendPrompt/respondApproval을 노출하지 않는다(read-only).
 *
 * **OQ-54 미결**: `thread/read`의 `includeTurns`가 gap-only인지 전체 snapshot인지 미확정이라
 * 조회 범위·실제 wire 호출은 후속이다. 본 모듈은 그 경계를 추상화한 read-only loader 인터페이스를
 * 제공하고, v1 기본 구현은 빈 결과(조회 불가/없음)를 돌려주는 안전한 최소 구현이다(mock 가능).
 */

import type { AgentEvent } from "../contracts/normalized";
import type { TranscriptModel } from "../contracts/transcript";
import {
  applyEvent,
  createEmptyTranscriptModel,
} from "../controller/agent-event-reducer";

/** replay 조회 결과(격리 read-only). */
export interface ReplayResult {
  /** 조회로 채운 격리 scratch transcript(live와 분리). */
  transcript: TranscriptModel;
  /** 조회된 event 수(0이면 표시할 이전 기록 없음). */
  eventCount: number;
}

/**
 * read-only replay loader. 격리 scratch 세션을 통해 evicted 구간 event를 조회한다.
 * 실제 구현은 transport(`session/load`·`thread/read`) 경유이며 OQ-54 확정 후 채운다.
 * 반환 event들은 reducer로 scratch TranscriptModel에 적용된다(live 미병합).
 */
export interface ReplayLoader {
  /** evicted 이전 기록 구간을 read-only로 조회 가능한지. false면 "사용 불가" notice(10 §4.7). */
  canLoad(): boolean;
  /** evicted 구간 event를 read-only로 조회한다(scratch 세션 1회). 폐기는 호출부가 dispose로. */
  loadHistory(): Promise<AgentEvent[]>;
  /** scratch 세션 폐기(뷰 닫을 때). */
  dispose(): Promise<void>;
}

/**
 * loader가 돌려준 event들을 격리 scratch TranscriptModel로 reduce한다(live store와 완전 분리).
 * reducer는 순수 함수이므로 동일 경로로 안전하게 read-only 모델을 만든다.
 */
export async function loadReplayTranscript(
  loader: ReplayLoader,
): Promise<ReplayResult> {
  if (!loader.canLoad()) {
    return { transcript: createEmptyTranscriptModel(), eventCount: 0 };
  }
  const events = await loader.loadHistory();
  let model = createEmptyTranscriptModel();
  for (const ev of events) {
    model = applyEvent(model, ev);
  }
  return { transcript: model, eventCount: events.length };
}

/**
 * v1 기본 loader — OQ-54 미결로 실제 wire 조회를 하지 않는 안전한 최소 구현.
 * `canLoad`는 주입된 능력 플래그를 그대로 따르고, 조회는 빈 결과를 돌려준다(표시할 이전 기록 없음).
 * 실제 `session/load`·`thread/read` 경유 구현으로 교체될 자리다(transport 주입 지점).
 */
export function createDefaultReplayLoader(options: {
  canLoad: boolean;
}): ReplayLoader {
  return {
    canLoad: () => options.canLoad,
    loadHistory: async () => [],
    dispose: async () => {
      // scratch 세션 폐기 — v1 기본 구현은 외부 자원이 없어 no-op.
    },
  };
}

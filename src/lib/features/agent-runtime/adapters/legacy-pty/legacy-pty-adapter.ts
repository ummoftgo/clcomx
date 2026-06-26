/**
 * Direct Agent Runtime — legacy PTY adapter (T1.5, 04 §3.5).
 *
 * 기존 PTY output을 `terminal_output_delta` AgentEvent(15 §3)로 감싸는 얇은 어댑터.
 * **transcript 모델로 끌어올리지 않는다** — reducer는 terminal_output_delta를 모델 불변으로 둔다(04 §3.5).
 * UI는 이 event를 legacy/fallback terminal surface에만 렌더한다.
 */

import type { AgentEvent, ProviderRef } from "../../contracts/normalized";

/** PTY 출력 1조각(기존 PTY transport가 올리는 형태). */
export interface LegacyPtyChunk {
  ptyId: number;
  /** PTY byte stream의 단조 증가 seq(transcript late-attach 신뢰성, 15 §8.3). */
  seq: number;
  /** 디코드된 출력 텍스트 조각. */
  delta: string;
}

/**
 * legacy PTY 출력을 `terminal_output_delta` event로 감싼다(04 §3.5).
 * ref.provider는 항상 "legacy-pty"이며 sessionId(=세션 핸들)만 보존한다.
 */
export function wrapLegacyPtyChunk(sessionId: string, chunk: LegacyPtyChunk): AgentEvent {
  const ref: ProviderRef = {
    provider: "legacy-pty",
    sessionId,
  };
  return {
    type: "terminal_output_delta",
    ref,
    ptyId: chunk.ptyId,
    seq: chunk.seq,
    delta: chunk.delta,
  };
}

/**
 * legacy PTY adapter. 상태 없는 얇은 변환기 — PTY chunk를 terminal_output_delta로 매핑만 한다.
 */
export class LegacyPtyAdapter {
  constructor(private readonly sessionId: string) {}

  /** PTY chunk 1개 → terminal_output_delta event 1개(transcript 미반영). */
  ingest(chunk: LegacyPtyChunk): AgentEvent {
    return wrapLegacyPtyChunk(this.sessionId, chunk);
  }
}

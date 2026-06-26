/**
 * Direct Agent Runtime — adapter fixture replay harness(11 §1.2, test util).
 *
 * fixture(NDJSON `{direction,message}` envelope)를 줄 단위로 읽어 `direction:"in"` 메시지를
 * adapter에 흘리고, 생성된 AgentEvent[]를 모은다. mapping 회귀의 1차 방어선.
 */

import type { AgentEvent } from "../contracts/normalized";
import type { JsonRpcMessage } from "../service/transport";

/** 재생 대상 adapter(순수 함수형 변환기). */
export interface AdapterUnderTest {
  /** wire 메시지 1개 → 이번 입력으로 생성된 AgentEvent[]. */
  ingest(message: JsonRpcMessage): AgentEvent[];
  /** 아웃바운드(approval 응답 등) 캡처용. */
  drainOutbound(): JsonRpcMessage[];
}

/** fixture 한 줄 = {direction,message} envelope(12 §T0.5 포맷 정본). */
export interface FixtureLine {
  direction: "in" | "out";
  message: JsonRpcMessage;
}

/**
 * NDJSON fixture 본문(문자열)을 FixtureLine[]로 파싱한다(빈 줄 제외).
 * 파일 I/O(node fs)에 의존하지 않도록 본문 문자열을 받는다(Vite `?raw` import로 로드).
 */
export function parseFixture(jsonlText: string): FixtureLine[] {
  return jsonlText
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((line) => JSON.parse(line) as FixtureLine);
}

/** fixture 본문의 `direction:"in"` 메시지를 순서대로 adapter에 흘려 AgentEvent[]를 모은다. */
export function replayFixture(adapter: AdapterUnderTest, jsonlText: string): AgentEvent[] {
  const events: AgentEvent[] = [];
  for (const { direction, message } of parseFixture(jsonlText)) {
    if (direction !== "in") continue; // out은 outbound 기대 비교용; ingest엔 in만
    events.push(...adapter.ingest(message));
  }
  return events;
}

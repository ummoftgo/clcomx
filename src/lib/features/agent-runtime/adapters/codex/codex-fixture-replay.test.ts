/**
 * Codex fixture replay 테스트(11 §1, FR-CX-1..4). NDJSON {direction,message} → AgentEvent[].
 * mapper를 AdapterUnderTest로 감싸 replay하고 *.expected.json과 비교한다.
 * fixture 본문은 Vite `?raw` glob import로 로드한다(node fs 비의존).
 */
import { describe, expect, it } from "vitest";
import type { AgentEvent } from "../../contracts/normalized";
import type { JsonRpcMessage } from "../../service/transport";
import { CodexRouting } from "./codex-routing";
import { mapCodexMessage } from "./codex-wire-mapper";
import { replayFixture, type AdapterUnderTest } from "../replay-harness";

// fixture 본문(.jsonl)과 기대(.expected.json)를 빌드타임에 로드.
const jsonlFiles = import.meta.glob("../__fixtures__/codex/*.jsonl", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;
const expectedFiles = import.meta.glob("../__fixtures__/codex/*.expected.json", {
  import: "default",
  eager: true,
}) as Record<string, AgentEvent[]>;

/** glob 키에서 fixture 이름(확장자 제외) 추출. */
function baseName(path: string): string {
  return path.replace(/^.*\//, "").replace(/\.(jsonl|expected\.json)$/, "");
}

/** mapper 기반 AdapterUnderTest(routing 상태 1개 보유). */
function makeMapperAdapter(): AdapterUnderTest {
  const routing = new CodexRouting();
  return {
    ingest(message: JsonRpcMessage): AgentEvent[] {
      return mapCodexMessage(message, routing);
    },
    drainOutbound(): JsonRpcMessage[] {
      return [];
    },
  };
}

/** 이름 → {jsonl 본문, expected} 매핑. */
const fixtures = new Map<string, { jsonl: string; expected?: AgentEvent[] }>();
for (const [path, text] of Object.entries(jsonlFiles)) {
  fixtures.set(baseName(path), { jsonl: text });
}
for (const [path, expected] of Object.entries(expectedFiles)) {
  const name = baseName(path);
  const cur = fixtures.get(name);
  if (cur) cur.expected = expected;
}

describe("codex fixture replay (FR-CX-1..4)", () => {
  for (const [name, { jsonl, expected }] of fixtures) {
    it(`${name} → expected AgentEvent[]`, () => {
      const events = replayFixture(makeMapperAdapter(), jsonl);
      expect(expected, `missing ${name}.expected.json`).toBeDefined();
      expect(events).toEqual(expected);
    });
  }

  it("FR-CX-4: interleaved two turns keep separate triple-key refs", () => {
    const events = replayFixture(makeMapperAdapter(), fixtures.get("interleaved-two-turns")!.jsonl);
    const aEvents = events.filter((e) => e.ref.threadId === "A");
    const bEvents = events.filter((e) => e.ref.threadId === "B");
    expect(aEvents.every((e) => e.ref.turnId === "t1" && (e.ref.itemId === "iA" || e.ref.itemId === undefined))).toBe(true);
    expect(bEvents.every((e) => e.ref.turnId === "t2" && (e.ref.itemId === "iB" || e.ref.itemId === undefined))).toBe(true);
  });

  it("FR-CX-3: command-exec-approval preserves requestId '7' in approval_requested", () => {
    const events = replayFixture(makeMapperAdapter(), fixtures.get("command-exec-approval")!.jsonl);
    const approval = events.find((e) => e.type === "approval_requested") as Extract<AgentEvent, { type: "approval_requested" }>;
    expect(approval.ref.requestId).toBe("7");
    expect(approval.request.id).toBe("7");
  });
});

import { describe, expect, it } from "vitest";
import { serializeTranscript, deserializeTranscript } from "./transcript-cache";
import { createEmptyTranscriptModel, applyEvent } from "../controller/agent-event-reducer";
import type { TranscriptItem, TranscriptModel, TranscriptTurnState } from "../contracts/transcript";

describe("transcript-cache 직렬화", () => {
  it("Map↔array 왕복 + visibleItemIds 보존", () => {
    let m = createEmptyTranscriptModel();
    m = applyEvent(m, {
      type: "session_started",
      ref: { provider: "codex", threadId: "A", turnId: "t1" },
      cwd: "/w",
    });
    m = applyEvent(m, {
      type: "agent_message_delta",
      ref: { provider: "codex", threadId: "A", turnId: "t1", itemId: "i1" },
      delta: "hello",
    });
    const snap = serializeTranscript(m);
    expect(snap.schemaVersion).toBe(1);
    const back = deserializeTranscript(snap);
    expect(back).not.toBeNull();
    expect([...back!.itemsById.keys()]).toContain("i1");
    expect(back!.visibleItemIds).toEqual(m.visibleItemIds);
  });

  it("schemaVersion 불일치는 null(무시)", () => {
    expect(deserializeTranscript({ schemaVersion: 99 as 1, visibleItemIds: [], items: [], turns: [] })).toBeNull();
  });

  it("tombstone 강등 turn 본문은 직렬화에서 제외", () => {
    // residency==='evicted-tombstone' turn의 item은 snap.items/turns/visibleItemIds에서 모두 제외되어야 한다.
    const ghostItem: TranscriptItem = {
      type: "message",
      id: "ghost",
      role: "agent",
      content: [{ type: "text", text: "gone" }],
      streaming: false,
      ref: { provider: "codex", threadId: "A", turnId: "t0" },
    };
    const keepItem: TranscriptItem = {
      type: "message",
      id: "keep",
      role: "agent",
      content: [{ type: "text", text: "still here" }],
      streaming: false,
      ref: { provider: "codex", threadId: "A", turnId: "t1" },
    };
    const tombstoneTurn: TranscriptTurnState = {
      residency: "evicted-tombstone",
      itemIds: ["ghost"],
      terminated: true,
      openItemCount: 0,
      pendingRequestCount: 0,
      resealCount: 0,
    };
    const sealedTurn: TranscriptTurnState = {
      residency: "sealed-retained",
      itemIds: ["keep"],
      terminated: true,
      openItemCount: 0,
      pendingRequestCount: 0,
      resealCount: 0,
    };
    const model: TranscriptModel = {
      visibleItemIds: ["ghost", "keep"],
      itemVersions: { ghost: 1, keep: 1 },
      itemsById: new Map([
        ["ghost", ghostItem],
        ["keep", keepItem],
      ]),
      turnsById: new Map([
        ["t0", tombstoneTurn],
        ["t1", sealedTurn],
      ]),
      tombstones: { lru: ["t0"], droppedLateEventCount: 0 },
    };

    const snap = serializeTranscript(model);

    const itemKeys = snap.items.map(([id]) => id);
    expect(itemKeys).toContain("keep");
    expect(itemKeys).not.toContain("ghost");

    const turnKeys = snap.turns.map(([id]) => id);
    expect(turnKeys).toContain("t1");
    expect(turnKeys).not.toContain("t0");

    expect(snap.visibleItemIds).toContain("keep");
    expect(snap.visibleItemIds).not.toContain("ghost");
  });
});

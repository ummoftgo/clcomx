/**
 * legacy-pty-adapter 단위 테스트 — 04 §3.5 (11 §2: legacy PTY 호환, transcript 미반영).
 */
import { describe, expect, it } from "vitest";
import { applyEvent, createEmptyTranscriptModel } from "../../controller/agent-event-reducer";
import { LegacyPtyAdapter, wrapLegacyPtyChunk } from "./legacy-pty-adapter";

describe("legacy-pty-adapter", () => {
  it("wraps PTY chunk into terminal_output_delta event", () => {
    const ev = wrapLegacyPtyChunk("sess-1", { ptyId: 3, seq: 42, delta: "hello" });
    expect(ev).toEqual({
      type: "terminal_output_delta",
      ref: { provider: "legacy-pty", sessionId: "sess-1" },
      ptyId: 3,
      seq: 42,
      delta: "hello",
    });
  });

  it("adapter.ingest produces terminal_output_delta", () => {
    const adapter = new LegacyPtyAdapter("sess-1");
    const ev = adapter.ingest({ ptyId: 1, seq: 0, delta: "$ ls" });
    expect(ev.type).toBe("terminal_output_delta");
  });

  it("terminal_output_delta is NOT lifted into transcript model (04 §3.5)", () => {
    const adapter = new LegacyPtyAdapter("sess-1");
    const model = createEmptyTranscriptModel();
    const next = applyEvent(model, adapter.ingest({ ptyId: 1, seq: 0, delta: "out" }));
    expect(next).toBe(model); // 불변(동일 참조)
    expect(next.visibleItemIds).toHaveLength(0);
    expect(next.itemsById.size).toBe(0);
  });
});

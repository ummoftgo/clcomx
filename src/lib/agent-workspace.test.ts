import { describe, expect, it } from "vitest";
import {
  appendActivityEvent,
  buildActivitySeed,
  detectRuntimeAgentId,
  normalizeActivityText,
  summarizeActivityText,
} from "./agent-workspace";
import type { ActivityEvent } from "./types";

describe("agent workspace helpers", () => {
  it("normalizes ansi sequences and backspaces from terminal output", () => {
    expect(normalizeActivityText("\u001b[31mError\u001b[0m!\b?\r\n")).toBe("Error?\n");
  });

  it("builds a snapshot seed without duplicating screen text already present in history", () => {
    expect(buildActivitySeed("one\ntwo\nthree", "two\nthree")).toBe("one\ntwo\nthree");
  });

  it("merges consecutive output events for the same node", () => {
    const events: ActivityEvent[] = [];
    appendActivityEvent(events, "session-1", "node-1", "output", "alpha\n", 1000);
    appendActivityEvent(events, "session-1", "node-1", "output", "beta\n", 1500);

    expect(events).toHaveLength(1);
    expect(events[0].text).toBe("alpha\nbeta\n");
  });

  it("summarizes the latest meaningful line", () => {
    expect(summarizeActivityText("\nfirst\nsecond\n", "idle")).toBe("second");
  });

  it("detects known runtime agents from command text", () => {
    expect(detectRuntimeAgentId("claude", "codex")).toBe("claude");
    expect(detectRuntimeAgentId("codex resume", "claude")).toBe("codex");
    expect(detectRuntimeAgentId("bash", "claude")).toBe("claude");
  });
});

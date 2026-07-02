import { describe, expect, it } from "vitest";
import { analyzeRawProtocolDebugLog } from "./debug-log-analyzer";

describe("debug-log-analyzer — OQ-53 same-turn late notification probe", () => {
  it("detects a Codex notification that arrives after turn/completed for the same turn", () => {
    const log = [
      debugEntry(1, "in", {
        method: "turn/completed",
        params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed" } },
      }),
      debugEntry(2, "in", {
        method: "item/completed",
        params: { threadId: "thread-1", turnId: "turn-1", itemId: "item-1" },
      }),
    ].join("\n");

    const analysis = analyzeRawProtocolDebugLog(log);
    expect(analysis.terminalMarkers).toEqual([
      {
        provider: "codex",
        turnKey: "codex:thread-1:turn-1",
        terminalSeq: 1,
        terminalMethod: "turn/completed",
      },
    ]);
    expect(analysis.lateEvents).toEqual([
      {
        provider: "codex",
        turnKey: "codex:thread-1:turn-1",
        terminalSeq: 1,
        terminalMethod: "turn/completed",
        lateSeq: 2,
        lateMethod: "item/completed",
      },
    ]);
  });

  it("does not fabricate same-turn evidence when inbound entries are missing reader seq", () => {
    const log = [
      debugEntry(undefined, "in", {
        method: "turn/completed",
        params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed" } },
      }),
      debugEntry(undefined, "in", {
        method: "item/completed",
        params: { threadId: "thread-1", turnId: "turn-1", itemId: "item-1" },
      }),
    ].join("\n");

    expect(analyzeRawProtocolDebugLog(log).lateEvents).toEqual([]);
  });

  it("detects an ACP session/update that arrives after a session/prompt stopReason response", () => {
    const log = [
      debugEntry(undefined, "out", {
        id: 7,
        method: "session/prompt",
        params: { sessionId: "sess-1", prompt: [] },
      }),
      debugEntry(1, "in", {
        method: "session/update",
        params: { sessionId: "sess-1", update: { sessionUpdate: "agent_message_chunk" } },
      }),
      debugEntry(2, "in", { id: 7, result: { stopReason: "end_turn" } }),
      debugEntry(3, "in", {
        method: "session/update",
        params: { sessionId: "sess-1", update: { sessionUpdate: "plan_update" } },
      }),
    ].join("\n");

    const analysis = analyzeRawProtocolDebugLog(log);
    expect(analysis.terminalMarkers).toEqual([
      {
        provider: "claude-acp",
        turnKey: "claude-acp:sess-1:request:7",
        terminalSeq: 2,
        terminalMethod: "session/prompt:response",
      },
    ]);
    expect(analysis.lateEvents).toEqual([
      {
        provider: "claude-acp",
        turnKey: "claude-acp:sess-1:request:7",
        terminalSeq: 2,
        terminalMethod: "session/prompt:response",
        lateSeq: 3,
        lateMethod: "session/update:plan_update",
      },
    ]);
  });
});

function debugEntry(seq: number | undefined, direction: "in" | "out", line: unknown): string {
  return JSON.stringify({
    runtimeId: 1,
    direction,
    line: JSON.stringify(line),
    ...(seq === undefined ? {} : { seq }),
  });
}

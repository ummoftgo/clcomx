/**
 * runtime-replay 테스트(T5.6) — 격리 scratch reduce·canLoad 게이팅·live 미병합(10 §4.7).
 */

import { describe, expect, it } from "vitest";
import type { AgentEvent } from "../contracts/normalized";
import {
  createDefaultReplayLoader,
  loadReplayTranscript,
  type ReplayLoader,
} from "./runtime-replay";

function loaderWith(events: AgentEvent[], canLoad = true): ReplayLoader {
  return {
    canLoad: () => canLoad,
    loadHistory: async () => events,
    dispose: async () => {},
  };
}

describe("runtime-replay", () => {
  it("returns an empty result when canLoad is false (no scratch session)", async () => {
    const result = await loadReplayTranscript(loaderWith([], false));
    expect(result.eventCount).toBe(0);
    expect(result.transcript.visibleItemIds).toEqual([]);
  });

  it("reduces loaded events into an isolated scratch transcript", async () => {
    const events: AgentEvent[] = [
      {
        type: "user_message",
        ref: { provider: "codex", threadId: "t", turnId: "u", itemId: "m1" },
        content: [{ type: "text", text: "old" }],
        mode: "replace",
      },
    ];
    const result = await loadReplayTranscript(loaderWith(events));
    expect(result.eventCount).toBe(1);
    expect(result.transcript.visibleItemIds.length).toBe(1);
    const item = result.transcript.itemsById.get(
      result.transcript.visibleItemIds[0],
    );
    expect(item?.type).toBe("message");
  });

  it("default loader performs no wire query (OQ-54 minimal) and disposes cleanly", async () => {
    const loader = createDefaultReplayLoader({ canLoad: true });
    expect(loader.canLoad()).toBe(true);
    expect(await loader.loadHistory()).toEqual([]);
    await expect(loader.dispose()).resolves.toBeUndefined();
  });
});

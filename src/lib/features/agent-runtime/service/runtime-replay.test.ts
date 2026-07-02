/**
 * runtime-replay 테스트(T5.6) — 격리 scratch reduce·canLoad 게이팅·live 미병합(10 §4.7).
 */

import { describe, expect, it, vi } from "vitest";
import type { AgentEvent } from "../contracts/normalized";
import {
  createPortReplayLoader,
  createDefaultReplayLoader,
  loadReplayTranscript,
  type ReplayLoader,
} from "./runtime-replay";
import type { AgentRuntimePort } from "../contracts/runtime-port";

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

  it("caps loaded replay events before reducing a full provider snapshot", async () => {
    const events: AgentEvent[] = [
      {
        type: "agent_message",
        ref: { provider: "codex", threadId: "t", turnId: "u1", itemId: "m1" },
        content: [{ type: "text", text: "old-1" }],
        mode: "replace",
      },
      {
        type: "agent_message",
        ref: { provider: "codex", threadId: "t", turnId: "u2", itemId: "m2" },
        content: [{ type: "text", text: "old-2" }],
        mode: "replace",
      },
      {
        type: "agent_message",
        ref: { provider: "codex", threadId: "t", turnId: "u3", itemId: "m3" },
        content: [{ type: "text", text: "old-3" }],
        mode: "replace",
      },
    ];

    const result = await loadReplayTranscript(loaderWith(events), {
      maxEvents: 2,
    });

    expect(result.eventCount).toBe(2);
    expect(result.truncated).toBe(true);
    expect(result.transcript.visibleItemIds).toHaveLength(2);
    expect(
      Array.from(result.transcript.itemsById.values()).some((item) =>
        item.type === "message" &&
        item.content.some((part) => part.type === "text" && part.text === "old-3"),
      ),
    ).toBe(false);
  });

  it("no-op loader performs no wire query and disposes cleanly", async () => {
    const loader = createDefaultReplayLoader({ canLoad: true });
    expect(loader.canLoad()).toBe(true);
    expect(await loader.loadHistory()).toEqual([]);
    await expect(loader.dispose()).resolves.toBeUndefined();
  });

  it("creates a scratch replay session through the provider port and shuts it down on dispose", async () => {
    const events: AgentEvent[] = [
      {
        type: "agent_message",
        ref: { provider: "codex", threadId: "thread-1", turnId: "archived-turn", itemId: "archived-item" },
        content: [{ type: "text", text: "archived from provider replay" }],
        mode: "replace",
      },
    ];
    let listener: ((event: AgentEvent) => void) | null = null;
    const port: AgentRuntimePort = {
      startSession: vi.fn(),
      resumeSession: vi.fn().mockImplementation(async () => {
        for (const event of events) listener?.(event);
        return { ref: { provider: "codex", threadId: "thread-1" } };
      }),
      sendPrompt: vi.fn(),
      cancelTurn: vi.fn(),
      respondApproval: vi.fn(),
      subscribeEvents: vi.fn((_sessionHandle, next) => {
        listener = next;
        return vi.fn();
      }),
      shutdown: vi.fn().mockResolvedValue(undefined),
    };

    const loader = createPortReplayLoader({
      canLoad: true,
      createPort: () => port,
      runtimeKind: "direct-codex",
      sessionHandle: "live-session",
      distro: "Ubuntu",
      workDir: "/workspace",
      metadata: {
        sessionRuntimeKind: "direct-codex",
        provider: "codex",
        providerThreadId: "thread-1",
        canLoad: true,
      },
    });

    expect(loader.canLoad()).toBe(true);
    expect(await loader.loadHistory()).toEqual(events);
    expect(port.resumeSession).toHaveBeenCalledWith({
      sessionHandle: "live-session:replay",
      provider: "codex",
      distro: "Ubuntu",
      workDir: "/workspace",
      providerSessionId: undefined,
      providerThreadId: "thread-1",
      replay: true,
    });

    await loader.dispose();

    expect(port.shutdown).toHaveBeenCalledWith("live-session:replay");
  });

  it("caps provider port replay collection before returning a snapshot", async () => {
    const events: AgentEvent[] = [
      {
        type: "agent_message",
        ref: { provider: "codex", threadId: "thread-1", turnId: "archived-1", itemId: "archived-item-1" },
        content: [{ type: "text", text: "archived replay 1" }],
        mode: "replace",
      },
      {
        type: "agent_message",
        ref: { provider: "codex", threadId: "thread-1", turnId: "archived-2", itemId: "archived-item-2" },
        content: [{ type: "text", text: "archived replay 2" }],
        mode: "replace",
      },
      {
        type: "agent_message",
        ref: { provider: "codex", threadId: "thread-1", turnId: "archived-3", itemId: "archived-item-3" },
        content: [{ type: "text", text: "archived replay 3" }],
        mode: "replace",
      },
    ];
    let listener: ((event: AgentEvent) => void) | null = null;
    const port: AgentRuntimePort = {
      startSession: vi.fn(),
      resumeSession: vi.fn().mockImplementation(async () => {
        for (const event of events) listener?.(event);
        return { ref: { provider: "codex", threadId: "thread-1" } };
      }),
      sendPrompt: vi.fn(),
      cancelTurn: vi.fn(),
      respondApproval: vi.fn(),
      subscribeEvents: vi.fn((_sessionHandle, next) => {
        listener = next;
        return vi.fn();
      }),
      shutdown: vi.fn().mockResolvedValue(undefined),
    };

    const loader = createPortReplayLoader({
      canLoad: true,
      createPort: () => port,
      runtimeKind: "direct-codex",
      sessionHandle: "live-session",
      distro: "Ubuntu",
      workDir: "/workspace",
      maxEvents: 2,
      metadata: {
        sessionRuntimeKind: "direct-codex",
        provider: "codex",
        providerThreadId: "thread-1",
        canLoad: true,
      },
    });

    expect(await loader.loadHistory()).toEqual(events.slice(0, 2));
  });

  it("does not reopen or reuse scratch replay after dispose", async () => {
    const events: AgentEvent[] = [
      {
        type: "agent_message",
        ref: { provider: "codex", threadId: "thread-1", turnId: "archived-turn", itemId: "archived-item" },
        content: [{ type: "text", text: "archived from provider replay" }],
        mode: "replace",
      },
    ];
    let listener: ((event: AgentEvent) => void) | null = null;
    const port: AgentRuntimePort = {
      startSession: vi.fn(),
      resumeSession: vi.fn().mockImplementation(async () => {
        for (const event of events) listener?.(event);
        return { ref: { provider: "codex", threadId: "thread-1" } };
      }),
      sendPrompt: vi.fn(),
      cancelTurn: vi.fn(),
      respondApproval: vi.fn(),
      subscribeEvents: vi.fn((_sessionHandle, next) => {
        listener = next;
        return vi.fn();
      }),
      shutdown: vi.fn().mockResolvedValue(undefined),
    };
    const createPort = vi.fn(() => port);

    const loader = createPortReplayLoader({
      canLoad: true,
      createPort,
      runtimeKind: "direct-codex",
      sessionHandle: "live-session",
      distro: "Ubuntu",
      workDir: "/workspace",
      metadata: {
        sessionRuntimeKind: "direct-codex",
        provider: "codex",
        providerThreadId: "thread-1",
        canLoad: true,
      },
    });

    expect(await loader.loadHistory()).toEqual(events);
    await loader.dispose();
    expect(await loader.loadHistory()).toEqual([]);

    expect(createPort).toHaveBeenCalledTimes(1);
    expect(port.shutdown).toHaveBeenCalledTimes(1);
  });

  it("does not expose in-flight replay events after dispose wins the race", async () => {
    const events: AgentEvent[] = [
      {
        type: "agent_message",
        ref: { provider: "codex", threadId: "thread-1", turnId: "archived-turn", itemId: "archived-item" },
        content: [{ type: "text", text: "late archived replay" }],
        mode: "replace",
      },
    ];
    let listener: ((event: AgentEvent) => void) | null = null;
    const resumeControl: { finish?: () => void } = {};
    const port: AgentRuntimePort = {
      startSession: vi.fn(),
      resumeSession: vi.fn().mockImplementation(
        () =>
          new Promise((resolve) => {
            resumeControl.finish = () => {
              for (const event of events) listener?.(event);
              resolve({ ref: { provider: "codex", threadId: "thread-1" } });
            };
          }),
      ),
      sendPrompt: vi.fn(),
      cancelTurn: vi.fn(),
      respondApproval: vi.fn(),
      subscribeEvents: vi.fn((_sessionHandle, next) => {
        listener = next;
        return vi.fn();
      }),
      shutdown: vi.fn().mockResolvedValue(undefined),
    };

    const loader = createPortReplayLoader({
      canLoad: true,
      createPort: () => port,
      runtimeKind: "direct-codex",
      sessionHandle: "live-session",
      distro: "Ubuntu",
      workDir: "/workspace",
      metadata: {
        sessionRuntimeKind: "direct-codex",
        provider: "codex",
        providerThreadId: "thread-1",
        canLoad: true,
      },
    });

    const loading = loader.loadHistory();
    await loader.dispose();
    resumeControl.finish?.();

    await expect(loading).resolves.toEqual([]);
    expect(port.shutdown).toHaveBeenCalledWith("live-session:replay");
  });

  it("does not expose in-flight replay failures after dispose wins the race", async () => {
    const resumeControl: { fail?: () => void } = {};
    const port: AgentRuntimePort = {
      startSession: vi.fn(),
      resumeSession: vi.fn().mockImplementation(
        () =>
          new Promise((_resolve, reject) => {
            resumeControl.fail = () => reject(new Error("thread/read failed after close"));
          }),
      ),
      sendPrompt: vi.fn(),
      cancelTurn: vi.fn(),
      respondApproval: vi.fn(),
      subscribeEvents: vi.fn(() => vi.fn()),
      shutdown: vi.fn().mockResolvedValue(undefined),
    };

    const loader = createPortReplayLoader({
      canLoad: true,
      createPort: () => port,
      runtimeKind: "direct-codex",
      sessionHandle: "live-session",
      distro: "Ubuntu",
      workDir: "/workspace",
      metadata: {
        sessionRuntimeKind: "direct-codex",
        provider: "codex",
        providerThreadId: "thread-1",
        canLoad: true,
      },
    });

    const loading = loader.loadHistory();
    await loader.dispose();
    resumeControl.fail?.();

    await expect(loading).resolves.toEqual([]);
    expect(port.shutdown).toHaveBeenCalledWith("live-session:replay");
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createTerminalLoadingLifecycle,
  hasRenderableTerminalOutput,
} from "./terminal-loading-lifecycle";

function createRuntime() {
  const state = {
    loadingState: null as "connecting" | null,
    loadingStartedAt: 0,
    loadingHasRenderableOutput: false,
    loadingQuietTimer: null as ReturnType<typeof setTimeout> | null,
    loadingMaxTimer: null as ReturnType<typeof setTimeout> | null,
  };

  const runtime = createTerminalLoadingLifecycle({
    getLoadingState: () => state.loadingState,
    setLoadingState: (loadingState) => {
      state.loadingState = loadingState;
    },
    getLoadingStartedAt: () => state.loadingStartedAt,
    setLoadingStartedAt: (loadingStartedAt) => {
      state.loadingStartedAt = loadingStartedAt;
    },
    getHasRenderableOutput: () => state.loadingHasRenderableOutput,
    setHasRenderableOutput: (loadingHasRenderableOutput) => {
      state.loadingHasRenderableOutput = loadingHasRenderableOutput;
    },
    getQuietTimer: () => state.loadingQuietTimer,
    setQuietTimer: (loadingQuietTimer) => {
      state.loadingQuietTimer = loadingQuietTimer;
    },
    getMaxTimer: () => state.loadingMaxTimer,
    setMaxTimer: (loadingMaxTimer) => {
      state.loadingMaxTimer = loadingMaxTimer;
    },
    shouldWaitForMinDuration: (force) => !force && state.loadingHasRenderableOutput,
    now: () => Date.now(),
    minVisibleDurationMs: 360,
    quietMs: 1300,
    maxMs: 8000,
  });

  return {
    runtime,
    state,
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("terminal-loading-lifecycle", () => {
  it("detects renderable output while ignoring control-only sequences", () => {
    expect(hasRenderableTerminalOutput("hello")).toBe(true);
    expect(hasRenderableTerminalOutput("\u001b[31m\u001b[0m")).toBe(false);
    expect(hasRenderableTerminalOutput("\u001b]633;foo\u0007")).toBe(false);
  });

  it("clears loading after renderable output settles past the quiet window", async () => {
    vi.useFakeTimers();
    const { runtime, state } = createRuntime();

    runtime.show("connecting");
    expect(runtime.noteRenderableOutput("ready")).toBe(true);
    runtime.scheduleQuietClear();

    await vi.advanceTimersByTimeAsync(1300);

    expect(state.loadingState).toBeNull();
    expect(state.loadingHasRenderableOutput).toBe(false);
  });

  it("forces loading closed on the max timer without waiting for renderable output", async () => {
    vi.useFakeTimers();
    const { runtime, state } = createRuntime();

    runtime.show("connecting");

    await vi.advanceTimersByTimeAsync(8000);

    expect(state.loadingState).toBeNull();
    expect(state.loadingHasRenderableOutput).toBe(false);
  });

  it("does not mutate loading state after dispose during min-duration wait", async () => {
    vi.useFakeTimers();
    const { runtime, state } = createRuntime();

    runtime.show("connecting");
    expect(runtime.noteRenderableOutput("ready")).toBe(true);
    runtime.scheduleQuietClear();

    await vi.advanceTimersByTimeAsync(200);
    runtime.dispose();
    await vi.advanceTimersByTimeAsync(2000);

    expect(state.loadingState).toBe("connecting");
    expect(state.loadingHasRenderableOutput).toBe(true);
  });
});

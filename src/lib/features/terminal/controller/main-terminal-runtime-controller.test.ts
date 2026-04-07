import { afterEach, describe, expect, it, vi } from "vitest";
import type { Terminal } from "@xterm/xterm";
import { createMainTerminalRuntimeController } from "./main-terminal-runtime-controller";
import { createMainTerminalRuntimeState } from "../state/main-terminal-runtime-state.svelte";
import type { CanonicalScreenSnapshot } from "../../../terminal/canonical-screen-authority";

function createController(options?: {
  storedPtyId?: number;
  requestCanonicalScreenSnapshotImpl?: () => Promise<never>;
  takePtyInitialOutputImpl?: (id: number) => Promise<string>;
  writeTerminalDataImpl?: (term: Terminal, data: string) => Promise<void>;
}) {
  const state = createMainTerminalRuntimeState();
  const writes: string[] = [];
  const scrollToBottom = vi.fn();
  const onPtyId = vi.fn();
  const onResumeFallback = vi.fn();
  const onExit = vi.fn();
  const syncLayoutToPty = vi.fn(async () => {});
  const spawnPty = vi.fn(async () => 42);
  const takePtyInitialOutput = vi.fn(
    options?.takePtyInitialOutputImpl ?? (async () => "hello"),
  );
  const requestCanonicalScreenSnapshot = vi.fn<
    (
      params: {
        sessionId: string;
        ptyId: number;
        agentId: string;
        cols: number;
        rows: number;
      },
    ) => Promise<CanonicalScreenSnapshot | null>
  >(options?.requestCanonicalScreenSnapshotImpl ?? (async () => null));
  const getPtyOutputSnapshot = vi.fn(async () => ({
    data: "snapshot",
    seq: 3,
  }));
  const getPtyRuntimeSnapshot = vi.fn(async () => ({
    data: "",
    seq: 1,
    cols: 120,
    rows: 36,
    homeDir: "/home/tester",
  }));
  const resizePty = vi.fn(async () => {});
  const writeTerminalData = vi.fn(
    options?.writeTerminalDataImpl
      ?? (async (_term, data: string) => {
        writes.push(data);
      }),
  );
  const term = {
    cols: 120,
    rows: 36,
    modes: {
      synchronizedOutputMode: false,
    },
    scrollToBottom,
  } as unknown as Terminal;

  const controller = createMainTerminalRuntimeController({
    state,
    getSessionId: () => "session-1",
    getStoredPtyId: () => options?.storedPtyId ?? -1,
    getAgentId: () => "claude",
    getDistro: () => "Ubuntu",
    getWorkDir: () => "/workspace",
    getResumeToken: () => "resume-1",
    getTerminal: () => term,
    getSoftFollowExperimentEnabled: () => false,
    getEditorViewMode: () => "terminal",
    getInitialPtySize: () => ({ cols: 120, rows: 36 }),
    writeTerminalData,
    waitForTerminalPaint: async () => {},
    syncLayoutToPty,
    scrollTerminalToBottom: scrollToBottom,
    requestCanonicalScreenSnapshot,
    registerCanonicalSession: vi.fn(),
    spawnPty,
    takePtyInitialOutput,
    getPtyOutputSnapshot,
    getPtyRuntimeSnapshot,
    resizePty,
    onPtyId,
    onResumeFallback,
    onExit,
  });

  return {
    controller,
    state,
    term,
    writes,
    scrollToBottom,
    onPtyId,
    onResumeFallback,
    onExit,
    syncLayoutToPty,
    spawnPty,
    takePtyInitialOutput,
    requestCanonicalScreenSnapshot,
    getPtyOutputSnapshot,
    writeTerminalData,
  };
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("main-terminal-runtime-controller", () => {
  it("spawns a PTY, sanitizes resume-failure markers, and reports the live PTY id", async () => {
    const runtime = createController({
      takePtyInitialOutputImpl: async () => "__CLCOMX_RESUME_FAILED__\r\nready",
    });

    await runtime.controller.attachOrSpawnPty(runtime.term, {
      loadingAlreadyShown: true,
    });

    expect(runtime.spawnPty).toHaveBeenCalledWith(
      120,
      36,
      "claude",
      "Ubuntu",
      "/workspace",
      "resume-1",
    );
    expect(runtime.writes).toEqual(["ready"]);
    expect(runtime.state.livePtyId).toBe(42);
    expect(runtime.state.initialOutputReady).toBe(true);
    expect(runtime.onResumeFallback).toHaveBeenCalledTimes(1);
    expect(runtime.onPtyId).toHaveBeenCalledWith(42);

    runtime.controller.dispose();
  });

  it("buffers main output while replay restore is in progress", () => {
    const runtime = createController();
    runtime.state.livePtyId = 7;
    runtime.state.replayInProgress = true;

    const handled = runtime.controller.handleMainOutputChunk({
      id: 7,
      seq: 9,
      data: "alpha",
    });

    expect(handled).toBe(true);
    expect(runtime.state.replayBuffer).toEqual([{ id: 7, seq: 9, data: "alpha" }]);
    expect(runtime.writeTerminalData).not.toHaveBeenCalled();
  });

  it("writes active main output and strips resume markers before rendering", async () => {
    const runtime = createController();
    runtime.state.livePtyId = 7;
    runtime.state.initialOutputReady = true;

    const handled = runtime.controller.handleMainOutputChunk({
      id: 7,
      seq: 2,
      data: "__CLCOMX_RESUME_FAILED__\r\nprompt",
    });

    await Promise.resolve();

    expect(handled).toBe(true);
    expect(runtime.writes).toEqual(["prompt"]);
    expect(runtime.onResumeFallback).toHaveBeenCalledTimes(1);
    expect(runtime.scrollToBottom).toHaveBeenCalledTimes(1);

    runtime.controller.dispose();
  });

  it("falls back to spawning a new PTY when restore attach fails", async () => {
    const runtime = createController({
      storedPtyId: 15,
      requestCanonicalScreenSnapshotImpl: async () => {
        throw new Error("restore failed");
      },
    });

    await runtime.controller.attachOrSpawnPty(runtime.term, {
      loadingAlreadyShown: true,
    });

    expect(runtime.requestCanonicalScreenSnapshot).toHaveBeenCalled();
    expect(runtime.spawnPty).toHaveBeenCalledTimes(1);
    expect(runtime.state.livePtyId).toBe(42);
    expect(runtime.state.replayInProgress).toBe(false);
    expect(runtime.state.initialOutputReady).toBe(true);

    runtime.controller.dispose();
  });

  it("restores an existing PTY from canonical snapshot and replays newer chunks", async () => {
    const runtime = createController({
      storedPtyId: 15,
    });
    runtime.requestCanonicalScreenSnapshot.mockImplementationOnce(async () => {
      runtime.state.replayBuffer.push(
        { id: 15, seq: 4, data: "stale" },
        { id: 15, seq: 6, data: " newer" },
      );

      return {
        serialized: "screen",
        delta: " delta",
        captureSeq: 3,
        appliedSeq: 5,
        cols: 120,
        rows: 36,
      };
    });

    await runtime.controller.attachOrSpawnPty(runtime.term, {
      loadingAlreadyShown: true,
    });

    expect(runtime.spawnPty).not.toHaveBeenCalled();
    expect(runtime.syncLayoutToPty).toHaveBeenNthCalledWith(1, { stickToBottom: false });
    expect(runtime.syncLayoutToPty).toHaveBeenLastCalledWith({ refresh: true });
    expect(runtime.writes).toEqual(["screen", " delta", " newer"]);
    expect(runtime.state.livePtyId).toBe(15);
    expect(runtime.state.replayInProgress).toBe(false);
    expect(runtime.state.initialOutputReady).toBe(true);

    runtime.controller.dispose();
  });

  it("routes active PTY exits through the runtime controller", () => {
    const runtime = createController();
    runtime.state.livePtyId = 42;

    expect(runtime.controller.handlePtyExit(12)).toBe(false);
    expect(runtime.controller.handlePtyExit(42)).toBe(true);
    expect(runtime.onExit).toHaveBeenCalledWith(42);
  });
});

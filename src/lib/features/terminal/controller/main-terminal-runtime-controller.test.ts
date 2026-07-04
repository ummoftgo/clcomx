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
  const killPty = vi.fn(async () => {});
  const registerCanonicalSession = vi.fn();
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
    registerCanonicalSession,
    spawnPty,
    takePtyInitialOutput,
    getPtyOutputSnapshot,
    getPtyRuntimeSnapshot,
    resizePty,
    killPty,
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
    registerCanonicalSession,
    getPtyOutputSnapshot,
    writeTerminalData,
    killPty,
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

  it("allowSpawnFallback=false: attach 실패 시 spawn하지 않고 false를 반환한다(숨김 탭 eager attach)", async () => {
    const runtime = createController({
      storedPtyId: 15,
      requestCanonicalScreenSnapshotImpl: async () => {
        throw new Error("restore failed");
      },
    });

    const started = await runtime.controller.attachOrSpawnPty(runtime.term, {
      loadingAlreadyShown: true,
      allowSpawnFallback: false,
    });

    expect(started).toBe(false);
    expect(runtime.spawnPty).not.toHaveBeenCalled();
    expect(runtime.state.livePtyId).toBe(-1);
    // 실패 정리 후 spawn 대기 상태로 남는다(첫 visible에서 fallback 허용 재호출).
    expect(runtime.state.replayInProgress).toBe(false);
    expect(runtime.state.initialOutputReady).toBe(false);

    runtime.controller.dispose();
  });

  it("allowSpawnFallback=false: attach 성공은 그대로 true를 반환한다", async () => {
    const runtime = createController({
      storedPtyId: 15,
    });

    const started = await runtime.controller.attachOrSpawnPty(runtime.term, {
      loadingAlreadyShown: true,
      allowSpawnFallback: false,
    });

    expect(started).toBe(true);
    expect(runtime.spawnPty).not.toHaveBeenCalled();
    expect(runtime.state.livePtyId).toBe(15);
    expect(runtime.state.initialOutputReady).toBe(true);

    runtime.controller.dispose();
  });

  it("dispose 후 완료된 지연 spawn은 고아 PTY를 회수하고 등록 부수효과를 내지 않는다", async () => {
    let resolveSpawn!: (id: number) => void;
    const runtime = createController();
    runtime.spawnPty.mockImplementationOnce(
      () =>
        new Promise<number>((resolve) => {
          resolveSpawn = resolve;
        }),
    );

    const startPromise = runtime.controller.attachOrSpawnPty(runtime.term, {
      loadingAlreadyShown: true,
    });
    runtime.controller.dispose();
    resolveSpawn(42);

    await expect(startPromise).resolves.toBe(false);
    expect(runtime.killPty).toHaveBeenCalledWith(42);
    expect(runtime.registerCanonicalSession).not.toHaveBeenCalled();
    expect(runtime.takePtyInitialOutput).not.toHaveBeenCalled();
    expect(runtime.onPtyId).not.toHaveBeenCalled();
    expect(runtime.state.livePtyId).toBe(-1);
  });

  it("dispose가 attach 도중 발생하면 남은 attach 부수효과 없이 false로 중단한다", async () => {
    let resolveSnapshot!: (value: CanonicalScreenSnapshot | null) => void;
    const runtime = createController({ storedPtyId: 15 });
    runtime.requestCanonicalScreenSnapshot.mockImplementationOnce(
      () =>
        new Promise<CanonicalScreenSnapshot | null>((resolve) => {
          resolveSnapshot = resolve;
        }),
    );

    const startPromise = runtime.controller.attachOrSpawnPty(runtime.term, {
      loadingAlreadyShown: true,
    });
    // snapshot await에 도달한 뒤(=조회 시작 후) destroy되는 경합을 재현한다.
    await vi.waitFor(() => {
      expect(runtime.requestCanonicalScreenSnapshot).toHaveBeenCalledTimes(1);
    });
    runtime.controller.dispose();
    resolveSnapshot(null);

    await expect(startPromise).resolves.toBe(false);
    // snapshot fallback 조회/화면 write/spawn 폴백 어느 것도 진행하지 않는다.
    expect(runtime.getPtyOutputSnapshot).not.toHaveBeenCalled();
    expect(runtime.writes).toEqual([]);
    expect(runtime.spawnPty).not.toHaveBeenCalled();
    expect(runtime.state.livePtyId).toBe(-1);
    expect(runtime.state.replayInProgress).toBe(false);
  });

  it("dispose 후 attachOrSpawnPty 진입은 아무 부수효과 없이 false를 반환한다", async () => {
    const runtime = createController({ storedPtyId: 15 });
    runtime.controller.dispose();

    await expect(
      runtime.controller.attachOrSpawnPty(runtime.term, { loadingAlreadyShown: true }),
    ).resolves.toBe(false);

    expect(runtime.registerCanonicalSession).not.toHaveBeenCalled();
    expect(runtime.requestCanonicalScreenSnapshot).not.toHaveBeenCalled();
    expect(runtime.spawnPty).not.toHaveBeenCalled();
  });

  it("allowSpawnFallback=false: stored ptyId가 없으면(cold) spawn 없이 false를 반환한다", async () => {
    const runtime = createController();

    const started = await runtime.controller.attachOrSpawnPty(runtime.term, {
      loadingAlreadyShown: true,
      allowSpawnFallback: false,
    });

    expect(started).toBe(false);
    expect(runtime.spawnPty).not.toHaveBeenCalled();
    expect(runtime.state.livePtyId).toBe(-1);

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

  it("keeps loading visible until the ready signal is rendered", async () => {
    vi.useFakeTimers();
    const runtime = createController();
    runtime.state.livePtyId = 42;
    runtime.state.initialOutputReady = true;

    await runtime.controller.showTerminalLoadingState("connecting");

    runtime.controller.handleMainOutputChunk({
      id: 42,
      seq: 1,
      data: "working...",
    });
    await Promise.resolve();
    runtime.controller.handleTerminalRender();
    await vi.advanceTimersByTimeAsync(1300);

    expect(runtime.state.terminalLoadingState).toBe("connecting");

    runtime.controller.handleMainOutputChunk({
      id: 42,
      seq: 2,
      data: "\n❯ ",
    });
    await Promise.resolve();
    runtime.controller.handleTerminalRender();
    await vi.advanceTimersByTimeAsync(1300);

    expect(runtime.state.terminalLoadingState).toBeNull();
    runtime.controller.dispose();
  });
});

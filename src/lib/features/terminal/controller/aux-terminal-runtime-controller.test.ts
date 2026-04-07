import { afterEach, describe, expect, it, vi } from "vitest";
import type { Terminal } from "@xterm/xterm";
import { createAuxTerminalRuntimeController } from "./aux-terminal-runtime-controller";
import { createAuxTerminalRuntimeState } from "../state/aux-terminal-runtime-state.svelte";

function encodeBase64Utf8(value: string) {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

function createCwdMarker(cwd: string) {
  return `\u001b]633;CLCOMX_CWD;${encodeBase64Utf8(cwd)}\u0007`;
}

function createController(options?: {
  statePtyId?: number;
  getPtyOutputSnapshotImpl?: (id: number) => Promise<{ data: string; seq: number }>;
  takePtyInitialOutputImpl?: (id: number) => Promise<string>;
  writeTerminalDataImpl?: (term: Terminal, data: string) => Promise<void>;
  spawnShellPtyImpl?: () => Promise<number>;
}) {
  const state = createAuxTerminalRuntimeState();
  if (options?.statePtyId !== undefined) {
    state.ptyId = options.statePtyId;
    state.exited = options.statePtyId < 0;
  }

  const writes: string[] = [];
  const scrollToBottom = vi.fn();
  const focusOutput = vi.fn();
  const writeTerminalData = vi.fn(
    options?.writeTerminalDataImpl
      ?? (async (_term, data: string) => {
        writes.push(data);
      }),
  );
  const spawnShellPty = vi.fn(options?.spawnShellPtyImpl ?? (async () => 42));
  const takePtyInitialOutput = vi.fn(
    options?.takePtyInitialOutputImpl ?? (async () => "prompt$ "),
  );
  const getPtyOutputSnapshot = vi.fn(
    options?.getPtyOutputSnapshotImpl ?? (async () => ({ data: "restored", seq: 3 })),
  );
  const writePty = vi.fn(async () => {});
  const resizePty = vi.fn(async () => {});
  const term = {
    cols: 120,
    rows: 36,
    scrollToBottom,
  } as unknown as Terminal;

  const controller = createAuxTerminalRuntimeController({
    state,
    getDistro: () => "Ubuntu",
    getWorkDir: () => "/workspace",
    getTerminal: () => term,
    getInitialPtySize: () => ({ cols: 120, rows: 36 }),
    writeTerminalData,
    focusOutput,
    spawnShellPty,
    takePtyInitialOutput,
    getPtyOutputSnapshot,
    writePty,
    resizePty,
  });

  return {
    controller,
    state,
    term,
    writes,
    focusOutput,
    scrollToBottom,
    writeTerminalData,
    spawnShellPty,
    takePtyInitialOutput,
    getPtyOutputSnapshot,
    writePty,
    resizePty,
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("aux-terminal-runtime-controller", () => {
  it("spawns an aux shell, strips cwd metadata from output, and tracks the current path", async () => {
    const runtime = createController({
      takePtyInitialOutputImpl: async () =>
        `hello\r\n${createCwdMarker("/workspace/subdir")}prompt$ `,
    });

    await runtime.controller.attachOrSpawn(runtime.term);

    expect(runtime.spawnShellPty).toHaveBeenCalledWith(120, 36, "Ubuntu", "/workspace");
    expect(runtime.writes).toEqual(["hello\r\nprompt$ "]);
    expect(runtime.state.ptyId).toBe(42);
    expect(runtime.state.currentPath).toBe("/workspace/subdir");
    expect(runtime.state.attached).toBe(true);
    expect(runtime.state.exited).toBe(false);

    runtime.controller.dispose();
  });

  it("falls back to spawning a new aux shell when attach to an existing PTY fails", async () => {
    const runtime = createController({
      statePtyId: 15,
      getPtyOutputSnapshotImpl: async () => {
        throw new Error("restore failed");
      },
    });

    await runtime.controller.attachOrSpawn(runtime.term);

    expect(runtime.getPtyOutputSnapshot).toHaveBeenCalledWith(15);
    expect(runtime.spawnShellPty).toHaveBeenCalledTimes(1);
    expect(runtime.state.ptyId).toBe(42);
    expect(runtime.state.attached).toBe(true);

    runtime.controller.dispose();
  });

  it("attaches to an existing aux PTY and restores the latest snapshot", async () => {
    const runtime = createController({
      statePtyId: 15,
      getPtyOutputSnapshotImpl: async () => ({
        data: `${createCwdMarker("/workspace/restored")}restored prompt$ `,
        seq: 5,
      }),
    });

    await runtime.controller.attachOrSpawn(runtime.term);

    expect(runtime.spawnShellPty).not.toHaveBeenCalled();
    expect(runtime.getPtyOutputSnapshot).toHaveBeenCalledWith(15);
    expect(runtime.writes).toEqual(["restored prompt$ "]);
    expect(runtime.state.ptyId).toBe(15);
    expect(runtime.state.currentPath).toBe("/workspace/restored");
    expect(runtime.state.attached).toBe(true);
    expect(runtime.state.exited).toBe(false);
    expect(runtime.state.followTail).toBe(true);

    runtime.controller.dispose();
  });

  it("routes active aux output only for the aux PTY and updates cwd metadata", async () => {
    const runtime = createController();
    runtime.state.ptyId = 7;
    runtime.state.exited = false;
    runtime.state.attached = true;
    runtime.state.followTail = true;

    expect(
      runtime.controller.handleOutputChunk({
        id: 6,
        seq: 1,
        data: "ignored",
      }),
    ).toBe(false);

    const handled = runtime.controller.handleOutputChunk({
      id: 7,
      seq: 2,
      data: `${createCwdMarker("/workspace/next")}build done`,
    });

    await Promise.resolve();

    expect(handled).toBe(true);
    expect(runtime.writes).toEqual(["build done"]);
    expect(runtime.state.currentPath).toBe("/workspace/next");
    expect(runtime.scrollToBottom).toHaveBeenCalledTimes(1);

    runtime.controller.dispose();
  });

  it("clears the aux loading state after renderable output settles", async () => {
    vi.useFakeTimers();
    const runtime = createController({
      takePtyInitialOutputImpl: async () => "ready",
    });

    await runtime.controller.attachOrSpawn(runtime.term);
    expect(runtime.state.loadingState).toBe("opening");

    await vi.advanceTimersByTimeAsync(1300);

    expect(runtime.state.loadingState).toBeNull();

    runtime.controller.dispose();
  });

  it("resets aux runtime state on active PTY exit", () => {
    const runtime = createController();
    runtime.state.ptyId = 7;
    runtime.state.exited = false;
    runtime.state.busy = true;
    runtime.state.loadingState = "opening";
    runtime.state.loadingHasRenderableOutput = true;
    runtime.state.attached = true;
    runtime.state.currentPath = "/workspace/subdir";

    expect(runtime.controller.handlePtyExit(5)).toBe(false);
    expect(runtime.controller.handlePtyExit(7)).toBe(true);
    expect(runtime.state.ptyId).toBe(-1);
    expect(runtime.state.exited).toBe(true);
    expect(runtime.state.busy).toBe(false);
    expect(runtime.state.loadingState).toBeNull();
    expect(runtime.state.loadingHasRenderableOutput).toBe(false);
    expect(runtime.state.attached).toBe(false);
    expect(runtime.focusOutput).toHaveBeenCalledTimes(1);
  });
});

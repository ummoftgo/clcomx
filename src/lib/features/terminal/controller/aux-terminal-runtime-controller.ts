import type { Terminal } from "@xterm/xterm";
import type { PtyOutputChunk } from "../../../pty";
import { consumeAuxShellMetadata } from "../../../terminal/aux-shell-metadata";
import type {
  AuxTerminalLoadingState,
  AuxTerminalRuntimeState,
} from "../state/aux-terminal-runtime-state.svelte";
import {
  createTerminalLoadingLifecycle,
} from "./terminal-loading-lifecycle";

interface AuxTerminalRuntimeControllerDeps {
  state: AuxTerminalRuntimeState;
  getDistro: () => string;
  getWorkDir: () => string;
  getTerminal: () => Terminal | null;
  getInitialPtySize: (term: Terminal) => { cols: number; rows: number };
  writeTerminalData: (term: Terminal, data: string) => Promise<void>;
  focusOutput: () => void;
  spawnShellPty: (
    cols: number,
    rows: number,
    distro: string,
    workDir: string,
  ) => Promise<number>;
  takePtyInitialOutput: (id: number) => Promise<string>;
  getPtyOutputSnapshot: (id: number) => Promise<{ data: string; seq: number }>;
  writePty: (id: number, data: string) => Promise<void>;
  resizePty: (id: number, cols: number, rows: number) => Promise<void>;
}

export function createAuxTerminalRuntimeController(deps: AuxTerminalRuntimeControllerDeps) {
  const { state } = deps;

  function writeAuxTerminalData(term: Terminal, data: string) {
    const parsed = consumeAuxShellMetadata(data, state.metadataRemainder);
    state.metadataRemainder = parsed.remainder;
    if (parsed.cwd) {
      state.currentPath = parsed.cwd;
    }
    return deps.writeTerminalData(term, parsed.text);
  }

  const terminalLoadingLifecycle = createTerminalLoadingLifecycle({
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
  });

  function clearLoadingTimers() {
    terminalLoadingLifecycle.clearTimers();
  }

  function showLoadingState(stateValue: AuxTerminalLoadingState = "opening") {
    terminalLoadingLifecycle.show(stateValue);
  }

  function noteLoadingOutput(data: string) {
    if (!terminalLoadingLifecycle.noteRenderableOutput(data)) {
      return;
    }

    terminalLoadingLifecycle.scheduleQuietClear();
  }

  async function clearLoadingState(force = false) {
    await terminalLoadingLifecycle.clear(force);
  }

  async function spawnShell(term: Terminal) {
    const { cols, rows } = deps.getInitialPtySize(term);
    state.busy = true;
    state.spawnError = null;
    state.currentPath = deps.getWorkDir();
    state.metadataRemainder = "";

    try {
      state.ptyId = await deps.spawnShellPty(cols, rows, deps.getDistro(), deps.getWorkDir());
      const initialOutput = await deps.takePtyInitialOutput(state.ptyId);
      await writeAuxTerminalData(term, initialOutput);
      noteLoadingOutput(initialOutput);
      state.exited = false;
      state.followTail = true;
      state.attached = true;
    } catch (error) {
      state.spawnError = error instanceof Error ? error.message : String(error);
      state.ptyId = -1;
    } finally {
      state.busy = false;
      if (state.spawnError) {
        void clearLoadingState(true);
      }
    }
  }

  async function attachToExistingPty(id: number, term: Terminal) {
    state.ptyId = id;
    state.currentPath = deps.getWorkDir();
    state.metadataRemainder = "";
    const snapshot = await deps.getPtyOutputSnapshot(id);
    await writeAuxTerminalData(term, snapshot.data);
    noteLoadingOutput(snapshot.data);
    state.exited = false;
    state.followTail = true;
    state.attached = true;
  }

  async function attachOrSpawn(term: Terminal) {
    state.spawnError = null;
    if (state.loadingState === null && !state.attached) {
      showLoadingState();
    }

    if (state.attached) {
      return;
    }

    if (state.ptyId >= 0) {
      try {
        await attachToExistingPty(state.ptyId, term);
        return;
      } catch (error) {
        console.warn("Failed to attach to existing auxiliary PTY, spawning a new shell", error);
        state.ptyId = -1;
      }
    }

    await spawnShell(term);
  }

  function handleTerminalInput(data: string) {
    if (state.ptyId >= 0) {
      void deps.writePty(state.ptyId, data);
    }
  }

  function handleTerminalResize(cols: number, rows: number) {
    if (state.ptyId >= 0) {
      void deps.resizePty(state.ptyId, cols, rows);
    }
    if (state.followTail) {
      deps.getTerminal()?.scrollToBottom();
    }
  }

  function handleViewportScroll(viewportY: number, baseY: number) {
    state.followTail = viewportY >= baseY;
  }

  function handleOutputChunk(event: PtyOutputChunk) {
    const term = deps.getTerminal();
    if (event.id !== state.ptyId || !term) {
      return false;
    }

    const shouldStickToBottom = state.followTail;
    void writeAuxTerminalData(term, event.data).then(() => {
      noteLoadingOutput(event.data);
      if (shouldStickToBottom) {
        term.scrollToBottom();
      }
    });
    return true;
  }

  function handlePtyExit(ptyId: number) {
    if (ptyId !== state.ptyId) {
      return false;
    }

    state.exited = true;
    state.ptyId = -1;
    state.busy = false;
    clearLoadingTimers();
    state.loadingState = null;
    state.loadingHasRenderableOutput = false;
    state.metadataRemainder = "";
    state.attached = false;
    deps.focusOutput();
    return true;
  }

  function handleTerminalInstanceDisposed() {
    state.metadataRemainder = "";
    state.attached = false;
  }

  function dispose() {
    terminalLoadingLifecycle.dispose();
  }

  return {
    attachOrSpawn,
    clearLoadingState,
    dispose,
    handleOutputChunk,
    handlePtyExit,
    handleTerminalInput,
    handleTerminalInstanceDisposed,
    handleTerminalResize,
    handleViewportScroll,
    showLoadingState,
  };
}

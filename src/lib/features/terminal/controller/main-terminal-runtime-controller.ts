import type { Terminal } from "@xterm/xterm";
import type { AgentId } from "../../../agents";
import type { PtyOutputChunk, PtyOutputSnapshot, PtyRuntimeSnapshot } from "../../../pty";
import { resolvePtyHomeDir } from "../../../pty";
import { consumeAuxShellMetadata } from "../../../terminal/aux-shell-metadata";
import type { CanonicalScreenSnapshot } from "../../../terminal/canonical-screen-authority";
import type {
  MainTerminalLoadingState,
  MainTerminalRuntimeState,
} from "../state/main-terminal-runtime-state.svelte";
import {
  createTerminalLoadingLifecycle,
  hasRenderableTerminalOutput,
} from "./terminal-loading-lifecycle";

const RESUME_FAILED_MARKER = "__CLCOMX_RESUME_FAILED__";
const BOTTOM_LOCK_MAX_MS = 12000;
const BOTTOM_LOCK_QUIET_MS = 1400;
const DEFERRED_BOTTOM_SCROLL_MS = 60;
const SYNC_OUTPUT_MODE_SEQUENCE = /\u001b\[\?2026[hl]/;
const ABSOLUTE_CURSOR_POSITION_SEQUENCE = /\u001b\[\d+(?:;\d+)?[Hf]/;

interface MainTerminalRuntimeControllerDeps {
  state: MainTerminalRuntimeState;
  getSessionId: () => string;
  getStoredPtyId: () => number;
  getAgentId: () => AgentId;
  getDistro: () => string;
  getWorkDir: () => string;
  getResumeToken: () => string | null;
  getTerminal: () => Terminal | null;
  getSoftFollowExperimentEnabled: () => boolean;
  getEditorViewMode: () => "terminal" | "editor";
  getInitialPtySize: (term: Terminal) => { cols: number; rows: number };
  writeTerminalData: (term: Terminal, data: string) => Promise<void>;
  waitForTerminalPaint: () => Promise<void>;
  syncLayoutToPty: (options?: { stickToBottom?: boolean; refresh?: boolean }) => Promise<void>;
  scrollTerminalToBottom: () => void;
  requestCanonicalScreenSnapshot: (params: {
    sessionId: string;
    ptyId: number;
    agentId: AgentId;
    cols: number;
    rows: number;
  }) => Promise<CanonicalScreenSnapshot | null>;
  registerCanonicalSession: (params: {
    sessionId: string;
    ptyId: number;
    agentId: AgentId;
  }) => void | Promise<void>;
  spawnPty: (
    cols: number,
    rows: number,
    agentId: AgentId,
    distro: string,
    workDir: string,
    resumeToken?: string | null,
  ) => Promise<number>;
  takePtyInitialOutput: (id: number) => Promise<string>;
  getPtyOutputSnapshot: (id: number) => Promise<PtyOutputSnapshot>;
  getPtyRuntimeSnapshot: (id: number) => Promise<PtyRuntimeSnapshot>;
  resizePty: (id: number, cols: number, rows: number) => Promise<void>;
  onPtyId?: (ptyId: number) => void | Promise<void>;
  onResumeFallback?: () => void | Promise<void>;
  onExit?: (ptyId: number) => void | Promise<void>;
}

export function createMainTerminalRuntimeController(deps: MainTerminalRuntimeControllerDeps) {
  const { state } = deps;
  const terminalLoadingLifecycle = createTerminalLoadingLifecycle({
    getLoadingState: () => state.terminalLoadingState,
    setLoadingState: (terminalLoadingState) => {
      state.terminalLoadingState = terminalLoadingState;
    },
    getLoadingStartedAt: () => state.terminalLoadingStartedAt,
    setLoadingStartedAt: (terminalLoadingStartedAt) => {
      state.terminalLoadingStartedAt = terminalLoadingStartedAt;
    },
    getHasRenderableOutput: () => state.terminalLoadingHasRenderableOutput,
    setHasRenderableOutput: (terminalLoadingHasRenderableOutput) => {
      state.terminalLoadingHasRenderableOutput = terminalLoadingHasRenderableOutput;
    },
    getQuietTimer: () => state.terminalLoadingQuietTimer,
    setQuietTimer: (terminalLoadingQuietTimer) => {
      state.terminalLoadingQuietTimer = terminalLoadingQuietTimer;
    },
    getMaxTimer: () => state.terminalLoadingMaxTimer,
    setMaxTimer: (terminalLoadingMaxTimer) => {
      state.terminalLoadingMaxTimer = terminalLoadingMaxTimer;
    },
    shouldWaitForMinDuration: (force) => !force,
    onShow: () => {
      state.terminalLoadingReadySignalSeen = !requiresAgentReadySignal();
    },
    onClear: () => {
      state.terminalLoadingReadySignalSeen = false;
    },
  });

  function getLivePtyId() {
    return state.livePtyId;
  }

  function getActivePtyId() {
    return state.livePtyId >= 0 ? state.livePtyId : deps.getStoredPtyId();
  }

  function clearShellHomeDirCache() {
    state.shellHomeDir = null;
  }

  function getShellHomeDirHint() {
    return resolvePtyHomeDir(state.shellHomeDir, null);
  }

  function consumeMainTerminalMetadata(data: string) {
    const parsed = consumeAuxShellMetadata(data, state.mainMetadataRemainder);
    state.mainMetadataRemainder = parsed.remainder;
    const parsedHomeDir = resolvePtyHomeDir(parsed.homeDir, null);
    if (parsedHomeDir) {
      state.shellHomeDir = parsedHomeDir;
    }
    return parsed;
  }

  async function rehydrateShellHomeDirFromRuntimeSnapshot() {
    const activePtyId = getActivePtyId();
    if (activePtyId < 0) {
      return null;
    }

    try {
      const snapshot = await deps.getPtyRuntimeSnapshot(activePtyId);
      const resolvedHomeDir = resolvePtyHomeDir(null, snapshot.homeDir);
      if (resolvedHomeDir) {
        state.shellHomeDir = resolvedHomeDir;
      }
      return resolvedHomeDir;
    } catch {
      return null;
    }
  }

  function writeMainTerminalData(term: Terminal, data: string) {
    const parsed = consumeMainTerminalMetadata(data);
    return deps.writeTerminalData(term, parsed.text);
  }

  function extractPrintableTerminalText(data: string) {
    if (!data) {
      return "";
    }

    const withoutOsc = data.replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, "");
    const withoutCsi = withoutOsc.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "");
    return withoutCsi.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "");
  }

  function requiresAgentReadySignal() {
    const agentId = deps.getAgentId();
    return agentId === "claude" || agentId === "codex";
  }

  function hasAgentReadySignal(data: string) {
    const text = extractPrintableTerminalText(data);
    if (!text) {
      return false;
    }

    if (deps.getAgentId() === "codex") {
      return text.includes("OpenAI Codex") || /(?:^|\n)\s*›\s/m.test(text);
    }

    if (deps.getAgentId() === "claude") {
      return /(?:^|\n)\s*❯[\u00a0 ]?/m.test(text) || (text.includes("current:") && text.includes("tokens"));
    }

    return hasRenderableTerminalOutput(data);
  }

  function clearBottomLockTimer() {
    if (state.bottomLockTimer) {
      clearTimeout(state.bottomLockTimer);
      state.bottomLockTimer = null;
    }
  }

  function clearDeferredBottomScrollTimer() {
    if (state.deferredBottomScrollTimer) {
      clearTimeout(state.deferredBottomScrollTimer);
      state.deferredBottomScrollTimer = null;
    }
  }

  function releaseBottomLock() {
    clearBottomLockTimer();
    state.bottomLockDeadline = 0;
    state.bottomLockMaxDeadline = 0;
  }

  function isBottomLockActive() {
    return deps.getTerminal() !== null && Date.now() < state.bottomLockDeadline;
  }

  function canExtendBottomLock() {
    return deps.getTerminal() !== null && Date.now() < state.bottomLockMaxDeadline;
  }

  function scheduleBottomLockTick() {
    clearBottomLockTimer();

    if (!deps.getTerminal()) {
      return;
    }

    deps.scrollTerminalToBottom();

    if (Date.now() >= state.bottomLockDeadline) {
      releaseBottomLock();
      return;
    }

    state.bottomLockTimer = setTimeout(() => {
      state.bottomLockTimer = null;
      scheduleBottomLockTick();
    }, 80);
  }

  function armBottomLock(maxDurationMs = BOTTOM_LOCK_MAX_MS, quietWindowMs = BOTTOM_LOCK_QUIET_MS) {
    const now = Date.now();
    state.bottomLockMaxDeadline = now + maxDurationMs;
    state.bottomLockDeadline = Math.min(state.bottomLockMaxDeadline, now + quietWindowMs);
    state.followTail = true;

    if (deps.getSoftFollowExperimentEnabled()) {
      clearBottomLockTimer();
      deps.scrollTerminalToBottom();
      return;
    }

    scheduleBottomLockTick();
  }

  function extendBottomLock(quietWindowMs = BOTTOM_LOCK_QUIET_MS) {
    if (!canExtendBottomLock()) {
      return;
    }

    state.bottomLockDeadline = Math.min(
      state.bottomLockMaxDeadline,
      Date.now() + quietWindowMs,
    );
    state.followTail = true;

    if (deps.getSoftFollowExperimentEnabled()) {
      clearBottomLockTimer();
      return;
    }

    scheduleBottomLockTick();
  }

  function disableAutoFollow() {
    state.followTail = false;
    state.pendingPostWriteScroll = false;
    clearDeferredBottomScrollTimer();
    releaseBottomLock();
  }

  function isLikelyTerminalRepaintChunk(data: string) {
    if (!deps.getSoftFollowExperimentEnabled()) {
      return false;
    }

    if (SYNC_OUTPUT_MODE_SEQUENCE.test(data)) {
      return true;
    }

    if (ABSOLUTE_CURSOR_POSITION_SEQUENCE.test(data)) {
      return true;
    }

    return data.includes("\r") && !data.includes("\n");
  }

  function scheduleDeferredBottomScroll() {
    clearDeferredBottomScrollTimer();
    state.deferredBottomScrollTimer = setTimeout(() => {
      state.deferredBottomScrollTimer = null;
      const terminal = deps.getTerminal();
      if (
        !deps.getSoftFollowExperimentEnabled()
        || !state.pendingPostWriteScroll
        || terminal?.modes.synchronizedOutputMode
      ) {
        return;
      }

      state.pendingPostWriteScroll = false;
      deps.scrollTerminalToBottom();
    }, DEFERRED_BOTTOM_SCROLL_MS);
  }

  async function showTerminalLoadingState(stateValue: MainTerminalLoadingState) {
    terminalLoadingLifecycle.show(stateValue);
    await deps.waitForTerminalPaint();
  }

  function noteTerminalLoadingOutput(data: string) {
    if (state.terminalLoadingState === null) {
      return;
    }

    terminalLoadingLifecycle.noteRenderableOutput(data);

    if (!state.terminalLoadingReadySignalSeen && hasAgentReadySignal(data)) {
      state.terminalLoadingReadySignalSeen = true;
    }
  }

  function handleTerminalRender() {
    if (state.terminalLoadingState === null || !state.terminalLoadingHasRenderableOutput) {
      return;
    }

    if (requiresAgentReadySignal() && !state.terminalLoadingReadySignalSeen) {
      return;
    }

    terminalLoadingLifecycle.scheduleQuietClear();
  }

  async function clearTerminalLoadingState(force = false) {
    await terminalLoadingLifecycle.clear(force);
  }

  function handleViewportScroll(viewportY: number, baseY: number) {
    if (!deps.getTerminal() || isBottomLockActive()) {
      return;
    }

    state.followTail = viewportY >= baseY;
  }

  function handleWriteParsed(term: Terminal) {
    if (
      !deps.getSoftFollowExperimentEnabled()
      || !state.pendingPostWriteScroll
      || term.modes.synchronizedOutputMode
    ) {
      return;
    }

    scheduleDeferredBottomScroll();
  }

  function handleTerminalResize(cols: number, rows: number) {
    if (state.livePtyId >= 0) {
      void deps.resizePty(state.livePtyId, cols, rows);
    }
    if (deps.getEditorViewMode() === "terminal" && (state.followTail || isBottomLockActive())) {
      deps.scrollTerminalToBottom();
    }
  }

  function handleMainOutputChunk(event: PtyOutputChunk) {
    const term = deps.getTerminal();
    if (event.id !== state.livePtyId || !term) {
      return false;
    }

    let data = event.data;
    const parsedMetadata = consumeMainTerminalMetadata(data);
    data = parsedMetadata.text;

    if (data.includes(RESUME_FAILED_MARKER)) {
      data = data.replaceAll(`${RESUME_FAILED_MARKER}\r\n`, "").replaceAll(RESUME_FAILED_MARKER, "");
      void deps.onResumeFallback?.();
    }

    if (state.replayInProgress) {
      state.replayBuffer.push({ ...event, data });
      return true;
    }

    if (state.initialOutputReady) {
      const repaintChunk = isLikelyTerminalRepaintChunk(data);
      const shouldStickToBottom = state.followTail || isBottomLockActive();
      if (!repaintChunk) {
        extendBottomLock();
      }
      void deps.writeTerminalData(term, data).then(() => {
        noteTerminalLoadingOutput(data);
        if (!shouldStickToBottom) {
          return;
        }

        if (repaintChunk || term.modes.synchronizedOutputMode) {
          state.pendingPostWriteScroll = true;
          scheduleDeferredBottomScroll();
          return;
        }

        term.scrollToBottom();
      });
    }

    return true;
  }

  async function attachToExistingPty(id: number, term: Terminal) {
    state.livePtyId = id;
    state.replayInProgress = true;
    state.replayBuffer = [];
    state.mainMetadataRemainder = "";
    clearShellHomeDirCache();
    void deps.registerCanonicalSession({
      sessionId: deps.getSessionId(),
      ptyId: id,
      agentId: deps.getAgentId(),
    });

    await deps.syncLayoutToPty({ stickToBottom: false });

    let appliedSeq = 0;
    let restored = false;
    let fallbackSnapshotData = "";
    const canonicalSnapshot = await deps.requestCanonicalScreenSnapshot({
      sessionId: deps.getSessionId(),
      ptyId: id,
      agentId: deps.getAgentId(),
      cols: term.cols,
      rows: term.rows,
    });

    if (canonicalSnapshot) {
      await writeMainTerminalData(term, canonicalSnapshot.serialized);
      await writeMainTerminalData(term, canonicalSnapshot.delta);
      appliedSeq = canonicalSnapshot.appliedSeq;
      restored = true;
    } else {
      const snapshot = await deps.getPtyOutputSnapshot(id);
      await writeMainTerminalData(term, snapshot.data);
      appliedSeq = snapshot.seq;
      fallbackSnapshotData = snapshot.data;
    }

    const pendingChunks = state.replayBuffer
      .filter((chunk) => chunk.seq > appliedSeq)
      .sort((left, right) => left.seq - right.seq);

    state.replayInProgress = false;
    for (const chunk of pendingChunks) {
      await writeMainTerminalData(term, chunk.data);
    }

    state.initialOutputReady = true;
    armBottomLock();
    if (
      (restored && canonicalSnapshot
        ? hasRenderableTerminalOutput(canonicalSnapshot.serialized)
          || hasRenderableTerminalOutput(canonicalSnapshot.delta)
        : false)
      || hasRenderableTerminalOutput(fallbackSnapshotData)
      || pendingChunks.some((chunk) => hasRenderableTerminalOutput(chunk.data))
    ) {
      noteTerminalLoadingOutput(
        restored && canonicalSnapshot
          ? `${canonicalSnapshot.serialized}${canonicalSnapshot.delta}`
          : `${fallbackSnapshotData}${pendingChunks.map((chunk) => chunk.data).join("")}`,
      );
    }

    await rehydrateShellHomeDirFromRuntimeSnapshot();
    await deps.syncLayoutToPty({ refresh: true });
  }

  async function spawnNewPty(term: Terminal) {
    const { cols, rows } = deps.getInitialPtySize(term);
    state.mainMetadataRemainder = "";
    clearShellHomeDirCache();
    state.livePtyId = await deps.spawnPty(
      cols,
      rows,
      deps.getAgentId(),
      deps.getDistro(),
      deps.getWorkDir(),
      deps.getResumeToken(),
    );
    void deps.registerCanonicalSession({
      sessionId: deps.getSessionId(),
      ptyId: state.livePtyId,
      agentId: deps.getAgentId(),
    });
    const initialOutput = await deps.takePtyInitialOutput(state.livePtyId);
    let sanitizedOutput = initialOutput;
    if (sanitizedOutput.includes(RESUME_FAILED_MARKER)) {
      sanitizedOutput = sanitizedOutput
        .replaceAll(`${RESUME_FAILED_MARKER}\r\n`, "")
        .replaceAll(RESUME_FAILED_MARKER, "");
      void deps.onResumeFallback?.();
    }
    await writeMainTerminalData(term, sanitizedOutput);
    state.initialOutputReady = true;
    armBottomLock();
    noteTerminalLoadingOutput(sanitizedOutput);
    void deps.onPtyId?.(state.livePtyId);
  }

  async function attachOrSpawnPty(term: Terminal, options?: { loadingAlreadyShown?: boolean }) {
    state.spawnError = null;
    const storedPtyId = deps.getStoredPtyId();
    if (storedPtyId >= 0) {
      if (!options?.loadingAlreadyShown) {
        await showTerminalLoadingState("restoring");
      }
      try {
        await attachToExistingPty(storedPtyId, term);
        return;
      } catch (error) {
        console.warn("Failed to attach to existing PTY, spawning a new one", error);
        state.livePtyId = -1;
        state.replayInProgress = false;
        state.replayBuffer = [];
        state.initialOutputReady = false;
        state.terminalLoadingState = "connecting";
        state.terminalLoadingStartedAt = performance.now();
        state.terminalLoadingHasRenderableOutput = false;
        state.terminalLoadingReadySignalSeen = !requiresAgentReadySignal();
        clearShellHomeDirCache();
      }
    } else if (!options?.loadingAlreadyShown) {
      await showTerminalLoadingState("connecting");
    }

    await spawnNewPty(term);
  }

  function handlePtyExit(ptyId: number) {
    if (ptyId !== state.livePtyId) {
      return false;
    }

    void deps.onExit?.(ptyId);
    return true;
  }

  function handleSessionChange(nextSessionId: string) {
    if (state.shellHomeDirSessionId === null) {
      state.shellHomeDirSessionId = nextSessionId;
      return;
    }

    if (state.shellHomeDirSessionId === nextSessionId) {
      return;
    }

    state.shellHomeDirSessionId = nextSessionId;
    clearShellHomeDirCache();
    state.mainMetadataRemainder = "";
  }

  function dispose() {
    terminalLoadingLifecycle.dispose();
    clearDeferredBottomScrollTimer();
    releaseBottomLock();
    state.pendingPostWriteScroll = false;
  }

  return {
    armBottomLock,
    attachOrSpawnPty,
    clearTerminalLoadingState,
    disableAutoFollow,
    dispose,
    getLivePtyId,
    getShellHomeDirHint,
    handleMainOutputChunk,
    handlePtyExit,
    handleSessionChange,
    handleTerminalRender,
    handleTerminalResize,
    handleViewportScroll,
    handleWriteParsed,
    isBottomLockActive,
    showTerminalLoadingState,
  };
}

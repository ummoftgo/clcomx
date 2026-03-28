<script lang="ts">
  import { onMount, onDestroy, tick } from "svelte";
  import { Terminal } from "@xterm/xterm";
  import { FitAddon } from "@xterm/addon-fit";
  import { listen, type UnlistenFn } from "@tauri-apps/api/event";
  import { _ as t } from "svelte-i18n";
  import { getAgentDefinition, type AgentId } from "../agents";
  import { translate } from "../i18n";
  import { getSettings } from "../stores/settings.svelte";
  import {
    applyTmuxSessionSnapshot,
    clearTmuxSessionSnapshot,
    getTmuxSessionSnapshot,
  } from "../stores/tmux-snapshots.svelte";
  import { getThemeById } from "../themes";
  import { buildFontStack, serializeFontFamilyList } from "../font-family";
  import {
    killTmuxPane,
    resizeTmuxSession,
    selectTmuxPane,
    selectTmuxPaneDirection,
    sendTmuxInput,
    splitTmuxPane,
    subscribeTmuxSession,
    unsubscribeTmuxSession,
    type TmuxErrorEvent,
    type TmuxOutputEvent,
    type TmuxStateEvent,
    type TmuxSessionSnapshot,
  } from "../tmux";
  import { TEST_IDS, tmuxPaneTestId } from "../testids";
  import "@xterm/xterm/css/xterm.css";

  interface Props {
    sessionId: string;
    visible: boolean;
    agentId: AgentId;
    distro: string;
    workDir: string;
    resumeToken?: string | null;
    tmuxSessionName?: string | null;
    tmuxActivePaneId?: string | null;
    agentCentric?: boolean;
    primaryPaneId?: string | null;
    onStateChange?: (state: { tmuxSessionName: string | null; tmuxActivePaneId: string | null }) => void;
  }

  interface PaneLayoutDebugInfo {
    paneCols: number;
    paneRows: number;
    termCols: number;
    termRows: number;
    fitCols: number;
    fitRows: number;
    deltaCols: number;
    deltaRows: number;
    hostWidth: number;
    hostHeight: number;
    cellWidth: number;
    cellHeight: number;
    scrollbarWidth: number;
  }

  let {
    sessionId,
    visible,
    agentId,
    distro,
    workDir,
    resumeToken = null,
    tmuxSessionName = null,
    tmuxActivePaneId = null,
    agentCentric = false,
    primaryPaneId = null,
    onStateChange = () => {},
  }: Props = $props();

  const settings = getSettings();
  const terminalFontFamily = $derived(
    buildFontStack(
      serializeFontFamilyList(
        settings.terminal.fontFamily,
        "\"JetBrains Mono\", \"Cascadia Code\", Consolas",
      ),
      serializeFontFamilyList(
        settings.terminal.fontFamilyFallback,
        "\"Malgun Gothic\", NanumGothicCoding, monospace",
      ),
      "monospace",
    ),
  );

  let shellEl = $state<HTMLDivElement | null>(null);
  let toolbarEl = $state<HTMLDivElement | null>(null);
  let shellBodyEl = $state<HTMLDivElement | null>(null);
  let paneGridEl = $state<HTMLDivElement | null>(null);
  let paneStageEl = $state<HTMLDivElement | null>(null);
  let measureEl = $state<HTMLDivElement | null>(null);
  const snapshot = $derived(getTmuxSessionSnapshot(sessionId));
  let loadingState = $state<"connecting" | "restoring" | null>(null);
  let error = $state<string | null>(null);
  let liveSessionName = $state<string | null>(null);
  let liveActivePaneId = $state<string | null>(null);
  let resizeTimer: ReturnType<typeof setTimeout> | null = null;
  let prefixTimer: ReturnType<typeof setTimeout> | null = null;
  let resizeObserver: ResizeObserver | null = null;
  let unlistenTmuxState: UnlistenFn | null = null;
  let unlistenTmuxOutput: UnlistenFn | null = null;
  let unlistenTmuxError: UnlistenFn | null = null;
  let tmuxPrefixPending = $state(false);
  let outputEventCount = $state(0);
  let lastOutputPaneId = $state<string | null>(null);
  let paneLayoutDebug = $state<Record<string, PaneLayoutDebugInfo>>({});
  let inFlightResizeTarget = $state<{ cols: number; rows: number } | null>(null);
  let inFlightResizeRequest: Promise<void> | null = null;
  let measureReady = $state(false);
  let measurementGateOpen = $state(false);
  let lastResizeSyncKey = $state<string | null>(null);
  let lastRenderablePaneKey = $state<string | null>(null);
  const subscriberId = crypto.randomUUID();
  let measureTerminal: Terminal | null = null;
  let measureFitAddon: FitAddon | null = null;

  const TMUX_PREFIX = "\u0002";
  const TMUX_PREFIX_TIMEOUT_MS = 1600;
  const TMUX_SESSION_COL_GUARD = 1;
  const TMUX_MIN_SESSION_COLS = 20;
  const TMUX_MIN_SESSION_ROWS = 8;

  const paneElements = new Map<string, HTMLDivElement>();
  const pendingPaneOutput = new Map<string, string[]>();
  const paneTerminals = new Map<
    string,
    {
      term: Terminal;
      lastContent: string;
      hydrating: boolean;
      bufferedOutput: string[];
      suppressUntil: number;
      flushTimer: ReturnType<typeof setTimeout> | null;
    }
  >();

  const loadingLabel = $derived(
    loadingState === "restoring" ? $t("terminal.tmux.restoring") : $t("terminal.tmux.connecting"),
  );
  const activePaneSummary = $derived.by(() => {
    if (!snapshot || !liveActivePaneId) return null;
    const pane = snapshot.panes.find((entry) => entry.paneId === liveActivePaneId) ?? null;
    if (!pane) return null;
    return pane.currentCommand || pane.currentPath || pane.paneId;
  });

  function buildStartCommand() {
    const agent = getAgentDefinition(agentId);
    return resumeToken ? agent.buildResumeCommand(resumeToken) : agent.buildStartCommand();
  }

  function buildExpectedSessionName(seed: string) {
    const normalized = seed
      .split("")
      .map((ch) => (/^[A-Za-z0-9_-]$/.test(ch) ? ch : "-"))
      .join("")
      .replace(/--+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48);

    if (!normalized) {
      return "clcomx-session";
    }

    return normalized.startsWith("clcomx-") ? normalized : `clcomx-${normalized}`;
  }

  function getPersistedSessionName() {
    return liveSessionName ?? tmuxSessionName ?? null;
  }

  function scheduleSessionResize(delayMs = 0) {
    if (resizeTimer) {
      clearTimeout(resizeTimer);
    }
    resizeTimer = setTimeout(() => {
      resizeTimer = null;
      void syncMeasuredViewportSize();
    }, Math.max(delayMs, 0));
  }

  function estimateWindowSize() {
    if (measureTerminal && measureFitAddon && measureEl) {
      measureFitAddon.fit();
      return {
        cols: Math.max(TMUX_MIN_SESSION_COLS, measureTerminal.cols - TMUX_SESSION_COL_GUARD),
        rows: Math.max(TMUX_MIN_SESSION_ROWS, measureTerminal.rows),
      };
    }

    const width = Math.max(
      paneStageEl?.clientWidth || paneGridEl?.clientWidth || shellBodyEl?.clientWidth || shellEl?.clientWidth || 0,
      960,
    );
    const height = Math.max(
      paneStageEl?.clientHeight ||
        paneGridEl?.clientHeight ||
        shellBodyEl?.clientHeight ||
        Math.max((shellEl?.clientHeight ?? 0) - (toolbarEl?.offsetHeight ?? 0) - 12, 0),
      540,
    );
    return {
      cols: Math.max(
        TMUX_MIN_SESSION_COLS,
        Math.round(width / Math.max(settings.terminal.fontSize * 0.62, 7)) - TMUX_SESSION_COL_GUARD,
      ),
      rows: Math.max(TMUX_MIN_SESSION_ROWS, Math.round(height / Math.max(settings.terminal.fontSize * 1.78, 16))),
    };
  }

  function ensureMeasureTerminal() {
    if (!measureEl || measureTerminal) return;
    measureFitAddon = new FitAddon();
    measureTerminal = new Terminal({
      fontSize: settings.terminal.fontSize,
      fontFamily: terminalFontFamily,
      theme: getThemeById(settings.interface.theme)?.theme,
      cursorBlink: false,
      cursorStyle: "block",
      disableStdin: true,
      scrollback: 0,
    });
    measureTerminal.loadAddon(measureFitAddon);
    measureTerminal.open(measureEl);
    measureFitAddon.fit();
    measureReady = true;
    if (snapshot && liveSessionName && visible) {
      scheduleSessionResize(80);
    }
  }

  async function waitForFontMetricsReady() {
    if (!("fonts" in document)) return;
    try {
      await Promise.race([
        (document as Document & { fonts?: FontFaceSet }).fonts?.ready ?? Promise.resolve(),
        new Promise((resolve) => setTimeout(resolve, 250)),
      ]);
    } catch {
      // Fall back when font readiness cannot be observed.
    }
  }

  async function waitForNextFrame() {
    await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
  }

  function getPaneStyle(pane: TmuxSessionSnapshot["panes"][number]) {
    if (agentCentric) {
      return "left:0;top:0;width:100%;height:100%";
    }
    return [
      `left:${(pane.left / layoutWidth) * 100}%`,
      `top:${(pane.top / layoutHeight) * 100}%`,
      `width:${(pane.width / layoutWidth) * 100}%`,
      `height:${(pane.height / layoutHeight) * 100}%`,
    ].join(";");
  }

  function paneAction(node: HTMLDivElement, paneId: string) {
    const syncActivePaneFromViewport = () => {
      if (liveActivePaneId !== paneId) {
        void activatePane(paneId);
      }
    };

    node.addEventListener("pointerdown", syncActivePaneFromViewport, true);
    node.addEventListener("focusin", syncActivePaneFromViewport, true);
    paneElements.set(paneId, node);
    if (!paneTerminals.has(paneId)) {
      createPaneTerminal(paneId, node);
        const pane = snapshot?.panes.find((entry) => entry.paneId === paneId);
        if (pane) {
          queueMicrotask(() => {
            void syncSinglePaneTerminal(pane, false);
          });
        }
    }
    return {
      update(nextPaneId: string) {
        if (nextPaneId === paneId) return;
        paneElements.delete(paneId);
        paneId = nextPaneId;
        paneElements.set(paneId, node);
        if (!paneTerminals.has(paneId)) {
          createPaneTerminal(paneId, node);
        }
        const pane = snapshot?.panes.find((entry) => entry.paneId === paneId);
        if (pane) {
          queueMicrotask(() => {
            void syncSinglePaneTerminal(pane, false);
          });
        }
      },
      destroy() {
        node.removeEventListener("pointerdown", syncActivePaneFromViewport, true);
        node.removeEventListener("focusin", syncActivePaneFromViewport, true);
        paneElements.delete(paneId);
      },
    };
  }

  function notifyState() {
    onStateChange({
      tmuxSessionName: liveSessionName,
      tmuxActivePaneId: liveActivePaneId,
    });
  }

  function clearTmuxPrefix() {
    tmuxPrefixPending = false;
    if (prefixTimer) {
      clearTimeout(prefixTimer);
      prefixTimer = null;
    }
  }

  function armTmuxPrefix() {
    tmuxPrefixPending = true;
    if (prefixTimer) {
      clearTimeout(prefixTimer);
    }
    prefixTimer = setTimeout(() => {
      tmuxPrefixPending = false;
      prefixTimer = null;
    }, TMUX_PREFIX_TIMEOUT_MS);
  }

  function disposeRemovedPaneTerminals(nextSnapshot: TmuxSessionSnapshot | null) {
    const paneIds = new Set(getRenderablePanes(nextSnapshot).map((pane) => pane.paneId));
    for (const [paneId, entry] of paneTerminals) {
      if (paneIds.has(paneId)) continue;
      if (entry.flushTimer) {
        clearTimeout(entry.flushTimer);
      }
      entry.term.dispose();
      paneTerminals.delete(paneId);
      pendingPaneOutput.delete(paneId);
      delete paneLayoutDebug[paneId];
    }
  }

  function getPaneLayoutDebugInfo(
    pane: TmuxSessionSnapshot["panes"][number],
    entry: { term: Terminal },
  ): PaneLayoutDebugInfo | null {
    const host = paneElements.get(pane.paneId);
    const termEl = entry.term.element;
    if (!host || !termEl) return null;

    const core = (entry.term as Terminal & { _core?: any })._core;
    const cell = core?._renderService?.dimensions?.css?.cell;
    const cellWidth = cell?.width ?? 0;
    const cellHeight = cell?.height ?? 0;
    if (!cellWidth || !cellHeight) return null;

    const termStyle = window.getComputedStyle(termEl);
    const paddingX =
      parseFloat(termStyle.getPropertyValue("padding-left")) +
      parseFloat(termStyle.getPropertyValue("padding-right"));
    const paddingY =
      parseFloat(termStyle.getPropertyValue("padding-top")) +
      parseFloat(termStyle.getPropertyValue("padding-bottom"));
    const scrollbarWidth = 0;
    const availableWidth = Math.max(host.clientWidth - paddingX, 0);
    const availableHeight = Math.max(host.clientHeight - paddingY, 0);
    const fitCols = Math.max(2, Math.floor(availableWidth / cellWidth));
    const fitRows = Math.max(1, Math.floor(availableHeight / cellHeight));

    return {
      paneCols: pane.width,
      paneRows: pane.height,
      termCols: entry.term.cols,
      termRows: entry.term.rows,
      fitCols,
      fitRows,
      deltaCols: fitCols - pane.width,
      deltaRows: fitRows - pane.height,
      hostWidth: host.clientWidth,
      hostHeight: host.clientHeight,
      cellWidth,
      cellHeight,
      scrollbarWidth,
    };
  }

  function updatePaneLayoutDebugInfo(pane: TmuxSessionSnapshot["panes"][number]) {
    const entry = paneTerminals.get(pane.paneId);
    if (!entry) return;
    const debugInfo = getPaneLayoutDebugInfo(pane, entry);
    if (!debugInfo) return;
    paneLayoutDebug[pane.paneId] = debugInfo;
  }

  function schedulePaneLayoutDebugInfo(pane: TmuxSessionSnapshot["panes"][number]) {
    requestAnimationFrame(() => {
      updatePaneLayoutDebugInfo(pane);
    });
  }

  function hasMatchingResizeTarget(target: { cols: number; rows: number } | null, cols: number, rows: number) {
    return target?.cols === cols && target?.rows === rows;
  }

  async function requestSessionResize(cols: number, rows: number, errorLabel: string) {
    if (!liveSessionName) return;
    if (snapshot && cols === snapshot.width && rows === snapshot.height) {
      return;
    }
    if (hasMatchingResizeTarget(inFlightResizeTarget, cols, rows) && inFlightResizeRequest) {
      await inFlightResizeRequest;
      return;
    }

    const request = (async () => {
      inFlightResizeTarget = { cols, rows };
      await resizeTmuxSession(sessionId, distro, liveSessionName, cols, rows);
    })()
      .catch((resizeError) => {
        console.error(errorLabel, resizeError);
      })
      .finally(() => {
        if (hasMatchingResizeTarget(inFlightResizeTarget, cols, rows)) {
          inFlightResizeTarget = null;
        }
        if (inFlightResizeRequest === request) {
          inFlightResizeRequest = null;
        }
      });

    inFlightResizeRequest = request;
    await request;
  }

  function resetResizeRequestState() {
    inFlightResizeTarget = null;
    inFlightResizeRequest = null;
  }

  function flushBufferedPaneOutput(paneId: string) {
    const entry = paneTerminals.get(paneId);
    if (!entry) return;
    entry.flushTimer = null;

    if (entry.hydrating) {
      if (entry.bufferedOutput.length) {
        scheduleBufferedPaneFlush(paneId, 24);
      }
      return;
    }

    if (!entry.bufferedOutput.length) {
      return;
    }

    const combined = entry.bufferedOutput.join("");
    entry.bufferedOutput = [];
    if (!combined) {
      return;
    }

    if (entry.lastContent.endsWith(combined)) {
      return;
    }

    entry.term.write(combined, () => {
      entry.lastContent += combined;
      if (entry.lastContent.length > 256 * 1024) {
        entry.lastContent = entry.lastContent.slice(-256 * 1024);
      }
    });
  }

  function splitSnapshotLines(value: string) {
    if (!value) return [];
    const trimmed = value.replace(/\r?\n$/, "");
    if (!trimmed) return [];
    return trimmed.split(/\r?\n/);
  }

  function buildSnapshotText(pane: TmuxSessionSnapshot["panes"][number]) {
    return splitSnapshotLines(pane.screenText).join("\n");
  }

  function buildVisibleScreenSequence(
    pane: TmuxSessionSnapshot["panes"][number],
    cursorRow: number,
    cursorCol: number,
  ) {
    const screenLines = splitSnapshotLines(pane.screenText);
    let sequence = "\u001b[H\u001b[2J\u001b[?7l";
    const rowCount = Math.min(screenLines.length, Math.max(pane.height, 0));
    for (let index = 0; index < rowCount; index += 1) {
      sequence += `\u001b[${index + 1};1H\u001b[2K${screenLines[index]}`;
    }
    sequence += `\u001b[?7h\u001b[${cursorRow};${cursorCol}H`;
    return sequence;
  }

  function scheduleBufferedPaneFlush(paneId: string, delayMs = 140) {
    const entry = paneTerminals.get(paneId);
    if (!entry) return;
    if (entry.flushTimer) {
      clearTimeout(entry.flushTimer);
    }
    entry.flushTimer = setTimeout(() => {
      flushBufferedPaneOutput(paneId);
    }, delayMs);
  }

  function createPaneTerminal(paneId: string, host: HTMLDivElement) {
    const theme = getThemeById(settings.interface.theme)?.theme;
    const term = new Terminal({
      fontSize: settings.terminal.fontSize,
      fontFamily: terminalFontFamily,
      theme,
      cursorBlink: false,
      cursorStyle: "block",
      disableStdin: false,
      scrollback: 0,
      allowProposedApi: true,
    });
    const entry = {
      term,
      lastContent: "",
      hydrating: true,
      bufferedOutput: [],
      suppressUntil: 0,
      flushTimer: null,
    };
    term.open(host);
    term.onData((data) => {
      const pane = snapshot?.panes.find((entry) => entry.paneId === paneId);
      if (pane?.dead) return;
      if (liveActivePaneId !== paneId) {
        void activatePane(paneId);
      }
      void (async () => {
        if (await handleTmuxShortcutInput(paneId, data)) {
          return;
        }
        await sendTmuxInput(sessionId, distro, paneId, data);
      })();
    });
    paneTerminals.set(paneId, entry);
    const pane = snapshot?.panes.find((item) => item.paneId === paneId);
    if (pane) {
      schedulePaneLayoutDebugInfo(pane);
    }
    const pending = pendingPaneOutput.get(paneId);
    if (pending?.length) {
      pendingPaneOutput.delete(paneId);
      for (const chunk of pending) {
        const entry = paneTerminals.get(paneId);
        if (entry) {
          entry.bufferedOutput.push(chunk);
        }
      }
    }
  }

  function appendPaneOutput(paneId: string, data: string) {
    outputEventCount += 1;
    lastOutputPaneId = paneId;
    if (agentCentric) {
      const displayPaneId = getDisplayPaneId(snapshot);
      if (displayPaneId && paneId !== displayPaneId) {
        return;
      }
    }
    const entry = paneTerminals.get(paneId);
    if (!entry) {
      const pending = pendingPaneOutput.get(paneId) ?? [];
      pending.push(data);
      pendingPaneOutput.set(paneId, pending);
      return;
    }

    if (entry.hydrating || Date.now() < entry.suppressUntil) {
      entry.bufferedOutput.push(data);
      const delayMs = Math.max(entry.suppressUntil - Date.now(), 0);
      scheduleBufferedPaneFlush(paneId, delayMs > 0 ? delayMs + 24 : 24);
      return;
    }

    entry.term.write(data, () => {
      entry.lastContent += data;
      if (entry.lastContent.length > 256 * 1024) {
        entry.lastContent = entry.lastContent.slice(-256 * 1024);
      }
    });
  }

  async function syncSinglePaneTerminal(
    pane: TmuxSessionSnapshot["panes"][number],
    structuralChange: boolean,
  ) {
    const host = paneElements.get(pane.paneId);
    if (!host) return;
    if (!paneTerminals.has(pane.paneId)) {
      createPaneTerminal(pane.paneId, host);
    }

    const entry = paneTerminals.get(pane.paneId);
    if (!entry) return;

    entry.hydrating = true;
    if (entry.flushTimer) {
      clearTimeout(entry.flushTimer);
      entry.flushTimer = null;
    }
    entry.term.resize(Math.max(2, pane.width), Math.max(1, pane.height));
    const cursorRow = Math.min(Math.max(pane.cursorY, 0), Math.max(pane.height - 1, 0)) + 1;
    const cursorCol = Math.min(Math.max(pane.cursorX, 0), Math.max(pane.width - 1, 0)) + 1;
    const snapshotContent = buildSnapshotText(pane);
    const visibleScreenSequence = buildVisibleScreenSequence(pane, cursorRow, cursorCol);
    entry.term.reset();
    entry.term.write(visibleScreenSequence, () => {
      const lastRow = Math.max(pane.height - 1, 0);
      entry.term.refresh(0, lastRow);
      entry.lastContent = snapshotContent;
      entry.hydrating = false;
      schedulePaneLayoutDebugInfo(pane);
      entry.suppressUntil = Date.now() + (structuralChange ? 900 : 260);
      if (entry.bufferedOutput.length) {
        const delayMs = Math.max(entry.suppressUntil - Date.now(), 0);
        scheduleBufferedPaneFlush(pane.paneId, delayMs > 0 ? delayMs + 24 : 24);
      }
    });

    if (visible && pane.active) {
      entry.term.focus();
    }
  }

  function isStructuralSnapshotChange(
    previousSnapshot: TmuxSessionSnapshot | null,
    nextSnapshot: TmuxSessionSnapshot,
  ) {
    if (!previousSnapshot) return true;
    if (
      previousSnapshot.width !== nextSnapshot.width ||
      previousSnapshot.height !== nextSnapshot.height ||
      previousSnapshot.panes.length !== nextSnapshot.panes.length
    ) {
      return true;
    }

    for (let index = 0; index < nextSnapshot.panes.length; index += 1) {
      const prev = previousSnapshot.panes[index];
      const next = nextSnapshot.panes[index];
      if (!prev) return true;
      if (
        prev.paneId !== next.paneId ||
        prev.left !== next.left ||
        prev.top !== next.top ||
        prev.width !== next.width ||
        prev.height !== next.height ||
        prev.dead !== next.dead
      ) {
        return true;
      }
    }

    return false;
  }

  function shouldRehydratePane(
    previousPane: TmuxSessionSnapshot["panes"][number] | null,
    nextPane: TmuxSessionSnapshot["panes"][number],
  ) {
    if (!previousPane) return true;
    return (
      previousPane.width !== nextPane.width ||
      previousPane.height !== nextPane.height ||
      previousPane.cursorX !== nextPane.cursorX ||
      previousPane.cursorY !== nextPane.cursorY ||
      previousPane.dead !== nextPane.dead ||
      previousPane.screenText !== nextPane.screenText
    );
  }

  async function syncPaneTerminals(
    previousSnapshot: TmuxSessionSnapshot | null,
    nextSnapshot: TmuxSessionSnapshot | null,
    structuralChange: boolean,
  ) {
    if (!nextSnapshot) return;
    await tick();
    disposeRemovedPaneTerminals(nextSnapshot);
    const previousPanesById = new Map(
      getRenderablePanes(previousSnapshot).map((pane) => [pane.paneId, pane]),
    );

    for (const pane of getRenderablePanes(nextSnapshot)) {
      const previousPane = previousPanesById.get(pane.paneId) ?? null;
      if (structuralChange || shouldRehydratePane(previousPane, pane)) {
        await syncSinglePaneTerminal(pane, structuralChange);
        continue;
      }

      if (visible && pane.active) {
        paneTerminals.get(pane.paneId)?.term.focus();
      }
      schedulePaneLayoutDebugInfo(pane);
    }
  }

  async function syncMeasuredViewportSize() {
    if (!liveSessionName || !visible) return;
    if (!measureReady) return;
    await tick();
    await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
    if (!snapshot) return;
    const { cols, rows } = estimateWindowSize();
    await requestSessionResize(cols, rows, "Failed to sync tmux viewport size");
  }

  async function applySnapshot(nextSnapshot: TmuxSessionSnapshot) {
    const previousSnapshot = getTmuxSessionSnapshot(sessionId);
    const effectiveSnapshot =
      applyTmuxSessionSnapshot(sessionId, nextSnapshot) ??
      getTmuxSessionSnapshot(sessionId) ??
      nextSnapshot;
    const structuralChange = isStructuralSnapshotChange(previousSnapshot, effectiveSnapshot);
    liveSessionName = liveSessionName ?? tmuxSessionName ?? effectiveSnapshot.sessionName;
    liveActivePaneId = effectiveSnapshot.activePaneId;
    notifyState();
    await syncPaneTerminals(previousSnapshot, effectiveSnapshot, structuralChange);
    if (!previousSnapshot) {
      scheduleSessionResize(80);
    }
  }

  async function ensureTmuxSession() {
    loadingState = liveSessionName ? "restoring" : "connecting";
    error = null;
    measureReady = Boolean(measureTerminal);
    lastResizeSyncKey = null;
    resetResizeRequestState();
    try {
      const existingSessionName = getPersistedSessionName();
      const { cols, rows } = estimateWindowSize();
      const nextSessionName = buildExpectedSessionName(existingSessionName ?? sessionId);
      liveSessionName = nextSessionName;
      liveActivePaneId = null;
      notifyState();
      const created = await subscribeTmuxSession(
        sessionId,
        subscriberId,
        distro,
        workDir,
        buildStartCommand(),
        nextSessionName,
        cols,
        rows,
        0,
      );
      await applySnapshot(created);
    } catch (createError) {
      console.error("Failed to initialize tmux session", createError);
      error = String(createError);
    } finally {
      loadingState = null;
    }
  }

  async function setupTmuxEventListeners() {
    unlistenTmuxState = await listen<TmuxStateEvent>("clcomx:tmux/state", (event) => {
      if (event.payload.sessionId !== sessionId) return;
      error = null;
      void applySnapshot(event.payload.snapshot);
    });

    unlistenTmuxOutput = await listen<TmuxOutputEvent>("clcomx:tmux/output", (event) => {
      if (event.payload.sessionId !== sessionId) return;
      appendPaneOutput(event.payload.paneId, event.payload.data);
    });

    unlistenTmuxError = await listen<TmuxErrorEvent>("clcomx:tmux/error", (event) => {
      if (event.payload.sessionId !== sessionId) return;
      error = event.payload.message || translate("terminal.tmux.missing");
    });
  }

  async function teardownTmuxEventListeners() {
    const listeners = [unlistenTmuxState, unlistenTmuxOutput, unlistenTmuxError];
    unlistenTmuxState = null;
    unlistenTmuxOutput = null;
    unlistenTmuxError = null;
    for (const unlisten of listeners) {
      if (unlisten) {
        await unlisten();
      }
    }
    await unsubscribeTmuxSession(sessionId, subscriberId);
  }

  async function restartTmuxSession() {
    error = null;
    liveSessionName = null;
    liveActivePaneId = null;
    clearTmuxSessionSnapshot(sessionId);
    lastResizeSyncKey = null;
    resetResizeRequestState();
    notifyState();
    await ensureTmuxSession();
  }

  async function activatePane(paneId: string) {
    liveActivePaneId = paneId;
    notifyState();
    await selectTmuxPane(sessionId, distro, paneId);
    const paneTerminal = paneTerminals.get(paneId);
    paneTerminal?.term.focus();
  }

  async function handleSplit(direction: "horizontal" | "vertical") {
    if (!liveActivePaneId) return;
    await splitTmuxPane(sessionId, distro, liveActivePaneId, direction, workDir);
  }

  async function handleClosePane() {
    if (!liveActivePaneId || !snapshot || snapshot.panes.length <= 1) return;
    await killTmuxPane(sessionId, distro, liveActivePaneId);
  }

  function findNextPaneId(currentPaneId: string) {
    if (!snapshot || snapshot.panes.length <= 1) return null;
    const currentIndex = snapshot.panes.findIndex((pane) => pane.paneId === currentPaneId);
    if (currentIndex < 0) {
      return snapshot.panes[0]?.paneId ?? null;
    }
    return snapshot.panes[(currentIndex + 1) % snapshot.panes.length]?.paneId ?? null;
  }

  async function handleSelectPaneDirection(direction: "left" | "right" | "up" | "down") {
    if (!liveActivePaneId) return;
    await selectTmuxPaneDirection(sessionId, distro, liveActivePaneId, direction);
  }

  async function handleTmuxShortcutInput(paneId: string, data: string) {
    if (data === TMUX_PREFIX) {
      armTmuxPrefix();
      return true;
    }

    if (!tmuxPrefixPending) {
      return false;
    }

    clearTmuxPrefix();

    switch (data) {
      case TMUX_PREFIX:
        await sendTmuxInput(sessionId, distro, paneId, data);
        return true;
      case "%":
        await handleSplit("horizontal");
        return true;
      case "\"":
        await handleSplit("vertical");
        return true;
      case "x":
      case "X":
        await handleClosePane();
        return true;
      case "o":
      case "O": {
        const nextPaneId = findNextPaneId(paneId);
        if (nextPaneId) {
          await activatePane(nextPaneId);
        }
        return true;
      }
      case "h":
      case "H":
      case "\u001b[D":
        await handleSelectPaneDirection("left");
        return true;
      case "l":
      case "L":
      case "\u001b[C":
        await handleSelectPaneDirection("right");
        return true;
      case "k":
      case "K":
      case "\u001b[A":
        await handleSelectPaneDirection("up");
        return true;
      case "j":
      case "J":
      case "\u001b[B":
        await handleSelectPaneDirection("down");
        return true;
      default:
        return true;
    }
  }

  function handleResize() {
    if (!liveSessionName) return;
    scheduleSessionResize(40);
  }

  $effect(() => {
    tmuxSessionName;
    tmuxActivePaneId;
    if (!liveSessionName && tmuxSessionName) {
      liveSessionName = tmuxSessionName;
    }
    if (!liveActivePaneId && tmuxActivePaneId) {
      liveActivePaneId = tmuxActivePaneId;
    }
  });

  $effect(() => {
    shellBodyEl;
    paneGridEl;
    paneStageEl;
    measureEl;
    measurementGateOpen;
    if (!measurementGateOpen) {
      return;
    }
    ensureMeasureTerminal();
    if (measureTerminal) {
      measureReady = true;
      measureTerminal.options.fontSize = settings.terminal.fontSize;
      measureTerminal.options.fontFamily = terminalFontFamily;
      measureTerminal.options.theme = getThemeById(settings.interface.theme)?.theme;
      measureFitAddon?.fit();
      if (snapshot && liveSessionName && visible) {
        scheduleSessionResize(80);
      }
    }
  });

  $effect(() => {
    const sessionName = snapshot?.sessionName ?? null;
    const snapshotWidth = snapshot?.width ?? null;
    const snapshotHeight = snapshot?.height ?? null;
    visible;
    measureReady;
    liveSessionName;

    if (!visible || !measureReady || !liveSessionName || !sessionName || snapshotWidth === null || snapshotHeight === null) {
      return;
    }

    const syncKey = `${sessionName}:${snapshotWidth}x${snapshotHeight}:${settings.terminal.fontSize}:${terminalFontFamily}`;
    if (lastResizeSyncKey === syncKey) {
      return;
    }

    lastResizeSyncKey = syncKey;
    scheduleSessionResize(80);
  });

  $effect(() => {
    resizeObserver;
    shellEl;
    toolbarEl;
    shellBodyEl;
    paneGridEl;
    paneStageEl;

    if (!resizeObserver) return;

    const targets = [shellEl, toolbarEl, shellBodyEl, paneGridEl, paneStageEl].filter(
      (value): value is HTMLDivElement => Boolean(value),
    );
    for (const target of targets) {
      resizeObserver.observe(target);
    }

    handleResize();

    return () => {
      for (const target of targets) {
        resizeObserver?.unobserve(target);
      }
    };
  });

  onMount(() => {
    resizeObserver = new ResizeObserver(() => {
      measureFitAddon?.fit();
      handleResize();
    });
    void (async () => {
      await tick();
      await waitForFontMetricsReady();
      measurementGateOpen = true;
      ensureMeasureTerminal();
      await waitForNextFrame();
      measureFitAddon?.fit();
      await setupTmuxEventListeners();
      await ensureTmuxSession();
    })();
  });

  onDestroy(() => {
    if (resizeTimer) clearTimeout(resizeTimer);
    clearTmuxPrefix();
    resizeObserver?.disconnect();
    lastResizeSyncKey = null;
    resetResizeRequestState();
    void teardownTmuxEventListeners();
    for (const entry of paneTerminals.values()) {
      if (entry.flushTimer) {
        clearTimeout(entry.flushTimer);
      }
      entry.term.dispose();
    }
    measureTerminal?.dispose();
    measureTerminal = null;
    measureFitAddon = null;
    measureReady = false;
    measurementGateOpen = false;
    paneTerminals.clear();
    pendingPaneOutput.clear();
  });

  const layoutWidth = $derived(Math.max(snapshot?.width ?? 0, 1));
  const layoutHeight = $derived(Math.max(snapshot?.height ?? 0, 1));

  function getDisplayPaneId(nextSnapshot: TmuxSessionSnapshot | null) {
    if (!nextSnapshot) return null;
    if (primaryPaneId && nextSnapshot.panes.some((pane) => pane.paneId === primaryPaneId)) {
      return primaryPaneId;
    }
    return nextSnapshot.panes[0]?.paneId ?? nextSnapshot.activePaneId ?? null;
  }

  function getRenderablePanes(nextSnapshot: TmuxSessionSnapshot | null) {
    if (!nextSnapshot) return [];
    if (!agentCentric) {
      return nextSnapshot.panes;
    }
    const displayPaneId = getDisplayPaneId(nextSnapshot);
    return nextSnapshot.panes.filter((pane) => pane.paneId === displayPaneId);
  }

  $effect(() => {
    const renderablePaneKey = getRenderablePanes(snapshot)
      .map((pane) => pane.paneId)
      .join(",");

    if (!snapshot) {
      lastRenderablePaneKey = null;
      return;
    }

    if (renderablePaneKey === lastRenderablePaneKey) {
      return;
    }

    lastRenderablePaneKey = renderablePaneKey;
    queueMicrotask(() => {
      disposeRemovedPaneTerminals(snapshot);
      for (const pane of getRenderablePanes(snapshot)) {
        void syncSinglePaneTerminal(pane, true);
      }
    });
  });
</script>

<div
  class="tmux-shell"
  class:tmux-shell--hidden={!visible}
  data-testid={TEST_IDS.tmuxShell}
  bind:this={shellEl}
>
  <div class="tmux-toolbar" data-testid={TEST_IDS.tmuxToolbar} bind:this={toolbarEl}>
    <div class="tmux-session-label">
      <strong>{$t("terminal.tmux.session")}</strong>
      <span>{liveSessionName ?? "—"}</span>
      <small class="tmux-debug-meta">
        panes:{snapshot?.panes.length ?? 0}
        {#if activePaneSummary}
          · active:{activePaneSummary}
        {/if}
        · out:{outputEventCount} {lastOutputPaneId ?? "-"}
      </small>
    </div>
    <div class="tmux-actions">
      <button class="tmux-action" onclick={() => void handleSplit("horizontal")} disabled={!liveActivePaneId}>
        {$t("terminal.tmux.splitHorizontal")}
      </button>
      <button class="tmux-action" onclick={() => void handleSplit("vertical")} disabled={!liveActivePaneId}>
        {$t("terminal.tmux.splitVertical")}
      </button>
      <button
        class="tmux-action tmux-action--danger"
        onclick={() => void handleClosePane()}
        disabled={!liveActivePaneId || (snapshot?.panes.length ?? 0) <= 1}
      >
        {$t("terminal.tmux.closePane")}
      </button>
    </div>
  </div>

  <div class="tmux-shell-body" bind:this={shellBodyEl}>
    <div class="tmux-measure-probe" bind:this={measureEl}></div>
    {#if error}
      <div class="tmux-state-card tmux-state-card--error">
        <p>{error}</p>
        <button class="tmux-action" onclick={() => void restartTmuxSession()}>
          {$t("terminal.tmux.restart")}
        </button>
      </div>
    {:else if !snapshot}
      <div class="tmux-state-card">
        <div class="tmux-spinner" aria-hidden="true"></div>
        <p>{loadingLabel}</p>
      </div>
    {:else}
      <div class="tmux-pane-grid" data-testid={TEST_IDS.tmuxPaneGrid} bind:this={paneGridEl}>
        <div class="tmux-pane-stage" bind:this={paneStageEl}>
          {#each getRenderablePanes(snapshot) as pane (pane.paneId)}
            <section
              class="tmux-pane"
              class:tmux-pane--active={pane.paneId === liveActivePaneId}
              class:tmux-pane--dead={pane.dead}
              data-testid={tmuxPaneTestId(pane.paneId)}
              style={getPaneStyle(pane)}
              role="button"
              tabindex="-1"
              onclick={() => void activatePane(pane.paneId)}
            >
              <div class="tmux-pane-meta">
                <span class="tmux-pane-title">{pane.currentPath || workDir}</span>
                {#if pane.dead}
                  <span class="tmux-pane-badge">{$t("terminal.tmux.paneDead")}</span>
                {:else if pane.currentCommand}
                  <span class="tmux-pane-badge">{pane.currentCommand}</span>
                {/if}
              </div>
              <div class="tmux-pane-body">
                <div class="tmux-pane-viewport" use:paneAction={pane.paneId}></div>
              </div>
              {#if paneLayoutDebug[pane.paneId]}
                <div class="tmux-pane-geometry-debug" aria-hidden="true">
                  <div>
                    pane {paneLayoutDebug[pane.paneId].paneCols}x{paneLayoutDebug[pane.paneId].paneRows} / term
                    {paneLayoutDebug[pane.paneId].termCols}x{paneLayoutDebug[pane.paneId].termRows}
                  </div>
                  <div>
                    fit {paneLayoutDebug[pane.paneId].fitCols}x{paneLayoutDebug[pane.paneId].fitRows} / delta
                    {paneLayoutDebug[pane.paneId].deltaCols >= 0 ? "+" : ""}{paneLayoutDebug[pane.paneId].deltaCols}x{paneLayoutDebug[pane.paneId].deltaRows >= 0 ? "+" : ""}{paneLayoutDebug[pane.paneId].deltaRows}
                  </div>
                  <div>
                    host {paneLayoutDebug[pane.paneId].hostWidth}x{paneLayoutDebug[pane.paneId].hostHeight} / cell
                    {paneLayoutDebug[pane.paneId].cellWidth.toFixed(2)}x{paneLayoutDebug[pane.paneId].cellHeight.toFixed(2)}
                    / sb {paneLayoutDebug[pane.paneId].scrollbarWidth}
                  </div>
                </div>
              {/if}
            </section>
          {/each}
        </div>
      </div>
    {/if}
  </div>
</div>

<style>
  .tmux-shell {
    position: absolute;
    inset: 0;
    display: grid;
    grid-template-rows: auto 1fr;
    gap: var(--ui-space-3);
    padding: var(--ui-space-3);
    overflow: hidden;
  }

  .tmux-shell--hidden {
    display: none;
  }

  .tmux-toolbar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--ui-space-3);
    padding: var(--ui-space-3);
    border: 1px solid var(--ui-border-subtle);
    border-radius: var(--ui-radius-lg);
    background: color-mix(in srgb, var(--ui-bg-surface) 92%, var(--ui-bg-surface-elevated));
  }

  .tmux-session-label {
    display: grid;
    gap: 2px;
    min-width: 0;
    color: var(--ui-text-secondary);
  }

  .tmux-session-label strong {
    color: var(--ui-text-primary);
  }

  .tmux-debug-meta {
    opacity: 0.7;
    font-size: 11px;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  }

  .tmux-actions {
    display: flex;
    gap: var(--ui-space-2);
    flex-wrap: wrap;
    justify-content: flex-end;
  }

  .tmux-action {
    min-height: calc(34px * var(--ui-scale));
    padding: calc(8px * var(--ui-scale)) calc(12px * var(--ui-scale));
    border-radius: var(--ui-radius-md);
    border: 1px solid var(--ui-border-subtle);
    background: color-mix(in srgb, var(--ui-bg-surface-elevated) 86%, var(--ui-accent-soft));
    color: var(--ui-text-primary);
    cursor: pointer;
    font-size: var(--ui-font-size-sm);
    font-weight: 600;
  }

  .tmux-action--danger {
    border-color: color-mix(in srgb, #ef4444 40%, var(--ui-border-subtle));
  }

  .tmux-action:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .tmux-state-card {
    display: grid;
    place-items: center;
    gap: var(--ui-space-3);
    width: 100%;
    height: 100%;
    min-height: 0;
    border: 1px solid var(--ui-border-subtle);
    border-radius: var(--ui-radius-xl);
    background: color-mix(in srgb, var(--ui-bg-surface) 92%, var(--ui-bg-surface-elevated));
    color: var(--ui-text-secondary);
  }

  .tmux-state-card--error {
    color: var(--ui-text-primary);
  }

  .tmux-spinner {
    width: 24px;
    height: 24px;
    border-radius: 999px;
    border: 2px solid color-mix(in srgb, var(--ui-accent) 35%, transparent);
    border-top-color: var(--ui-accent);
    animation: tmux-spin 900ms linear infinite;
  }

  .tmux-pane-grid {
    --tmux-grid-border-width: 1px;
    --tmux-grid-padding: 10px;
    --tmux-stage-inset: calc(var(--tmux-grid-border-width) + var(--tmux-grid-padding));
    position: relative;
    width: 100%;
    height: 100%;
    min-height: 0;
    box-sizing: border-box;
    padding: var(--tmux-grid-padding);
    overflow: hidden;
    border-radius: var(--ui-radius-xl);
    border: var(--tmux-grid-border-width) solid var(--ui-border-subtle);
    background: color-mix(in srgb, var(--ui-bg-app) 92%, black 8%);
  }

  .tmux-shell-body {
    position: relative;
    min-height: 0;
  }

  .tmux-pane-stage {
    position: relative;
    width: 100%;
    height: 100%;
    min-height: 0;
  }

  .tmux-pane {
    position: absolute;
    box-sizing: border-box;
    padding: 0;
    overflow: hidden;
    background: color-mix(in srgb, var(--ui-bg-surface) 90%, black 10%);
    outline: 1px solid color-mix(in srgb, var(--ui-border-subtle) 82%, transparent);
    outline-offset: 0;
    box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.04);
    transition:
      outline-color 120ms ease,
      outline-width 120ms ease,
      box-shadow 120ms ease,
      background-color 120ms ease;
  }

  .tmux-pane--active {
    outline-width: 2px;
    outline-color: color-mix(in srgb, var(--ui-accent) 62%, var(--ui-border-subtle));
    box-shadow:
      0 0 0 1px color-mix(in srgb, var(--ui-accent-soft) 68%, transparent),
      inset 0 0 0 1px color-mix(in srgb, var(--ui-accent-soft) 36%, transparent),
      inset 0 1px 0 rgba(255, 255, 255, 0.08);
  }

  .tmux-pane--dead {
    opacity: 0.8;
  }

  .tmux-pane-geometry-debug {
    position: absolute;
    right: 10px;
    bottom: 10px;
    z-index: 11;
    display: grid;
    gap: 2px;
    max-width: calc(100% - 20px);
    padding: 6px 8px;
    border-radius: 10px;
    background: rgba(0, 0, 0, 0.7);
    color: rgba(255, 255, 255, 0.85);
    font-size: 10px;
    line-height: 1.35;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    pointer-events: none;
    white-space: nowrap;
  }

  .tmux-pane-meta {
    position: absolute;
    left: 12px;
    top: 12px;
    z-index: 10;
    display: flex;
    align-items: center;
    gap: var(--ui-space-2);
    max-width: calc(100% - 16px);
    padding: 4px 8px;
    border-radius: 999px;
    background: rgba(0, 0, 0, 0.62);
    color: var(--ui-text-secondary);
    font-size: var(--ui-font-size-xs);
    pointer-events: none;
    backdrop-filter: blur(4px);
    transition:
      border-color 120ms ease,
      box-shadow 120ms ease,
      background-color 120ms ease,
      color 120ms ease;
  }

  .tmux-pane--active .tmux-pane-meta {
    color: var(--ui-text-primary);
    background: color-mix(in srgb, rgba(0, 0, 0, 0.72) 82%, var(--ui-accent-soft));
    box-shadow: 0 0 0 1px color-mix(in srgb, var(--ui-accent-soft) 58%, transparent);
  }

  .tmux-pane-title {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .tmux-pane-badge {
    flex-shrink: 0;
    padding: 2px 8px;
    border-radius: 999px;
    background: color-mix(in srgb, var(--ui-accent-soft) 72%, transparent);
  }

  .tmux-pane-body {
    width: 100%;
    height: 100%;
    min-height: 0;
    box-sizing: border-box;
    padding: 0;
  }

  .tmux-pane-viewport {
    width: 100%;
    height: 100%;
    min-height: 0;
    overflow: hidden;
    border-radius: calc(var(--ui-radius-lg) - 4px);
  }

  .tmux-pane-viewport :global(.xterm) {
    height: 100%;
  }

  .tmux-measure-probe {
    position: absolute;
    inset: 11px;
    visibility: hidden;
    pointer-events: none;
    overflow: hidden;
  }

  @keyframes tmux-spin {
    to {
      transform: rotate(360deg);
    }
  }
</style>

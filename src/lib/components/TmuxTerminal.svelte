<script lang="ts">
  import { onMount, onDestroy, tick } from "svelte";
  import { Terminal } from "@xterm/xterm";
  import { FitAddon } from "@xterm/addon-fit";
  import { listen, type UnlistenFn } from "@tauri-apps/api/event";
  import { _ as t } from "svelte-i18n";
  import { getAgentDefinition, type AgentId } from "../agents";
  import { translate } from "../i18n";
  import { getSettings } from "../stores/settings.svelte";
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
    onStateChange?: (state: { tmuxSessionName: string | null; tmuxActivePaneId: string | null }) => void;
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
  let paneGridEl = $state<HTMLDivElement | null>(null);
  let paneStageEl = $state<HTMLDivElement | null>(null);
  let measureEl = $state<HTMLDivElement | null>(null);
  let snapshot = $state<TmuxSessionSnapshot | null>(null);
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
  const subscriberId = crypto.randomUUID();
  let measureTerminal: Terminal | null = null;
  let measureFitAddon: FitAddon | null = null;

  const TMUX_PREFIX = "\u0002";
  const TMUX_PREFIX_TIMEOUT_MS = 1600;

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

  function estimateWindowSize() {
    if (measureTerminal && measureFitAddon && (paneStageEl || paneGridEl)) {
      measureFitAddon.fit();
      return {
        cols: Math.max(80, measureTerminal.cols),
        rows: Math.max(24, measureTerminal.rows),
      };
    }

    const width = Math.max(paneStageEl?.clientWidth || paneGridEl?.clientWidth || shellEl?.clientWidth || 0, 960);
    const height = Math.max(
      paneStageEl?.clientHeight ||
        paneGridEl?.clientHeight ||
        Math.max((shellEl?.clientHeight ?? 0) - (toolbarEl?.offsetHeight ?? 0) - 12, 0),
      540,
    );
    return {
      cols: Math.max(80, Math.round(width / Math.max(settings.terminal.fontSize * 0.62, 7))),
      rows: Math.max(24, Math.round(height / Math.max(settings.terminal.fontSize * 1.78, 16))),
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
  }

  function getPaneStyle(pane: TmuxSessionSnapshot["panes"][number]) {
    return [
      `left:${(pane.left / layoutWidth) * 100}%`,
      `top:${(pane.top / layoutHeight) * 100}%`,
      `width:${(pane.width / layoutWidth) * 100}%`,
      `height:${(pane.height / layoutHeight) * 100}%`,
    ].join(";");
  }

  function paneAction(node: HTMLDivElement, paneId: string) {
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
    const paneIds = new Set((nextSnapshot?.panes ?? []).map((pane) => pane.paneId));
    for (const [paneId, entry] of paneTerminals) {
      if (paneIds.has(paneId)) continue;
      if (entry.flushTimer) {
        clearTimeout(entry.flushTimer);
      }
      entry.term.dispose();
      paneTerminals.delete(paneId);
      pendingPaneOutput.delete(paneId);
    }
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

    const keepViewportPinned = paneIsPinnedToBottom(entry.term);
    entry.term.write(combined, () => {
      if (keepViewportPinned) {
        entry.term.scrollToBottom();
      }
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

  function getPaneScrollback() {
    return Math.max(settings.terminal.scrollback ?? 0, 0);
  }

  function paneHasScrollback(term: Terminal) {
    return term.buffer.active.baseY > 0;
  }

  function paneIsPinnedToBottom(term: Terminal) {
    return term.buffer.active.viewportY >= term.buffer.active.baseY;
  }

  function buildSnapshotText(pane: TmuxSessionSnapshot["panes"][number]) {
    return splitSnapshotLines(pane.screenText).join("\n");
  }

  function buildHistorySequence(pane: TmuxSessionSnapshot["panes"][number]) {
    const historyLines = splitSnapshotLines(pane.historyText);
    if (!historyLines.length) return "";
    return `${historyLines.join("\r\n")}\r\n`;
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
      scrollback: getPaneScrollback(),
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
    term.attachCustomWheelEventHandler(() => paneHasScrollback(term));
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

    const keepViewportPinned = paneIsPinnedToBottom(entry.term);
    entry.term.write(data, () => {
      if (keepViewportPinned) {
        entry.term.scrollToBottom();
      }
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
    const historySequence = buildHistorySequence(pane);
    const snapshotContent = buildSnapshotText(pane);
    const visibleScreenSequence = buildVisibleScreenSequence(pane, cursorRow, cursorCol);
    entry.term.reset();
    entry.term.options.scrollback = getPaneScrollback();
    entry.term.write(`${historySequence}${visibleScreenSequence}`, () => {
      entry.term.scrollToBottom();
      const lastRow = Math.max(pane.height - 1, 0);
      entry.term.refresh(0, lastRow);
      entry.lastContent = snapshotContent;
      entry.hydrating = false;
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

  async function syncPaneTerminals(nextSnapshot: TmuxSessionSnapshot | null, structuralChange: boolean) {
    if (!nextSnapshot) return;
    await tick();
    disposeRemovedPaneTerminals(nextSnapshot);

    for (const pane of nextSnapshot.panes) {
      await syncSinglePaneTerminal(pane, structuralChange);
    }
  }

  async function syncMeasuredViewportSize() {
    if (!liveSessionName || !visible) return;
    await tick();
    await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
    const { cols, rows } = estimateWindowSize();
    if (!snapshot) return;
    if (cols === snapshot.width && rows === snapshot.height) {
      return;
    }
    try {
      await resizeTmuxSession(sessionId, distro, liveSessionName, cols, rows);
    } catch (resizeError) {
      console.error("Failed to sync tmux viewport size", resizeError);
    }
  }

  async function applySnapshot(nextSnapshot: TmuxSessionSnapshot) {
    const structuralChange = isStructuralSnapshotChange(snapshot, nextSnapshot);
    snapshot = nextSnapshot;
    liveSessionName = liveSessionName ?? tmuxSessionName ?? nextSnapshot.sessionName;
    liveActivePaneId = nextSnapshot.activePaneId;
    notifyState();
    await syncPaneTerminals(nextSnapshot, structuralChange);
    if (structuralChange) {
      void syncMeasuredViewportSize();
    }
  }

  async function ensureTmuxSession() {
    loadingState = liveSessionName ? "restoring" : "connecting";
    error = null;
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
        settings.terminal.scrollback,
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
    snapshot = null;
    notifyState();
    await ensureTmuxSession();
  }

  async function activatePane(paneId: string) {
    liveActivePaneId = paneId;
    snapshot = snapshot
      ? {
          ...snapshot,
          activePaneId: paneId,
          panes: snapshot.panes.map((pane) => ({ ...pane, active: pane.paneId === paneId })),
        }
      : snapshot;
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
    if (resizeTimer) clearTimeout(resizeTimer);
    resizeTimer = setTimeout(async () => {
      const { cols, rows } = estimateWindowSize();
      try {
        await resizeTmuxSession(sessionId, distro, liveSessionName!, cols, rows);
      } catch (resizeError) {
        console.error("Failed to resize tmux session", resizeError);
      }
    }, 120);
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
    settings.terminal.scrollback;
    for (const entry of paneTerminals.values()) {
      entry.term.options.scrollback = getPaneScrollback();
    }
  });

  $effect(() => {
    paneGridEl;
    paneStageEl;
    measureEl;
    ensureMeasureTerminal();
    if (measureTerminal) {
      measureTerminal.options.fontSize = settings.terminal.fontSize;
      measureTerminal.options.fontFamily = terminalFontFamily;
      measureTerminal.options.theme = getThemeById(settings.interface.theme)?.theme;
      measureFitAddon?.fit();
    }
  });

  $effect(() => {
    resizeObserver;
    shellEl;
    toolbarEl;
    paneGridEl;
    paneStageEl;

    if (!resizeObserver) return;

    const targets = [shellEl, toolbarEl, paneGridEl, paneStageEl].filter(
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
    void (async () => {
      await setupTmuxEventListeners();
      await ensureTmuxSession();
    })();
    resizeObserver = new ResizeObserver(() => {
      measureFitAddon?.fit();
      handleResize();
    });
  });

  onDestroy(() => {
    if (resizeTimer) clearTimeout(resizeTimer);
    clearTmuxPrefix();
    resizeObserver?.disconnect();
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
    paneTerminals.clear();
    pendingPaneOutput.clear();
  });

  const layoutWidth = $derived(Math.max(snapshot?.width ?? 0, 1));
  const layoutHeight = $derived(Math.max(snapshot?.height ?? 0, 1));
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
      <small class="tmux-debug-meta">out:{outputEventCount} {lastOutputPaneId ?? "-"}</small>
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

  {#if error}
    <div class="tmux-state-card tmux-state-card--error">
      <p>{error}</p>
      <button class="tmux-action" onclick={() => void restartTmuxSession()}>
        {$t("terminal.tmux.restart")}
      </button>
    </div>
  {:else if loadingState || !snapshot}
    <div class="tmux-state-card">
      <div class="tmux-spinner" aria-hidden="true"></div>
      <p>{loadingLabel}</p>
    </div>
  {:else}
    <div class="tmux-pane-grid" data-testid={TEST_IDS.tmuxPaneGrid} bind:this={paneGridEl}>
      <div class="tmux-pane-stage" bind:this={paneStageEl}>
        <div class="tmux-measure-probe" bind:this={measureEl}></div>
        {#each snapshot.panes as pane (pane.paneId)}
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
          </section>
        {/each}
      </div>
    </div>
  {/if}
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
    position: relative;
    width: 100%;
    height: 100%;
    min-height: 0;
    box-sizing: border-box;
    padding: 10px;
    overflow: hidden;
    border-radius: var(--ui-radius-xl);
    border: 1px solid var(--ui-border-subtle);
    background: color-mix(in srgb, var(--ui-bg-app) 92%, black 8%);
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
  }

  .tmux-pane--active {
    outline-color: color-mix(in srgb, var(--ui-accent) 58%, var(--ui-border-subtle));
    box-shadow: 0 0 0 1px color-mix(in srgb, var(--ui-accent-soft) 60%, transparent);
  }

  .tmux-pane--dead {
    opacity: 0.8;
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
    padding: 3px 12px 1px;
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

  .tmux-pane-viewport :global(.xterm .xterm-viewport) {
    overflow-y: auto !important;
    overflow-x: hidden !important;
    scrollbar-gutter: stable;
    scrollbar-width: thin;
    scrollbar-color: color-mix(in srgb, var(--ui-accent) 48%, var(--ui-border-subtle)) transparent;
  }

  .tmux-pane-viewport :global(.xterm .xterm-viewport::-webkit-scrollbar) {
    width: 10px;
    height: 10px;
  }

  .tmux-pane-viewport :global(.xterm .xterm-viewport::-webkit-scrollbar-track) {
    background: transparent;
  }

  .tmux-pane-viewport :global(.xterm .xterm-viewport::-webkit-scrollbar-thumb) {
    border-radius: 999px;
    border: 2px solid transparent;
    background: color-mix(in srgb, var(--ui-accent) 42%, var(--ui-border-subtle));
    background-clip: padding-box;
  }

  .tmux-pane-viewport :global(.xterm .xterm-viewport::-webkit-scrollbar-thumb:hover) {
    background: color-mix(in srgb, var(--ui-accent) 58%, var(--ui-border-subtle));
    background-clip: padding-box;
  }

  .tmux-measure-probe {
    position: absolute;
    inset: 0;
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

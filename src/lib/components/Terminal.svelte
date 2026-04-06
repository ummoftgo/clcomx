<script lang="ts">
  import { onMount, onDestroy, tick } from "svelte";
  import { Terminal, type IDisposable } from "@xterm/xterm";
  import { FitAddon } from "@xterm/addon-fit";
  import { WebLinksAddon } from "@xterm/addon-web-links";
  import { WebglAddon } from "@xterm/addon-webgl";
  import InternalEditor from "./InternalEditor.svelte";
  import EditorQuickOpenModal from "./EditorQuickOpenModal.svelte";
  import ImagePasteModal from "./ImagePasteModal.svelte";
  import EditorPickerModal from "./EditorPickerModal.svelte";
  import TerminalAssistPanel from "./TerminalAssistPanel.svelte";
  import TerminalAuxPanel from "./TerminalAuxPanel.svelte";
  import TerminalDraftPanel from "./TerminalDraftPanel.svelte";
  import TerminalEditorCloseConfirmModal from "../features/terminal/view/TerminalEditorCloseConfirmModal.svelte";
  import TerminalInterruptConfirmModal from "../features/terminal/view/TerminalInterruptConfirmModal.svelte";
  import ContextMenu from "../ui/components/ContextMenu.svelte";
  import { listen, type UnlistenFn } from "../tauri/event";
  import { getBootstrap } from "../bootstrap";
  import {
    createPendingClipboardImage,
    formatPathForAgentInput,
    getImageFromPasteEvent,
    readImageFromClipboard,
    revokePendingClipboardImage,
    saveClipboardImage,
  } from "../clipboard";
  import {
    type PtyOutputChunk,
    getPtyOutputSnapshot,
    getPtyRuntimeSnapshot,
    resolvePtyHomeDir,
    spawnShellPty,
    spawnPty,
    writePty,
    resizePty,
    takePtyInitialOutput,
  } from "../pty";
  import {
    registerCanonicalSession,
    requestCanonicalScreenSnapshot,
  } from "../terminal/canonical-screen-authority";
  import { t } from "../i18n";
  import { ensureEditorsDetected, getEditorDetectionState } from "../stores/editors.svelte";
  import {
    getSessions,
    setSessionActiveEditorPath,
    setSessionDirtyPaths,
    setSessionEditorRootDir,
    setSessionOpenEditorTabs,
    setSessionViewMode,
  } from "../stores/sessions.svelte";
  import { getSettings } from "../stores/settings.svelte";
  import { getThemeById } from "../themes";
  import type { ContextMenuItem } from "../ui/context-menu";
  import { buildFontStack, serializeFontFamilyList } from "../font-family";
  import { matchesShortcut } from "../hotkeys";
  import type { TerminalRendererPreference } from "../types";
  import {
    listSessionFiles,
    openInEditor,
    readSessionFile,
    resolveTerminalPath,
    writeSessionFile,
    type EditorSearchResult,
    type ResolvedTerminalPath,
  } from "../editors";
  import type { InternalEditorTab } from "../editor/contracts";
  import type { NavigationFileSnapshot } from "../editor/navigation";
  import { warmMonacoEditorRuntime } from "../editor/monaco-host";
  import { createTerminalFileLinks } from "../terminal/file-links";
  import { consumeAuxShellMetadata } from "../terminal/aux-shell-metadata";
  import {
    isClaudeFooterGhostingMitigationEnabled,
    syncTerminalUnicodeWidth,
  } from "../terminal/claude-footer-ghosting";
  import { TEST_IDS } from "../testids";
  import { openExternalUrl } from "../workspace";
  import type { SessionShellProps } from "../features/session/contracts/session-shell";
  import { createEditorRuntimeController } from "../features/editor/controller/editor-runtime-controller";
  import { createEditorRuntimeState } from "../features/editor/state/editor-runtime-state.svelte";
  import { createDraftComposerController } from "../features/terminal/controller/draft-composer-controller";
  import { buildOverlayLinkMenuItems } from "../features/terminal/controller/overlay-link-menu-items";
  import { createOverlayInteractionController } from "../features/terminal/controller/overlay-interaction-controller";
  import { createTerminalTestBridgeController } from "../features/terminal/controller/terminal-test-bridge-controller";
  import { createDraftComposerState } from "../features/terminal/state/draft-composer-state.svelte";
  import { createOverlayInteractionState } from "../features/terminal/state/overlay-interaction-state.svelte";
  import {
    TEST_BRIDGE_EVENTS,
    getOrCreateTerminalTestHooks,
    isTestBridgeEnabled,
  } from "../testing/test-bridge";
  import "@xterm/xterm/css/xterm.css";

  function hasSessionFileMtime(value: unknown): value is { mtimeMs: number } {
    return (
      typeof value === "object" &&
      value !== null &&
      "mtimeMs" in value &&
      typeof (value as { mtimeMs?: unknown }).mtimeMs === "number"
    );
  }

  let {
    sessionId,
    visible,
    agentId,
    distro,
    workDir,
    ptyId,
    storedAuxPtyId = -1,
    storedAuxVisible = false,
    storedAuxHeightPercent = null,
    resumeToken = null,
    onPtyId,
    onAuxStateChange,
    onExit,
    onResumeFallback,
  }: SessionShellProps = $props();

  let shellEl: HTMLDivElement;
  let outputEl: HTMLDivElement;
  let auxOutputEl = $state<HTMLDivElement | null>(null);
  let assistPanelEl = $state<HTMLDivElement | null>(null);
  let terminal: Terminal | null = null;
  let fitAddon: FitAddon | null = null;
  let inputTextarea: HTMLTextAreaElement | undefined;
  let livePtyId = $state(-1);
  let initialOutputReady = false;
  let terminalReady = $state(false);
  let terminalStartupSettled = $state(false);
  let spawnError = $state<string | null>(null);
  let terminalLoadingState = $state<"connecting" | "restoring" | null>(null);
  let terminalLoadingStartedAt = 0;
  let terminalLoadingHasRenderableOutput = false;
  let terminalLoadingReadySignalSeen = false;
  let terminalLoadingQuietTimer: ReturnType<typeof setTimeout> | null = null;
  let terminalLoadingMaxTimer: ReturnType<typeof setTimeout> | null = null;
  let interruptConfirmVisible = $state(false);
  const editorDetection = getEditorDetectionState();
  const detectedEditors = $derived(editorDetection.editors);
  const editorsError = $derived(editorDetection.error);
  let unlistenOutput: UnlistenFn | null = null;
  let unlistenExit: UnlistenFn | null = null;
  let resizeObserver: ResizeObserver | null = null;
  let assistResizeObserver: ResizeObserver | null = null;
  let fileLinkProviderDisposable: IDisposable | null = null;
  let auxTerminal: Terminal | null = null;
  let auxFitAddon: FitAddon | null = null;
  let auxResizeObserver: ResizeObserver | null = null;
  let auxOutputPointerCleanup: (() => void) | null = null;
  let activeRenderer = $state<TerminalRendererPreference>("dom");
  let auxPtyId = $state(-1);
  let auxVisible = $state(false);
  let auxInitialized = $state(false);
  let auxExited = $state(true);
  let auxBusy = $state(false);
  let auxLoadingState = $state<"opening" | null>(null);
  let auxLoadingStartedAt = 0;
  let auxLoadingHasRenderableOutput = false;
  let auxLoadingQuietTimer: ReturnType<typeof setTimeout> | null = null;
  let auxLoadingMaxTimer: ReturnType<typeof setTimeout> | null = null;
  let auxSpawnError = $state<string | null>(null);
  let auxCurrentPath = $state("");
  let auxMetadataRemainder = "";
  let mainMetadataRemainder = "";
  let shellHomeDir = $state<string | null>(null);
  let shellHomeDirSessionId = $state<string | null>(null);
  let auxHeightPercent = $state(28);
  let auxHeightCustomized = false;
  let auxFollowTail = true;
  let auxAttached = false;
  let auxStateHydrated = false;
  let auxLayoutSettleTimer: ReturnType<typeof setTimeout> | null = null;
  let assistPanelHeight = $state(0);
  let resizingAux = false;
  let auxResizePointerId: number | null = null;
  let auxResizeStartY = 0;
  let auxResizeStartPercent = 0;
  let replayInProgress = false;
  let replayBuffer: PtyOutputChunk[] = [];
  let testHookRegistered = $state(false);
  let bottomLockTimer: ReturnType<typeof setTimeout> | null = null;
  let bottomLockDeadline = 0;
  let bottomLockMaxDeadline = 0;
  let followTail = true;
  let pendingPostWriteScroll = false;
  let deferredBottomScrollTimer: ReturnType<typeof setTimeout> | null = null;
  let writeParsedDisposable: IDisposable | null = null;
  let editorViewMode = $state<"terminal" | "editor">("terminal");
  let editorRootDir = $state("");
  let editorQuickOpenVisible = $state(false);
  let editorQuickOpenQuery = $state("");
  let editorQuickOpenRootDir = $state("");
  let editorQuickOpenEntries = $state<EditorSearchResult[]>([]);
  let editorQuickOpenLastUpdatedMs = $state(0);
  let editorQuickOpenBusy = $state(false);
  let editorQuickOpenOpenKey = $state(0);
  let editorHydratedSessionId = $state<string | null>(null);
  let editorHydrationToken = 0;
  let editorQuickOpenRequestToken = 0;
  let editorQuickOpenPrewarmHandle: ReturnType<typeof setTimeout> | number | null = null;
  let editorQuickOpenPrewarmToken = 0;
  let editorQuickOpenPrewarmRequestedRootDir = "";
  let editorQuickOpenPrewarmInFlightRootDir = "";
  let editorMonacoPrewarmHandle: ReturnType<typeof setTimeout> | number | null = null;
  let editorMonacoPrewarmToken = 0;
  let editorMonacoPrewarming = false;
  let editorMonacoPrewarmed = false;
  const editorRuntimeState = createEditorRuntimeState();
  const RESUME_FAILED_MARKER = "__CLCOMX_RESUME_FAILED__";
  const BOTTOM_LOCK_MAX_MS = 12000;
  const BOTTOM_LOCK_QUIET_MS = 1400;
  const MIN_TERMINAL_LOADING_MS = 360;
  const TERMINAL_LOADING_QUIET_MS = 1300;
  const TERMINAL_LOADING_MAX_MS = 8000;
  const DEFERRED_BOTTOM_SCROLL_MS = 60;
  const QUICK_OPEN_CACHE_STALE_MS = 30_000;
  const WEB_LINK_REGEX = /(?:https?|ftp):[/]{2}[^\s"'!*(){}|\\^<>`]*[^\s"':,.!?{}|\\^~\[\]`()<>]/i;
  const SYNC_OUTPUT_MODE_SEQUENCE = /\u001b\[\?2026[hl]/;
  const ABSOLUTE_CURSOR_POSITION_SEQUENCE = /\u001b\[\d+(?:;\d+)?[Hf]/;

  const settings = getSettings();
  const bootstrap = getBootstrap();
  const {
    cancelCloseTab: cancelCloseEditorTab,
    confirmCloseTab: confirmCloseEditorTab,
    getCurrentSessionState: getCurrentEditorSessionState,
    handleContentChange: handleEditorContentChange,
    patchTab: patchEditorTab,
    requestCloseTab: closeEditorTab,
    setStatus: setEditorStatus,
    setTabError: setEditorTabError,
    setTabLoaded: setEditorTabLoaded,
    setTabSaving: setEditorTabSaving,
    setTabs: setEditorTabs,
    syncSessionState: syncEditorSessionState,
  } = createEditorRuntimeController(editorRuntimeState, {
    getSessionId: () => sessionId,
    getSessions,
    getViewMode: () => editorViewMode,
    getRootDir: () => editorRootDir,
    setSessionViewMode,
    setSessionEditorRootDir,
    setSessionOpenEditorTabs,
    setSessionActiveEditorPath,
    setSessionDirtyPaths,
  });
  const draftComposerState = createDraftComposerState();
  const draftComposer = createDraftComposerController(draftComposerState, {
    getVisible: () => visible,
    getUiScale: () => settings.interface.uiScale,
    getTerminalFontSize: () => settings.terminal.fontSize,
    getShellHeight: () => shellEl?.clientHeight ?? window.innerHeight,
    getAssistPanelHeight: () => assistPanelHeight,
    focusOutput,
    getAuxVisible: () => auxVisible,
    hideAuxTerminal,
    getTerminal: () => terminal,
    getLivePtyId: () => livePtyId,
    writeLivePty: (text) => writePty(livePtyId, text),
    tick,
  });
  const {
    syncDraftHeight,
    focusDraft,
    closeDraft,
    stopDraftResize,
    handleDraftResizeStart,
    routeInsertedText,
    insertDraftIntoTerminal,
    handleDraftKeydown,
    handleDraftInput,
    toggleDraft,
  } = draftComposer;
  const overlayInteractionState = createOverlayInteractionState();
  const overlayInteraction = createOverlayInteractionController(overlayInteractionState, {
    getSessionId: () => sessionId,
    getDistro: () => distro,
    getWorkDir: () => workDir,
    getVisible: () => visible,
    getTerminal: () => terminal,
    getDraftOpen: () => draftComposerState.draftOpen,
    focusDraft: () => focusDraft(),
    focusOutput,
    routeInsertedText,
    openExternalUrl,
    resolveTerminalPath,
    getShellHomeDirHint,
    getFileOpenTarget: () => settings.interface.fileOpenTarget,
    getFileOpenMode: () => settings.interface.fileOpenMode,
    getDefaultEditorId: () => settings.interface.defaultEditorId,
    getEditorsError: () => editorsError,
    ensureEditorsLoaded: () => ensureEditorsLoaded(),
    openInEditor,
    openInternalEditorForLinkPath,
    t: (key, options) => $t(key, options),
    createPendingClipboardImage,
    revokePendingClipboardImage,
    readImageFromClipboard,
    getImageFromPasteEvent,
    saveClipboardImage,
    formatPathForAgentInput,
  });
  const {
    setClipboardNotice,
    openContextMenu,
    closeLinkMenu,
    releaseLinkSelectionBlock,
    closeEditorPicker,
    openFileLinkMenu,
    openFileLinkMenuForTest,
    openUrlLinkMenuForTest,
    handleEditorSelect,
    handleLinkMenuSelect,
    handleLinkHover,
    handleLinkLeave,
    handleLinkPointerMove,
    openClipboardPreview,
    resetClipboardImage,
    handlePasteImageFromClipboard,
    confirmClipboardImage,
    handleDraftPaste,
    handleTerminalPaste,
    handleSelectionCopy,
    dispose: disposeOverlayInteraction,
    buildCandidateFileLinkMenuItems,
  } = overlayInteraction;
  const terminalTestBridge = createTerminalTestBridgeController({
    getSessionId: () => sessionId,
    focusOutput,
    isTestBridgeEnabled,
    openClipboardPreview,
    setClipboardNotice,
    getLivePtyId: () => livePtyId,
    getAuxPtyId: () => auxPtyId,
    getPtyOutputSnapshot,
    getTerminal: () => terminal,
    getTestHooks: () => getOrCreateTerminalTestHooks(),
    openUrlMenu: openUrlLinkMenuForTest,
    openFileMenu: openFileLinkMenuForTest,
  });
  const {
    handleFocusRequest,
    handleTestPendingImage,
    registerTestHooks,
    unregisterTestHooks,
  } = terminalTestBridge;
  const softFollowExperimentEnabled = $derived(
    isClaudeFooterGhostingMitigationEnabled(
      agentId,
      settings.terminal.claudeFooterGhostingMitigation,
      bootstrap.softFollowExperiment,
    ),
  );
  const preferredRenderer = $derived(settings.terminal.renderer);
  const editorBusy = $derived(editorRuntimeState.tabs.some((tab) => tab.loading || tab.saving));
  const editorCloseConfirmLabel = $derived(
    editorRuntimeState.closeConfirmPath ? editorRuntimeState.closeConfirmPath.split("/").pop() || editorRuntimeState.closeConfirmPath : "",
  );
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
  const linkMenuItems = $derived<ContextMenuItem[]>(
    buildOverlayLinkMenuItems(
      overlayInteractionState.linkMenuTarget,
      (key, options) => $t(key, options),
      buildCandidateFileLinkMenuItems,
    ),
  );
  const terminalLoadingLabel = $derived(
    terminalLoadingState === "restoring"
      ? $t("terminal.loading.restoring")
      : $t("terminal.loading.connecting"),
  );
  const auxLoadingLabel = $derived($t("terminal.aux.loadingTitle"));

  function clampAuxHeightPercent(value: number) {
    if (!Number.isFinite(value)) {
      return clampAuxHeightPercent(settings.terminal.auxTerminalDefaultHeight);
    }
    return Math.min(70, Math.max(18, Math.round(value)));
  }

  function buildTerminalOptions(theme = getThemeById(settings.interface.theme)?.theme) {
    return {
      fontSize: settings.terminal.fontSize,
      fontFamily: terminalFontFamily,
      theme,
      cursorBlink: false,
      cursorStyle: "block" as const,
      allowProposedApi: true,
      scrollback: settings.terminal.scrollback,
      disableStdin: false,
    };
  }

  interface RendererController {
    addon: WebglAddon | null;
    contextLossDisposable: IDisposable | null;
  }

  const mainRendererController: RendererController = {
    addon: null,
    contextLossDisposable: null,
  };

  const auxRendererController: RendererController = {
    addon: null,
    contextLossDisposable: null,
  };

  function releaseRendererController(controller: RendererController) {
    controller.contextLossDisposable?.dispose();
    controller.contextLossDisposable = null;
    controller.addon?.dispose();
    controller.addon = null;
  }

  function syncRendererPreference(
    term: Terminal,
    controller: RendererController,
    preferred: TerminalRendererPreference,
    updateActiveRenderer: (value: TerminalRendererPreference) => void,
  ) {
    if (preferred === "dom") {
      releaseRendererController(controller);
      updateActiveRenderer("dom");
      return;
    }

    if (controller.addon) {
      updateActiveRenderer("webgl");
      return;
    }

    try {
      const addon = new WebglAddon();
      controller.contextLossDisposable = addon.onContextLoss(() => {
        console.warn("WebGL terminal renderer context lost, falling back to DOM");
        releaseRendererController(controller);
        updateActiveRenderer("dom");
      });
      term.loadAddon(addon);
      controller.addon = addon;
      updateActiveRenderer("webgl");
    } catch (error) {
      releaseRendererController(controller);
      updateActiveRenderer("dom");
      console.warn("Failed to activate WebGL terminal renderer, falling back to DOM", error);
    }
  }

  function hexToRgba(color: string | undefined, alpha: number, fallback: string) {
    if (!color) return fallback;

    const normalized = color.trim();
    const shortHex = /^#([\da-f]{3})$/i.exec(normalized);
    if (shortHex) {
      const [r, g, b] = shortHex[1].split("").map((value) => Number.parseInt(value + value, 16));
      return `rgba(${r}, ${g}, ${b}, ${alpha})`;
    }

    const longHex = /^#([\da-f]{6})$/i.exec(normalized);
    if (longHex) {
      const hex = longHex[1];
      const r = Number.parseInt(hex.slice(0, 2), 16);
      const g = Number.parseInt(hex.slice(2, 4), 16);
      const b = Number.parseInt(hex.slice(4, 6), 16);
      return `rgba(${r}, ${g}, ${b}, ${alpha})`;
    }

    return fallback;
  }

  function applyCompositionViewTheme() {
    if (!shellEl) return;

    const themeDef = getThemeById(settings.interface.theme)?.theme;
    const foreground = themeDef?.foreground ?? "#f8fafc";
    const emphasis = themeDef?.selectionBackground ?? themeDef?.cursor ?? "#64748b";
    const background = hexToRgba(emphasis, 0.18, "rgba(15, 23, 42, 0.18)");

    shellEl.style.setProperty("--ime-composition-fg", foreground);
    shellEl.style.setProperty("--ime-composition-bg", background);
  }

  function getInitialPtySize(term: Terminal) {
    return {
      cols: term.cols > 0 ? term.cols : settings.interface.windowDefaultCols,
      rows: term.rows > 0 ? term.rows : settings.interface.windowDefaultRows,
    };
  }

  async function waitForStableTerminalLayout() {
    await tick();
    if (document.fonts?.ready) {
      await document.fonts.ready.catch(() => {});
    }
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => resolve());
      });
    });
  }

  function writeTerminalData(term: Terminal, data: string) {
    return new Promise<void>((resolve) => {
      if (!data) {
        resolve();
        return;
      }

      term.write(data, () => resolve());
    });
  }

  function consumeMainTerminalMetadata(data: string) {
    const parsed = consumeAuxShellMetadata(data, mainMetadataRemainder);
    mainMetadataRemainder = parsed.remainder;
    const parsedHomeDir = resolvePtyHomeDir(parsed.homeDir, null);
    if (parsedHomeDir) {
      shellHomeDir = parsedHomeDir;
    }
    return parsed;
  }

  function getActivePtyId() {
    return livePtyId >= 0 ? livePtyId : ptyId;
  }

  function clearShellHomeDirCache() {
    shellHomeDir = null;
  }

  function getShellHomeDirHint() {
    return resolvePtyHomeDir(shellHomeDir, null);
  }

  async function rehydrateShellHomeDirFromRuntimeSnapshot() {
    const activePtyId = getActivePtyId();
    if (activePtyId < 0) {
      return null;
    }

    try {
      const snapshot = await getPtyRuntimeSnapshot(activePtyId);
      const resolvedHomeDir = resolvePtyHomeDir(null, snapshot.homeDir);
      if (resolvedHomeDir) {
        shellHomeDir = resolvedHomeDir;
      }
      return resolvedHomeDir;
    } catch {
      return null;
    }
  }

  function writeMainTerminalData(term: Terminal, data: string) {
    const parsed = consumeMainTerminalMetadata(data);
    return writeTerminalData(term, parsed.text);
  }

  function hasRenderableTerminalOutput(data: string) {
    if (!data) {
      return false;
    }

    const withoutOsc = data.replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, "");
    const withoutCsi = withoutOsc.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "");
    const withoutControl = withoutCsi.replace(/[\u0000-\u001f\u007f]/g, "");
    return withoutControl.trim().length > 0;
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
    return agentId === "claude" || agentId === "codex";
  }

  function hasAgentReadySignal(data: string) {
    const text = extractPrintableTerminalText(data);
    if (!text) {
      return false;
    }

    if (agentId === "codex") {
      return (
        text.includes("OpenAI Codex") ||
        /(?:^|\n)\s*›\s/m.test(text)
      );
    }

    if (agentId === "claude") {
      return (
        /(?:^|\n)\s*❯[\u00a0 ]?/m.test(text) ||
        (text.includes("current:") && text.includes("tokens"))
      );
    }

    return hasRenderableTerminalOutput(data);
  }

  function writeAuxTerminalData(term: Terminal, data: string) {
    const parsed = consumeAuxShellMetadata(data, auxMetadataRemainder);
    auxMetadataRemainder = parsed.remainder;
    if (parsed.cwd) {
      auxCurrentPath = parsed.cwd;
    }
    return writeTerminalData(term, parsed.text);
  }

  function clearBottomLockTimer() {
    if (bottomLockTimer) {
      clearTimeout(bottomLockTimer);
      bottomLockTimer = null;
    }
  }

  function clearDeferredBottomScrollTimer() {
    if (deferredBottomScrollTimer) {
      clearTimeout(deferredBottomScrollTimer);
      deferredBottomScrollTimer = null;
    }
  }

  function releaseBottomLock() {
    clearBottomLockTimer();
    bottomLockDeadline = 0;
    bottomLockMaxDeadline = 0;
  }

  function scrollTerminalToBottom() {
    requestAnimationFrame(() => {
      terminal?.scrollToBottom();
    });
  }

  async function syncMainTerminalLayoutToPty(options?: {
    stickToBottom?: boolean;
    refresh?: boolean;
  }) {
    if (!terminal || !fitAddon || editorViewMode !== "terminal") {
      return;
    }

    const term = terminal;
    const fit = fitAddon;
    const stickToBottom = options?.stickToBottom ?? (followTail || isBottomLockActive());
    const refresh = options?.refresh ?? false;

    await waitForStableTerminalLayout();

    if (terminal !== term || fitAddon !== fit) {
      return;
    }

    fit.fit();

    if (refresh) {
      term.refresh(0, Math.max(term.rows - 1, 0));
    }

    if (livePtyId >= 0) {
      try {
        await resizePty(livePtyId, term.cols, term.rows);
      } catch (error) {
        console.error("Failed to resize terminal PTY", error);
      }
    }

    if (terminal !== term) {
      return;
    }

    if (stickToBottom) {
      term.scrollToBottom();
    }
    syncDraftHeight();
    syncAssistPanelHeight();
  }

  function isBottomLockActive() {
    return terminal !== null && Date.now() < bottomLockDeadline;
  }

  function canExtendBottomLock() {
    return terminal !== null && Date.now() < bottomLockMaxDeadline;
  }

  function scheduleBottomLockTick() {
    clearBottomLockTimer();

    if (!terminal) {
      return;
    }

    terminal.scrollToBottom();

    if (Date.now() >= bottomLockDeadline) {
      releaseBottomLock();
      return;
    }

    bottomLockTimer = setTimeout(() => {
      bottomLockTimer = null;
      scheduleBottomLockTick();
    }, 80);
  }

  function armBottomLock(maxDurationMs = BOTTOM_LOCK_MAX_MS, quietWindowMs = BOTTOM_LOCK_QUIET_MS) {
    const now = Date.now();
    bottomLockMaxDeadline = now + maxDurationMs;
    bottomLockDeadline = Math.min(bottomLockMaxDeadline, now + quietWindowMs);
    followTail = true;

    if (softFollowExperimentEnabled) {
      clearBottomLockTimer();
      scrollTerminalToBottom();
      return;
    }

    scheduleBottomLockTick();
  }

  function extendBottomLock(quietWindowMs = BOTTOM_LOCK_QUIET_MS) {
    if (!canExtendBottomLock()) {
      return;
    }

    bottomLockDeadline = Math.min(bottomLockMaxDeadline, Date.now() + quietWindowMs);
    followTail = true;

    if (softFollowExperimentEnabled) {
      clearBottomLockTimer();
      return;
    }

    scheduleBottomLockTick();
  }

  function disableAutoFollow() {
    followTail = false;
    pendingPostWriteScroll = false;
    clearDeferredBottomScrollTimer();
    releaseBottomLock();
  }

  function isLikelyTerminalRepaintChunk(data: string) {
    if (!softFollowExperimentEnabled) {
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
    deferredBottomScrollTimer = setTimeout(() => {
      deferredBottomScrollTimer = null;
      if (!softFollowExperimentEnabled || !pendingPostWriteScroll || terminal?.modes.synchronizedOutputMode) {
        return;
      }

      pendingPostWriteScroll = false;
      scrollTerminalToBottom();
    }, DEFERRED_BOTTOM_SCROLL_MS);
  }

  function focusTerminalSurface(term: Terminal | null, container: HTMLElement | null) {
    if (!term || !container) {
      return;
    }

    term.focus();

    const helperTextarea = container.querySelector(
      ".xterm-helper-textarea",
    ) as HTMLTextAreaElement | null;
    helperTextarea?.focus({ preventScroll: true });
  }

  function focusOutput() {
    if (!terminalReady || !visible || editorViewMode !== "terminal") return;

    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        focusTerminalSurface(terminal, outputEl);
      });
    });
  }

  function focusAuxTerminal() {
    if (!auxVisible || !visible) return;

    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        focusTerminalSurface(auxTerminal, auxOutputEl);
      });
    });
  }

  function syncAssistPanelHeight() {
    assistPanelHeight = assistPanelEl?.offsetHeight ?? 0;
    if (shellEl) {
      shellEl.style.setProperty("--assist-panel-height", `${assistPanelHeight}px`);
    }
  }

  function isEditableTarget(target: EventTarget | null) {
    if (!(target instanceof Element)) {
      return false;
    }

    return Boolean(target.closest("input, textarea, select, [contenteditable='true']"));
  }

  function handleAuxOutputPointerDown() {
    focusAuxTerminal();
  }

  function clearAuxLayoutSettleTimer() {
    if (auxLayoutSettleTimer) {
      clearTimeout(auxLayoutSettleTimer);
      auxLayoutSettleTimer = null;
    }
  }

  async function settleAuxTerminalLayout() {
    if (!visible || !auxVisible || !auxTerminal) {
      return;
    }

    const term = auxTerminal;
    const fit = auxFitAddon;
    await waitForStableTerminalLayout();

    if (!fit || auxTerminal !== term || auxFitAddon !== fit) {
      return;
    }

    fit.fit();
    if (auxPtyId >= 0) {
      try {
        await resizePty(auxPtyId, term.cols, term.rows);
      } catch (error) {
        console.error("Failed to resize auxiliary terminal PTY", error);
      }
    }
    term.scrollToBottom();
    term.refresh(0, Math.max(term.rows - 1, 0));
  }

  function scheduleAuxLayoutSettle(delay = 220) {
    clearAuxLayoutSettleTimer();
    auxLayoutSettleTimer = setTimeout(() => {
      auxLayoutSettleTimer = null;
      void settleAuxTerminalLayout();
    }, delay);
  }

  async function waitForTerminalPaint() {
    await tick();
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => resolve());
      });
    });
  }

  async function showTerminalLoadingState(state: "connecting" | "restoring") {
    clearTerminalLoadingTimers();
    terminalLoadingState = state;
    terminalLoadingStartedAt = performance.now();
    terminalLoadingHasRenderableOutput = false;
    terminalLoadingReadySignalSeen = !requiresAgentReadySignal();
    terminalLoadingMaxTimer = setTimeout(() => {
      terminalLoadingMaxTimer = null;
      void clearTerminalLoadingState(true);
    }, TERMINAL_LOADING_MAX_MS);
    await waitForTerminalPaint();
  }

  function clearTerminalLoadingTimers() {
    if (terminalLoadingQuietTimer) {
      clearTimeout(terminalLoadingQuietTimer);
      terminalLoadingQuietTimer = null;
    }
    if (terminalLoadingMaxTimer) {
      clearTimeout(terminalLoadingMaxTimer);
      terminalLoadingMaxTimer = null;
    }
  }

  function noteTerminalLoadingActivity() {
    if (terminalLoadingState === null) {
      return;
    }

    terminalLoadingHasRenderableOutput = true;
  }

  function noteTerminalLoadingOutput(data: string) {
    if (terminalLoadingState === null) {
      return;
    }

    if (hasRenderableTerminalOutput(data)) {
      noteTerminalLoadingActivity();
    }

    if (!terminalLoadingReadySignalSeen && hasAgentReadySignal(data)) {
      terminalLoadingReadySignalSeen = true;
    }
  }

  function handleTerminalRender() {
    if (terminalLoadingState === null || !terminalLoadingHasRenderableOutput) {
      return;
    }

    if (requiresAgentReadySignal() && !terminalLoadingReadySignalSeen) {
      return;
    }

    if (terminalLoadingQuietTimer) {
      clearTimeout(terminalLoadingQuietTimer);
    }
    terminalLoadingQuietTimer = setTimeout(() => {
      terminalLoadingQuietTimer = null;
      void clearTerminalLoadingState();
    }, TERMINAL_LOADING_QUIET_MS);
  }

  async function clearTerminalLoadingState(force = false) {
    if (terminalLoadingState === null) {
      return;
    }

    if (!force) {
      const elapsed = performance.now() - terminalLoadingStartedAt;
      const remaining = MIN_TERMINAL_LOADING_MS - elapsed;
      if (remaining > 0) {
        await new Promise<void>((resolve) => {
          setTimeout(resolve, remaining);
        });
      }
    }

    clearTerminalLoadingTimers();
    terminalLoadingHasRenderableOutput = false;
    terminalLoadingReadySignalSeen = false;
    terminalLoadingState = null;
  }

  function showAuxLoadingState() {
    clearAuxLoadingTimers();
    auxLoadingState = "opening";
    auxLoadingStartedAt = performance.now();
    auxLoadingHasRenderableOutput = false;
    auxLoadingMaxTimer = setTimeout(() => {
      auxLoadingMaxTimer = null;
      void clearAuxLoadingState(true);
    }, TERMINAL_LOADING_MAX_MS);
  }

  function clearAuxLoadingTimers() {
    if (auxLoadingQuietTimer) {
      clearTimeout(auxLoadingQuietTimer);
      auxLoadingQuietTimer = null;
    }
    if (auxLoadingMaxTimer) {
      clearTimeout(auxLoadingMaxTimer);
      auxLoadingMaxTimer = null;
    }
  }

  function noteAuxLoadingOutput(data: string) {
    if (auxLoadingState === null || !hasRenderableTerminalOutput(data)) {
      return;
    }

    auxLoadingHasRenderableOutput = true;

    if (auxLoadingQuietTimer) {
      clearTimeout(auxLoadingQuietTimer);
    }
    auxLoadingQuietTimer = setTimeout(() => {
      auxLoadingQuietTimer = null;
      void clearAuxLoadingState();
    }, TERMINAL_LOADING_QUIET_MS);
  }

  async function clearAuxLoadingState(force = false) {
    if (auxLoadingState === null) {
      return;
    }

    if (!force && auxLoadingHasRenderableOutput) {
      const elapsed = performance.now() - auxLoadingStartedAt;
      const remaining = MIN_TERMINAL_LOADING_MS - elapsed;
      if (remaining > 0) {
        await new Promise<void>((resolve) => {
          setTimeout(resolve, remaining);
        });
      }
    }

    clearAuxLoadingTimers();
    auxLoadingState = null;
    auxLoadingHasRenderableOutput = false;
  }

  function handleAuxShortcut(event: KeyboardEvent) {
    if (!visible || !matchesShortcut(event, settings.terminal.auxTerminalShortcut)) {
      return;
    }

    const targetNode = event.target instanceof Node ? event.target : null;

    if (
      (overlayInteractionState.pendingClipboardImage !== null ||
        overlayInteractionState.editorPickerVisible) &&
      targetNode !== null &&
      !shellEl.contains(targetNode)
    ) {
      return;
    }

    if (isEditableTarget(event.target) && targetNode !== null && !shellEl.contains(targetNode)) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    void toggleAuxTerminal();
  }

  function isInsideInternalEditor(target: EventTarget | null) {
    if (!(target instanceof Element)) {
      return false;
    }

    return Boolean(
      target.closest(`[data-testid="${TEST_IDS.internalEditorShell}"]`) ||
        target.closest(`[data-testid="${TEST_IDS.internalEditorQuickOpenModal}"]`),
    );
  }

  function handleEditorShortcut(event: KeyboardEvent) {
    if (!visible || !matchesShortcut(event, "Ctrl+P")) {
      return;
    }

    const targetNode = event.target instanceof Node ? event.target : null;
    const insideTerminalShell = targetNode !== null && shellEl.contains(targetNode);
    const insideEditorSurface = isInsideInternalEditor(targetNode);

    if (targetNode !== null && !insideTerminalShell && !insideEditorSurface) {
      return;
    }

    if (isEditableTarget(event.target) && !insideTerminalShell && !insideEditorSurface) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();

    if (editorQuickOpenVisible) {
      return;
    }

    void openEditorQuickOpen(editorRootDir);
  }

  function shouldInterceptTerminalCtrlC(event: KeyboardEvent) {
    return (
      event.type === "keydown" &&
      event.key.toLowerCase() === "c" &&
      event.ctrlKey &&
      !event.shiftKey &&
      !event.altKey &&
      !event.metaKey
    );
  }

  async function copyTerminalSelection() {
    const selection = terminal?.getSelection() ?? "";
    if (!selection) {
      return false;
    }

    await handleSelectionCopy();
    return true;
  }

  function closeInterruptConfirm() {
    interruptConfirmVisible = false;
    tick().then(focusOutput);
  }

  async function confirmTerminalInterrupt() {
    interruptConfirmVisible = false;
    if (livePtyId < 0) {
      tick().then(focusOutput);
      return;
    }

    try {
      await writePty(livePtyId, "\u0003");
    } catch (error) {
      console.error("Failed to send Ctrl+C to terminal", error);
    } finally {
      tick().then(focusOutput);
    }
  }

  function handleMainTerminalKey(event: KeyboardEvent) {
    if (!visible || !shouldInterceptTerminalCtrlC(event)) {
      return true;
    }

    event.preventDefault();
    event.stopPropagation();

    if (terminal?.hasSelection()) {
      void copyTerminalSelection().catch((error) => {
        console.error("Failed to copy terminal selection", error);
      });
      return false;
    }

    interruptConfirmVisible = true;
    return false;
  }

  async function ensureEditorsLoaded() {
    return await ensureEditorsDetected();
  }

  function ensureEditorViewMode() {
    if (editorViewMode === "editor") {
      return;
    }

    if (auxVisible) {
      hideAuxTerminal({ restoreFocus: false });
    }
    if (draftComposerState.draftOpen) {
      closeDraft({ restoreFocus: false });
    }
    editorViewMode = "editor";
    setSessionViewMode(sessionId, editorViewMode);
  }

  function switchToTerminalView() {
    editorViewMode = "terminal";
    closeEditorQuickOpen();
    editorRuntimeState.closeConfirmVisible = false;
    editorRuntimeState.closeConfirmPath = null;
    setSessionViewMode(sessionId, editorViewMode);
    tick().then(focusOutput);
  }

  async function initializeEditorRuntimeFromSession() {
    const session = getCurrentEditorSessionState();
    editorHydratedSessionId = sessionId;
    editorViewMode = session?.viewMode ?? "terminal";
    editorRootDir = session?.editorRootDir || workDir;
    editorQuickOpenRootDir = editorRootDir;
    editorRuntimeState.activePath = session?.activeEditorPath ?? null;
    editorRuntimeState.savedContentByPath = {};
    editorRuntimeState.mtimeByPath = {};

    const refs = session?.openEditorTabs ?? [];
    if (refs.length === 0) {
      setEditorTabs([]);
      return;
    }

    const token = ++editorHydrationToken;
    setEditorTabs(
      refs.map((ref) => ({
        wslPath: ref.wslPath,
        content: "",
        languageId: "plaintext",
        dirty: false,
        line: ref.line ?? null,
        column: ref.column ?? null,
        loading: true,
        saving: false,
        error: null,
      })),
    );

    const loadedTabs = await Promise.all(
      refs.map(async (ref) => {
        try {
          const file = await readSessionFile(sessionId, ref.wslPath);
          return {
            wslPath: ref.wslPath,
            content: file.content,
            languageId: file.languageId || "plaintext",
            dirty: false,
            line: ref.line ?? null,
            column: ref.column ?? null,
            loading: false,
            saving: false,
            error: null,
            mtimeMs: file.mtimeMs,
          };
        } catch (error) {
          return {
            wslPath: ref.wslPath,
            content: "",
            languageId: "plaintext",
            dirty: false,
            line: ref.line ?? null,
            column: ref.column ?? null,
            loading: false,
            saving: false,
            error: error instanceof Error ? error.message : String(error),
            mtimeMs: 0,
          };
        }
      }),
    );

    if (token !== editorHydrationToken) {
      return;
    }

    for (const tab of loadedTabs) {
      if (tab.mtimeMs > 0) {
        editorRuntimeState.savedContentByPath = {
          ...editorRuntimeState.savedContentByPath,
          [tab.wslPath]: tab.content,
        };
        editorRuntimeState.mtimeByPath = {
          ...editorRuntimeState.mtimeByPath,
          [tab.wslPath]: tab.mtimeMs,
        };
      }
    }

    editorRuntimeState.tabs = loadedTabs.map(({ mtimeMs, ...tab }) => tab);

    if (!editorRuntimeState.activePath || !editorRuntimeState.tabs.some((tab) => tab.wslPath === editorRuntimeState.activePath)) {
      editorRuntimeState.activePath = editorRuntimeState.tabs[0]?.wslPath ?? null;
    }

    syncEditorSessionState();
  }

  async function ensureEditorRuntimeReady() {
    if (editorHydratedSessionId === sessionId) {
      return;
    }

    await initializeEditorRuntimeFromSession();
  }

  function invalidateEditorQuickOpenRequest() {
    editorQuickOpenRequestToken += 1;
  }

  function resetEditorQuickOpenState({
    resetRootDir = false,
    clearEntries = false,
  }: { resetRootDir?: boolean; clearEntries?: boolean } = {}) {
    invalidateEditorQuickOpenRequest();
    editorQuickOpenBusy = false;
    if (clearEntries) {
      editorQuickOpenEntries = [];
      editorQuickOpenLastUpdatedMs = 0;
    }
    if (resetRootDir) {
      editorQuickOpenRootDir = "";
    }
  }

  function closeEditorQuickOpen() {
    editorQuickOpenVisible = false;
    resetEditorQuickOpenState();
  }

  function clearEditorQuickOpenPrewarmHandle() {
    if (editorQuickOpenPrewarmHandle === null) {
      return;
    }

    const idleWindow = window as Window & {
      cancelIdleCallback?: (handle: number) => void;
    };
    if (
      typeof editorQuickOpenPrewarmHandle === "number" &&
      typeof idleWindow.cancelIdleCallback === "function"
    ) {
      idleWindow.cancelIdleCallback(editorQuickOpenPrewarmHandle);
    } else {
      clearTimeout(editorQuickOpenPrewarmHandle);
    }
    editorQuickOpenPrewarmHandle = null;
  }

  function cancelEditorQuickOpenPrewarm() {
    editorQuickOpenPrewarmToken += 1;
    editorQuickOpenPrewarmRequestedRootDir = "";
    clearEditorQuickOpenPrewarmHandle();
  }

  function clearEditorMonacoPrewarmHandle() {
    if (editorMonacoPrewarmHandle === null) {
      return;
    }

    const idleWindow = window as Window & {
      cancelIdleCallback?: (handle: number) => void;
    };
    if (
      typeof editorMonacoPrewarmHandle === "number" &&
      typeof idleWindow.cancelIdleCallback === "function"
    ) {
      idleWindow.cancelIdleCallback(editorMonacoPrewarmHandle);
    } else {
      clearTimeout(editorMonacoPrewarmHandle);
    }
    editorMonacoPrewarmHandle = null;
  }

  function cancelEditorMonacoPrewarm() {
    editorMonacoPrewarmToken += 1;
    clearEditorMonacoPrewarmHandle();
  }

  function isEditorQuickOpenCacheStale() {
    if (!editorQuickOpenLastUpdatedMs) {
      return true;
    }
    return Date.now() - editorQuickOpenLastUpdatedMs > QUICK_OPEN_CACHE_STALE_MS;
  }

  async function refreshEditorQuickOpenEntries(
    forceRefresh = false,
    rootDir = editorQuickOpenRootDir || workDir,
    options?: { background?: boolean },
  ) {
    const requestToken = ++editorQuickOpenRequestToken;
    const normalizedRootDir = rootDir || workDir;
    const background = options?.background ?? false;
    if (!background) {
      editorQuickOpenBusy = true;
    }
    try {
      const result = await listSessionFiles(sessionId, normalizedRootDir, forceRefresh);
      if (requestToken !== editorQuickOpenRequestToken) {
        return;
      }
      editorQuickOpenRootDir = result.rootDir;
      editorQuickOpenEntries = result.results;
      editorQuickOpenLastUpdatedMs = result.lastUpdatedMs;
    } catch (error) {
      if (requestToken !== editorQuickOpenRequestToken) {
        return;
      }

      if (!background) {
        setClipboardNotice(error instanceof Error ? error.message : String(error));
      }
    } finally {
      if (!background && requestToken === editorQuickOpenRequestToken) {
        editorQuickOpenBusy = false;
      }
    }
  }

  async function listEditorWorkspaceFiles(rootDir: string) {
    const normalizedRootDir = rootDir || editorRootDir || workDir;
    if (editorQuickOpenRootDir === normalizedRootDir && editorQuickOpenEntries.length > 0) {
      if (!isEditorQuickOpenCacheStale()) {
        return editorQuickOpenEntries;
      }

      void refreshEditorQuickOpenEntries(false, normalizedRootDir, { background: true });
      return editorQuickOpenEntries;
    }

    const result = await listSessionFiles(sessionId, normalizedRootDir, false);
    if (editorQuickOpenRootDir === normalizedRootDir || !editorQuickOpenVisible) {
      editorQuickOpenRootDir = result.rootDir;
      editorQuickOpenEntries = result.results;
      editorQuickOpenLastUpdatedMs = result.lastUpdatedMs;
    }
    return result.results;
  }

  async function readEditorNavigationFile(wslPath: string) {
    const existingTab = editorRuntimeState.tabs.find(
      (tab) => tab.wslPath === wslPath && !tab.loading && !tab.error,
    );
    if (existingTab) {
      return {
        wslPath,
        content: existingTab.content,
        languageId: existingTab.languageId,
      };
    }

    const file = await readSessionFile(sessionId, wslPath);
    return {
      wslPath: file.wslPath,
      content: file.content,
      languageId: file.languageId,
    };
  }

  function openEditorNavigationLocation(detail: {
    wslPath: string;
    line?: number | null;
    column?: number | null;
    rootDir?: string;
    snapshot?: NavigationFileSnapshot;
  }) {
    const rootDir = detail.rootDir || editorRootDir || workDir;
    const quickOpenEntry = computeQuickOpenEntryForRoot(detail.wslPath, rootDir);
    void openEditorPath(
      {
        wslPath: detail.wslPath,
        relativePath: quickOpenEntry?.relativePath || detail.wslPath,
        basename: quickOpenEntry?.basename || detail.wslPath.split("/").pop() || detail.wslPath,
        line: detail.line ?? null,
        column: detail.column ?? null,
      },
      { rootDir, focusExisting: true, prefetchedFile: detail.snapshot },
    );
  }

  function primeEditorWorkspaceFiles(rootDir = editorRootDir || workDir) {
    const normalizedRootDir = rootDir || workDir;
    if (!normalizedRootDir) {
      return;
    }

    if (
      editorQuickOpenRootDir === normalizedRootDir &&
      editorQuickOpenEntries.length > 0 &&
      !isEditorQuickOpenCacheStale()
    ) {
      return;
    }

    if (
      editorQuickOpenPrewarmRequestedRootDir === normalizedRootDir ||
      editorQuickOpenPrewarmInFlightRootDir === normalizedRootDir
    ) {
      return;
    }

    editorQuickOpenPrewarmInFlightRootDir = normalizedRootDir;
    void refreshEditorQuickOpenEntries(false, normalizedRootDir, { background: true }).finally(() => {
      if (editorQuickOpenPrewarmInFlightRootDir === normalizedRootDir) {
        editorQuickOpenPrewarmInFlightRootDir = "";
      }
    });
  }

  function primeEditorMonacoRuntime() {
    if (editorMonacoPrewarmed || editorMonacoPrewarming) {
      return;
    }

    clearEditorMonacoPrewarmHandle();
    const prewarmToken = ++editorMonacoPrewarmToken;
    requestAnimationFrame(() => {
      if (
        prewarmToken !== editorMonacoPrewarmToken ||
        editorMonacoPrewarmed ||
        editorMonacoPrewarming
      ) {
        return;
      }

      editorMonacoPrewarming = true;
      const themeDef = getThemeById(settings.interface.theme) ?? null;
      void warmMonacoEditorRuntime(themeDef)
        .then(() => {
          editorMonacoPrewarmed = true;
        })
        .finally(() => {
          editorMonacoPrewarming = false;
        });
    });
  }

  function scheduleEditorQuickOpenPrewarm(rootDir = editorRootDir || workDir) {
    const normalizedRootDir = rootDir || workDir;
    if (!terminalReady || !terminalStartupSettled || !visible || editorQuickOpenVisible) {
      return;
    }

    if (!normalizedRootDir) {
      return;
    }

    if (
      editorQuickOpenRootDir === normalizedRootDir &&
      editorQuickOpenLastUpdatedMs > 0 &&
      !isEditorQuickOpenCacheStale()
    ) {
      return;
    }

    if (
      editorQuickOpenPrewarmRequestedRootDir === normalizedRootDir ||
      editorQuickOpenPrewarmInFlightRootDir === normalizedRootDir
    ) {
      return;
    }

    clearEditorQuickOpenPrewarmHandle();
    const prewarmToken = ++editorQuickOpenPrewarmToken;
    editorQuickOpenPrewarmRequestedRootDir = normalizedRootDir;

    const runPrewarm = () => {
      if (prewarmToken !== editorQuickOpenPrewarmToken) {
        return;
      }

      editorQuickOpenPrewarmHandle = null;
      editorQuickOpenPrewarmRequestedRootDir = "";
      if (!terminalReady || !terminalStartupSettled || !visible || editorQuickOpenVisible) {
        return;
      }

      editorQuickOpenPrewarmInFlightRootDir = normalizedRootDir;
      void refreshEditorQuickOpenEntries(false, normalizedRootDir, { background: true }).finally(
        () => {
          if (editorQuickOpenPrewarmInFlightRootDir === normalizedRootDir) {
            editorQuickOpenPrewarmInFlightRootDir = "";
          }
        },
      );
    };

    const idleWindow = window as Window & {
      requestIdleCallback?: (
        callback: IdleRequestCallback,
        options?: IdleRequestOptions,
      ) => number;
    };

    if (typeof idleWindow.requestIdleCallback === "function") {
      editorQuickOpenPrewarmHandle = idleWindow.requestIdleCallback(runPrewarm, { timeout: 1200 });
      return;
    }

    editorQuickOpenPrewarmHandle = window.setTimeout(runPrewarm, 250);
  }

  function scheduleEditorMonacoPrewarm() {
    if (
      editorMonacoPrewarmed ||
      editorMonacoPrewarming ||
      !terminalReady ||
      !terminalStartupSettled ||
      !visible
    ) {
      return;
    }

    clearEditorMonacoPrewarmHandle();
    const prewarmToken = ++editorMonacoPrewarmToken;
    const runPrewarm = () => {
      if (prewarmToken !== editorMonacoPrewarmToken) {
        return;
      }

      editorMonacoPrewarmHandle = null;
      if (
        editorMonacoPrewarmed ||
        editorMonacoPrewarming ||
        !terminalReady ||
        !terminalStartupSettled ||
        !visible
      ) {
        return;
      }

      editorMonacoPrewarming = true;
      const themeDef = getThemeById(settings.interface.theme) ?? null;
      void warmMonacoEditorRuntime(themeDef)
        .then(() => {
          editorMonacoPrewarmed = true;
        })
        .finally(() => {
          editorMonacoPrewarming = false;
        });
    };

    const idleWindow = window as Window & {
      requestIdleCallback?: (
        callback: IdleRequestCallback,
        options?: IdleRequestOptions,
      ) => number;
    };

    if (typeof idleWindow.requestIdleCallback === "function") {
      editorMonacoPrewarmHandle = idleWindow.requestIdleCallback(runPrewarm, { timeout: 1500 });
      return;
    }

    editorMonacoPrewarmHandle = window.setTimeout(runPrewarm, 350);
  }

  function computeQuickOpenEntryForRoot(
    wslPath: string,
    rootDir = editorQuickOpenRootDir || editorRootDir || workDir,
  ): EditorSearchResult | null {
    const normalizedRoot = rootDir.replace(/\/+$/, "") || "/";
    if (wslPath !== normalizedRoot && !wslPath.startsWith(`${normalizedRoot}/`)) {
      return null;
    }

    const basename = wslPath.split("/").pop() || wslPath;
    const relativePath =
      wslPath === normalizedRoot ? basename : wslPath.slice(normalizedRoot.length + 1);

    return {
      wslPath,
      relativePath,
      basename,
    };
  }

  function upsertEditorQuickOpenEntry(wslPath: string) {
    const entry = computeQuickOpenEntryForRoot(wslPath);
    if (!entry) {
      return;
    }

    const index = editorQuickOpenEntries.findIndex((candidate) => candidate.wslPath === wslPath);
    if (index < 0) {
      editorQuickOpenEntries = [...editorQuickOpenEntries, entry];
    } else {
      editorQuickOpenEntries = editorQuickOpenEntries.map((candidate) =>
        candidate.wslPath === wslPath ? entry : candidate,
      );
    }
    editorQuickOpenLastUpdatedMs = Date.now();
  }

  function openEditorQuickOpen(rootDir = editorRootDir, query = "") {
    const normalizedRoot = rootDir || workDir;
    primeEditorMonacoRuntime();
    primeEditorWorkspaceFiles(normalizedRoot);
    const rootChanged = editorQuickOpenRootDir !== normalizedRoot;
    if (rootChanged) {
      resetEditorQuickOpenState({ clearEntries: true });
    }
    editorQuickOpenRootDir = normalizedRoot;
    editorQuickOpenQuery = query;
    editorQuickOpenVisible = true;
    editorQuickOpenOpenKey += 1;

    if (isEditorQuickOpenCacheStale()) {
      void refreshEditorQuickOpenEntries(false, normalizedRoot);
    }
  }

  async function openEditorDirectory(rootDir: string) {
    editorRootDir = rootDir || workDir;
    syncEditorSessionState();
    primeEditorMonacoRuntime();
    primeEditorWorkspaceFiles(editorRootDir);
    openEditorQuickOpen(editorRootDir, "");
  }

  async function openEditorPath(
    path: ResolvedTerminalPath | EditorSearchResult,
    options?: {
      rootDir?: string;
      focusExisting?: boolean;
      prefetchedFile?: NavigationFileSnapshot;
    },
  ) {
    ensureEditorViewMode();
    primeEditorMonacoRuntime();

    if (draftComposerState.draftOpen) {
      closeDraft({ restoreFocus: false });
    }

    if ("isDirectory" in path && path.isDirectory) {
      await openEditorDirectory(path.wslPath);
      return;
    }

    const wslPath = path.wslPath;
    const nextRootDir = options?.rootDir || editorRootDir || workDir;
    primeEditorWorkspaceFiles(nextRootDir);
    const existingTabIndex = editorRuntimeState.tabs.findIndex((tab) => tab.wslPath === wslPath);
    const nextLine = "line" in path ? path.line ?? null : null;
    const nextColumn = "column" in path ? path.column ?? null : null;

    if (existingTabIndex >= 0) {
      const currentTab = editorRuntimeState.tabs[existingTabIndex];
      editorRuntimeState.tabs = editorRuntimeState.tabs.map((tab) =>
        tab.wslPath !== wslPath
          ? tab
          : {
              ...tab,
              line: nextLine ?? tab.line ?? null,
              column: nextColumn ?? tab.column ?? null,
              error: null,
            },
      );
      editorRuntimeState.activePath = wslPath;
      if (options?.rootDir) {
        editorRootDir = options.rootDir;
      }
      closeEditorQuickOpen();
      syncEditorSessionState();
      tick().then(() => {
        if (editorViewMode === "editor" && !currentTab.loading) {
          editorRuntimeState.statusText = null;
        }
      });
      return;
    }

    const newTab: InternalEditorTab = {
      wslPath,
      content: "",
      languageId: "plaintext",
      dirty: false,
      line: nextLine,
      column: nextColumn,
      loading: true,
      saving: false,
      error: null,
    };

    editorRuntimeState.tabs = [...editorRuntimeState.tabs, newTab];
    editorRuntimeState.activePath = wslPath;
    if (options?.rootDir) {
      editorRootDir = options.rootDir;
    }
    syncEditorSessionState();
    setEditorStatus($t("common.labels.loading"));

    try {
      const file =
        options?.prefetchedFile && options.prefetchedFile.wslPath === wslPath
          ? options.prefetchedFile
          : await readSessionFile(sessionId, wslPath);
      if (!editorRuntimeState.tabs.some((tab) => tab.wslPath === wslPath)) {
        return;
      }

      setEditorTabLoaded(wslPath, {
        content: file.content,
        languageId: file.languageId || "plaintext",
        mtimeMs: hasSessionFileMtime(file) ? file.mtimeMs : (editorRuntimeState.mtimeByPath[wslPath] ?? 0),
        line: nextLine,
        column: nextColumn,
      });
      editorRuntimeState.statusText = null;
      closeEditorQuickOpen();
    } catch (error) {
      setEditorTabError(wslPath, error instanceof Error ? error.message : String(error));
      editorRuntimeState.statusText = error instanceof Error ? error.message : String(error);
    }

    syncEditorSessionState();
  }

  function openEditorPathFromQuickResult(result: EditorSearchResult) {
    void openEditorPath(result, { rootDir: editorQuickOpenRootDir, focusExisting: true });
  }

  function openResolvedPathInInternalEditor(path: ResolvedTerminalPath) {
    void openEditorPath(path, { rootDir: editorRootDir });
  }

  function openResolvedDirectoryInInternalEditor(path: ResolvedTerminalPath) {
    void openEditorDirectory(path.wslPath);
  }

  function openInternalEditorForLinkPath(path: ResolvedTerminalPath) {
    if (path.isDirectory) {
      openResolvedDirectoryInInternalEditor(path);
      return;
    }

    openResolvedPathInInternalEditor(path);
  }

  function requestSwitchToEditorMode() {
    ensureEditorViewMode();
    primeEditorMonacoRuntime();
    primeEditorWorkspaceFiles(editorRootDir || workDir);
    editorRuntimeState.statusText = null;
    if (!editorQuickOpenVisible && editorRuntimeState.tabs.length === 0) {
      void openEditorQuickOpen(editorRootDir);
      return;
    }
  }

  function requestSwitchToTerminalMode() {
    switchToTerminalView();
  }

  async function saveEditorTab(wslPath: string) {
    const tab = editorRuntimeState.tabs.find((entry) => entry.wslPath === wslPath);
    if (!tab) {
      return;
    }

    const contentToSave = tab.content;
    const expectedMtimeMs = editorRuntimeState.mtimeByPath[wslPath] ?? 0;
    setEditorTabSaving(wslPath, true);
    setEditorStatus($t("common.actions.save"));

    try {
      const result = await writeSessionFile(sessionId, wslPath, contentToSave, expectedMtimeMs);
      const latestTab = editorRuntimeState.tabs.find((entry) => entry.wslPath === wslPath);
      if (!latestTab) {
        return;
      }

      editorRuntimeState.savedContentByPath = {
        ...editorRuntimeState.savedContentByPath,
        [wslPath]: contentToSave,
      };
      editorRuntimeState.mtimeByPath = {
        ...editorRuntimeState.mtimeByPath,
        [wslPath]: result.mtimeMs,
      };
      patchEditorTab(wslPath, {
        dirty: latestTab.content !== contentToSave,
        saving: false,
        error: null,
      });
      upsertEditorQuickOpenEntry(wslPath);
      editorRuntimeState.statusText = null;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setEditorTabError(wslPath, message);
      editorRuntimeState.statusText = message;
    } finally {
      syncEditorSessionState();
    }
  }

  function handleEditorActivePathChange(wslPath: string) {
    editorRuntimeState.activePath = wslPath;
    editorViewMode = "editor";
    syncEditorSessionState();
  }

  function disposeAuxTerminalInstance() {
    auxResizeObserver?.disconnect();
    auxResizeObserver = null;
    auxOutputPointerCleanup?.();
    auxOutputPointerCleanup = null;
    releaseRendererController(auxRendererController);
    auxTerminal?.dispose();
    auxTerminal = null;
    auxFitAddon = null;
    auxMetadataRemainder = "";
    auxAttached = false;
    auxOutputEl?.replaceChildren();
  }

  async function createAuxTerminalInstance() {
    if (!auxOutputEl) {
      return;
    }

    disposeAuxTerminalInstance();

    const auxTerm = new Terminal(buildTerminalOptions());
    syncTerminalUnicodeWidth(auxTerm, softFollowExperimentEnabled);
    const auxFit = new FitAddon();
    auxTerm.loadAddon(auxFit);
    auxTerm.open(auxOutputEl);
    syncRendererPreference(auxTerm, auxRendererController, preferredRenderer, () => {});
    auxOutputEl.addEventListener("pointerdown", handleAuxOutputPointerDown, true);
    auxOutputPointerCleanup = () => {
      auxOutputEl?.removeEventListener("pointerdown", handleAuxOutputPointerDown, true);
    };

    auxTerm.onData((data) => {
      if (auxPtyId >= 0) {
        void writePty(auxPtyId, data);
      }
    });

    auxTerm.onResize(({ cols, rows }) => {
      if (auxPtyId >= 0) {
        void resizePty(auxPtyId, cols, rows);
      }
      if (auxFollowTail) {
        auxTerm.scrollToBottom();
      }
    });

    auxTerm.onScroll((viewportY) => {
      auxFollowTail = viewportY >= auxTerm.buffer.active.baseY;
    });

    auxResizeObserver = new ResizeObserver(() => {
      if (visible && auxVisible && auxFitAddon) {
        auxFitAddon.fit();
        auxTerminal?.scrollToBottom();
        scheduleAuxLayoutSettle();
      }
    });
    auxResizeObserver.observe(auxOutputEl);

    auxTerminal = auxTerm;
    auxFitAddon = auxFit;
    auxFollowTail = true;

    await tick();
    requestAnimationFrame(() => {
      auxFit.fit();
      scheduleAuxLayoutSettle();
    });
  }

  async function spawnAuxShell(term: Terminal) {
    const { cols, rows } = getInitialPtySize(term);
    auxBusy = true;
    auxSpawnError = null;
    auxCurrentPath = workDir;
    auxMetadataRemainder = "";

    try {
      auxPtyId = await spawnShellPty(cols, rows, distro, workDir);
      const initialOutput = await takePtyInitialOutput(auxPtyId);
      await writeAuxTerminalData(term, initialOutput);
      noteAuxLoadingOutput(initialOutput);
      auxExited = false;
      auxFollowTail = true;
      auxAttached = true;
    } catch (error) {
      auxSpawnError = error instanceof Error ? error.message : String(error);
      auxPtyId = -1;
    } finally {
      auxBusy = false;
      if (auxSpawnError) {
        void clearAuxLoadingState(true);
      }
    }
  }

  async function attachToExistingAuxPty(id: number, term: Terminal) {
    auxPtyId = id;
    auxCurrentPath = workDir;
    auxMetadataRemainder = "";
    const snapshot = await getPtyOutputSnapshot(id);
    await writeAuxTerminalData(term, snapshot.data);
    noteAuxLoadingOutput(snapshot.data);
    auxExited = false;
    auxFollowTail = true;
    auxAttached = true;
  }

  async function ensureAuxTerminalVisible() {
    if (document.activeElement instanceof HTMLElement) {
      document.activeElement.blur();
    }

    auxVisible = true;
    if (!auxInitialized) {
      auxInitialized = true;
    }

    if (auxLoadingState === null && !auxAttached) {
      showAuxLoadingState();
    }

    await tick();

    if (!auxTerminal || auxExited) {
      await createAuxTerminalInstance();
    }

    if (!auxTerminal) {
      return;
    }

    if (!auxAttached) {
      if (auxPtyId >= 0) {
        try {
          await attachToExistingAuxPty(auxPtyId, auxTerminal);
        } catch (error) {
          console.warn("Failed to attach to existing auxiliary PTY, spawning a new shell", error);
          auxPtyId = -1;
          await spawnAuxShell(auxTerminal);
        }
      } else {
        await spawnAuxShell(auxTerminal);
      }
    }

    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        settleAuxTerminalLayout();
        focusAuxTerminal();
        scheduleAuxLayoutSettle();
      });
    });
  }

  function hideAuxTerminal(options?: { restoreFocus?: boolean }) {
    auxVisible = false;
    resizingAux = false;
    clearAuxLayoutSettleTimer();
    if (options?.restoreFocus ?? true) {
      focusOutput();
    }
  }

  async function toggleAuxTerminal() {
    if (auxVisible) {
      hideAuxTerminal();
      return;
    }

    if (draftComposerState.draftOpen) {
      closeDraft({ restoreFocus: false });
    }

    await ensureAuxTerminalVisible();
  }

  function handleAuxPtyExit() {
    auxExited = true;
    auxPtyId = -1;
    auxVisible = false;
    auxBusy = false;
    clearAuxLoadingTimers();
    auxLoadingState = null;
    auxLoadingHasRenderableOutput = false;
    auxMetadataRemainder = "";
    auxAttached = false;
    focusOutput();
  }

  function stopAuxResize() {
    resizingAux = false;
    auxResizePointerId = null;
    window.removeEventListener("pointermove", handleAuxResizeMove, true);
    window.removeEventListener("pointerup", stopAuxResize, true);
    window.removeEventListener("pointercancel", stopAuxResize, true);
    document.body.style.removeProperty("cursor");
    document.body.style.removeProperty("user-select");
  }

  function handleAuxResizeMove(event: PointerEvent) {
    if (!resizingAux || auxResizePointerId !== event.pointerId || !shellEl) {
      return;
    }

    event.preventDefault();
    const delta = auxResizeStartY - event.clientY;
    const availableHeight = Math.max(shellEl.clientHeight - assistPanelHeight - 12, 1);
    const percentDelta = (delta / availableHeight) * 100;
    auxHeightPercent = clampAuxHeightPercent(auxResizeStartPercent + percentDelta);
    auxHeightCustomized = true;
  }

  function handleAuxResizeStart(event: PointerEvent) {
    if (event.button !== 0 || !auxVisible) {
      return;
    }

    event.preventDefault();
    resizingAux = true;
    auxResizePointerId = event.pointerId;
    auxResizeStartY = event.clientY;
    auxResizeStartPercent = auxHeightPercent;
    document.body.style.cursor = "ns-resize";
    document.body.style.userSelect = "none";
    window.addEventListener("pointermove", handleAuxResizeMove, true);
    window.addEventListener("pointerup", stopAuxResize, true);
    window.addEventListener("pointercancel", stopAuxResize, true);
  }

  function handleOutputChunk(event: PtyOutputChunk) {
    if (event.id === auxPtyId && auxTerminal) {
      const shouldStickToBottom = auxFollowTail;
      void writeAuxTerminalData(auxTerminal, event.data).then(() => {
        noteAuxLoadingOutput(event.data);
        if (shouldStickToBottom) {
          auxTerminal?.scrollToBottom();
        }
      });
      return;
    }

    if (event.id !== livePtyId || !terminal) {
      return;
    }

    let data = event.data;
    const parsedMetadata = consumeMainTerminalMetadata(data);
    data = parsedMetadata.text;

    if (data.includes(RESUME_FAILED_MARKER)) {
      data = data.replaceAll(`${RESUME_FAILED_MARKER}\r\n`, "").replaceAll(RESUME_FAILED_MARKER, "");
      onResumeFallback?.();
    }

    if (replayInProgress) {
      replayBuffer.push({ ...event, data });
      return;
    }

    if (initialOutputReady) {
      const repaintChunk = isLikelyTerminalRepaintChunk(data);
      const shouldStickToBottom = followTail || isBottomLockActive();
      if (!repaintChunk) {
        extendBottomLock();
      }
      terminal.write(data, () => {
        noteTerminalLoadingOutput(data);
        if (!shouldStickToBottom) {
          return;
        }

        if (repaintChunk || terminal?.modes.synchronizedOutputMode) {
          pendingPostWriteScroll = true;
          scheduleDeferredBottomScroll();
          return;
        }

        terminal?.scrollToBottom();
      });
    }
  }

  async function attachToExistingPty(id: number, term: Terminal) {
    livePtyId = id;
    replayInProgress = true;
    replayBuffer = [];
    mainMetadataRemainder = "";
    clearShellHomeDirCache();
    void registerCanonicalSession({ sessionId, ptyId: id, agentId });

    await syncMainTerminalLayoutToPty({ stickToBottom: false });

    let appliedSeq = 0;
    let restored = false;
    let fallbackSnapshotData = "";
    const canonicalSnapshot = await requestCanonicalScreenSnapshot({
      sessionId,
      ptyId: id,
      agentId,
      cols: term.cols,
      rows: term.rows,
    });

    if (canonicalSnapshot) {
      await writeMainTerminalData(term, canonicalSnapshot.serialized);
      await writeMainTerminalData(term, canonicalSnapshot.delta);
      appliedSeq = canonicalSnapshot.appliedSeq;
      restored = true;
    } else {
      const snapshot = await getPtyOutputSnapshot(id);
      await writeMainTerminalData(term, snapshot.data);
      appliedSeq = snapshot.seq;
      fallbackSnapshotData = snapshot.data;
    }

    const pendingChunks = replayBuffer
      .filter((chunk) => chunk.seq > appliedSeq)
      .sort((left, right) => left.seq - right.seq);

    replayInProgress = false;
    for (const chunk of pendingChunks) {
      await writeMainTerminalData(term, chunk.data);
    }

    initialOutputReady = true;
    armBottomLock();
    if (
      (restored && canonicalSnapshot
        ? hasRenderableTerminalOutput(canonicalSnapshot.serialized) ||
          hasRenderableTerminalOutput(canonicalSnapshot.delta)
        : false) ||
      hasRenderableTerminalOutput(fallbackSnapshotData) ||
      pendingChunks.some((chunk) => hasRenderableTerminalOutput(chunk.data))
    ) {
      noteTerminalLoadingOutput(
        restored && canonicalSnapshot
          ? `${canonicalSnapshot.serialized}${canonicalSnapshot.delta}`
          : `${fallbackSnapshotData}${pendingChunks.map((chunk) => chunk.data).join("")}`,
      );
    }

    await rehydrateShellHomeDirFromRuntimeSnapshot();
    await syncMainTerminalLayoutToPty({ refresh: true });
  }

  async function attachOrSpawnPty(term: Terminal, options?: { loadingAlreadyShown?: boolean }) {
    spawnError = null;
    if (ptyId >= 0) {
      if (!options?.loadingAlreadyShown) {
        await showTerminalLoadingState("restoring");
      }
      try {
        await attachToExistingPty(ptyId, term);
        return;
      } catch (error) {
        console.warn("Failed to attach to existing PTY, spawning a new one", error);
        livePtyId = -1;
        replayInProgress = false;
        replayBuffer = [];
        initialOutputReady = false;
        terminalLoadingState = "connecting";
        terminalLoadingStartedAt = performance.now();
        terminalLoadingHasRenderableOutput = false;
        terminalLoadingReadySignalSeen = !requiresAgentReadySignal();
        clearShellHomeDirCache();
      }
    } else {
      if (!options?.loadingAlreadyShown) {
        await showTerminalLoadingState("connecting");
      }
    }

    await spawnNewPty(term);
  }

  async function spawnNewPty(term: Terminal) {
    const { cols, rows } = getInitialPtySize(term);
    mainMetadataRemainder = "";
    clearShellHomeDirCache();
    livePtyId = await spawnPty(cols, rows, agentId, distro, workDir, resumeToken);
    void registerCanonicalSession({ sessionId, ptyId: livePtyId, agentId });
    const initialOutput = await takePtyInitialOutput(livePtyId);
    let sanitizedOutput = initialOutput;
    if (sanitizedOutput.includes(RESUME_FAILED_MARKER)) {
      sanitizedOutput = sanitizedOutput
        .replaceAll(`${RESUME_FAILED_MARKER}\r\n`, "")
        .replaceAll(RESUME_FAILED_MARKER, "");
      onResumeFallback?.();
    }
    await writeMainTerminalData(term, sanitizedOutput);
    initialOutputReady = true;
    armBottomLock();
    noteTerminalLoadingOutput(sanitizedOutput);
    onPtyId?.(livePtyId);
  }

  onMount(async () => {
    const initialTheme = getThemeById(settings.interface.theme)?.theme;
    const term = new Terminal(buildTerminalOptions(initialTheme));
    syncTerminalUnicodeWidth(term, softFollowExperimentEnabled);

    const fit = new FitAddon();
    term.loadAddon(fit);
    term.loadAddon(new WebLinksAddon(
      (event, url) => {
        if (event.button !== 0) {
          return;
        }

        event.preventDefault();
        event.stopPropagation();
        terminal?.clearSelection();
        openContextMenu({ kind: "url", url }, event.clientX, event.clientY);
      },
      {
        urlRegex: WEB_LINK_REGEX,
        hover: handleLinkHover,
        leave: handleLinkLeave,
      },
    ));
    fileLinkProviderDisposable = term.registerLinkProvider({
      provideLinks(bufferLineNumber, callback) {
        callback(
          createTerminalFileLinks(
            term,
            bufferLineNumber,
            (event, text) => {
              if (event.button !== 0) {
                return;
              }

              event.preventDefault();
              event.stopPropagation();
              void openFileLinkMenu(text, event);
            },
            handleLinkHover,
            handleLinkLeave,
          ),
        );
      },
    });

    term.open(outputEl);
    term.attachCustomKeyEventHandler(handleMainTerminalKey);
    syncRendererPreference(term, mainRendererController, preferredRenderer, (value) => {
      activeRenderer = value;
    });
    inputTextarea = term.textarea;

    await tick();
    syncDraftHeight();
    syncAssistPanelHeight();

    applyCompositionViewTheme();

    unlistenOutput = await listen<PtyOutputChunk>("pty-output", (event) => {
      handleOutputChunk(event.payload);
    });

    unlistenExit = await listen<number>("pty-exit", (event) => {
      if (event.payload === livePtyId) {
        onExit?.(event.payload);
        return;
      }

      if (event.payload === auxPtyId) {
        handleAuxPtyExit();
      }
    });

    try {
      terminal = term;
      fitAddon = fit;
      terminalReady = true;
      await showTerminalLoadingState(ptyId >= 0 ? "restoring" : "connecting");
      await syncMainTerminalLayoutToPty({ stickToBottom: false });

      await attachOrSpawnPty(term, { loadingAlreadyShown: true });
      terminalStartupSettled = true;
      scheduleEditorQuickOpenPrewarm();
    } catch (error) {
      spawnError = error instanceof Error ? error.message : String(error);
      await clearTerminalLoadingState();
    }

    term.onData((data) => {
      if (livePtyId >= 0) {
        void writePty(livePtyId, data);
      }
    });

    resizeObserver = new ResizeObserver(() => {
      if (visible && fit && editorViewMode === "terminal") {
        void syncMainTerminalLayoutToPty();
      }
    });
    resizeObserver.observe(outputEl);

    assistResizeObserver = new ResizeObserver(() => {
      syncAssistPanelHeight();
    });
    if (assistPanelEl) {
      assistResizeObserver.observe(assistPanelEl);
    }

    term.onResize(({ cols, rows }) => {
      if (livePtyId >= 0) {
        void resizePty(livePtyId, cols, rows);
      }
      if (editorViewMode === "terminal" && (followTail || isBottomLockActive())) {
        scrollTerminalToBottom();
      }
    });

    term.onRender(() => {
      handleTerminalRender();
    });

    writeParsedDisposable = term.onWriteParsed(() => {
      if (!softFollowExperimentEnabled || !pendingPostWriteScroll || term.modes.synchronizedOutputMode) {
        return;
      }

      scheduleDeferredBottomScroll();
    });

    term.onScroll((viewportY) => {
      if (!terminal || isBottomLockActive()) {
        return;
      }

      followTail = viewportY >= terminal.buffer.active.baseY;
    });

    inputTextarea?.addEventListener("paste", handleTerminalPaste as EventListener, true);
    outputEl.addEventListener("mousemove", handleLinkPointerMove, true);
    outputEl.addEventListener("wheel", disableAutoFollow, true);
    window.addEventListener("mouseup", releaseLinkSelectionBlock, true);
    window.addEventListener("blur", releaseLinkSelectionBlock);
    window.addEventListener("keydown", handleAuxShortcut, true);
    window.addEventListener("keydown", handleEditorShortcut, true);
    window.addEventListener("clcomx:focus-active-terminal", handleFocusRequest);
    window.addEventListener(TEST_BRIDGE_EVENTS.openPendingImage, handleTestPendingImage as EventListener);
    if (isTestBridgeEnabled()) {
      registerTestHooks();
      testHookRegistered = true;
    }
  });

  $effect(() => {
    if (!terminalReady || !visible || editorViewMode !== "terminal") return;

    armBottomLock();
    void syncMainTerminalLayoutToPty();
  });

  $effect(() => {
    terminalReady;
    terminalStartupSettled;
    visible;
    editorQuickOpenVisible;
    editorQuickOpenBusy;
    editorQuickOpenRootDir;
    editorQuickOpenLastUpdatedMs;
    editorRootDir;
    editorQuickOpenEntries.length;
    editorQuickOpenPrewarmRequestedRootDir;
    editorQuickOpenPrewarmInFlightRootDir;

    if (!visible) {
      cancelEditorQuickOpenPrewarm();
      cancelEditorMonacoPrewarm();
      return;
    }

    scheduleEditorQuickOpenPrewarm(editorRootDir || workDir);
    scheduleEditorMonacoPrewarm();
  });

  $effect(() => {
    if (!visible || !auxVisible || !auxTerminal) return;

    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        void settleAuxTerminalLayout();
        focusAuxTerminal();
        scheduleAuxLayoutSettle();
      });
    });
  });

  $effect(() => {
    if (visible) return;
    closeLinkMenu();
    closeEditorPicker();
    closeEditorQuickOpen();
    cancelCloseEditorTab();
  });

  $effect(() => {
    const themeDef = getThemeById(settings.interface.theme);
    applyCompositionViewTheme();
    if (!terminalReady) return;
    if (themeDef) {
      terminal!.options.theme = themeDef.theme;
      if (auxTerminal) {
        auxTerminal.options.theme = themeDef.theme;
      }
    }
  });

  $effect(() => {
    if (!terminalReady) return;
    terminal!.options.fontSize = settings.terminal.fontSize;
    terminal!.options.fontFamily = terminalFontFamily;
    terminal!.options.scrollback = settings.terminal.scrollback;
    if (auxTerminal) {
      auxTerminal.options.fontSize = settings.terminal.fontSize;
      auxTerminal.options.fontFamily = terminalFontFamily;
      auxTerminal.options.scrollback = settings.terminal.scrollback;
    }
    void syncMainTerminalLayoutToPty();
    if (auxTerminal) {
      scheduleAuxLayoutSettle(0);
    }
  });

  $effect(() => {
    if (!terminalReady || !terminal || editorViewMode !== "terminal") return;
    syncTerminalUnicodeWidth(terminal, softFollowExperimentEnabled);
    if (auxTerminal) {
      syncTerminalUnicodeWidth(auxTerminal, softFollowExperimentEnabled);
    }
  });

  $effect(() => {
    if (!terminalReady || !terminal || editorViewMode !== "terminal") return;
    syncRendererPreference(terminal, mainRendererController, preferredRenderer, (value) => {
      activeRenderer = value;
    });
    if (auxTerminal) {
      syncRendererPreference(auxTerminal, auxRendererController, preferredRenderer, () => {});
    }
  });

  $effect(() => {
    draftComposerState.draftOpen;
    tick().then(syncAssistPanelHeight);
  });

  $effect(() => {
    settings.terminal.auxTerminalDefaultHeight;
    if (!auxHeightCustomized) {
      auxHeightPercent = clampAuxHeightPercent(settings.terminal.auxTerminalDefaultHeight);
    }
  });

  $effect(() => {
    if (auxStateHydrated) return;
    auxPtyId = storedAuxPtyId;
    auxVisible = storedAuxVisible;
    auxInitialized = storedAuxVisible;
    auxExited = storedAuxPtyId < 0;
    auxHeightPercent = clampAuxHeightPercent(
      storedAuxHeightPercent ?? settings.terminal.auxTerminalDefaultHeight,
    );
    auxHeightCustomized = storedAuxHeightPercent !== null;
    auxStateHydrated = true;
  });

  $effect(() => {
    onAuxStateChange?.({
      auxPtyId,
      auxVisible,
      auxHeightPercent: auxHeightCustomized ? auxHeightPercent : null,
    });
  });

  $effect(() => {
    if (auxPtyId < 0) {
      auxCurrentPath = workDir;
    }
  });

  $effect(() => {
    if (shellHomeDirSessionId === null) {
      shellHomeDirSessionId = sessionId;
      return;
    }

    if (shellHomeDirSessionId === sessionId) {
      return;
    }

    shellHomeDirSessionId = sessionId;
    clearShellHomeDirCache();
    mainMetadataRemainder = "";
  });

  $effect(() => {
    if (editorHydratedSessionId === sessionId) {
      return;
    }

    void ensureEditorRuntimeReady();
  });

  onDestroy(() => {
    window.removeEventListener("clcomx:focus-active-terminal", handleFocusRequest);
    window.removeEventListener(TEST_BRIDGE_EVENTS.openPendingImage, handleTestPendingImage as EventListener);
    window.removeEventListener("keydown", handleAuxShortcut, true);
    window.removeEventListener("keydown", handleEditorShortcut, true);
    if (isTestBridgeEnabled()) {
      unregisterTestHooks();
      testHookRegistered = false;
    }
    inputTextarea?.removeEventListener("paste", handleTerminalPaste as EventListener, true);
    outputEl?.removeEventListener("mousemove", handleLinkPointerMove, true);
    outputEl?.removeEventListener("wheel", disableAutoFollow, true);
    window.removeEventListener("mouseup", releaseLinkSelectionBlock, true);
    window.removeEventListener("blur", releaseLinkSelectionBlock);
    stopDraftResize();
    stopAuxResize();
    unlistenOutput?.();
    unlistenExit?.();
    resizeObserver?.disconnect();
    assistResizeObserver?.disconnect();
    clearTerminalLoadingTimers();
    clearAuxLayoutSettleTimer();
    clearDeferredBottomScrollTimer();
    cancelEditorQuickOpenPrewarm();
    releaseBottomLock();
    pendingPostWriteScroll = false;
    invalidateEditorQuickOpenRequest();
    disposeOverlayInteraction();
    fileLinkProviderDisposable?.dispose();
    writeParsedDisposable?.dispose();
    disposeAuxTerminalInstance();
    releaseRendererController(mainRendererController);
    terminal?.dispose();
    fitAddon = null;
    terminal = null;
  });

  $effect(() => {
    if (!terminalReady || !visible || !storedAuxVisible) return;
    if (auxVisible && auxAttached) return;
    void ensureAuxTerminalVisible();
  });
</script>

<div
  class="terminal-shell"
  data-testid={TEST_IDS.terminalShell}
  data-agent-id={agentId}
  data-session-id={sessionId}
  data-pty-id={String(livePtyId)}
  data-aux-pty-id={String(auxPtyId)}
  data-aux-visible={auxVisible ? "true" : "false"}
  data-draft-open={draftComposerState.draftOpen ? "true" : "false"}
  data-pending-image={overlayInteractionState.pendingClipboardImage ? "true" : "false"}
  data-test-hook-registered={testHookRegistered ? "true" : "false"}
  data-loading-state={terminalLoadingState ?? "idle"}
  data-soft-follow-experiment={softFollowExperimentEnabled ? "true" : "false"}
  data-renderer-preference={preferredRenderer}
  data-renderer={activeRenderer}
  class:hidden={!visible}
  bind:this={shellEl}
>
  {#if editorViewMode === "editor"}
    <InternalEditor
      tabs={editorRuntimeState.tabs}
      activePath={editorRuntimeState.activePath}
      rootDir={editorRootDir || workDir}
      busy={editorBusy}
      statusText={editorRuntimeState.statusText}
      title={$t("terminal.editor.title")}
      emptyTitle={$t("terminal.editor.emptyTitle")}
      emptyDescription={$t("terminal.editor.emptyDescription")}
      saveLabel={$t("common.actions.save")}
      openFileLabel={$t("terminal.editor.openFile")}
      switchToTerminalLabel={$t("terminal.editor.switchToTerminal")}
      onActivePathChange={handleEditorActivePathChange}
      onCloseTab={closeEditorTab}
      onContentChange={handleEditorContentChange}
      onSaveRequest={(wslPath) => void saveEditorTab(wslPath)}
      onOpenFile={() => void openEditorQuickOpen(editorRootDir || workDir)}
      onSwitchToTerminal={requestSwitchToTerminalMode}
      onListWorkspaceFiles={listEditorWorkspaceFiles}
      onReadWorkspaceFile={readEditorNavigationFile}
      onOpenLocation={openEditorNavigationLocation}
    />
  {/if}

  <div
    class="terminal-runtime"
    class:terminal-runtime--hidden={editorViewMode !== "terminal"}
    aria-hidden={editorViewMode === "terminal" ? undefined : "true"}
  >
  <div
    class="terminal-output"
    class:terminal-output--link-hover={overlayInteractionState.linkHovering}
    data-testid={TEST_IDS.terminalOutput}
    bind:this={outputEl}
  >
    {#if spawnError}
      <div class="terminal-error">
        {$t("terminal.assist.startFailed", { values: { message: spawnError } })}
      </div>
    {/if}

    {#if overlayInteractionState.clipboardNotice}
      <div class="terminal-notice">
        {overlayInteractionState.clipboardNotice}
      </div>
    {/if}

    {#if terminalLoadingState !== null && !spawnError}
      <div class="terminal-connect-overlay">
        <div class="terminal-connect-card">
          <div class="terminal-connect-eyebrow">CLCOMX</div>
          <div class="terminal-connect-title">{terminalLoadingLabel}</div>
          <div class="terminal-connect-hint">{$t("terminal.loading.hint")}</div>
          <div class="terminal-connect-dots" aria-hidden="true">
            <span></span>
            <span></span>
            <span></span>
          </div>
          <div class="terminal-connect-bar" aria-hidden="true">
            <span></span>
          </div>
        </div>
      </div>
    {/if}
  </div>

  {#if draftComposerState.draftOpen}
    <TerminalDraftPanel
      title={$t("terminal.assist.draftTitle")}
      draftValue={draftComposerState.draftValue}
      fixedHeightPx={draftComposerState.draftHeightPx}
      bind:draftElement={draftComposerState.draftEl}
      bind:panelElement={draftComposerState.draftPanelEl}
      onResizeStart={handleDraftResizeStart}
      onClose={toggleDraft}
      onDraftInput={handleDraftInput}
      onDraftKeydown={handleDraftKeydown}
      onDraftPaste={handleDraftPaste}
      onInsertDraft={() => void insertDraftIntoTerminal(false)}
      onSendDraft={() => void insertDraftIntoTerminal(true)}
    />
  {/if}

  {#if auxInitialized}
    {#snippet liveAuxBody()}
      {#if auxSpawnError}
        <div class="terminal-error">
          {$t("terminal.aux.startFailed", { values: { message: auxSpawnError } })}
        </div>
      {/if}
    {/snippet}

    {#snippet liveAuxOverlay()}
      {#if auxLoadingState !== null && !auxSpawnError}
        <div class="terminal-connect-overlay terminal-connect-overlay--subpanel terminal-connect-overlay--aux-panel">
          <div class="terminal-connect-card terminal-connect-card--compact">
            <div class="terminal-connect-eyebrow">CLCOMX</div>
            <div class="terminal-connect-title">{auxLoadingLabel}</div>
            <div class="terminal-connect-hint">{$t("terminal.aux.loadingHint")}</div>
            <div class="terminal-connect-dots" aria-hidden="true">
              <span></span>
              <span></span>
              <span></span>
            </div>
          </div>
        </div>
      {/if}
    {/snippet}

    <TerminalAuxPanel
      visible={auxVisible}
      heightPercent={auxHeightPercent}
      title={$t("terminal.aux.title")}
      currentPath={auxCurrentPath}
      pathLabel={$t("terminal.aux.currentPath")}
      outputTestId={TEST_IDS.auxTerminalShell}
      resizable={true}
      onResizeStart={handleAuxResizeStart}
      onClose={hideAuxTerminal}
      body={liveAuxBody}
      overlay={liveAuxOverlay}
      onOutputElementChange={(element) => {
        auxOutputEl = element;
      }}
    />
  {/if}

  <div bind:this={assistPanelEl}>
    <TerminalAssistPanel
      auxVisible={auxVisible}
      auxBusy={auxBusy}
      draftOpen={draftComposerState.draftOpen}
      draftValue={draftComposerState.draftValue}
      showEditorActions={true}
      onPasteImage={handlePasteImageFromClipboard}
      onOpenFile={() => void openEditorQuickOpen(editorRootDir || workDir)}
      onOpenEditor={requestSwitchToEditorMode}
      onToggleAux={() => {
        document.activeElement instanceof HTMLElement && document.activeElement.blur();
        void toggleAuxTerminal();
      }}
      onToggleDraft={toggleDraft}
    />
  </div>
  </div>
</div>

<ContextMenu
  visible={overlayInteractionState.linkMenuVisible}
  x={overlayInteractionState.linkMenuX}
  y={overlayInteractionState.linkMenuY}
  items={linkMenuItems}
  onSelect={handleLinkMenuSelect}
  onClose={closeLinkMenu}
/>

<ImagePasteModal
  visible={overlayInteractionState.pendingClipboardImage !== null}
  image={overlayInteractionState.pendingClipboardImage}
  busy={overlayInteractionState.clipboardBusy}
  error={overlayInteractionState.clipboardError}
  onCancel={() => resetClipboardImage(true)}
  onConfirm={confirmClipboardImage}
/>

<EditorPickerModal
  visible={overlayInteractionState.editorPickerVisible}
  title={$t("terminal.filePaths.pickerTitle")}
  description={$t("terminal.filePaths.pickerDescription")}
  emptyLabel={editorsError || $t("terminal.filePaths.noEditors")}
  defaultEditorId={settings.interface.defaultEditorId}
  editors={detectedEditors}
  onSelect={handleEditorSelect}
  onClose={closeEditorPicker}
/>

<EditorQuickOpenModal
  visible={editorQuickOpenVisible}
  openKey={editorQuickOpenOpenKey}
  initialQuery={editorQuickOpenQuery}
  rootDir={editorQuickOpenRootDir || editorRootDir || workDir}
  entries={editorQuickOpenEntries}
  title={$t("terminal.editor.quickOpenTitle")}
  description={$t("terminal.editor.quickOpenDescription")}
  placeholder={$t("terminal.editor.quickOpenPlaceholder")}
  idleLabel={$t("terminal.editor.quickOpenIdle")}
  emptyLabel={$t("terminal.editor.quickOpenEmpty")}
  loadingLabel={$t("terminal.editor.quickOpenLoading")}
  refreshLabel={$t("common.actions.refresh")}
  closeLabel={$t("common.actions.close")}
  keyboardHintLabel={$t("terminal.editor.quickOpenKeyboardHint")}
  busy={editorQuickOpenBusy}
  onRefresh={() => void refreshEditorQuickOpenEntries(true)}
  onSelect={openEditorPathFromQuickResult}
  onClose={closeEditorQuickOpen}
/>

<TerminalEditorCloseConfirmModal
  open={editorRuntimeState.closeConfirmVisible}
  title={editorCloseConfirmLabel}
  onClose={cancelCloseEditorTab}
  onConfirm={confirmCloseEditorTab}
/>

<TerminalInterruptConfirmModal
  open={interruptConfirmVisible}
  onClose={closeInterruptConfirm}
  onConfirm={confirmTerminalInterrupt}
/>

<style>
  .terminal-shell {
    width: 100%;
    height: 100%;
    display: flex;
    flex-direction: column;
    position: relative;
    background: var(--ui-bg-app, var(--app-bg));
  }

  .terminal-runtime {
    display: flex;
    flex: 1;
    min-height: 0;
    flex-direction: column;
  }

  .terminal-runtime.terminal-runtime--hidden {
    display: none;
  }

  .terminal-shell.hidden {
    position: absolute;
    left: -9999px;
    visibility: hidden;
  }

  .terminal-output {
    flex: 1;
    min-height: 0;
    padding: var(--ui-space-1);
    position: relative;
  }

  .terminal-connect-overlay {
    position: absolute;
    inset: var(--ui-space-1);
    display: grid;
    place-items: center;
    padding: clamp(20px, 3vw, 28px);
    border-radius: calc(var(--ui-radius-lg) + 2px);
    background:
      linear-gradient(180deg, rgba(var(--ui-shadow-rgb, 15, 23, 42), 0.16), rgba(var(--ui-shadow-rgb, 15, 23, 42), 0.3)),
      color-mix(in srgb, var(--ui-bg-app, var(--app-bg)) 72%, transparent);
    backdrop-filter: blur(6px);
    z-index: 8;
  }

  .terminal-connect-card {
    min-width: min(320px, 100%);
    max-width: min(420px, 100%);
    display: grid;
    gap: var(--ui-space-2);
    padding: clamp(18px, 2.2vw, 24px);
    border: 1px solid color-mix(in srgb, var(--ui-border-strong, var(--tab-border)) 78%, transparent);
    border-radius: calc(var(--ui-radius-xl) + 2px);
    background:
      linear-gradient(180deg, color-mix(in srgb, var(--ui-bg-surface, var(--tab-active-bg)) 94%, transparent), transparent),
      color-mix(in srgb, var(--ui-bg-app, var(--app-bg)) 90%, transparent);
    box-shadow: 0 18px 40px rgba(var(--ui-shadow-rgb, 15, 23, 42), 0.24);
  }

  .terminal-connect-card--compact {
    min-width: min(280px, 100%);
    gap: var(--ui-space-2);
    padding: clamp(16px, 2vw, 20px);
  }

  .terminal-connect-eyebrow {
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 0.16em;
    text-transform: uppercase;
    color: var(--ui-text-muted, var(--tab-text));
  }

  .terminal-connect-title {
    font-size: clamp(18px, 2vw, 22px);
    font-weight: 700;
    line-height: 1.2;
    color: var(--ui-text-primary, var(--tab-text));
  }

  .terminal-connect-hint {
    font-size: var(--ui-font-size-sm);
    line-height: 1.55;
    color: var(--ui-text-muted, var(--tab-text));
  }

  .terminal-connect-dots {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    margin-top: var(--ui-space-1);
  }

  .terminal-connect-dots span {
    width: 8px;
    height: 8px;
    border-radius: 999px;
    background: color-mix(in srgb, var(--ui-accent, var(--tab-accent, #6ea8ff)) 82%, white 18%);
    animation: terminal-loading-bounce 1.1s ease-in-out infinite;
  }

  .terminal-connect-dots span:nth-child(2) {
    animation-delay: 0.12s;
  }

  .terminal-connect-dots span:nth-child(3) {
    animation-delay: 0.24s;
  }

  .terminal-connect-bar {
    position: relative;
    overflow: hidden;
    width: 100%;
    height: 4px;
    margin-top: var(--ui-space-1);
    border-radius: 999px;
    background: color-mix(in srgb, var(--ui-border-subtle, var(--tab-border)) 72%, transparent);
  }

  .terminal-connect-bar span {
    position: absolute;
    top: 0;
    bottom: 0;
    left: -24%;
    width: 24%;
    border-radius: inherit;
    background: linear-gradient(90deg, transparent, color-mix(in srgb, var(--ui-accent, var(--tab-accent, #6ea8ff)) 92%, white 8%), transparent);
    animation: terminal-loading-sweep 1.5s ease-in-out infinite;
  }

  .terminal-connect-overlay--subpanel {
    inset: 0;
    padding: var(--ui-space-3);
    border-radius: var(--ui-radius-md);
  }

  .terminal-connect-overlay--aux-panel {
    z-index: 24;
    border-radius: inherit;
  }

  @keyframes terminal-loading-bounce {
    0%, 80%, 100% {
      transform: translateY(0);
      opacity: 0.42;
    }
    40% {
      transform: translateY(-4px);
      opacity: 1;
    }
  }

  @keyframes terminal-loading-sweep {
    0% {
      transform: translateX(0);
    }
    100% {
      transform: translateX(520%);
    }
  }

  .terminal-output.terminal-output--link-hover {
    cursor: pointer;
  }

  .terminal-error {
    position: absolute;
    inset: var(--ui-space-4);
    padding: var(--ui-space-3) var(--ui-space-4);
    border: 1px solid color-mix(in srgb, var(--ui-danger, #ef4444) 70%, transparent);
    border-radius: var(--ui-radius-md);
    background: var(--ui-danger-soft, rgba(127, 29, 29, 0.18));
    color: color-mix(in srgb, var(--ui-danger, #ef4444) 28%, white);
    font-size: var(--ui-font-size-base);
    white-space: pre-wrap;
    z-index: 10;
  }

  .terminal-notice {
    position: absolute;
    right: var(--ui-space-4);
    bottom: var(--ui-space-4);
    max-width: min(calc(420px * var(--ui-scale)), calc(100vw - 32px));
    padding: calc(10px * var(--ui-scale)) var(--ui-space-3);
    border-radius: var(--ui-radius-md);
    color: var(--ui-text-primary, #f8fafc);
    background: color-mix(in srgb, var(--ui-bg-elevated, var(--tab-bg)) 92%, black 8%);
    border: 1px solid var(--ui-border-subtle, rgba(148, 163, 184, 0.24));
    box-shadow: 0 10px 26px rgba(var(--ui-shadow-rgb, 15, 23, 42), 0.26);
    font-size: var(--ui-font-size-sm);
    z-index: 30;
  }

  :global(.xterm .composition-view) {
    padding: 0 1px;
    border-radius: 2px;
    color: var(--ime-composition-fg, #f8fafc);
    background: var(--ime-composition-bg, rgba(15, 23, 42, 0.18));
    box-shadow: none;
    border: none;
  }

</style>

<script lang="ts">
  import { onMount, onDestroy, tick } from "svelte";
  import { Terminal, type IDisposable } from "@xterm/xterm";
  import { FitAddon } from "@xterm/addon-fit";
  import { WebLinksAddon } from "@xterm/addon-web-links";
  import TerminalEmbeddedEditorSurface from "../features/terminal/view/TerminalEmbeddedEditorSurface.svelte";
  import TerminalOverlayStack from "../features/terminal/view/TerminalOverlayStack.svelte";
  import TerminalRuntimeSurface from "../features/terminal/view/TerminalRuntimeSurface.svelte";
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
  } from "../editors";
  import { warmMonacoEditorRuntime } from "../editor/monaco-host";
  import { createTerminalFileLinks } from "../terminal/file-links";
  import {
    isClaudeFooterGhostingMitigationEnabled,
    syncTerminalUnicodeWidth,
  } from "../terminal/claude-footer-ghosting";
  import { TEST_IDS } from "../testids";
  import { openExternalUrl } from "../workspace";
  import type { SessionHostProps } from "../features/session/contracts/session-shell";
  import { createEditorQuickOpenState } from "../features/editor/state/editor-quick-open-state.svelte";
  import { createEditorRuntimeState } from "../features/editor/state/editor-runtime-state.svelte";
  import { createDraftComposerController } from "../features/terminal/controller/draft-composer-controller";
  import { createAuxTerminalRuntimeController } from "../features/terminal/controller/aux-terminal-runtime-controller";
  import { createAuxTerminalResizeController } from "../features/terminal/controller/aux-terminal-resize-controller";
  import { applyTerminalCompositionViewTheme } from "../features/terminal/controller/composition-view-theme";
  import { createMainTerminalRuntimeController } from "../features/terminal/controller/main-terminal-runtime-controller";
  import { buildOverlayLinkMenuItems } from "../features/terminal/controller/overlay-link-menu-items";
  import { createOverlayInteractionController } from "../features/terminal/controller/overlay-interaction-controller";
  import {
    focusTerminalSurface,
    isEditableTarget,
    isInsideInternalEditor,
    shouldInterceptTerminalCtrlC,
    waitForStableTerminalLayout,
    waitForTerminalPaint as waitForTerminalPaintFrame,
    writeTerminalData,
  } from "../features/terminal/controller/terminal-dom-helpers";
  import {
    createTerminalRendererController,
    releaseTerminalRendererController,
    syncTerminalRendererPreference,
  } from "../features/terminal/controller/terminal-renderer-controller";
  import { createTerminalEditorIntegrationController } from "../features/terminal/controller/terminal-editor-integration-controller";
  import { createTerminalEditorPreflightController } from "../features/terminal/controller/terminal-editor-preflight-controller";
  import {
    addTerminalFocusRequestListener,
    removeTerminalFocusRequestListener,
  } from "../features/terminal/controller/terminal-focus-bridge";
  import { createTerminalTestBridgeController } from "../features/terminal/controller/terminal-test-bridge-controller";
  import { createAuxTerminalRuntimeState } from "../features/terminal/state/aux-terminal-runtime-state.svelte";
  import { createDraftComposerState } from "../features/terminal/state/draft-composer-state.svelte";
  import { createMainTerminalRuntimeState } from "../features/terminal/state/main-terminal-runtime-state.svelte";
  import { createOverlayInteractionState } from "../features/terminal/state/overlay-interaction-state.svelte";
  import {
    TEST_BRIDGE_EVENTS,
    getOrCreateTerminalTestHooks,
    isTestBridgeEnabled,
  } from "../testing/test-bridge";
  import "@xterm/xterm/css/xterm.css";

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
    sessionSnapshot = null,
    onEditorSessionStateChange,
    resumeToken = null,
    onPtyId,
    onAuxStateChange,
    onExit,
    onResumeFallback,
  }: SessionHostProps = $props();

  let shellEl: HTMLDivElement;
  let outputEl = $state<HTMLDivElement>(undefined!);
  let auxOutputEl = $state<HTMLDivElement | null>(null);
  let assistPanelEl = $state<HTMLDivElement | null>(null);
  let terminal: Terminal | null = null;
  let fitAddon: FitAddon | null = null;
  let inputTextarea: HTMLTextAreaElement | undefined;
  const auxTerminalRuntimeState = createAuxTerminalRuntimeState();
  const mainTerminalRuntimeState = createMainTerminalRuntimeState();
  let terminalReady = $state(false);
  let terminalStartupSettled = $state(false);
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
  let auxVisible = $state(false);
  let auxInitialized = $state(false);
  let auxHeightPercent = $state(28);
  let auxHeightCustomized = false;
  let auxStateHydrated = false;
  let auxLayoutSettleTimer: ReturnType<typeof setTimeout> | null = null;
  let assistPanelHeight = $state(0);
  let testHookRegistered = $state(false);
  let writeParsedDisposable: IDisposable | null = null;
  let editorViewMode = $state<"terminal" | "editor">("terminal");
  let editorRootDir = $state("");
  const editorQuickOpenState = createEditorQuickOpenState();
  const editorRuntimeState = createEditorRuntimeState();
  const WEB_LINK_REGEX = /(?:https?|ftp):[/]{2}[^\s"'!*(){}|\\^<>`]*[^\s"':,.!?{}|\\^~\[\]`()<>]/i;

  const settings = getSettings();
  const bootstrap = getBootstrap();
  const softFollowExperimentEnabled = $derived(
    isClaudeFooterGhostingMitigationEnabled(
      agentId,
      settings.terminal.claudeFooterGhostingMitigation,
      bootstrap.softFollowExperiment,
    ),
  );
  const mainTerminalRuntime = createMainTerminalRuntimeController({
    state: mainTerminalRuntimeState,
    getSessionId: () => sessionId,
    getStoredPtyId: () => ptyId,
    getAgentId: () => agentId,
    getDistro: () => distro,
    getWorkDir: () => workDir,
    getResumeToken: () => resumeToken,
    getTerminal: () => terminal,
    getSoftFollowExperimentEnabled: () => softFollowExperimentEnabled,
    getEditorViewMode: () => editorViewMode,
    getInitialPtySize,
    writeTerminalData,
    waitForTerminalPaint: () =>
      waitForTerminalPaintFrame({
        tick,
        requestAnimationFrame: (callback) => requestAnimationFrame(callback),
      }),
    syncLayoutToPty: syncMainTerminalLayoutToPty,
    scrollTerminalToBottom,
    requestCanonicalScreenSnapshot,
    registerCanonicalSession,
    spawnPty,
    takePtyInitialOutput,
    getPtyOutputSnapshot,
    getPtyRuntimeSnapshot,
    resizePty,
    onPtyId: (nextPtyId) => onPtyId?.(nextPtyId),
    onResumeFallback: () => onResumeFallback?.(),
    onExit: (exitedPtyId) => onExit?.(exitedPtyId),
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
    getLivePtyId: () => mainTerminalRuntimeState.livePtyId,
    writeLivePty: (text) => writePty(mainTerminalRuntimeState.livePtyId, text),
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
  const terminalEditorPreflight = createTerminalEditorPreflightController({
    getAuxVisible: () => auxVisible,
    getDraftOpen: () => draftComposerState.draftOpen,
    hideAuxTerminal,
    closeDraft,
  });
  const {
    cancelCloseTab: cancelCloseEditorTab,
    confirmCloseTab: confirmCloseEditorTab,
    handleActivePathChange: handleEditorActivePathChange,
    handleContentChange: handleEditorContentChange,
    invalidateQuickOpenRequest: invalidateEditorQuickOpenRequest,
    listWorkspaceFiles: listEditorWorkspaceFiles,
    openInternalEditorForLinkPath,
    openNavigationLocation: openEditorNavigationLocation,
    openPathFromQuickResult: openEditorPathFromQuickResult,
    openQuickOpen: openEditorQuickOpen,
    readNavigationFile: readEditorNavigationFile,
    refreshQuickOpenEntries: refreshEditorQuickOpenEntries,
    requestCloseTab: closeEditorTab,
    requestSwitchToEditorMode,
    saveTab: saveEditorTab,
    scheduleMonacoPrewarm: scheduleEditorMonacoPrewarm,
    scheduleQuickOpenPrewarm: scheduleEditorQuickOpenPrewarm,
    switchToTerminalView,
    cancelMonacoPrewarm: cancelEditorMonacoPrewarm,
    cancelQuickOpenPrewarm: cancelEditorQuickOpenPrewarm,
    closeQuickOpen: closeEditorQuickOpen,
    ensureRuntimeReady: ensureEditorRuntimeReady,
  } = createTerminalEditorIntegrationController({
    runtimeState: editorRuntimeState,
    quickOpenState: editorQuickOpenState,
    getSessionId: () => sessionId,
    getSessionSnapshot: () => sessionSnapshot,
    getWorkDir: () => workDir,
    getViewMode: () => editorViewMode,
    setViewMode: (viewMode) => {
      editorViewMode = viewMode;
    },
    getRootDir: () => editorRootDir,
    setRootDir: (rootDir) => {
      editorRootDir = rootDir;
    },
    onEditorSessionStateChange: (sessionState) => {
      void onEditorSessionStateChange?.(sessionState);
    },
    prepareForEditorMode: terminalEditorPreflight.prepareForEditorMode,
    prepareForEditorPathOpen: terminalEditorPreflight.prepareForEditorPathOpen,
    getLoadingStatusLabel: () => $t("common.labels.loading"),
    getSaveStatusLabel: () => $t("common.actions.save"),
    readSessionFile,
    writeSessionFile,
    getVisible: () => visible,
    getTerminalReady: () => terminalReady,
    getTerminalStartupSettled: () => terminalStartupSettled,
    getThemeDefinition: () => getThemeById(settings.interface.theme) ?? null,
    warmMonacoRuntime: warmMonacoEditorRuntime,
    listSessionFiles,
    reportForegroundError: (message) => setClipboardNotice(message),
  });
  const auxTerminalRuntime = createAuxTerminalRuntimeController({
    state: auxTerminalRuntimeState,
    getDistro: () => distro,
    getWorkDir: () => workDir,
    getTerminal: () => auxTerminal,
    getInitialPtySize,
    writeTerminalData,
    focusOutput,
    spawnShellPty,
    takePtyInitialOutput,
    getPtyOutputSnapshot,
    writePty,
    resizePty,
  });
  const auxTerminalResize = createAuxTerminalResizeController({
    getAuxVisible: () => auxVisible,
    getDefaultHeightPercent: () => settings.terminal.auxTerminalDefaultHeight,
    getShellHeight: () => shellEl?.clientHeight ?? null,
    getAssistPanelHeight: () => assistPanelHeight,
    getHeightPercent: () => auxHeightPercent,
    setHeightPercent: (value) => {
      auxHeightPercent = value;
    },
    markHeightCustomized: () => {
      auxHeightCustomized = true;
    },
  });
  const {
    cancelResizeTracking: cancelAuxResizeTracking,
    clampHeightPercent: clampAuxHeightPercent,
    handleResizeStart: handleAuxResizeStart,
    stopResize: stopAuxResize,
  } = auxTerminalResize;
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
    getShellHomeDirHint: mainTerminalRuntime.getShellHomeDirHint,
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
    getLivePtyId: () => mainTerminalRuntimeState.livePtyId,
    getAuxPtyId: () => auxTerminalRuntimeState.ptyId,
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
  const preferredRenderer = $derived(settings.terminal.renderer);
  const editorBusy = $derived(editorRuntimeState.tabs.some((tab) => tab.loading || tab.saving));
  const editorSurfaceRootDir = $derived(editorRootDir || workDir);
  const editorCloseConfirmLabel = $derived(
    editorRuntimeState.closeConfirmPath ? editorRuntimeState.closeConfirmPath.split("/").pop() || editorRuntimeState.closeConfirmPath : "",
  );
  const editorSurfaceLabels = $derived({
    title: $t("terminal.editor.title"),
    emptyTitle: $t("terminal.editor.emptyTitle"),
    emptyDescription: $t("terminal.editor.emptyDescription"),
    saveLabel: $t("common.actions.save"),
    openFileLabel: $t("terminal.editor.openFile"),
    switchToTerminalLabel: $t("terminal.editor.switchToTerminal"),
    quickOpenTitle: $t("terminal.editor.quickOpenTitle"),
    quickOpenDescription: $t("terminal.editor.quickOpenDescription"),
    quickOpenPlaceholder: $t("terminal.editor.quickOpenPlaceholder"),
    quickOpenIdleLabel: $t("terminal.editor.quickOpenIdle"),
    quickOpenEmptyLabel: $t("terminal.editor.quickOpenEmpty"),
    quickOpenLoadingLabel: $t("terminal.editor.quickOpenLoading"),
    refreshLabel: $t("common.actions.refresh"),
    closeLabel: $t("common.actions.close"),
    keyboardHintLabel: $t("terminal.editor.quickOpenKeyboardHint"),
  });
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
    mainTerminalRuntimeState.terminalLoadingState === "restoring"
      ? $t("terminal.loading.restoring")
      : $t("terminal.loading.connecting"),
  );
  const auxLoadingLabel = $derived($t("terminal.aux.loadingTitle"));

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

  const mainRendererController = createTerminalRendererController();
  const auxRendererController = createTerminalRendererController();

  function applyCompositionViewTheme() {
    applyTerminalCompositionViewTheme(shellEl, getThemeById(settings.interface.theme)?.theme);
  }

  function getInitialPtySize(term: Terminal) {
    return {
      cols: term.cols > 0 ? term.cols : settings.interface.windowDefaultCols,
      rows: term.rows > 0 ? term.rows : settings.interface.windowDefaultRows,
    };
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
    const stickToBottom =
      options?.stickToBottom
      ?? (mainTerminalRuntimeState.followTail || mainTerminalRuntime.isBottomLockActive());
    const refresh = options?.refresh ?? false;

    await waitForStableTerminalLayout({
      tick,
      getFontsReady: () => document.fonts?.ready,
      requestAnimationFrame: (callback) => requestAnimationFrame(callback),
    });

    if (terminal !== term || fitAddon !== fit) {
      return;
    }

    fit.fit();

    if (refresh) {
      term.refresh(0, Math.max(term.rows - 1, 0));
    }

    if (mainTerminalRuntimeState.livePtyId >= 0) {
      try {
        await resizePty(mainTerminalRuntimeState.livePtyId, term.cols, term.rows);
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
    await waitForStableTerminalLayout({
      tick,
      getFontsReady: () => document.fonts?.ready,
      requestAnimationFrame: (callback) => requestAnimationFrame(callback),
    });

    if (!fit || auxTerminal !== term || auxFitAddon !== fit) {
      return;
    }

    fit.fit();
    if (auxTerminalRuntimeState.ptyId >= 0) {
      try {
        await resizePty(auxTerminalRuntimeState.ptyId, term.cols, term.rows);
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

    if (editorQuickOpenState.visible) {
      return;
    }

    void openEditorQuickOpen(editorRootDir);
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
    if (mainTerminalRuntimeState.livePtyId < 0) {
      tick().then(focusOutput);
      return;
    }

    try {
      await writePty(mainTerminalRuntimeState.livePtyId, "\u0003");
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

  function requestSwitchToTerminalMode() {
    switchToTerminalView();
    tick().then(focusOutput);
  }

  function disposeAuxTerminalInstance() {
    auxResizeObserver?.disconnect();
    auxResizeObserver = null;
    auxOutputPointerCleanup?.();
    auxOutputPointerCleanup = null;
    releaseTerminalRendererController(auxRendererController);
    auxTerminal?.dispose();
    auxTerminal = null;
    auxFitAddon = null;
    auxTerminalRuntime.handleTerminalInstanceDisposed();
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
    syncTerminalRendererPreference(auxTerm, auxRendererController, preferredRenderer, () => {});
    auxOutputEl.addEventListener("pointerdown", handleAuxOutputPointerDown, true);
    auxOutputPointerCleanup = () => {
      auxOutputEl?.removeEventListener("pointerdown", handleAuxOutputPointerDown, true);
    };

    auxTerm.onData((data) => {
      auxTerminalRuntime.handleTerminalInput(data);
    });

    auxTerm.onResize(({ cols, rows }) => {
      auxTerminalRuntime.handleTerminalResize(cols, rows);
    });

    auxTerm.onScroll((viewportY) => {
      auxTerminalRuntime.handleViewportScroll(viewportY, auxTerm.buffer.active.baseY);
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
    auxTerminalRuntimeState.followTail = true;

    await tick();
    requestAnimationFrame(() => {
      auxFit.fit();
      scheduleAuxLayoutSettle();
    });
  }

  async function ensureAuxTerminalVisible() {
    if (document.activeElement instanceof HTMLElement) {
      document.activeElement.blur();
    }

    auxVisible = true;
    if (!auxInitialized) {
      auxInitialized = true;
    }

    await tick();

    if (!auxTerminal || auxTerminalRuntimeState.exited) {
      await createAuxTerminalInstance();
    }

    if (!auxTerminal) {
      return;
    }

    if (!auxTerminalRuntimeState.attached) {
      await auxTerminalRuntime.attachOrSpawn(auxTerminal);
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
    cancelAuxResizeTracking();
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

  function handleOutputChunk(event: PtyOutputChunk) {
    if (auxTerminalRuntime.handleOutputChunk(event)) {
      return;
    }
    mainTerminalRuntime.handleMainOutputChunk(event);
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
    syncTerminalRendererPreference(term, mainRendererController, preferredRenderer, (value) => {
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
      if (mainTerminalRuntime.handlePtyExit(event.payload)) {
        return;
      }

      if (auxTerminalRuntime.handlePtyExit(event.payload)) {
        auxVisible = false;
      }
    });

    try {
      terminal = term;
      fitAddon = fit;
      terminalReady = true;
      await mainTerminalRuntime.showTerminalLoadingState(ptyId >= 0 ? "restoring" : "connecting");
      await syncMainTerminalLayoutToPty({ stickToBottom: false });

      await mainTerminalRuntime.attachOrSpawnPty(term, { loadingAlreadyShown: true });
      terminalStartupSettled = true;
      scheduleEditorQuickOpenPrewarm();
    } catch (error) {
      mainTerminalRuntimeState.spawnError = error instanceof Error ? error.message : String(error);
      await mainTerminalRuntime.clearTerminalLoadingState();
    }

    term.onData((data) => {
      if (mainTerminalRuntimeState.livePtyId >= 0) {
        void writePty(mainTerminalRuntimeState.livePtyId, data);
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
      mainTerminalRuntime.handleTerminalResize(cols, rows);
    });

    term.onRender(() => {
      mainTerminalRuntime.handleTerminalRender();
    });

    writeParsedDisposable = term.onWriteParsed(() => {
      mainTerminalRuntime.handleWriteParsed(term);
    });

    term.onScroll((viewportY) => {
      mainTerminalRuntime.handleViewportScroll(viewportY, term.buffer.active.baseY);
    });

    inputTextarea?.addEventListener("paste", handleTerminalPaste as EventListener, true);
    outputEl.addEventListener("mousemove", handleLinkPointerMove, true);
    outputEl.addEventListener("wheel", mainTerminalRuntime.disableAutoFollow, true);
    window.addEventListener("mouseup", releaseLinkSelectionBlock, true);
    window.addEventListener("blur", releaseLinkSelectionBlock);
    window.addEventListener("keydown", handleAuxShortcut, true);
    window.addEventListener("keydown", handleEditorShortcut, true);
    addTerminalFocusRequestListener(window, handleFocusRequest);
    window.addEventListener(TEST_BRIDGE_EVENTS.openPendingImage, handleTestPendingImage as EventListener);
    if (isTestBridgeEnabled()) {
      registerTestHooks();
      testHookRegistered = true;
    }
  });

  $effect(() => {
    if (!terminalReady || !visible || editorViewMode !== "terminal") return;

    mainTerminalRuntime.armBottomLock();
    void syncMainTerminalLayoutToPty();
  });

  $effect(() => {
    terminalReady;
    terminalStartupSettled;
    visible;
    editorQuickOpenState.visible;
    editorQuickOpenState.busy;
    editorQuickOpenState.rootDir;
    editorQuickOpenState.lastUpdatedMs;
    editorRootDir;
    editorQuickOpenState.entries.length;
    editorQuickOpenState.prewarmRequestedRootDir;
    editorQuickOpenState.prewarmInFlightRootDir;

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
    syncTerminalRendererPreference(terminal, mainRendererController, preferredRenderer, (value) => {
      activeRenderer = value;
    });
    if (auxTerminal) {
      syncTerminalRendererPreference(auxTerminal, auxRendererController, preferredRenderer, () => {});
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
    auxTerminalRuntimeState.ptyId = storedAuxPtyId;
    auxVisible = storedAuxVisible;
    auxInitialized = storedAuxVisible;
    auxTerminalRuntimeState.exited = storedAuxPtyId < 0;
    auxHeightPercent = clampAuxHeightPercent(
      storedAuxHeightPercent ?? settings.terminal.auxTerminalDefaultHeight,
    );
    auxHeightCustomized = storedAuxHeightPercent !== null;
    auxStateHydrated = true;
  });

  $effect(() => {
    void onAuxStateChange?.({
      auxPtyId: auxTerminalRuntimeState.ptyId,
      auxVisible,
      auxHeightPercent: auxHeightCustomized ? auxHeightPercent : null,
    });
  });

  $effect(() => {
    if (auxTerminalRuntimeState.ptyId < 0) {
      auxTerminalRuntimeState.currentPath = workDir;
    }
  });

  $effect(() => {
    mainTerminalRuntime.handleSessionChange(sessionId);
  });

  $effect(() => {
    sessionId;
    sessionSnapshot;
    void ensureEditorRuntimeReady();
  });

  onDestroy(() => {
    removeTerminalFocusRequestListener(window, handleFocusRequest);
    window.removeEventListener(TEST_BRIDGE_EVENTS.openPendingImage, handleTestPendingImage as EventListener);
    window.removeEventListener("keydown", handleAuxShortcut, true);
    window.removeEventListener("keydown", handleEditorShortcut, true);
    if (isTestBridgeEnabled()) {
      unregisterTestHooks();
      testHookRegistered = false;
    }
    inputTextarea?.removeEventListener("paste", handleTerminalPaste as EventListener, true);
    outputEl?.removeEventListener("mousemove", handleLinkPointerMove, true);
    outputEl?.removeEventListener("wheel", mainTerminalRuntime.disableAutoFollow, true);
    window.removeEventListener("mouseup", releaseLinkSelectionBlock, true);
    window.removeEventListener("blur", releaseLinkSelectionBlock);
    stopDraftResize();
    stopAuxResize();
    unlistenOutput?.();
    unlistenExit?.();
    resizeObserver?.disconnect();
    assistResizeObserver?.disconnect();
    clearAuxLayoutSettleTimer();
    cancelEditorQuickOpenPrewarm();
    mainTerminalRuntime.dispose();
    auxTerminalRuntime.dispose();
    invalidateEditorQuickOpenRequest();
    disposeOverlayInteraction();
    fileLinkProviderDisposable?.dispose();
    writeParsedDisposable?.dispose();
    disposeAuxTerminalInstance();
    releaseTerminalRendererController(mainRendererController);
    terminal?.dispose();
    fitAddon = null;
    terminal = null;
  });

  $effect(() => {
    if (!terminalReady || !visible || !storedAuxVisible) return;
    if (auxVisible && auxTerminalRuntimeState.attached) return;
    void ensureAuxTerminalVisible();
  });
</script>

<div
  class="terminal-shell"
  data-testid={TEST_IDS.terminalShell}
  data-agent-id={agentId}
  data-session-id={sessionId}
  data-pty-id={String(mainTerminalRuntimeState.livePtyId)}
  data-aux-pty-id={String(auxTerminalRuntimeState.ptyId)}
  data-aux-visible={auxVisible ? "true" : "false"}
  data-draft-open={draftComposerState.draftOpen ? "true" : "false"}
  data-pending-image={overlayInteractionState.pendingClipboardImage ? "true" : "false"}
  data-test-hook-registered={testHookRegistered ? "true" : "false"}
  data-loading-state={mainTerminalRuntimeState.terminalLoadingState ?? "idle"}
  data-soft-follow-experiment={softFollowExperimentEnabled ? "true" : "false"}
  data-renderer-preference={preferredRenderer}
  data-renderer={activeRenderer}
  class:hidden={!visible}
  bind:this={shellEl}
>
  <TerminalEmbeddedEditorSurface
    viewMode={editorViewMode}
    runtimeState={editorRuntimeState}
    quickOpenState={editorQuickOpenState}
    rootDir={editorSurfaceRootDir}
    busy={editorBusy}
    closeConfirmTitle={editorCloseConfirmLabel}
    labels={editorSurfaceLabels}
    onActivePathChange={handleEditorActivePathChange}
    onCloseTab={closeEditorTab}
    onContentChange={handleEditorContentChange}
    onSaveRequest={(wslPath) => void saveEditorTab(wslPath)}
    onOpenFile={() => void openEditorQuickOpen(editorSurfaceRootDir)}
    onSwitchToTerminal={requestSwitchToTerminalMode}
    onListWorkspaceFiles={listEditorWorkspaceFiles}
    onReadWorkspaceFile={readEditorNavigationFile}
    onOpenLocation={openEditorNavigationLocation}
    onRefreshQuickOpen={(forceRefresh) => void refreshEditorQuickOpenEntries(forceRefresh)}
    onSelectQuickOpenResult={openEditorPathFromQuickResult}
    onCloseQuickOpen={closeEditorQuickOpen}
    onCancelCloseConfirm={cancelCloseEditorTab}
    onConfirmCloseConfirm={confirmCloseEditorTab}
  />

  <TerminalRuntimeSurface
    viewMode={editorViewMode}
    linkHovering={overlayInteractionState.linkHovering}
    bind:outputElement={outputEl}
    spawnError={mainTerminalRuntimeState.spawnError}
    clipboardNotice={overlayInteractionState.clipboardNotice}
    terminalLoadingState={mainTerminalRuntimeState.terminalLoadingState}
    {terminalLoadingLabel}
    draftOpen={draftComposerState.draftOpen}
    draftTitle={$t("terminal.assist.draftTitle")}
    draftValue={draftComposerState.draftValue}
    draftHeightPx={draftComposerState.draftHeightPx}
    bind:draftElement={draftComposerState.draftEl}
    bind:draftPanelElement={draftComposerState.draftPanelEl}
    auxInitialized={auxInitialized}
    auxVisible={auxVisible}
    auxBusy={auxTerminalRuntimeState.busy}
    auxHeightPercent={auxHeightPercent}
    auxCurrentPath={auxTerminalRuntimeState.currentPath}
    auxSpawnError={auxTerminalRuntimeState.spawnError}
    auxLoadingState={auxTerminalRuntimeState.loadingState}
    auxLoadingLabel={auxLoadingLabel}
    auxTitle={$t("terminal.aux.title")}
    auxPathLabel={$t("terminal.aux.currentPath")}
    bind:auxOutputElement={auxOutputEl}
    bind:assistPanelElement={assistPanelEl}
    onDraftResizeStart={handleDraftResizeStart}
    onCloseDraft={toggleDraft}
    onDraftInput={handleDraftInput}
    onDraftKeydown={handleDraftKeydown}
    onDraftPaste={handleDraftPaste}
    onInsertDraft={() => void insertDraftIntoTerminal(false)}
    onSendDraft={() => void insertDraftIntoTerminal(true)}
    onAuxResizeStart={handleAuxResizeStart}
    onCloseAux={hideAuxTerminal}
    onPasteImage={handlePasteImageFromClipboard}
    onOpenFile={() => void openEditorQuickOpen(editorSurfaceRootDir)}
    onOpenEditor={requestSwitchToEditorMode}
    onToggleAux={() => {
      document.activeElement instanceof HTMLElement && document.activeElement.blur();
      void toggleAuxTerminal();
    }}
    onToggleDraft={toggleDraft}
  />
</div>

<TerminalOverlayStack
  linkMenuVisible={overlayInteractionState.linkMenuVisible}
  linkMenuX={overlayInteractionState.linkMenuX}
  linkMenuY={overlayInteractionState.linkMenuY}
  {linkMenuItems}
  pendingClipboardImage={overlayInteractionState.pendingClipboardImage}
  clipboardBusy={overlayInteractionState.clipboardBusy}
  clipboardError={overlayInteractionState.clipboardError}
  editorPickerVisible={overlayInteractionState.editorPickerVisible}
  editorPickerTitle={$t("terminal.filePaths.pickerTitle")}
  editorPickerDescription={$t("terminal.filePaths.pickerDescription")}
  editorPickerEmptyLabel={editorsError || $t("terminal.filePaths.noEditors")}
  defaultEditorId={settings.interface.defaultEditorId}
  editors={detectedEditors}
  {interruptConfirmVisible}
  onLinkMenuSelect={handleLinkMenuSelect}
  onCloseLinkMenu={closeLinkMenu}
  onCancelClipboardImage={() => resetClipboardImage(true)}
  onConfirmClipboardImage={confirmClipboardImage}
  onEditorSelect={handleEditorSelect}
  onCloseEditorPicker={closeEditorPicker}
  onCloseInterruptConfirm={closeInterruptConfirm}
  onConfirmInterrupt={confirmTerminalInterrupt}
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

  .terminal-shell.hidden {
    position: absolute;
    left: -9999px;
    visibility: hidden;
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

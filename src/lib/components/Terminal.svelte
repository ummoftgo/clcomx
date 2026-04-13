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
  import { createMainTerminalRuntimeController } from "../features/terminal/controller/main-terminal-runtime-controller";
  import { buildOverlayLinkMenuItems } from "../features/terminal/controller/overlay-link-menu-items";
  import { createOverlayInteractionController } from "../features/terminal/controller/overlay-interaction-controller";
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
  let outputEl: HTMLDivElement;
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
  let resizingAux = false;
  let auxResizePointerId: number | null = null;
  let auxResizeStartY = 0;
  let auxResizeStartPercent = 0;
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
    waitForTerminalPaint,
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
    mainTerminalRuntimeState.terminalLoadingState === "restoring"
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

    await waitForStableTerminalLayout();

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

  async function waitForTerminalPaint() {
    await tick();
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => resolve());
      });
    });
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

    if (editorQuickOpenState.visible) {
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
    releaseRendererController(auxRendererController);
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
    syncRendererPreference(auxTerm, auxRendererController, preferredRenderer, () => {});
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
    releaseRendererController(mainRendererController);
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
    {#if mainTerminalRuntimeState.spawnError}
      <div class="terminal-error">
        {$t("terminal.assist.startFailed", { values: { message: mainTerminalRuntimeState.spawnError } })}
      </div>
    {/if}

    {#if overlayInteractionState.clipboardNotice}
      <div class="terminal-notice">
        {overlayInteractionState.clipboardNotice}
      </div>
    {/if}

    {#if mainTerminalRuntimeState.terminalLoadingState !== null && !mainTerminalRuntimeState.spawnError}
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
      {#if auxTerminalRuntimeState.spawnError}
        <div class="terminal-error">
          {$t("terminal.aux.startFailed", { values: { message: auxTerminalRuntimeState.spawnError } })}
        </div>
      {/if}
    {/snippet}

    {#snippet liveAuxOverlay()}
      {#if auxTerminalRuntimeState.loadingState !== null && !auxTerminalRuntimeState.spawnError}
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
      currentPath={auxTerminalRuntimeState.currentPath}
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
      auxBusy={auxTerminalRuntimeState.busy}
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
  visible={editorQuickOpenState.visible}
  openKey={editorQuickOpenState.openKey}
  initialQuery={editorQuickOpenState.query}
  rootDir={editorQuickOpenState.rootDir || editorRootDir || workDir}
  entries={editorQuickOpenState.entries}
  title={$t("terminal.editor.quickOpenTitle")}
  description={$t("terminal.editor.quickOpenDescription")}
  placeholder={$t("terminal.editor.quickOpenPlaceholder")}
  idleLabel={$t("terminal.editor.quickOpenIdle")}
  emptyLabel={$t("terminal.editor.quickOpenEmpty")}
  loadingLabel={$t("terminal.editor.quickOpenLoading")}
  refreshLabel={$t("common.actions.refresh")}
  closeLabel={$t("common.actions.close")}
  keyboardHintLabel={$t("terminal.editor.quickOpenKeyboardHint")}
  busy={editorQuickOpenState.busy}
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

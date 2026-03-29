<script lang="ts">
  import { onMount, onDestroy, tick } from "svelte";
  import { Terminal, type IDisposable } from "@xterm/xterm";
  import { FitAddon } from "@xterm/addon-fit";
  import { Unicode11Addon } from "@xterm/addon-unicode11";
  import { WebLinksAddon } from "@xterm/addon-web-links";
  import { WebglAddon } from "@xterm/addon-webgl";
  import ImagePasteModal from "./ImagePasteModal.svelte";
  import EditorPickerModal from "./EditorPickerModal.svelte";
  import ContextMenu from "../ui/components/ContextMenu.svelte";
  import { listen, type UnlistenFn } from "@tauri-apps/api/event";
  import { getBootstrap } from "../bootstrap";
  import {
    createPendingClipboardImage,
    formatPathForAgentInput,
    getImageFromPasteEvent,
    readImageFromClipboard,
    revokePendingClipboardImage,
    saveClipboardImage,
    type PendingClipboardImage,
  } from "../clipboard";
  import {
    type PtyOutputChunk,
    getPtyOutputSnapshot,
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
  import { Button, ModalShell } from "../ui";
  import { buildFontStack, serializeFontFamilyList } from "../font-family";
  import { matchesShortcut } from "../hotkeys";
  import type { TerminalRendererPreference } from "../types";
  import {
    openInEditor,
    resolveTerminalPath,
    type DetectedEditor,
    type ResolvedTerminalPath,
  } from "../editors";
  import { createTerminalFileLinks } from "../terminal/file-links";
  import { consumeAuxShellMetadata } from "../terminal/aux-shell-metadata";
  import { TEST_IDS } from "../testids";
  import { openExternalUrl } from "../workspace";
  import {
    TEST_BRIDGE_EVENTS,
    decodeBase64Blob,
    getOrCreateTerminalTestHooks,
    isTestBridgeEnabled,
    type TerminalBufferSnapshot,
    type TestOpenPendingImageDetail,
  } from "../testing/test-bridge";
  import "@xterm/xterm/css/xterm.css";

  interface Props {
    sessionId: string;
    visible: boolean;
    agentId: string;
    distro: string;
    workDir: string;
    ptyId: number;
    storedAuxPtyId?: number;
    storedAuxVisible?: boolean;
    storedAuxHeightPercent?: number | null;
    resumeToken?: string | null;
    onPtyId?: (ptyId: number) => void;
    onAuxStateChange?: (state: {
      auxPtyId: number;
      auxVisible: boolean;
      auxHeightPercent: number | null;
    }) => void;
    onExit?: (ptyId: number) => void;
    onResumeFallback?: () => void;
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
  }: Props = $props();

  let shellEl: HTMLDivElement;
  let outputEl: HTMLDivElement;
  let auxOutputEl = $state<HTMLDivElement | null>(null);
  let assistPanelEl = $state<HTMLDivElement | null>(null);
  let draftEl = $state<HTMLTextAreaElement | null>(null);
  let terminal: Terminal | null = null;
  let fitAddon: FitAddon | null = null;
  let inputTextarea: HTMLTextAreaElement | undefined;
  let livePtyId = $state(-1);
  let initialOutputReady = false;
  let terminalReady = $state(false);
  let spawnError = $state<string | null>(null);
  let terminalLoadingState = $state<"connecting" | "restoring" | null>(null);
  let terminalLoadingStartedAt = 0;
  let terminalLoadingHasRenderableOutput = false;
  let terminalLoadingReadySignalSeen = false;
  let terminalLoadingQuietTimer: ReturnType<typeof setTimeout> | null = null;
  let terminalLoadingMaxTimer: ReturnType<typeof setTimeout> | null = null;
  let draftValue = $state("");
  let draftOpen = $state(false);
  let pendingClipboardImage = $state<PendingClipboardImage | null>(null);
  let linkMenuVisible = $state(false);
  let linkMenuX = $state(0);
  let linkMenuY = $state(0);
  let linkMenuTarget = $state<
    | { kind: "url"; url: string }
    | { kind: "file"; path: ResolvedTerminalPath }
    | null
  >(null);
  let linkHovering = $state(false);
  let suppressSelectionUntilMouseUp = false;
  let clipboardBusy = $state(false);
  let clipboardError = $state<string | null>(null);
  let clipboardNotice = $state<string | null>(null);
  let interruptConfirmVisible = $state(false);
  let editorPickerVisible = $state(false);
  let editorPickerPath = $state<ResolvedTerminalPath | null>(null);
  const editorDetection = getEditorDetectionState();
  const detectedEditors = $derived(editorDetection.editors);
  const editorsError = $derived(editorDetection.error);
  let noticeTimer: ReturnType<typeof setTimeout> | null = null;
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
  const RESUME_FAILED_MARKER = "__CLCOMX_RESUME_FAILED__";
  const BOTTOM_LOCK_MAX_MS = 12000;
  const BOTTOM_LOCK_QUIET_MS = 1400;
  const MIN_TERMINAL_LOADING_MS = 360;
  const TERMINAL_LOADING_QUIET_MS = 1300;
  const TERMINAL_LOADING_MAX_MS = 8000;
  const DEFERRED_BOTTOM_SCROLL_MS = 60;
  const WEB_LINK_REGEX = /(?:https?|ftp):[/]{2}[^\s"'!*(){}|\\^<>`]*[^\s"':,.!?{}|\\^~\[\]`()<>]/i;
  const SYNC_OUTPUT_MODE_SEQUENCE = /\u001b\[\?2026[hl]/;
  const ABSOLUTE_CURSOR_POSITION_SEQUENCE = /\u001b\[\d+(?:;\d+)?[Hf]/;

  const settings = getSettings();
  const bootstrap = getBootstrap();
  const softFollowExperimentEnabled = $derived(bootstrap.softFollowExperiment && agentId === "claude");
  const preferredRenderer = $derived(settings.terminal.renderer);
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
    linkMenuTarget?.kind === "file"
      ? [
          {
            id: "open-file",
            kind: "item",
            label: $t("terminal.filePaths.openFile"),
            icon: "file",
          },
          {
            id: "open-in-other-editor",
            kind: "item",
            label: $t("terminal.filePaths.openInOtherEditor"),
            icon: "open-with",
          },
          {
            id: "copy-path",
            kind: "item",
            label: $t("terminal.filePaths.copyPath"),
            icon: "copy",
          },
        ]
      : [
          {
            id: "open-link-in-browser",
            kind: "item",
            label: $t("terminal.links.openInBrowser"),
            icon: "external-link",
          },
          {
            id: "copy-link",
            kind: "item",
            label: $t("terminal.links.copyLink"),
            icon: "copy",
          },
      ],
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

  function enableExperimentalUnicodeWidth(term: Terminal) {
    if (!softFollowExperimentEnabled) {
      return;
    }

    term.loadAddon(new Unicode11Addon());
    term.unicode.activeVersion = "11";
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
    if (!terminal || !fitAddon) {
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

  function getDraftLineHeight() {
    const style = draftEl ? getComputedStyle(draftEl) : null;
    const parsed = style ? Number.parseFloat(style.lineHeight) : Number.NaN;
    return Number.isFinite(parsed) ? parsed : settings.terminal.fontSize * 1.5;
  }

  function getDraftWindowCap(lineHeight = getDraftLineHeight()) {
    const availableHeight = Math.max(80, (shellEl?.clientHeight ?? window.innerHeight) - 220);
    return Math.max(1, Math.floor(availableHeight / lineHeight));
  }

  function getEffectiveDraftMaxRows() {
    return Math.min(
      Math.max(1, settings.terminal.draftMaxRows),
      getDraftWindowCap(),
    );
  }

  function syncDraftHeight() {
    if (!draftEl) return;

    const lineHeight = getDraftLineHeight();
    const style = getComputedStyle(draftEl);
    const verticalPadding =
      Number.parseFloat(style.paddingTop) +
      Number.parseFloat(style.paddingBottom) +
      Number.parseFloat(style.borderTopWidth) +
      Number.parseFloat(style.borderBottomWidth);

    const maxHeight = lineHeight * getEffectiveDraftMaxRows() + verticalPadding;

    draftEl.style.height = "auto";
    draftEl.style.height = `${Math.min(draftEl.scrollHeight, maxHeight)}px`;
    draftEl.style.overflowY = draftEl.scrollHeight > maxHeight ? "auto" : "hidden";
  }

  function focusDraft(moveCaretToEnd = false) {
    if (!visible || !draftOpen) return;

    requestAnimationFrame(() => {
      draftEl?.focus();
      if (moveCaretToEnd && draftEl) {
        const length = draftEl.value.length;
        draftEl.setSelectionRange(length, length);
      }
    });
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
    if (!terminalReady || !visible) return;

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

  function setClipboardNotice(message: string) {
    clipboardNotice = message;
    if (noticeTimer) {
      clearTimeout(noticeTimer);
    }
    noticeTimer = setTimeout(() => {
      clipboardNotice = null;
    }, 2600);
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
      (pendingClipboardImage !== null || editorPickerVisible) &&
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

    await navigator.clipboard.writeText(selection);
    terminal?.clearSelection();
    setClipboardNotice($t("terminal.selection.copySuccess"));
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

  function openContextMenu(
    target: { kind: "url"; url: string } | { kind: "file"; path: ResolvedTerminalPath },
    x: number,
    y: number,
  ) {
    suppressSelectionUntilMouseUp = true;
    terminal?.clearSelection();
    linkMenuTarget = target;
    linkMenuX = x;
    linkMenuY = y;
    linkMenuVisible = true;
  }

  function closeLinkMenu() {
    linkMenuVisible = false;
    linkMenuTarget = null;
  }

  function releaseLinkSelectionBlock() {
    suppressSelectionUntilMouseUp = false;
  }

  function getFilePathNotice(error: unknown, fallbackKey: string) {
    const message = error instanceof Error ? error.message : String(error);
    if (/path does not exist/i.test(message)) {
      return $t("terminal.filePaths.pathNotFound");
    }
    return $t(fallbackKey);
  }

  async function ensureEditorsLoaded() {
    return await ensureEditorsDetected();
  }

  async function showEditorPicker(path: ResolvedTerminalPath) {
    await ensureEditorsLoaded();
    editorPickerPath = path;
    editorPickerVisible = true;
  }

  function closeEditorPicker() {
    editorPickerVisible = false;
    editorPickerPath = null;
  }

  async function openPathInEditor(
    path: ResolvedTerminalPath,
    preferredEditorId?: string | null,
    forcePicker = false,
  ) {
    const editors = await ensureEditorsLoaded();

    if (editors.length === 0) {
      setClipboardNotice(editorsError || $t("terminal.filePaths.noEditors"));
      return;
    }

    if (forcePicker || settings.interface.fileOpenMode === "picker") {
      await showEditorPicker(path);
      return;
    }

    const preferredId = preferredEditorId?.trim() || settings.interface.defaultEditorId.trim();
    const preferredEditor = editors.find((editor) => editor.id === preferredId);
    if (!preferredEditor) {
      await showEditorPicker(path);
      return;
    }

    await openInEditor(preferredEditor.id, path);
  }

  async function handleEditorSelect(editor: DetectedEditor) {
    if (!editorPickerPath) {
      return;
    }

    try {
      await openInEditor(editor.id, editorPickerPath);
      closeEditorPicker();
    } catch (error) {
      console.error("Failed to open path in editor", error);
      setClipboardNotice(getFilePathNotice(error, "terminal.filePaths.openFailed"));
    }
  }

  async function openFileLinkMenu(rawPath: string, event: MouseEvent) {
    suppressSelectionUntilMouseUp = true;
    terminal?.clearSelection();

    try {
      const path = await resolveTerminalPath(rawPath, distro, workDir);
      openContextMenu({ kind: "file", path }, event.clientX, event.clientY);
    } catch (error) {
      console.warn("Failed to resolve terminal file path", error);
      setClipboardNotice(getFilePathNotice(error, "terminal.filePaths.resolveFailed"));
    }
  }

  async function openFileLinkMenuForTest(rawPath: string) {
    suppressSelectionUntilMouseUp = true;
    terminal?.clearSelection();

    const path = await resolveTerminalPath(rawPath, distro, workDir);
    openContextMenu({ kind: "file", path }, 160, 160);
  }

  function openUrlLinkMenuForTest(url: string) {
    terminal?.clearSelection();
    openContextMenu({ kind: "url", url }, 160, 160);
  }

  async function handleLinkMenuSelect(item: Extract<ContextMenuItem, { kind: "item" }>) {
    if (!linkMenuTarget) return;

    try {
      if (linkMenuTarget.kind === "url") {
        if (item.id === "open-link-in-browser") {
          await openExternalUrl(linkMenuTarget.url);
          return;
        }

        if (item.id === "copy-link") {
          await navigator.clipboard.writeText(linkMenuTarget.url);
          setClipboardNotice($t("terminal.links.copySuccess"));
        }
        return;
      }

      if (item.id === "open-file") {
        await openPathInEditor(linkMenuTarget.path);
        return;
      }

      if (item.id === "open-in-other-editor") {
        await showEditorPicker(linkMenuTarget.path);
        return;
      }

      if (item.id === "copy-path") {
        await navigator.clipboard.writeText(linkMenuTarget.path.copyText);
        setClipboardNotice($t("terminal.filePaths.copySuccess"));
      }
    } catch (error) {
      console.error("Failed to handle link menu action", error);
      setClipboardNotice(
        linkMenuTarget.kind === "file"
          ? getFilePathNotice(error, "terminal.filePaths.openFailed")
          : $t("terminal.links.openFailed"),
      );
    }
  }

  function handleLinkHover() {
    linkHovering = true;
  }

  function handleLinkLeave() {
    linkHovering = false;
  }

  function handleLinkPointerMove(event: MouseEvent) {
    if (!suppressSelectionUntilMouseUp || (event.buttons & 1) === 0) {
      return;
    }

    terminal?.clearSelection();
    event.preventDefault();
    event.stopPropagation();
  }

  function handleFocusRequest(event: Event) {
    const focusEvent = event as CustomEvent<{ sessionId?: string }>;
    const targetSessionId = focusEvent.detail?.sessionId;
    if (targetSessionId && targetSessionId !== sessionId) {
      return;
    }

    focusOutput();
  }

  function handleTestPendingImage(event: Event) {
    if (!isTestBridgeEnabled()) return;

    const detail = (event as CustomEvent<TestOpenPendingImageDetail>).detail;
    if (!detail?.base64) return;
    if (detail.sessionId && detail.sessionId !== sessionId) return;

    try {
      openClipboardPreview(decodeBase64Blob(detail.base64, detail.mimeType));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setClipboardNotice(message);
    }
  }

  function openPendingImageForTest(detail: Omit<TestOpenPendingImageDetail, "sessionId">) {
    try {
      openClipboardPreview(decodeBase64Blob(detail.base64, detail.mimeType));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setClipboardNotice(message);
    }
  }

  async function getOutputSnapshotForTest() {
    if (livePtyId < 0) {
      return null;
    }

    return getPtyOutputSnapshot(livePtyId);
  }

  async function getAuxOutputSnapshotForTest() {
    if (auxPtyId < 0) {
      return null;
    }

    return getPtyOutputSnapshot(auxPtyId);
  }

  function getViewportStateForTest() {
    if (!terminal) {
      return null;
    }

    return {
      viewportY: terminal.buffer.active.viewportY,
      baseY: terminal.buffer.active.baseY,
      rows: terminal.rows,
      cols: terminal.cols,
    };
  }

  function getBufferSnapshotForTest(): TerminalBufferSnapshot | null {
    if (!terminal) {
      return null;
    }

    const buffer = terminal.buffer.active;
    const lines: string[] = [];

    for (let index = 0; index < terminal.rows; index += 1) {
      const line = buffer.getLine(buffer.viewportY + index);
      lines.push(line?.translateToString(false) ?? "");
    }

    return {
      baseY: buffer.baseY,
      viewportY: buffer.viewportY,
      cursorX: buffer.cursorX,
      cursorY: buffer.cursorY,
      rows: terminal.rows,
      cols: terminal.cols,
      lines,
    };
  }

  function insertIntoDraft(text: string, moveCaretToEnd = false) {
    if (!draftEl) {
      draftValue += text;
      return;
    }

    const start = draftEl.selectionStart ?? draftValue.length;
    const end = draftEl.selectionEnd ?? draftValue.length;
    draftValue = `${draftValue.slice(0, start)}${text}${draftValue.slice(end)}`;

    tick().then(() => {
      syncDraftHeight();
      const nextPosition = moveCaretToEnd ? draftValue.length : start + text.length;
      draftEl?.setSelectionRange(nextPosition, nextPosition);
    });
  }

  function pasteIntoTerminal(text: string) {
    if (!terminal || livePtyId < 0) {
      if (!draftOpen) {
        draftOpen = true;
      }
      insertIntoDraft(text, true);
      tick().then(() => {
        syncDraftHeight();
        focusDraft(true);
      });
      return;
    }

    terminal.paste(text);
    focusOutput();
  }

  function routeInsertedText(text: string) {
    if (draftOpen || draftValue.length > 0) {
      if (!draftOpen) {
        draftOpen = true;
      }
      insertIntoDraft(text, true);
      tick().then(() => {
        syncDraftHeight();
        focusDraft(true);
      });
      return;
    }

    pasteIntoTerminal(text);
  }

  function resetClipboardImage(restoreFocus = false) {
    const current = pendingClipboardImage;
    pendingClipboardImage = null;
    clipboardError = null;
    revokePendingClipboardImage(current);

    if (restoreFocus) {
      if (draftOpen) {
        focusDraft();
      } else {
        focusOutput();
      }
    }
  }

  function openClipboardPreview(blob: Blob) {
    const nextImage = createPendingClipboardImage(blob);
    revokePendingClipboardImage(pendingClipboardImage);
    pendingClipboardImage = nextImage;
    clipboardError = null;
  }

  async function handlePasteImageFromClipboard() {
    try {
      const imageBlob = await readImageFromClipboard();
      if (!imageBlob) {
        setClipboardNotice($t("terminal.assist.clipboardNoImage"));
        if (draftOpen) {
          focusDraft();
        } else {
          focusOutput();
        }
        return;
      }

      openClipboardPreview(imageBlob);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setClipboardNotice(message);
      if (draftOpen) {
        focusDraft();
      } else {
        focusOutput();
      }
    }
  }

  async function confirmClipboardImage() {
    if (!pendingClipboardImage) return;

    clipboardBusy = true;
    clipboardError = null;

    try {
      const savedImage = await saveClipboardImage(pendingClipboardImage, distro);
      routeInsertedText(formatPathForAgentInput(savedImage.wslPath));
      resetClipboardImage(true);
    } catch (error) {
      clipboardError = error instanceof Error ? error.message : String(error);
    } finally {
      clipboardBusy = false;
    }
  }

  function handleDraftPaste(event: ClipboardEvent) {
    const imageBlob = getImageFromPasteEvent(event);
    if (!imageBlob) {
      return;
    }

    event.preventDefault();
    openClipboardPreview(imageBlob);
  }

  function splitDraftLines(text: string) {
    return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  }

  function handleTerminalPaste(event: ClipboardEvent) {
    if (!visible) return;

    const imageBlob = getImageFromPasteEvent(event);
    if (!imageBlob) {
      return;
    }

    event.preventDefault();
    openClipboardPreview(imageBlob);
  }

  async function insertDraftIntoTerminal(submit: boolean) {
    const text = draftValue;
    if (!text || livePtyId < 0) {
      return;
    }

    draftValue = "";
    syncDraftHeight();
    const lines = splitDraftLines(text);

    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index] ?? "";
      if (line.length > 0) {
        await writePty(livePtyId, line);
      }

      const hasNextLine = index < lines.length - 1;
      if (hasNextLine) {
        // Agent CLIs like Claude Code and Codex accept line-feed separated multiline input here.
        await writePty(livePtyId, "\n");
      }
    }

    if (submit) {
      await writePty(livePtyId, "\r");
      draftOpen = false;
    }

    if (submit) {
      tick().then(focusOutput);
      return;
    }

    focusDraft();
  }

  function handleDraftKeydown(event: KeyboardEvent) {
    if (event.key === "Enter" && event.ctrlKey && !event.altKey && !event.metaKey) {
      event.preventDefault();
      void insertDraftIntoTerminal(true);
    }
  }

  function handleDraftInput() {
    syncDraftHeight();
  }

  function toggleDraft() {
    draftOpen = !draftOpen;
    tick().then(() => {
      syncDraftHeight();
      if (draftOpen) {
        focusDraft(true);
      } else {
        focusOutput();
      }
    });
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
    enableExperimentalUnicodeWidth(auxTerm);
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

  function hideAuxTerminal() {
    auxVisible = false;
    resizingAux = false;
    clearAuxLayoutSettleTimer();
    focusOutput();
  }

  async function toggleAuxTerminal() {
    if (auxVisible) {
      hideAuxTerminal();
      return;
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
      await writeTerminalData(term, canonicalSnapshot.serialized);
      await writeTerminalData(term, canonicalSnapshot.delta);
      appliedSeq = canonicalSnapshot.appliedSeq;
      restored = true;
    } else {
      const snapshot = await getPtyOutputSnapshot(id);
      await writeTerminalData(term, snapshot.data);
      appliedSeq = snapshot.seq;
      fallbackSnapshotData = snapshot.data;
    }

    const pendingChunks = replayBuffer
      .filter((chunk) => chunk.seq > appliedSeq)
      .sort((left, right) => left.seq - right.seq);

    replayInProgress = false;
    for (const chunk of pendingChunks) {
      await writeTerminalData(term, chunk.data);
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

    await syncMainTerminalLayoutToPty({ refresh: true });
  }

  async function attachOrSpawnPty(term: Terminal) {
    spawnError = null;
    if (ptyId >= 0) {
      await showTerminalLoadingState("restoring");
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
      }
    } else {
      await showTerminalLoadingState("connecting");
    }

    await spawnNewPty(term);
  }

  async function spawnNewPty(term: Terminal) {
    const { cols, rows } = getInitialPtySize(term);
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
    await writeTerminalData(term, sanitizedOutput);
    initialOutputReady = true;
    armBottomLock();
    noteTerminalLoadingOutput(sanitizedOutput);
    onPtyId?.(livePtyId);
  }

  onMount(async () => {
    const initialTheme = getThemeById(settings.interface.theme)?.theme;
    const term = new Terminal(buildTerminalOptions(initialTheme));
    enableExperimentalUnicodeWidth(term);

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
      await syncMainTerminalLayoutToPty({ stickToBottom: false });

      await attachOrSpawnPty(term);
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
      if (visible && fit) {
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
      if (followTail || isBottomLockActive()) {
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
    window.addEventListener("clcomx:focus-active-terminal", handleFocusRequest);
    window.addEventListener(TEST_BRIDGE_EVENTS.openPendingImage, handleTestPendingImage as EventListener);
    if (isTestBridgeEnabled()) {
      getOrCreateTerminalTestHooks()[sessionId] = {
        openPendingImage: openPendingImageForTest,
        getOutputSnapshot: getOutputSnapshotForTest,
        getAuxOutputSnapshot: getAuxOutputSnapshotForTest,
        getViewportState: getViewportStateForTest,
        getBufferSnapshot: getBufferSnapshotForTest,
        openUrlMenu: openUrlLinkMenuForTest,
        openFileMenu: openFileLinkMenuForTest,
      };
      testHookRegistered = true;
    }
  });

  $effect(() => {
    if (!terminalReady || !visible) return;

    armBottomLock();
    void syncMainTerminalLayoutToPty();
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
    if (!terminalReady || !terminal) return;
    syncRendererPreference(terminal, mainRendererController, preferredRenderer, (value) => {
      activeRenderer = value;
    });
    if (auxTerminal) {
      syncRendererPreference(auxTerminal, auxRendererController, preferredRenderer, () => {});
    }
  });

  $effect(() => {
    settings.terminal.draftMaxRows;
    tick().then(syncDraftHeight);
  });

  $effect(() => {
    draftOpen;
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

  onDestroy(() => {
    window.removeEventListener("clcomx:focus-active-terminal", handleFocusRequest);
    window.removeEventListener(TEST_BRIDGE_EVENTS.openPendingImage, handleTestPendingImage as EventListener);
    window.removeEventListener("keydown", handleAuxShortcut, true);
    if (isTestBridgeEnabled()) {
      delete getOrCreateTerminalTestHooks()[sessionId];
      testHookRegistered = false;
    }
    inputTextarea?.removeEventListener("paste", handleTerminalPaste as EventListener, true);
    outputEl?.removeEventListener("mousemove", handleLinkPointerMove, true);
    outputEl?.removeEventListener("wheel", disableAutoFollow, true);
    window.removeEventListener("mouseup", releaseLinkSelectionBlock, true);
    window.removeEventListener("blur", releaseLinkSelectionBlock);
    stopAuxResize();
    unlistenOutput?.();
    unlistenExit?.();
    resizeObserver?.disconnect();
    assistResizeObserver?.disconnect();
    if (noticeTimer) {
      clearTimeout(noticeTimer);
    }
    clearTerminalLoadingTimers();
    clearAuxLayoutSettleTimer();
    clearDeferredBottomScrollTimer();
    releaseBottomLock();
    pendingPostWriteScroll = false;
    revokePendingClipboardImage(pendingClipboardImage);
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
  data-draft-open={draftOpen ? "true" : "false"}
  data-pending-image={pendingClipboardImage ? "true" : "false"}
  data-test-hook-registered={testHookRegistered ? "true" : "false"}
  data-loading-state={terminalLoadingState ?? "idle"}
  data-soft-follow-experiment={softFollowExperimentEnabled ? "true" : "false"}
  data-renderer-preference={preferredRenderer}
  data-renderer={activeRenderer}
  class:hidden={!visible}
  bind:this={shellEl}
>
  <div
    class="terminal-output"
    class:terminal-output--link-hover={linkHovering}
    data-testid={TEST_IDS.terminalOutput}
    bind:this={outputEl}
  >
    {#if spawnError}
      <div class="terminal-error">
        {$t("terminal.assist.startFailed", { values: { message: spawnError } })}
      </div>
    {/if}

    {#if clipboardNotice}
      <div class="terminal-notice">
        {clipboardNotice}
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

  {#if auxInitialized}
    <div
      class="aux-panel"
      class:aux-panel--hidden={!auxVisible}
      style:height={`${auxHeightPercent}%`}
      aria-hidden={!auxVisible}
    >
      <div class="aux-surface">
        <button
          type="button"
          class="aux-resize-handle"
          tabindex="-1"
          aria-label={$t("terminal.aux.resizeHint")}
          title={$t("terminal.aux.resizeHint")}
          onpointerdown={handleAuxResizeStart}
        ></button>

        <div class="aux-header">
          <div class="aux-copy">
            <span class="aux-title">{$t("terminal.aux.title")}</span>
            <span class="aux-path">
              {$t("terminal.aux.currentPath")}: {auxCurrentPath}
            </span>
          </div>

          <Button
            size="sm"
            variant="ghost"
            onclick={(event) => {
              (event.currentTarget as HTMLButtonElement | null)?.blur();
              hideAuxTerminal();
            }}
          >
            {$t("common.actions.close")}
          </Button>
        </div>

        <div class="aux-output" data-testid={TEST_IDS.auxTerminalShell} bind:this={auxOutputEl}>
          {#if auxSpawnError}
            <div class="terminal-error">
              {$t("terminal.aux.startFailed", { values: { message: auxSpawnError } })}
            </div>
          {/if}
        </div>
      </div>

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
    </div>
  {/if}

  <div class="assist-panel" class:assist-panel--draft-open={draftOpen} bind:this={assistPanelEl}>
    <div class="assist-header">
      <div class="assist-copy">
        <span class="assist-label">{$t("terminal.assist.label")}</span>
        <span class="assist-hint">{$t("terminal.assist.hint")}</span>
      </div>

      <div class="assist-actions">
        <Button size="sm" onclick={handlePasteImageFromClipboard}>
          {$t("terminal.assist.pasteImage")}
        </Button>
        <Button
          size="sm"
          data-testid={TEST_IDS.auxTerminalToggle}
          variant={auxVisible ? "primary" : "secondary"}
          onclick={(event) => {
            (event.currentTarget as HTMLButtonElement | null)?.blur();
            void toggleAuxTerminal();
          }}
          disabled={auxBusy}
        >
          {#if auxVisible}
            {$t("terminal.assist.hideTerminal")}
          {:else}
            {$t("terminal.assist.openTerminal")}
          {/if}
        </Button>
        <Button
          size="sm"
          data-testid={TEST_IDS.draftToggle}
          variant={draftOpen ? "primary" : "secondary"}
          onclick={toggleDraft}
        >
          {#if draftOpen}
            {$t("terminal.assist.hideDraft")}
          {:else if draftValue}
            {$t("terminal.assist.draftWithCount", { values: { count: draftValue.length } })}
          {:else}
            {$t("terminal.assist.openDraft")}
          {/if}
        </Button>
      </div>
    </div>

    {#if draftOpen}
      <div class="draft-panel">
        <textarea
          bind:this={draftEl}
          bind:value={draftValue}
          data-testid={TEST_IDS.draftTextarea}
          class="draft-textarea"
          rows="1"
          spellcheck="false"
          autocapitalize="off"
          autocomplete="off"
          placeholder={$t("terminal.assist.draftPlaceholder")}
          oninput={handleDraftInput}
          onkeydown={handleDraftKeydown}
          onpaste={handleDraftPaste}
        ></textarea>

        <div class="draft-footer">
          <span class="draft-hint">{$t("terminal.assist.draftHint")}</span>

          <div class="draft-actions">
            <Button
              size="sm"
              data-testid={TEST_IDS.draftInsertButton}
              onclick={() => void insertDraftIntoTerminal(false)}
              disabled={draftValue.length === 0}
            >
              {$t("common.actions.insert")}
            </Button>
            <Button
              size="sm"
              variant="primary"
              data-testid={TEST_IDS.draftSendButton}
              onclick={() => void insertDraftIntoTerminal(true)}
              disabled={draftValue.length === 0}
            >
              {$t("common.actions.send")}
            </Button>
          </div>
        </div>
      </div>
    {/if}
  </div>
</div>

<ContextMenu
  visible={linkMenuVisible}
  x={linkMenuX}
  y={linkMenuY}
  items={linkMenuItems}
  onSelect={handleLinkMenuSelect}
  onClose={closeLinkMenu}
/>

<ImagePasteModal
  visible={pendingClipboardImage !== null}
  image={pendingClipboardImage}
  busy={clipboardBusy}
  error={clipboardError}
  onCancel={() => resetClipboardImage(true)}
  onConfirm={confirmClipboardImage}
/>

<EditorPickerModal
  visible={editorPickerVisible}
  title={$t("terminal.filePaths.pickerTitle")}
  description={$t("terminal.filePaths.pickerDescription")}
  emptyLabel={editorsError || $t("terminal.filePaths.noEditors")}
  defaultEditorId={settings.interface.defaultEditorId}
  editors={detectedEditors}
  onSelect={handleEditorSelect}
  onClose={closeEditorPicker}
/>

<ModalShell
  open={interruptConfirmVisible}
  size="sm"
  onClose={closeInterruptConfirm}
>
  <div class="terminal-interrupt-panel">
    <h2>{$t("terminal.interrupt.title")}</h2>
    <p>{$t("terminal.interrupt.description")}</p>
    <div class="terminal-interrupt-actions">
      <Button variant="danger" onclick={() => void confirmTerminalInterrupt()}>
        {$t("terminal.interrupt.confirm")}
      </Button>
      <Button onclick={closeInterruptConfirm}>
        {$t("common.actions.cancel")}
      </Button>
    </div>
  </div>
</ModalShell>

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

  .aux-panel {
    position: absolute;
    left: var(--ui-space-1);
    right: var(--ui-space-1);
    bottom: calc(var(--assist-panel-height, 0px) + var(--ui-space-1));
    overflow: hidden;
    min-height: 0;
    max-height: calc(100% - var(--assist-panel-height, 0px) - calc(12px * var(--ui-scale)));
    border: 1px solid color-mix(in srgb, var(--ui-border-strong, var(--tab-border)) 76%, transparent);
    border-radius: var(--ui-radius-lg);
    background:
      linear-gradient(180deg, color-mix(in srgb, var(--ui-bg-surface, var(--tab-active-bg)) 90%, transparent), transparent),
      color-mix(in srgb, var(--ui-bg-app, var(--app-bg)) 88%, transparent);
    box-shadow: 0 -12px 28px rgba(var(--ui-shadow-rgb, 15, 23, 42), 0.22);
    transition: border-color 160ms ease, opacity 160ms ease, transform 160ms ease, visibility 0s linear;
    z-index: 15;
  }

  .aux-panel.aux-panel--hidden {
    visibility: hidden;
    opacity: 0;
    pointer-events: none;
    transform: translateY(calc(100% + var(--ui-space-2)));
  }

  .aux-surface {
    height: 100%;
    min-height: 0;
    display: flex;
    flex-direction: column;
  }

  .aux-resize-handle {
    flex: 0 0 auto;
    height: calc(14px * var(--ui-scale));
    display: flex;
    align-items: center;
    justify-content: center;
    border: none;
    background: transparent;
    cursor: ns-resize;
    color: var(--ui-text-muted, var(--tab-text));
  }

  .aux-resize-handle::before {
    content: "";
    width: calc(56px * var(--ui-scale));
    height: calc(4px * var(--ui-scale));
    border-radius: 999px;
    background: color-mix(in srgb, var(--ui-border-strong, var(--tab-border)) 74%, transparent);
  }

  .aux-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--ui-space-3);
    padding: 0 var(--ui-space-4) var(--ui-space-3);
  }

  .aux-copy {
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: var(--ui-space-1);
  }

  .aux-title {
    font-size: var(--ui-font-size-sm);
    font-weight: 700;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--ui-text-secondary, var(--tab-text));
  }

  .aux-path {
    font-size: var(--ui-font-size-sm);
    line-height: 1.45;
    color: var(--ui-text-muted, var(--tab-text));
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .aux-output {
    flex: 1;
    min-height: 0;
    position: relative;
    padding: 0 var(--ui-space-3) var(--ui-space-3);
  }

  .assist-panel {
    flex-shrink: 0;
    padding: var(--ui-space-3) var(--ui-space-4) var(--ui-space-4);
    border-top: 1px solid var(--ui-border-subtle, var(--tab-border));
    background:
      linear-gradient(180deg, color-mix(in srgb, var(--ui-bg-surface, var(--tab-active-bg)) 72%, transparent), transparent),
      var(--ui-bg-app, var(--app-bg));
    transition: box-shadow 160ms ease, border-color 160ms ease;
  }

  .assist-panel.assist-panel--draft-open {
    border-top-color: color-mix(in srgb, var(--ui-border-strong, var(--tab-border)) 82%, transparent);
    box-shadow: 0 -16px 26px rgba(var(--ui-shadow-rgb, 15, 23, 42), 0.18);
  }

  .assist-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--ui-space-3);
  }

  .assist-copy {
    display: flex;
    flex-direction: column;
    gap: var(--ui-space-1);
    min-width: 0;
  }

  .assist-label {
    font-size: var(--ui-font-size-sm);
    font-weight: 700;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--ui-text-secondary, var(--tab-text));
  }

  .assist-hint {
    font-size: var(--ui-font-size-sm);
    line-height: 1.45;
    color: var(--ui-text-muted, var(--tab-text));
  }

  .assist-actions {
    display: flex;
    flex-wrap: wrap;
    gap: var(--ui-space-2);
    align-items: center;
    justify-content: flex-end;
  }

  .draft-panel {
    margin-top: var(--ui-space-3);
    padding: var(--ui-space-4);
    border-radius: var(--ui-radius-lg);
    border: 1px solid var(--ui-border-subtle, rgba(148, 163, 184, 0.18));
    background: color-mix(in srgb, var(--ui-bg-surface, var(--tab-active-bg)) 88%, transparent);
    box-shadow: 0 14px 28px rgba(var(--ui-shadow-rgb, 15, 23, 42), 0.16);
  }

  .draft-textarea {
    width: 100%;
    min-height: calc(42px * var(--ui-scale));
    max-height: 50vh;
    resize: none;
    padding: calc(10px * var(--ui-scale)) var(--ui-space-3);
    border: 1px solid var(--ui-border-subtle, rgba(148, 163, 184, 0.24));
    border-radius: var(--ui-radius-md);
    background: color-mix(in srgb, var(--ui-bg-elevated, var(--tab-bg)) 92%, transparent);
    color: var(--ui-text-primary, #e2e8f0);
    font: inherit;
    line-height: 1.5;
    outline: none;
    box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.02);
  }

  .draft-textarea:focus {
    border-color: var(--ui-accent, rgba(96, 165, 250, 0.65));
    box-shadow:
      inset 0 1px 0 rgba(255, 255, 255, 0.03),
      0 0 0 1px var(--ui-focus-ring, rgba(96, 165, 250, 0.12));
  }

  .draft-footer {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--ui-space-3);
    margin-top: var(--ui-space-3);
  }

  .draft-hint {
    font-size: var(--ui-font-size-sm);
    line-height: 1.45;
    color: var(--ui-text-muted, var(--tab-text));
  }

  .draft-actions {
    display: flex;
    gap: var(--ui-space-2);
    align-items: center;
  }

  .terminal-interrupt-panel {
    display: grid;
    gap: 16px;
    padding: 24px;
    color: var(--ui-text-primary, var(--tab-text));
  }

  .terminal-interrupt-panel h2 {
    margin: 0;
    font-size: 19px;
    line-height: 1.2;
    color: var(--ui-text-primary, var(--tab-text));
  }

  .terminal-interrupt-panel p {
    margin: 0;
    font-size: 14px;
    line-height: 1.55;
    color: var(--ui-text-muted, var(--tab-text));
  }

  .terminal-interrupt-actions {
    display: flex;
    flex-wrap: wrap;
    justify-content: flex-end;
    gap: 10px;
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

  @media (max-width: 900px) {
    .assist-header,
    .draft-footer {
      flex-direction: column;
      align-items: stretch;
    }

    .assist-actions,
    .draft-actions {
      justify-content: stretch;
    }

    :global(.assist-actions .ui-button),
    :global(.draft-actions .ui-button) {
      flex: 1;
    }
  }
</style>

<script lang="ts">
  import { onMount, onDestroy, tick } from "svelte";
  import { Terminal, type IDisposable } from "@xterm/xterm";
  import { FitAddon } from "@xterm/addon-fit";
  import { WebLinksAddon } from "@xterm/addon-web-links";
  import ImagePasteModal from "./ImagePasteModal.svelte";
  import EditorPickerModal from "./EditorPickerModal.svelte";
  import ContextMenu from "../ui/components/ContextMenu.svelte";
  import { listen, type UnlistenFn } from "@tauri-apps/api/event";
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
    spawnPty,
    writePty,
    resizePty,
    takePtyInitialOutput,
  } from "../pty";
  import { t } from "../i18n";
  import { getSettings } from "../stores/settings.svelte";
  import { getThemeById } from "../themes";
  import type { ContextMenuItem } from "../ui/context-menu";
  import { Button } from "../ui";
  import { buildFontStack, serializeFontFamilyList } from "../font-family";
  import {
    listAvailableEditors,
    openInEditor,
    resolveTerminalPath,
    type DetectedEditor,
    type ResolvedTerminalPath,
  } from "../editors";
  import { createTerminalFileLinks } from "../terminal/file-links";
  import { TEST_IDS } from "../testids";
  import { openExternalUrl } from "../workspace";
  import {
    TEST_BRIDGE_EVENTS,
    decodeBase64Blob,
    getOrCreateTerminalTestHooks,
    isTestBridgeEnabled,
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
    resumeToken?: string | null;
    onPtyId?: (ptyId: number) => void;
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
    resumeToken = null,
    onPtyId,
    onExit,
    onResumeFallback,
  }: Props = $props();

  let shellEl: HTMLDivElement;
  let outputEl: HTMLDivElement;
  let draftEl = $state<HTMLTextAreaElement | null>(null);
  let terminal: Terminal | null = null;
  let fitAddon: FitAddon | null = null;
  let inputTextarea: HTMLTextAreaElement | undefined;
  let livePtyId = $state(-1);
  let initialOutputReady = false;
  let terminalReady = $state(false);
  let spawnError = $state<string | null>(null);
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
  let editorPickerVisible = $state(false);
  let editorPickerPath = $state<ResolvedTerminalPath | null>(null);
  let detectedEditors = $state<DetectedEditor[]>([]);
  let editorsLoaded = false;
  let editorsError = $state<string | null>(null);
  let noticeTimer: ReturnType<typeof setTimeout> | null = null;
  let unlistenOutput: UnlistenFn | null = null;
  let unlistenExit: UnlistenFn | null = null;
  let resizeObserver: ResizeObserver | null = null;
  let fileLinkProviderDisposable: IDisposable | null = null;
  let replayInProgress = false;
  let replayBuffer: PtyOutputChunk[] = [];
  let testHookRegistered = $state(false);
  let bottomLockTimer: ReturnType<typeof setTimeout> | null = null;
  let bottomLockDeadline = 0;
  let bottomLockMaxDeadline = 0;
  let followTail = true;
  const RESUME_FAILED_MARKER = "__CLCOMX_RESUME_FAILED__";
  const BOTTOM_LOCK_MAX_MS = 12000;
  const BOTTOM_LOCK_QUIET_MS = 1400;
  const WEB_LINK_REGEX = /(?:https?|ftp):[/]{2}[^\s"'!*(){}|\\^<>`]*[^\s"':,.!?{}|\\^~\[\]`()<>]/i;

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

  function writeTerminalData(term: Terminal, data: string) {
    return new Promise<void>((resolve) => {
      if (!data) {
        resolve();
        return;
      }

      term.write(data, () => resolve());
    });
  }

  function clearBottomLockTimer() {
    if (bottomLockTimer) {
      clearTimeout(bottomLockTimer);
      bottomLockTimer = null;
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
    scheduleBottomLockTick();
  }

  function extendBottomLock(quietWindowMs = BOTTOM_LOCK_QUIET_MS) {
    if (!canExtendBottomLock()) {
      return;
    }

    bottomLockDeadline = Math.min(bottomLockMaxDeadline, Date.now() + quietWindowMs);
    followTail = true;
    scheduleBottomLockTick();
  }

  function disableAutoFollow() {
    followTail = false;
    releaseBottomLock();
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

  function focusOutput() {
    if (!terminalReady || !visible) return;

    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        terminal?.focus();
      });
    });
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
    if (editorsLoaded && !editorsError) {
      return detectedEditors;
    }

    editorsError = null;

    try {
      detectedEditors = await listAvailableEditors();
    } catch (error) {
      editorsError = error instanceof Error ? error.message : String(error);
      detectedEditors = [];
    } finally {
      editorsLoaded = true;
    }

    return detectedEditors;
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

  function handleOutputChunk(event: PtyOutputChunk) {
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
      const shouldStickToBottom = followTail || isBottomLockActive();
      extendBottomLock();
      terminal.write(data, () => {
        if (shouldStickToBottom) {
          terminal?.scrollToBottom();
        }
      });
    }
  }

  async function attachToExistingPty(id: number, term: Terminal) {
    livePtyId = id;
    replayInProgress = true;
    replayBuffer = [];

    const snapshot = await getPtyOutputSnapshot(id);
    await writeTerminalData(term, snapshot.data);

    const pendingChunks = replayBuffer
      .filter((chunk) => chunk.seq > snapshot.seq)
      .sort((left, right) => left.seq - right.seq);

    replayInProgress = false;
    for (const chunk of pendingChunks) {
      await writeTerminalData(term, chunk.data);
    }

    initialOutputReady = true;
    armBottomLock();
  }

  async function spawnNewPty(term: Terminal) {
    const { cols, rows } = getInitialPtySize(term);
    livePtyId = await spawnPty(cols, rows, agentId, distro, workDir, resumeToken);
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
    onPtyId?.(livePtyId);
  }

  onMount(async () => {
    const initialTheme = getThemeById(settings.interface.theme)?.theme;
    const term = new Terminal({
      fontSize: settings.terminal.fontSize,
      fontFamily: terminalFontFamily,
      theme: initialTheme,
      cursorBlink: false,
      cursorStyle: "block",
      allowProposedApi: true,
      scrollback: settings.terminal.scrollback,
      disableStdin: false,
    });

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
    inputTextarea = term.textarea;

    await tick();
    syncDraftHeight();

    requestAnimationFrame(() => {
      fit.fit();
    });

    applyCompositionViewTheme();

    unlistenOutput = await listen<PtyOutputChunk>("pty-output", (event) => {
      handleOutputChunk(event.payload);
    });

    unlistenExit = await listen<number>("pty-exit", (event) => {
      if (event.payload === livePtyId) {
        onExit?.(event.payload);
      }
    });

    try {
      terminal = term;
      fitAddon = fit;
      terminalReady = true;

      await new Promise<void>((resolve) => {
        requestAnimationFrame(() => {
          fit.fit();
          resolve();
        });
      });

      if (ptyId >= 0) {
        await attachToExistingPty(ptyId, term);
      } else {
        await spawnNewPty(term);
      }
    } catch (error) {
      spawnError = error instanceof Error ? error.message : String(error);
    }

    term.onData((data) => {
      if (livePtyId >= 0) {
        void writePty(livePtyId, data);
      }
    });

    resizeObserver = new ResizeObserver(() => {
      if (visible && fit) {
        fit.fit();
        if (followTail || isBottomLockActive()) {
          scrollTerminalToBottom();
        }
        syncDraftHeight();
      }
    });
    resizeObserver.observe(outputEl);

    term.onResize(({ cols, rows }) => {
      if (livePtyId >= 0) {
        void resizePty(livePtyId, cols, rows);
      }
      if (followTail || isBottomLockActive()) {
        scrollTerminalToBottom();
      }
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
    window.addEventListener("clcomx:focus-active-terminal", handleFocusRequest);
    window.addEventListener(TEST_BRIDGE_EVENTS.openPendingImage, handleTestPendingImage as EventListener);
    if (isTestBridgeEnabled()) {
      getOrCreateTerminalTestHooks()[sessionId] = {
        openPendingImage: openPendingImageForTest,
        getOutputSnapshot: getOutputSnapshotForTest,
        getViewportState: getViewportStateForTest,
        openUrlMenu: openUrlLinkMenuForTest,
        openFileMenu: openFileLinkMenuForTest,
      };
      testHookRegistered = true;
    }
  });

  $effect(() => {
    if (!terminalReady || !visible) return;

    armBottomLock();
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        fitAddon?.fit();
        if (followTail || isBottomLockActive()) {
          terminal?.scrollToBottom();
        }
        if (livePtyId >= 0 && terminal) {
          void resizePty(livePtyId, terminal.cols, terminal.rows);
        }
        syncDraftHeight();
        focusOutput();
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
    }
  });

  $effect(() => {
    if (!terminalReady) return;
    terminal!.options.fontSize = settings.terminal.fontSize;
    terminal!.options.fontFamily = terminalFontFamily;
    terminal!.options.scrollback = settings.terminal.scrollback;
    fitAddon?.fit();
    tick().then(syncDraftHeight);
  });

  $effect(() => {
    settings.terminal.draftMaxRows;
    tick().then(syncDraftHeight);
  });

  onDestroy(() => {
    window.removeEventListener("clcomx:focus-active-terminal", handleFocusRequest);
    window.removeEventListener(TEST_BRIDGE_EVENTS.openPendingImage, handleTestPendingImage as EventListener);
    if (isTestBridgeEnabled()) {
      delete getOrCreateTerminalTestHooks()[sessionId];
      testHookRegistered = false;
    }
    inputTextarea?.removeEventListener("paste", handleTerminalPaste as EventListener, true);
    outputEl?.removeEventListener("mousemove", handleLinkPointerMove, true);
    outputEl?.removeEventListener("wheel", disableAutoFollow, true);
    window.removeEventListener("mouseup", releaseLinkSelectionBlock, true);
    window.removeEventListener("blur", releaseLinkSelectionBlock);
    unlistenOutput?.();
    unlistenExit?.();
    resizeObserver?.disconnect();
    if (noticeTimer) {
      clearTimeout(noticeTimer);
    }
    releaseBottomLock();
    revokePendingClipboardImage(pendingClipboardImage);
    fileLinkProviderDisposable?.dispose();
    terminal?.dispose();
  });
</script>

<div
  class="terminal-shell"
  data-testid={TEST_IDS.terminalShell}
  data-agent-id={agentId}
  data-session-id={sessionId}
  data-pty-id={String(livePtyId)}
  data-draft-open={draftOpen ? "true" : "false"}
  data-pending-image={pendingClipboardImage ? "true" : "false"}
  data-test-hook-registered={testHookRegistered ? "true" : "false"}
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
  </div>

  <div class="assist-panel" class:assist-panel--draft-open={draftOpen}>
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

  .terminal-output.terminal-output--link-hover {
    cursor: pointer;
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

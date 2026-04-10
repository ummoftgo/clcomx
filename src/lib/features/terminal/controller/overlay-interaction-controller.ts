import type { Terminal } from "@xterm/xterm";
import type { PendingClipboardImage, SavedClipboardImage } from "../../../clipboard";
import type {
  DetectedEditor,
  ResolvedTerminalPath,
  TerminalPathResolution,
} from "../../../editors";
import type { ContextMenuItem } from "../../../ui/context-menu";
import type { OverlayInteractionState, LinkMenuTarget } from "../state/overlay-interaction-state.svelte";
import { createOverlayClipboardImageController } from "./overlay-clipboard-image-controller";
import {
  createOverlayFileLinkActions,
  getFilePathNotice,
} from "./overlay-file-link-actions";

type TranslateFn = (key: string, options?: Record<string, unknown>) => string;

interface OverlayInteractionDeps {
  getSessionId: () => string;
  getDistro: () => string;
  getWorkDir: () => string;
  getVisible: () => boolean;
  getTerminal: () => Terminal | null;
  getDraftOpen: () => boolean;
  focusDraft: () => void;
  focusOutput: () => void;
  routeInsertedText: (text: string) => void;
  openExternalUrl: (url: string) => Promise<void>;
  resolveTerminalPath: (
    raw: string,
    distro: string,
    workDir: string,
    sessionId?: string | null,
    homeDirHint?: string | null,
  ) => Promise<TerminalPathResolution>;
  getShellHomeDirHint: () => string | null;
  getFileOpenTarget: () => "internal" | "external";
  getFileOpenMode: () => "default" | "picker";
  getDefaultEditorId: () => string;
  getEditorsError: () => string | null;
  ensureEditorsLoaded: () => Promise<DetectedEditor[]>;
  openInEditor: (editorId: string, path: ResolvedTerminalPath) => Promise<void>;
  openInternalEditorForLinkPath: (path: ResolvedTerminalPath) => void;
  t: TranslateFn;
  createPendingClipboardImage: (blob: Blob) => PendingClipboardImage;
  revokePendingClipboardImage: (image: PendingClipboardImage | null) => void;
  readImageFromClipboard: () => Promise<Blob | null>;
  getImageFromPasteEvent: (event: ClipboardEvent) => Blob | null;
  saveClipboardImage: (
    image: PendingClipboardImage,
    distro: string,
  ) => Promise<SavedClipboardImage>;
  formatPathForAgentInput: (path: string) => string;
}

function clearNoticeTimer(state: OverlayInteractionState) {
  if (state.noticeTimer) {
    clearTimeout(state.noticeTimer);
    state.noticeTimer = null;
  }
}

export function createOverlayInteractionController(
  state: OverlayInteractionState,
  deps: OverlayInteractionDeps,
) {
  const setClipboardNotice = (message: string) => {
    clearNoticeTimer(state);
    state.clipboardNotice = message;
    state.noticeTimer = setTimeout(() => {
      state.clipboardNotice = null;
      state.noticeTimer = null;
    }, 2400);
  };

  const openContextMenu = (
    target: LinkMenuTarget,
    x: number,
    y: number,
  ) => {
    state.suppressSelectionUntilMouseUp = true;
    deps.getTerminal()?.clearSelection();
    state.linkMenuTarget = target;
    state.linkMenuX = x;
    state.linkMenuY = y;
    state.linkMenuVisible = true;
  };

  const closeLinkMenu = () => {
    state.linkMenuVisible = false;
    state.linkMenuTarget = null;
  };

  const releaseLinkSelectionBlock = () => {
    state.suppressSelectionUntilMouseUp = false;
  };

  const handleLinkHover = () => {
    state.linkHovering = true;
  };

  const handleLinkLeave = () => {
    state.linkHovering = false;
  };

  const handleLinkPointerMove = (event: MouseEvent) => {
    if (!state.suppressSelectionUntilMouseUp || (event.buttons & 1) === 0) {
      return;
    }

    deps.getTerminal()?.clearSelection();
    event.preventDefault();
    event.stopPropagation();
  };

  const showEditorPicker = (path: ResolvedTerminalPath) => {
    state.editorPickerPath = path;
    state.editorPickerVisible = true;
  };

  const closeEditorPicker = () => {
    state.editorPickerVisible = false;
    state.editorPickerPath = null;
  };

  const fileLinkActions = createOverlayFileLinkActions({
    getWorkDir: deps.getWorkDir,
    getFileOpenTarget: deps.getFileOpenTarget,
    getFileOpenMode: deps.getFileOpenMode,
    getDefaultEditorId: deps.getDefaultEditorId,
    getEditorsError: deps.getEditorsError,
    ensureEditorsLoaded: deps.ensureEditorsLoaded,
    openInEditor: deps.openInEditor,
    openInternalEditorForLinkPath: deps.openInternalEditorForLinkPath,
    openExternalUrl: deps.openExternalUrl,
    openEditorPicker: showEditorPicker,
    writeClipboardText: (text) => navigator.clipboard.writeText(text),
    setNotice: setClipboardNotice,
    reportError: (message, error) => {
      console.error(message, error);
    },
    t: deps.t,
  });
  const clipboardImageController = createOverlayClipboardImageController(state, {
    getDistro: deps.getDistro,
    getVisible: deps.getVisible,
    getDraftOpen: deps.getDraftOpen,
    focusDraft: deps.focusDraft,
    focusOutput: deps.focusOutput,
    routeInsertedText: deps.routeInsertedText,
    setNotice: setClipboardNotice,
    t: deps.t,
    createPendingClipboardImage: deps.createPendingClipboardImage,
    revokePendingClipboardImage: deps.revokePendingClipboardImage,
    readImageFromClipboard: deps.readImageFromClipboard,
    getImageFromPasteEvent: deps.getImageFromPasteEvent,
    saveClipboardImage: deps.saveClipboardImage,
    formatPathForAgentInput: deps.formatPathForAgentInput,
  });

  const openFileLinkMenu = async (rawPath: string, event: MouseEvent) => {
    state.suppressSelectionUntilMouseUp = true;
    deps.getTerminal()?.clearSelection();

    try {
      const pathResolution: TerminalPathResolution = await deps.resolveTerminalPath(
        rawPath,
        deps.getDistro(),
        deps.getWorkDir(),
        deps.getSessionId(),
        deps.getShellHomeDirHint(),
      );
      if (pathResolution.kind === "resolved") {
        openContextMenu({ kind: "file", path: pathResolution.path }, event.clientX, event.clientY);
        return;
      }

      if (pathResolution.candidates.length === 0) {
        setClipboardNotice(getFilePathNotice(deps.t, undefined, "terminal.filePaths.resolveFailed"));
        return;
      }

      openContextMenu(
        { kind: "file-candidates", raw: pathResolution.raw, candidates: pathResolution.candidates },
        event.clientX,
        event.clientY,
      );
    } catch (error) {
      console.warn("Failed to resolve terminal file path", error);
      setClipboardNotice(getFilePathNotice(deps.t, error, "terminal.filePaths.resolveFailed"));
    }
  };

  const openFileLinkMenuForTest = async (rawPath: string) => {
    state.suppressSelectionUntilMouseUp = true;
    deps.getTerminal()?.clearSelection();

    const pathResolution: TerminalPathResolution = await deps.resolveTerminalPath(
      rawPath,
      deps.getDistro(),
      deps.getWorkDir(),
      deps.getSessionId(),
      deps.getShellHomeDirHint(),
    );
    if (pathResolution.kind === "resolved") {
      openContextMenu({ kind: "file", path: pathResolution.path }, 160, 160);
      return;
    }

    if (pathResolution.candidates.length === 0) {
      setClipboardNotice(getFilePathNotice(deps.t, undefined, "terminal.filePaths.resolveFailed"));
      return;
    }

    openContextMenu(
      { kind: "file-candidates", raw: pathResolution.raw, candidates: pathResolution.candidates },
      160,
      160,
    );
  };

  const openUrlLinkMenuForTest = (url: string) => {
    deps.getTerminal()?.clearSelection();
    openContextMenu({ kind: "url", url }, 160, 160);
  };

  const handleEditorSelect = async (editor: DetectedEditor) => {
    const opened = await fileLinkActions.handleEditorSelect(editor, state.editorPickerPath);
    if (opened) {
      closeEditorPicker();
    }
  };

  const handleLinkMenuSelect = async (item: Extract<ContextMenuItem, { kind: "item" }>) => {
    if (!state.linkMenuTarget) return;
    await fileLinkActions.handleLinkMenuSelect(state.linkMenuTarget, item);
  };

  const handleSelectionCopy = async () => {
    const term = deps.getTerminal();
    if (!term) return;
    const selection = term.getSelection();
    if (!selection) return;
    await navigator.clipboard.writeText(selection);
    term.clearSelection();
    setClipboardNotice(deps.t("terminal.selection.copySuccess"));
  };

  const dispose = () => {
    clearNoticeTimer(state);
    clipboardImageController.dispose();
    state.clipboardNotice = null;
    state.linkMenuVisible = false;
    state.linkMenuTarget = null;
    state.editorPickerVisible = false;
    state.editorPickerPath = null;
  };

  return {
    state,
    setClipboardNotice,
    openContextMenu,
    closeLinkMenu,
    releaseLinkSelectionBlock,
    handleLinkHover,
    handleLinkLeave,
    handleLinkPointerMove,
    closeEditorPicker,
    showEditorPicker,
    openPathInEditor: fileLinkActions.openPathInEditor,
    buildCandidateFileLinkMenuItems: fileLinkActions.buildCandidateFileLinkMenuItems,
    openFileLinkMenu,
    openFileLinkMenuForTest,
    openUrlLinkMenuForTest,
    handleEditorSelect,
    handleLinkMenuSelect,
    openClipboardPreview: clipboardImageController.openClipboardPreview,
    resetClipboardImage: clipboardImageController.resetClipboardImage,
    handlePasteImageFromClipboard: clipboardImageController.handlePasteImageFromClipboard,
    confirmClipboardImage: clipboardImageController.confirmClipboardImage,
    handleDraftPaste: clipboardImageController.handleDraftPaste,
    handleTerminalPaste: clipboardImageController.handleTerminalPaste,
    handleSelectionCopy,
    dispose,
  };
}

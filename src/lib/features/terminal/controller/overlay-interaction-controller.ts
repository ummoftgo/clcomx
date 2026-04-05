import type { Terminal } from "@xterm/xterm";
import {
  formatPathForAgentInput,
  getImageFromPasteEvent,
  readImageFromClipboard,
  revokePendingClipboardImage,
  saveClipboardImage,
} from "../../../clipboard";
import type {
  DetectedEditor,
  ResolvedTerminalPath,
  TerminalPathResolution,
} from "../../../editors";
import type { ContextMenuItem } from "../../../ui/context-menu";
import type { OverlayInteractionState, LinkMenuTarget } from "../state/overlay-interaction-state.svelte";

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
  createPendingClipboardImage: typeof import("../../../clipboard").createPendingClipboardImage;
  revokePendingClipboardImage: typeof revokePendingClipboardImage;
  readImageFromClipboard: typeof readImageFromClipboard;
  getImageFromPasteEvent: typeof getImageFromPasteEvent;
  saveClipboardImage: typeof saveClipboardImage;
  formatPathForAgentInput: typeof formatPathForAgentInput;
}

function clearNoticeTimer(state: OverlayInteractionState) {
  if (state.noticeTimer) {
    clearTimeout(state.noticeTimer);
    state.noticeTimer = null;
  }
}

function getFilePathNotice(t: TranslateFn, error: unknown, fallbackKey: string) {
  const message = error instanceof Error ? error.message : String(error);
  if (/path does not exist/i.test(message)) {
    return t("terminal.filePaths.pathNotFound");
  }
  return t(fallbackKey);
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

  const ensureEditorsLoaded = async () => await deps.ensureEditorsLoaded();

  const showEditorPicker = async (path: ResolvedTerminalPath) => {
    await ensureEditorsLoaded();
    state.editorPickerPath = path;
    state.editorPickerVisible = true;
  };

  const closeEditorPicker = () => {
    state.editorPickerVisible = false;
    state.editorPickerPath = null;
  };

  const openPathInEditor = async (
    path: ResolvedTerminalPath,
    preferredEditorId?: string | null,
    forcePicker = false,
  ) => {
    if (!forcePicker && deps.getFileOpenTarget() === "internal") {
      deps.openInternalEditorForLinkPath(path);
      return;
    }

    const editors = await ensureEditorsLoaded();
    if (editors.length === 0) {
      setClipboardNotice(deps.getEditorsError() || deps.t("terminal.filePaths.noEditors"));
      return;
    }

    if (forcePicker || deps.getFileOpenMode() === "picker") {
      await showEditorPicker(path);
      return;
    }

    const preferredId = preferredEditorId?.trim() || deps.getDefaultEditorId().trim();
    const preferredEditor = editors.find((editor) => editor.id === preferredId);
    if (!preferredEditor) {
      await showEditorPicker(path);
      return;
    }

    await deps.openInEditor(preferredEditor.id, path);
  };

  const getCandidateLinkLabel = (path: ResolvedTerminalPath) => {
    const displayPath = (path.wslPath || path.raw).replace(/\\/g, "/");
    const normalizedWorkDir = deps.getWorkDir().replace(/\\/g, "/");
    let shortPath = displayPath;

    if (normalizedWorkDir && displayPath.startsWith(`${normalizedWorkDir}/`)) {
      shortPath = displayPath.slice(normalizedWorkDir.length + 1);
    } else if (displayPath === normalizedWorkDir) {
      shortPath = ".";
    } else {
      const lastSlash = displayPath.lastIndexOf("/");
      if (lastSlash >= 0) {
        shortPath = displayPath.slice(lastSlash + 1);
      }
    }

    const positionSuffix =
      path.line === null
        ? ""
        : path.column === null
          ? `:${path.line}`
          : `:${path.line}:${path.column}`;
    return `${shortPath}${positionSuffix}`;
  };

  const buildCandidateMenuActionId = (
    index: number,
    action: "open-file" | "open-in-internal-editor" | "open-in-other-editor" | "copy-path",
  ) => `candidate-${index}-${action}`;

  const parseCandidateMenuActionId = (value: string) => {
    const match =
      /^candidate-(\d+)-(open-file|open-in-internal-editor|open-in-other-editor|copy-path)$/.exec(
        value,
      );
    if (!match) return null;
    return {
      index: Number(match[1]),
      action: match[2] as
        | "open-file"
        | "open-in-internal-editor"
        | "open-in-other-editor"
        | "copy-path",
    };
  };

  const buildCandidateFileLinkMenuItems = (raw: string, candidates: ResolvedTerminalPath[]) => {
    const items: ContextMenuItem[] = [
      {
        id: `candidate-list-title:${raw}`,
        kind: "header",
        label: deps.t("terminal.filePaths.candidatesTitle"),
      },
    ];

    candidates.forEach((candidate, index) => {
      if (index > 0) {
        items.push({ id: `candidate-${index}-separator`, kind: "separator" });
      }

      items.push({
        id: `candidate-${index}-header`,
        kind: "header",
        label: getCandidateLinkLabel(candidate),
      });
      items.push(
        {
          id: buildCandidateMenuActionId(index, "open-file"),
          kind: "item",
          label: deps.t("terminal.filePaths.openFile"),
          icon: "file",
        },
        {
          id: buildCandidateMenuActionId(index, "open-in-internal-editor"),
          kind: "item",
          label: deps.t("terminal.filePaths.openInInternalEditor"),
          icon: "file",
        },
        {
          id: buildCandidateMenuActionId(index, "open-in-other-editor"),
          kind: "item",
          label: deps.t("terminal.filePaths.openInOtherEditor"),
          icon: "open-with",
        },
        {
          id: buildCandidateMenuActionId(index, "copy-path"),
          kind: "item",
          label: deps.t("terminal.filePaths.copyPath"),
          icon: "copy",
        },
      );
    });

    return items;
  };

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
    if (!state.editorPickerPath) {
      return;
    }

    try {
      await deps.openInEditor(editor.id, state.editorPickerPath);
      closeEditorPicker();
    } catch (error) {
      console.error("Failed to open path in editor", error);
      setClipboardNotice(getFilePathNotice(deps.t, error, "terminal.filePaths.openFailed"));
    }
  };

  const handleLinkMenuSelect = async (item: Extract<ContextMenuItem, { kind: "item" }>) => {
    if (!state.linkMenuTarget) return;

    try {
      if (state.linkMenuTarget.kind === "url") {
        if (item.id === "open-link-in-browser") {
          await deps.openExternalUrl(state.linkMenuTarget.url);
          return;
        }

        if (item.id === "copy-link") {
          await navigator.clipboard.writeText(state.linkMenuTarget.url);
          setClipboardNotice(deps.t("terminal.links.copySuccess"));
        }
        return;
      }

      if (state.linkMenuTarget.kind === "file-candidates") {
        const candidateAction = parseCandidateMenuActionId(item.id);
        if (!candidateAction) {
          return;
        }

        const candidate = state.linkMenuTarget.candidates[candidateAction.index];
        if (!candidate) {
          return;
        }

        if (candidateAction.action === "open-file") {
          await openPathInEditor(candidate);
          return;
        }

        if (candidateAction.action === "open-in-internal-editor") {
          deps.openInternalEditorForLinkPath(candidate);
          return;
        }

        if (candidateAction.action === "open-in-other-editor") {
          await showEditorPicker(candidate);
          return;
        }

        if (candidateAction.action === "copy-path") {
          await navigator.clipboard.writeText(candidate.copyText);
          setClipboardNotice(deps.t("terminal.filePaths.copySuccess"));
        }
        return;
      }

      if (item.id === "open-file") {
        await openPathInEditor(state.linkMenuTarget.path);
        return;
      }

      if (item.id === "open-in-internal-editor") {
        deps.openInternalEditorForLinkPath(state.linkMenuTarget.path);
        return;
      }

      if (item.id === "open-in-other-editor") {
        await showEditorPicker(state.linkMenuTarget.path);
        return;
      }

      if (item.id === "copy-path") {
        await navigator.clipboard.writeText(state.linkMenuTarget.path.copyText);
        setClipboardNotice(deps.t("terminal.filePaths.copySuccess"));
      }
    } catch (error) {
      console.error("Failed to handle link menu action", error);
      setClipboardNotice(
        state.linkMenuTarget.kind === "url"
          ? deps.t("terminal.links.openFailed")
          : getFilePathNotice(deps.t, error, "terminal.filePaths.openFailed"),
      );
    }
  };

  const resetClipboardImage = (restoreFocus = false) => {
    const current = state.pendingClipboardImage;
    state.pendingClipboardImage = null;
    state.clipboardError = null;
    revokePendingClipboardImage(current);

    if (restoreFocus) {
      if (deps.getDraftOpen()) {
        deps.focusDraft();
      } else {
        deps.focusOutput();
      }
    }
  };

  const openClipboardPreview = (blob: Blob) => {
    const nextImage = deps.createPendingClipboardImage(blob);
    revokePendingClipboardImage(state.pendingClipboardImage);
    state.pendingClipboardImage = nextImage;
    state.clipboardError = null;
  };

  const handlePasteImageFromClipboard = async () => {
    try {
      const imageBlob = await deps.readImageFromClipboard();
      if (!imageBlob) {
        setClipboardNotice(deps.t("terminal.assist.clipboardNoImage"));
        if (deps.getDraftOpen()) {
          deps.focusDraft();
        } else {
          deps.focusOutput();
        }
        return;
      }

      openClipboardPreview(imageBlob);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setClipboardNotice(message);
      if (deps.getDraftOpen()) {
        deps.focusDraft();
      } else {
        deps.focusOutput();
      }
    }
  };

  const confirmClipboardImage = async () => {
    if (!state.pendingClipboardImage) return;

    state.clipboardBusy = true;
    state.clipboardError = null;

    try {
      const savedImage = await deps.saveClipboardImage(state.pendingClipboardImage, deps.getDistro());
      const text = deps.formatPathForAgentInput(savedImage.wslPath);
      deps.routeInsertedText(text);
      resetClipboardImage(true);
    } catch (error) {
      state.clipboardError = error instanceof Error ? error.message : String(error);
    } finally {
      state.clipboardBusy = false;
    }
  };

  const handleDraftPaste = (event: ClipboardEvent) => {
    const imageBlob = deps.getImageFromPasteEvent(event);
    if (!imageBlob) {
      return;
    }

    event.preventDefault();
    openClipboardPreview(imageBlob);
  };

  const handleTerminalPaste = (event: ClipboardEvent) => {
    if (!deps.getVisible()) return;

    const imageBlob = deps.getImageFromPasteEvent(event);
    if (!imageBlob) {
      return;
    }

    event.preventDefault();
    openClipboardPreview(imageBlob);
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
    revokePendingClipboardImage(state.pendingClipboardImage);
    state.pendingClipboardImage = null;
    state.clipboardNotice = null;
    state.clipboardError = null;
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
    openPathInEditor,
    buildCandidateFileLinkMenuItems,
    openFileLinkMenu,
    openFileLinkMenuForTest,
    openUrlLinkMenuForTest,
    handleEditorSelect,
    handleLinkMenuSelect,
    openClipboardPreview,
    resetClipboardImage,
    handlePasteImageFromClipboard,
    confirmClipboardImage,
    handleDraftPaste,
    handleTerminalPaste,
    handleSelectionCopy,
    dispose,
  };
}

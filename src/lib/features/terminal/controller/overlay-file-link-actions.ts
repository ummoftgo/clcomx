import type {
  DetectedEditor,
  ResolvedTerminalPath,
} from "../../../editors";
import type { ContextMenuItem } from "../../../ui/context-menu";
import type { LinkMenuTarget } from "../state/overlay-interaction-state.svelte";

type TranslateFn = (key: string, options?: Record<string, unknown>) => string;
type FileOpenTarget = "internal" | "external";
type FileOpenMode = "default" | "picker";
type CandidateFileLinkAction =
  | "open-file"
  | "open-in-internal-editor"
  | "open-in-other-editor"
  | "copy-path";

interface OverlayFileLinkActionDeps {
  getWorkDir: () => string;
  getFileOpenTarget: () => FileOpenTarget;
  getFileOpenMode: () => FileOpenMode;
  getDefaultEditorId: () => string;
  getEditorsError: () => string | null;
  ensureEditorsLoaded: () => Promise<DetectedEditor[]>;
  openInEditor: (editorId: string, path: ResolvedTerminalPath) => Promise<void>;
  openInternalEditorForLinkPath: (path: ResolvedTerminalPath) => void;
  openExternalUrl: (url: string) => Promise<void>;
  openEditorPicker: (path: ResolvedTerminalPath) => void;
  writeClipboardText: (text: string) => Promise<void>;
  setNotice: (message: string) => void;
  reportError: (message: string, error: unknown) => void;
  t: TranslateFn;
}

export function getFilePathNotice(t: TranslateFn, error: unknown, fallbackKey: string) {
  const message = error instanceof Error ? error.message : String(error);
  if (/path does not exist/i.test(message)) {
    return t("terminal.filePaths.pathNotFound");
  }
  return t(fallbackKey);
}

function getCandidateLinkLabel(path: ResolvedTerminalPath, workDir: string) {
  const displayPath = (path.wslPath || path.raw).replace(/\\/g, "/");
  const normalizedWorkDir = workDir.replace(/\\/g, "/");
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
}

export const buildCandidateMenuActionId = (
  index: number,
  action: CandidateFileLinkAction,
) => `candidate-${index}-${action}`;

export function parseCandidateMenuActionId(value: string) {
  const match =
    /^candidate-(\d+)-(open-file|open-in-internal-editor|open-in-other-editor|copy-path)$/.exec(
      value,
    );
  if (!match) return null;
  return {
    index: Number(match[1]),
    action: match[2] as CandidateFileLinkAction,
  };
}

export function buildCandidateFileLinkMenuItems(
  raw: string,
  candidates: ResolvedTerminalPath[],
  t: TranslateFn,
  workDir: string,
) {
  const items: ContextMenuItem[] = [
    {
      id: `candidate-list-title:${raw}`,
      kind: "header",
      label: t("terminal.filePaths.candidatesTitle"),
    },
  ];

  candidates.forEach((candidate, index) => {
    if (index > 0) {
      items.push({ id: `candidate-${index}-separator`, kind: "separator" });
    }

    items.push({
      id: `candidate-${index}-header`,
      kind: "header",
      label: getCandidateLinkLabel(candidate, workDir),
    });
    items.push(
      {
        id: buildCandidateMenuActionId(index, "open-file"),
        kind: "item",
        label: t("terminal.filePaths.openFile"),
        icon: "file",
      },
      {
        id: buildCandidateMenuActionId(index, "open-in-internal-editor"),
        kind: "item",
        label: t("terminal.filePaths.openInInternalEditor"),
        icon: "file",
      },
      {
        id: buildCandidateMenuActionId(index, "open-in-other-editor"),
        kind: "item",
        label: t("terminal.filePaths.openInOtherEditor"),
        icon: "open-with",
      },
      {
        id: buildCandidateMenuActionId(index, "copy-path"),
        kind: "item",
        label: t("terminal.filePaths.copyPath"),
        icon: "copy",
      },
    );
  });

  return items;
}

export function createOverlayFileLinkActions(deps: OverlayFileLinkActionDeps) {
  const ensureEditorsLoaded = async () => await deps.ensureEditorsLoaded();

  const showEditorPicker = async (path: ResolvedTerminalPath) => {
    await ensureEditorsLoaded();
    deps.openEditorPicker(path);
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
      deps.setNotice(deps.getEditorsError() || deps.t("terminal.filePaths.noEditors"));
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

  const handleEditorSelect = async (
    editor: DetectedEditor,
    path: ResolvedTerminalPath | null,
  ) => {
    if (!path) {
      return false;
    }

    try {
      await deps.openInEditor(editor.id, path);
      return true;
    } catch (error) {
      deps.reportError("Failed to open path in editor", error);
      deps.setNotice(getFilePathNotice(deps.t, error, "terminal.filePaths.openFailed"));
      return false;
    }
  };

  const handleCandidateMenuAction = async (
    target: Extract<LinkMenuTarget, { kind: "file-candidates" }>,
    itemId: string,
  ) => {
    const candidateAction = parseCandidateMenuActionId(itemId);
    if (!candidateAction) {
      return;
    }

    const candidate = target.candidates[candidateAction.index];
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
      await deps.writeClipboardText(candidate.copyText);
      deps.setNotice(deps.t("terminal.filePaths.copySuccess"));
    }
  };

  const handleLinkMenuSelect = async (
    target: LinkMenuTarget,
    item: Extract<ContextMenuItem, { kind: "item" }>,
  ) => {
    try {
      if (target.kind === "url") {
        if (item.id === "open-link-in-browser") {
          await deps.openExternalUrl(target.url);
          return;
        }

        if (item.id === "copy-link") {
          await deps.writeClipboardText(target.url);
          deps.setNotice(deps.t("terminal.links.copySuccess"));
        }
        return;
      }

      if (target.kind === "file-candidates") {
        await handleCandidateMenuAction(target, item.id);
        return;
      }

      if (item.id === "open-file") {
        await openPathInEditor(target.path);
        return;
      }

      if (item.id === "open-in-internal-editor") {
        deps.openInternalEditorForLinkPath(target.path);
        return;
      }

      if (item.id === "open-in-other-editor") {
        await showEditorPicker(target.path);
        return;
      }

      if (item.id === "copy-path") {
        await deps.writeClipboardText(target.path.copyText);
        deps.setNotice(deps.t("terminal.filePaths.copySuccess"));
      }
    } catch (error) {
      deps.reportError("Failed to handle link menu action", error);
      deps.setNotice(
        target.kind === "url"
          ? deps.t("terminal.links.openFailed")
          : getFilePathNotice(deps.t, error, "terminal.filePaths.openFailed"),
      );
    }
  };

  return {
    openPathInEditor,
    buildCandidateFileLinkMenuItems: (raw: string, candidates: ResolvedTerminalPath[]) =>
      buildCandidateFileLinkMenuItems(raw, candidates, deps.t, deps.getWorkDir()),
    handleEditorSelect,
    handleLinkMenuSelect,
  };
}

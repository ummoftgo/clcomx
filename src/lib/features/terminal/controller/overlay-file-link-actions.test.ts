import { describe, expect, it, vi } from "vitest";
import type { DetectedEditor, ResolvedTerminalPath } from "../../../editors";
import type { ContextMenuItem } from "../../../ui/context-menu";
import {
  buildCandidateFileLinkMenuItems,
  createOverlayFileLinkActions,
  parseCandidateMenuActionId,
} from "./overlay-file-link-actions";

function createPath(overrides: Partial<ResolvedTerminalPath> = {}): ResolvedTerminalPath {
  return {
    raw: "src/App.svelte:12",
    wslPath: "/workspace/src/App.svelte",
    copyText: "/workspace/src/App.svelte:12",
    windowsPath: "C:\\workspace\\src\\App.svelte",
    line: 12,
    column: null,
    isDirectory: false,
    ...overrides,
  };
}

function createMenuItem(id: string): Extract<ContextMenuItem, { kind: "item" }> {
  return { id, kind: "item", label: id };
}

function createActions(options: {
  editors?: DetectedEditor[];
  fileOpenTarget?: "internal" | "external";
  fileOpenMode?: "default" | "picker";
  defaultEditorId?: string;
  editorsError?: string | null;
  openInEditorImpl?: (editorId: string, path: ResolvedTerminalPath) => Promise<void>;
} = {}) {
  const deps = {
    getWorkDir: () => "/workspace",
    getFileOpenTarget: () => options.fileOpenTarget ?? "external",
    getFileOpenMode: () => options.fileOpenMode ?? "default",
    getDefaultEditorId: () => options.defaultEditorId ?? "code",
    getEditorsError: () => options.editorsError ?? null,
    ensureEditorsLoaded: vi.fn(async () => options.editors ?? [{ id: "code", label: "VS Code" }]),
    openInEditor: vi.fn(options.openInEditorImpl ?? (async () => {})),
    openInternalEditorForLinkPath: vi.fn(),
    openExternalUrl: vi.fn(async () => {}),
    openEditorPicker: vi.fn(),
    writeClipboardText: vi.fn(async () => {}),
    setNotice: vi.fn(),
    reportError: vi.fn(),
    t: (key: string) => key,
  };

  return {
    actions: createOverlayFileLinkActions(deps),
    deps,
  };
}

describe("overlay-file-link-actions", () => {
  it("builds candidate menu ids and compact labels relative to the workdir", () => {
    const items = buildCandidateFileLinkMenuItems(
      "App.svelte",
      [
        createPath(),
        createPath({
          wslPath: "/other/project/routes.ts",
          copyText: "/other/project/routes.ts:4:2",
          line: 4,
          column: 2,
        }),
      ],
      (key) => key,
      "/workspace",
    );

    expect(items.map((item) => item.id)).toEqual([
      "candidate-list-title:App.svelte",
      "candidate-0-header",
      "candidate-0-open-file",
      "candidate-0-open-in-internal-editor",
      "candidate-0-open-in-other-editor",
      "candidate-0-copy-path",
      "candidate-1-separator",
      "candidate-1-header",
      "candidate-1-open-file",
      "candidate-1-open-in-internal-editor",
      "candidate-1-open-in-other-editor",
      "candidate-1-copy-path",
    ]);
    expect(items[1]).toMatchObject({ kind: "header", label: "src/App.svelte:12" });
    expect(items[7]).toMatchObject({ kind: "header", label: "routes.ts:4:2" });
    expect(parseCandidateMenuActionId("candidate-1-copy-path")).toEqual({
      index: 1,
      action: "copy-path",
    });
    expect(parseCandidateMenuActionId("candidate-x-copy-path")).toBeNull();
  });

  it("routes default file open to the internal editor when internal target is configured", async () => {
    const path = createPath();
    const { actions, deps } = createActions({ fileOpenTarget: "internal" });

    await actions.handleLinkMenuSelect({ kind: "file", path }, createMenuItem("open-file"));

    expect(deps.openInternalEditorForLinkPath).toHaveBeenCalledWith(path);
    expect(deps.ensureEditorsLoaded).not.toHaveBeenCalled();
    expect(deps.openInEditor).not.toHaveBeenCalled();
  });

  it("routes default file open to the configured external editor", async () => {
    const path = createPath();
    const { actions, deps } = createActions({
      editors: [{ id: "cursor", label: "Cursor" }],
      defaultEditorId: "cursor",
    });

    await actions.handleLinkMenuSelect({ kind: "file", path }, createMenuItem("open-file"));

    expect(deps.ensureEditorsLoaded).toHaveBeenCalledTimes(1);
    expect(deps.openInEditor).toHaveBeenCalledWith("cursor", path);
    expect(deps.openEditorPicker).not.toHaveBeenCalled();
  });

  it("opens the editor picker when picker mode is configured or default editor is missing", async () => {
    const path = createPath();
    const pickerMode = createActions({ fileOpenMode: "picker" });
    const missingDefault = createActions({
      editors: [{ id: "cursor", label: "Cursor" }],
      defaultEditorId: "code",
    });

    await pickerMode.actions.handleLinkMenuSelect(
      { kind: "file", path },
      createMenuItem("open-file"),
    );
    await missingDefault.actions.handleLinkMenuSelect(
      { kind: "file", path },
      createMenuItem("open-file"),
    );

    expect(pickerMode.deps.openEditorPicker).toHaveBeenCalledWith(path);
    expect(missingDefault.deps.openEditorPicker).toHaveBeenCalledWith(path);
  });

  it("routes candidate actions by index", async () => {
    const first = createPath();
    const second = createPath({ wslPath: "/workspace/src/routes.ts", copyText: "/workspace/src/routes.ts" });
    const { actions, deps } = createActions();
    const target = { kind: "file-candidates" as const, raw: "src", candidates: [first, second] };

    await actions.handleLinkMenuSelect(target, createMenuItem("candidate-1-open-in-internal-editor"));
    await actions.handleLinkMenuSelect(target, createMenuItem("candidate-1-open-in-other-editor"));
    await actions.handleLinkMenuSelect(target, createMenuItem("candidate-1-copy-path"));

    expect(deps.openInternalEditorForLinkPath).toHaveBeenCalledWith(second);
    expect(deps.openEditorPicker).toHaveBeenCalledWith(second);
    expect(deps.writeClipboardText).toHaveBeenCalledWith(second.copyText);
    expect(deps.setNotice).toHaveBeenCalledWith("terminal.filePaths.copySuccess");
  });

  it("routes URL menu actions", async () => {
    const { actions, deps } = createActions();
    const target = { kind: "url" as const, url: "https://example.test" };

    await actions.handleLinkMenuSelect(target, createMenuItem("open-link-in-browser"));
    await actions.handleLinkMenuSelect(target, createMenuItem("copy-link"));

    expect(deps.openExternalUrl).toHaveBeenCalledWith("https://example.test");
    expect(deps.writeClipboardText).toHaveBeenCalledWith("https://example.test");
    expect(deps.setNotice).toHaveBeenCalledWith("terminal.links.copySuccess");
  });

  it("keeps the picker open and surfaces a notice when selected editor launch fails", async () => {
    const path = createPath();
    const { actions, deps } = createActions({
      openInEditorImpl: async () => {
        throw new Error("path does not exist");
      },
    });

    const opened = await actions.handleEditorSelect({ id: "code", label: "VS Code" }, path);

    expect(opened).toBe(false);
    expect(deps.reportError).toHaveBeenCalled();
    expect(deps.setNotice).toHaveBeenCalledWith("terminal.filePaths.pathNotFound");
  });
});

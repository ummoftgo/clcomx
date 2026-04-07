import { describe, expect, it, vi } from "vitest";
import { createEditorFacade } from "./editor-facade";
import { createEditorQuickOpenState } from "../state/editor-quick-open-state.svelte";
import { createEditorRuntimeState } from "../state/editor-runtime-state.svelte";

function createFacade(options?: {
  sessionSnapshot?: {
    viewMode: "terminal" | "editor";
    editorRootDir: string;
    openEditorTabs: { wslPath: string; line?: number | null; column?: number | null }[];
    activeEditorPath: string | null;
  } | null;
}) {
  const runtimeState = createEditorRuntimeState();
  const quickOpenState = createEditorQuickOpenState();
  let viewMode: "terminal" | "editor" = "editor";
  let rootDir = "/workspace";
  const syncSessionState = vi.fn();
  const prepareForEditorMode = vi.fn();
  const prepareForEditorPathOpen = vi.fn();
  const readSessionFile = vi.fn(async (_sessionId: string, wslPath: string) => ({
    wslPath,
    content: "alpha",
    languageId: "typescript",
    sizeBytes: 5,
    mtimeMs: 12,
  }));

  const facade = createEditorFacade({
    runtimeState,
    quickOpenState,
    getSessionId: () => "session-1",
    getSessionSnapshot: () => options?.sessionSnapshot ?? null,
    getWorkDir: () => "/workspace",
    getViewMode: () => viewMode,
    setViewMode: (nextViewMode) => {
      viewMode = nextViewMode;
    },
    getRootDir: () => rootDir,
    setRootDir: (nextRootDir) => {
      rootDir = nextRootDir;
    },
    syncSessionState,
    prepareForEditorMode,
    prepareForEditorPathOpen,
    getLoadingStatusLabel: () => "Loading",
    getSaveStatusLabel: () => "Save",
    readSessionFile,
    writeSessionFile: vi.fn(async () => ({
      wslPath: "/workspace/a.ts",
      mtimeMs: 22,
      sizeBytes: 5,
    })),
    getVisible: () => true,
    getTerminalReady: () => true,
    getTerminalStartupSettled: () => true,
    getThemeDefinition: () => null,
    warmMonacoRuntime: vi.fn(async () => {}),
    listSessionFiles: vi.fn(async () => ({
      rootDir,
      results: [],
      lastUpdatedMs: 1,
    })),
    reportForegroundError: vi.fn(),
  });

  return {
    facade,
    runtimeState,
    quickOpenState,
    readSessionFile,
    syncSessionState,
    prepareForEditorMode,
    prepareForEditorPathOpen,
    getViewMode: () => viewMode,
    getRootDir: () => rootDir,
  };
}

describe("editor-facade", () => {
  it("switches back to terminal mode through a single session-state sync", () => {
    const { facade, runtimeState, quickOpenState, syncSessionState, getViewMode } = createFacade();
    runtimeState.closeConfirmVisible = true;
    runtimeState.closeConfirmPath = "/workspace/a.ts";
    quickOpenState.visible = true;

    facade.switchToTerminalView();

    expect(getViewMode()).toBe("terminal");
    expect(quickOpenState.visible).toBe(false);
    expect(runtimeState.closeConfirmVisible).toBe(false);
    expect(runtimeState.closeConfirmPath).toBeNull();
    expect(syncSessionState).toHaveBeenCalledWith("session-1", {
      viewMode: "terminal",
      editorRootDir: "/workspace",
      openEditorTabs: [],
      activeEditorPath: null,
      dirtyPaths: [],
    });
  });

  it("hydrates runtime state from the current session snapshot", async () => {
    const { facade, runtimeState, readSessionFile, syncSessionState, getViewMode, getRootDir } =
      createFacade({
        sessionSnapshot: {
          viewMode: "editor",
          editorRootDir: "/workspace/src",
          openEditorTabs: [{ wslPath: "/workspace/src/a.ts" }],
          activeEditorPath: "/workspace/src/a.ts",
        },
      });

    await facade.ensureRuntimeReady();

    expect(getViewMode()).toBe("editor");
    expect(getRootDir()).toBe("/workspace/src");
    expect(readSessionFile).toHaveBeenCalledWith("session-1", "/workspace/src/a.ts");
    expect(runtimeState.tabs).toMatchObject([
      {
        wslPath: "/workspace/src/a.ts",
        content: "alpha",
        languageId: "typescript",
        dirty: false,
        loading: false,
        saving: false,
        error: null,
      },
    ]);
    expect(runtimeState.activePath).toBe("/workspace/src/a.ts");
    expect(syncSessionState).toHaveBeenLastCalledWith("session-1", {
      viewMode: "editor",
      editorRootDir: "/workspace/src",
      openEditorTabs: [{ wslPath: "/workspace/src/a.ts", line: null, column: null }],
      activeEditorPath: "/workspace/src/a.ts",
      dirtyPaths: [],
    });
  });

  it("keeps editor-mode path opens from requesting a full editor-mode transition", async () => {
    const { facade, prepareForEditorMode, prepareForEditorPathOpen, readSessionFile } =
      createFacade();

    await facade.openPath({
      wslPath: "/workspace/a.ts",
      relativePath: "a.ts",
      basename: "a.ts",
    });

    expect(prepareForEditorPathOpen).toHaveBeenCalled();
    expect(prepareForEditorMode).not.toHaveBeenCalled();
    expect(readSessionFile).toHaveBeenCalledWith("session-1", "/workspace/a.ts");
  });
});

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
  readSessionFileImpl?: (sessionId: string, wslPath: string) => Promise<{
    wslPath: string;
    content: string;
    languageId: string;
    sizeBytes: number;
    mtimeMs: number;
  }>;
}) {
  const runtimeState = createEditorRuntimeState();
  const quickOpenState = createEditorQuickOpenState();
  let sessionSnapshot = options?.sessionSnapshot ?? null;
  let viewMode: "terminal" | "editor" = "editor";
  let rootDir = "/workspace";
  const syncSessionState = vi.fn();
  const prepareForEditorMode = vi.fn();
  const prepareForEditorPathOpen = vi.fn();
  const readSessionFile = vi.fn(
    options?.readSessionFileImpl
      ?? (async (_sessionId: string, wslPath: string) => ({
        wslPath,
        content: "alpha",
        languageId: "typescript",
        sizeBytes: 5,
        mtimeMs: 12,
      })),
  );

  const facade = createEditorFacade({
    runtimeState,
    quickOpenState,
    getSessionId: () => "session-1",
    getSessionSnapshot: () => sessionSnapshot,
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
    setSessionSnapshot: (
      nextSessionSnapshot: {
        viewMode: "terminal" | "editor";
        editorRootDir: string;
        openEditorTabs: { wslPath: string; line?: number | null; column?: number | null }[];
        activeEditorPath: string | null;
      } | null,
    ) => {
      sessionSnapshot = nextSessionSnapshot;
    },
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

  it("rehydrates when the mounted session receives a new external snapshot", async () => {
    const { facade, runtimeState, getViewMode, getRootDir, readSessionFile, setSessionSnapshot } =
      createFacade({
        sessionSnapshot: {
          viewMode: "editor",
          editorRootDir: "/workspace/src",
          openEditorTabs: [{ wslPath: "/workspace/src/a.ts" }],
          activeEditorPath: "/workspace/src/a.ts",
        },
      });

    await facade.ensureRuntimeReady();

    setSessionSnapshot({
      viewMode: "terminal",
      editorRootDir: "/workspace/next",
      openEditorTabs: [],
      activeEditorPath: null,
    });

    await facade.ensureRuntimeReady();

    expect(getViewMode()).toBe("terminal");
    expect(getRootDir()).toBe("/workspace/next");
    expect(runtimeState.tabs).toEqual([]);
    expect(runtimeState.activePath).toBeNull();
    expect(readSessionFile).toHaveBeenCalledTimes(1);
  });

  it("does not rehydrate when the external snapshot only reflects the current runtime state", async () => {
    const { facade, readSessionFile, syncSessionState, setSessionSnapshot } = createFacade({
      sessionSnapshot: {
        viewMode: "terminal",
        editorRootDir: "/workspace",
        openEditorTabs: [],
        activeEditorPath: null,
      },
    });

    await facade.ensureRuntimeReady();
    await facade.openPath({
      wslPath: "/workspace/a.ts",
      relativePath: "a.ts",
      basename: "a.ts",
    });

    const latestSessionState = syncSessionState.mock.calls[syncSessionState.mock.calls.length - 1]?.[1];
    expect(latestSessionState).toBeTruthy();

    setSessionSnapshot({
      viewMode: latestSessionState.viewMode,
      editorRootDir: latestSessionState.editorRootDir,
      openEditorTabs: latestSessionState.openEditorTabs,
      activeEditorPath: latestSessionState.activeEditorPath,
    });

    await facade.ensureRuntimeReady();

    expect(readSessionFile).toHaveBeenCalledTimes(1);
  });

  it("cancels an in-flight hydrate when the same session snapshot clears all open tabs", async () => {
    type ReadSessionFileResponse = {
      wslPath: string;
      content: string;
      languageId: string;
      sizeBytes: number;
      mtimeMs: number;
    };
    let resolveRead!: (value: ReadSessionFileResponse) => void;
    const { facade, runtimeState, setSessionSnapshot } = createFacade({
      sessionSnapshot: {
        viewMode: "editor",
        editorRootDir: "/workspace/src",
        openEditorTabs: [{ wslPath: "/workspace/src/a.ts" }],
        activeEditorPath: "/workspace/src/a.ts",
      },
      readSessionFileImpl: async (_sessionId, _wslPath) =>
        await new Promise<ReadSessionFileResponse>((resolve) => {
          resolveRead = resolve;
        }),
    });

    const firstHydration = facade.ensureRuntimeReady();

    setSessionSnapshot({
      viewMode: "terminal",
      editorRootDir: "/workspace",
      openEditorTabs: [],
      activeEditorPath: null,
    });

    await facade.ensureRuntimeReady();
    resolveRead({
      wslPath: "/workspace/src/a.ts",
      content: "alpha",
      languageId: "typescript",
      sizeBytes: 5,
      mtimeMs: 12,
    });
    await firstHydration;

    expect(runtimeState.tabs).toEqual([]);
    expect(runtimeState.activePath).toBeNull();
  });

  it("routes directory opens through the editor directory flow without reading a file", async () => {
    const { facade, quickOpenState, readSessionFile, getRootDir } = createFacade();

    await facade.openPath({
      raw: "src",
      wslPath: "/workspace/src",
      copyText: "/workspace/src",
      windowsPath: "C:\\workspace\\src",
      line: null,
      column: null,
      isDirectory: true,
    });

    expect(getRootDir()).toBe("/workspace/src");
    expect(quickOpenState.visible).toBe(true);
    expect(readSessionFile).not.toHaveBeenCalled();
  });

  it("prefers prefetched file content when opening a new path through the facade", async () => {
    const { facade, runtimeState, readSessionFile } = createFacade();

    await facade.openPath(
      {
        wslPath: "/workspace/prefetched.ts",
        relativePath: "prefetched.ts",
        basename: "prefetched.ts",
      },
      {
        prefetchedFile: {
          wslPath: "/workspace/prefetched.ts",
          content: "prefetched",
          languageId: "typescript",
        },
      },
    );

    expect(readSessionFile).not.toHaveBeenCalled();
    expect(runtimeState.tabs).toMatchObject([
      {
        wslPath: "/workspace/prefetched.ts",
        content: "prefetched",
        languageId: "typescript",
        loading: false,
        error: null,
      },
    ]);
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

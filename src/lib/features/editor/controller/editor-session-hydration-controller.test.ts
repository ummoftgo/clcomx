import { describe, expect, it, vi } from "vitest";
import { createEditorQuickOpenState } from "../state/editor-quick-open-state.svelte";
import { createEditorRuntimeState } from "../state/editor-runtime-state.svelte";
import { createEditorSessionHydrationController } from "./editor-session-hydration-controller";

function createController(options?: {
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
  const setTabs = vi.fn((tabs) => {
    runtimeState.tabs = tabs;
    syncSessionState("session-1", {
      viewMode,
      editorRootDir: rootDir,
      openEditorTabs: tabs.map((tab: { wslPath: string; line?: number | null; column?: number | null }) => ({
        wslPath: tab.wslPath,
        line: tab.line ?? null,
        column: tab.column ?? null,
      })),
      activeEditorPath: runtimeState.activePath,
      dirtyPaths: [],
    });
  });

  const controller = createEditorSessionHydrationController({
    runtimeState,
    quickOpenState,
    getSessionId: () => "session-1",
    getSessionSnapshot: () => sessionSnapshot,
    getWorkDir: () => "/workspace",
    setViewMode: (nextViewMode) => {
      viewMode = nextViewMode;
    },
    setRootDir: (nextRootDir) => {
      rootDir = nextRootDir;
    },
    readSessionFile,
    setTabs,
    syncSessionState: () => {
      syncSessionState("session-1", {
        viewMode,
        editorRootDir: rootDir,
        openEditorTabs: runtimeState.tabs.map((tab) => ({
          wslPath: tab.wslPath,
          line: tab.line ?? null,
          column: tab.column ?? null,
        })),
        activeEditorPath: runtimeState.activePath,
        dirtyPaths: [],
      });
    },
  });

  syncSessionState.mockImplementation((sessionId, sessionState) => {
    controller.markSessionStateSynced(sessionId, sessionState);
  });

  return {
    controller,
    runtimeState,
    quickOpenState,
    readSessionFile,
    syncSessionState,
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

describe("editor-session-hydration-controller", () => {
  it("hydrates runtime state from the current session snapshot", async () => {
    const { controller, runtimeState, quickOpenState, readSessionFile, syncSessionState, getViewMode, getRootDir } =
      createController({
        sessionSnapshot: {
          viewMode: "editor",
          editorRootDir: "/workspace/src",
          openEditorTabs: [{ wslPath: "/workspace/src/a.ts" }],
          activeEditorPath: "/workspace/src/a.ts",
        },
      });

    await controller.ensureRuntimeReady();

    expect(getViewMode()).toBe("editor");
    expect(getRootDir()).toBe("/workspace/src");
    expect(quickOpenState.rootDir).toBe("/workspace/src");
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
    const { controller, runtimeState, getViewMode, getRootDir, readSessionFile, setSessionSnapshot } =
      createController({
        sessionSnapshot: {
          viewMode: "editor",
          editorRootDir: "/workspace/src",
          openEditorTabs: [{ wslPath: "/workspace/src/a.ts" }],
          activeEditorPath: "/workspace/src/a.ts",
        },
      });

    await controller.ensureRuntimeReady();

    setSessionSnapshot({
      viewMode: "terminal",
      editorRootDir: "/workspace/next",
      openEditorTabs: [],
      activeEditorPath: null,
    });

    await controller.ensureRuntimeReady();

    expect(getViewMode()).toBe("terminal");
    expect(getRootDir()).toBe("/workspace/next");
    expect(runtimeState.tabs).toEqual([]);
    expect(runtimeState.activePath).toBeNull();
    expect(readSessionFile).toHaveBeenCalledTimes(1);
  });

  it("does not rehydrate when the external snapshot only reflects the current runtime state", async () => {
    const { controller, readSessionFile, syncSessionState, setSessionSnapshot } = createController({
      sessionSnapshot: {
        viewMode: "terminal",
        editorRootDir: "/workspace",
        openEditorTabs: [],
        activeEditorPath: null,
      },
    });

    await controller.ensureRuntimeReady();
    const latestSessionState = syncSessionState.mock.calls[syncSessionState.mock.calls.length - 1]?.[1];
    expect(latestSessionState).toBeTruthy();

    setSessionSnapshot({
      viewMode: latestSessionState.viewMode,
      editorRootDir: latestSessionState.editorRootDir,
      openEditorTabs: latestSessionState.openEditorTabs,
      activeEditorPath: latestSessionState.activeEditorPath,
    });

    await controller.ensureRuntimeReady();

    expect(readSessionFile).toHaveBeenCalledTimes(0);
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
    const { controller, runtimeState, setSessionSnapshot } = createController({
      sessionSnapshot: {
        viewMode: "editor",
        editorRootDir: "/workspace/src",
        openEditorTabs: [{ wslPath: "/workspace/src/a.ts" }],
        activeEditorPath: "/workspace/src/a.ts",
      },
      readSessionFileImpl: async () =>
        await new Promise<ReadSessionFileResponse>((resolve) => {
          resolveRead = resolve;
        }),
    });

    const firstHydration = controller.ensureRuntimeReady();

    setSessionSnapshot({
      viewMode: "terminal",
      editorRootDir: "/workspace",
      openEditorTabs: [],
      activeEditorPath: null,
    });

    await controller.ensureRuntimeReady();
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
});

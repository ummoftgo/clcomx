import { describe, expect, it, vi } from "vitest";
import { createEditorQuickOpenController } from "./editor-quick-open-controller";
import { createEditorQuickOpenState } from "../state/editor-quick-open-state.svelte";

describe("editor-quick-open-controller", () => {
  function createController() {
    const state = createEditorQuickOpenState();
    const listSessionFiles = vi.fn();
    const reportForegroundError = vi.fn();
    const controller = createEditorQuickOpenController(state, {
      getSessionId: () => "session-1",
      getWorkDir: () => "/workspace",
      getEditorRootDir: () => "/workspace",
      getVisible: () => true,
      getTerminalReady: () => true,
      getTerminalStartupSettled: () => true,
      getThemeDefinition: () => null,
      warmMonacoRuntime: vi.fn(async () => undefined),
      listSessionFiles,
      reportForegroundError,
    });

    return { state, controller, listSessionFiles, reportForegroundError };
  }

  it("opens quick-open and clears stale entries when the root changes", () => {
    const { state, controller } = createController();
    state.rootDir = "/workspace/old";
    state.entries = [
      { wslPath: "/workspace/old/a.ts", relativePath: "a.ts", basename: "a.ts" },
    ];
    state.lastUpdatedMs = Date.now();

    controller.openQuickOpen("/workspace/new", "abc");

    expect(state.rootDir).toBe("/workspace/new");
    expect(state.query).toBe("abc");
    expect(state.visible).toBe(true);
    expect(state.openKey).toBe(1);
    expect(state.entries).toEqual([]);
  });

  it("refreshes entries and ignores stale request completions", async () => {
    const { state, controller, listSessionFiles } = createController();
    let firstResolve!: (value: {
      rootDir: string;
      results: { wslPath: string; relativePath: string; basename: string }[];
      lastUpdatedMs: number;
    }) => void;
    listSessionFiles.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          firstResolve = resolve;
        }),
    );
    listSessionFiles.mockResolvedValueOnce({
      rootDir: "/workspace",
      results: [{ wslPath: "/workspace/b.ts", relativePath: "b.ts", basename: "b.ts" }],
      lastUpdatedMs: 22,
    });

    const first = controller.refreshEntries(false, "/workspace");
    const second = controller.refreshEntries(false, "/workspace");

    firstResolve({
      rootDir: "/workspace",
      results: [{ wslPath: "/workspace/a.ts", relativePath: "a.ts", basename: "a.ts" }],
      lastUpdatedMs: 11,
    });

    await Promise.all([first, second]);

    expect(state.entries).toEqual([
      { wslPath: "/workspace/b.ts", relativePath: "b.ts", basename: "b.ts" },
    ]);
    expect(state.lastUpdatedMs).toBe(22);
  });

  it("reuses cached entries for workspace file listing and refreshes in background when stale", async () => {
    const { state, controller, listSessionFiles } = createController();
    state.rootDir = "/workspace";
    state.entries = [{ wslPath: "/workspace/a.ts", relativePath: "a.ts", basename: "a.ts" }];
    state.lastUpdatedMs = 1;
    vi.spyOn(Date, "now").mockReturnValue(31_500);
    listSessionFiles.mockResolvedValue({
      rootDir: "/workspace",
      results: [{ wslPath: "/workspace/b.ts", relativePath: "b.ts", basename: "b.ts" }],
      lastUpdatedMs: 99,
    });

    const result = await controller.listWorkspaceFiles("/workspace");

    expect(result).toEqual([
      { wslPath: "/workspace/a.ts", relativePath: "a.ts", basename: "a.ts" },
    ]);
    expect(listSessionFiles).toHaveBeenCalledTimes(1);
    vi.restoreAllMocks();
  });

  it("upserts quick-open entries relative to the active root", () => {
    const { state, controller } = createController();
    state.rootDir = "/workspace";
    controller.upsertEntry("/workspace/src/a.ts");
    controller.upsertEntry("/workspace/src/a.ts");

    expect(state.entries).toEqual([
      { wslPath: "/workspace/src/a.ts", relativePath: "src/a.ts", basename: "a.ts" },
    ]);
  });
});

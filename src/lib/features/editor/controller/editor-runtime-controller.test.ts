import { describe, expect, it, vi } from "vitest";
import { createEditorRuntimeController } from "./editor-runtime-controller";
import { createEditorRuntimeState } from "../state/editor-runtime-state.svelte";

function createDeps() {
  return {
    getSessionId: () => "session-1",
    getViewMode: () => "editor" as const,
    getRootDir: () => "/workspace",
    syncSessionState: vi.fn(),
  };
}

describe("editor-runtime-controller", () => {
  it("syncs tab state back into the session snapshot shape", () => {
    const state = createEditorRuntimeState();
    state.activePath = "/workspace/a.ts";
    const deps = createDeps();
    const controller = createEditorRuntimeController(state, deps);

    controller.setTabs([
      {
        wslPath: "/workspace/a.ts",
        content: "alpha",
        languageId: "typescript",
        dirty: true,
      },
      {
        wslPath: "/workspace/b.ts",
        content: "beta",
        languageId: "typescript",
        dirty: false,
        line: 5,
        column: 2,
      },
    ]);

    expect(deps.syncSessionState).toHaveBeenCalledWith("session-1", {
      viewMode: "editor",
      editorRootDir: "/workspace",
      openEditorTabs: [
        { wslPath: "/workspace/a.ts", line: null, column: null },
        { wslPath: "/workspace/b.ts", line: 5, column: 2 },
      ],
      activeEditorPath: "/workspace/a.ts",
      dirtyPaths: ["/workspace/a.ts"],
    });
  });

  it("removes tabs and clears cached file snapshots", () => {
    const state = createEditorRuntimeState();
    state.tabs = [
      {
        wslPath: "/workspace/a.ts",
        content: "alpha",
        languageId: "typescript",
        dirty: false,
      },
      {
        wslPath: "/workspace/b.ts",
        content: "beta",
        languageId: "typescript",
        dirty: true,
      },
    ];
    state.activePath = "/workspace/b.ts";
    state.savedContentByPath = {
      "/workspace/a.ts": "alpha",
      "/workspace/b.ts": "beta",
    };
    state.mtimeByPath = {
      "/workspace/a.ts": 1,
      "/workspace/b.ts": 2,
    };
    const controller = createEditorRuntimeController(state, createDeps());

    const removed = controller.removeTab("/workspace/b.ts");

    expect(removed).toBe(true);
    expect(state.tabs.map((tab) => tab.wslPath)).toEqual(["/workspace/a.ts"]);
    expect(state.activePath).toBe("/workspace/a.ts");
    expect(state.savedContentByPath["/workspace/b.ts"]).toBeUndefined();
    expect(state.mtimeByPath["/workspace/b.ts"]).toBeUndefined();
  });

  it("marks a loaded tab as clean and updates cached content/mtime", () => {
    const state = createEditorRuntimeState();
    state.tabs = [
      {
        wslPath: "/workspace/a.ts",
        content: "",
        languageId: "plaintext",
        dirty: true,
        loading: true,
        saving: true,
        error: "stale",
      },
    ];
    const controller = createEditorRuntimeController(state, createDeps());

    controller.setTabLoaded("/workspace/a.ts", {
      content: "console.log('ok')",
      languageId: "typescript",
      mtimeMs: 42,
      line: 7,
      column: 3,
    });

    expect(state.savedContentByPath["/workspace/a.ts"]).toBe("console.log('ok')");
    expect(state.mtimeByPath["/workspace/a.ts"]).toBe(42);
    expect(state.tabs[0]).toMatchObject({
      wslPath: "/workspace/a.ts",
      content: "console.log('ok')",
      languageId: "typescript",
      dirty: false,
      loading: false,
      saving: false,
      error: null,
      line: 7,
      column: 3,
    });
  });

  it("opens the dirty-close confirm flow before forcing removal", () => {
    const state = createEditorRuntimeState();
    state.tabs = [
      {
        wslPath: "/workspace/a.ts",
        content: "alpha",
        languageId: "typescript",
        dirty: true,
      },
    ];
    state.activePath = "/workspace/a.ts";
    const controller = createEditorRuntimeController(state, createDeps());

    controller.requestCloseTab("/workspace/a.ts");
    expect(state.closeConfirmVisible).toBe(true);
    expect(state.closeConfirmPath).toBe("/workspace/a.ts");

    controller.confirmCloseTab();
    expect(state.closeConfirmVisible).toBe(false);
    expect(state.closeConfirmPath).toBeNull();
    expect(state.tabs).toEqual([]);
  });
});

import { describe, expect, it, vi } from "vitest";
import { createEditorRuntimeState } from "../state/editor-runtime-state.svelte";
import { createEditorOpenStateController } from "./editor-open-state-controller";

describe("editor-open-state-controller", () => {
  function createController() {
    const state = createEditorRuntimeState();
    let editorRootDir = "/workspace";
    const deps = {
      setEditorRootDir: vi.fn((rootDir: string) => {
        editorRootDir = rootDir;
      }),
      syncSessionState: vi.fn(),
    };
    const controller = createEditorOpenStateController(state, deps);

    return {
      state,
      deps,
      controller,
      getEditorRootDir: () => editorRootDir,
    };
  }

  it("reuses existing tabs and updates navigation coordinates", () => {
    const { state, deps, controller, getEditorRootDir } = createController();
    state.tabs = [
      {
        wslPath: "/workspace/a.ts",
        content: "alpha",
        languageId: "typescript",
        dirty: false,
        line: 1,
        column: 2,
        loading: false,
        error: "stale",
      },
    ];

    const result = controller.prepareOpenPath({
      wslPath: "/workspace/a.ts",
      line: 7,
      column: 3,
      rootDir: "/workspace/src",
    });

    expect(result).toEqual({ kind: "existing", wasLoading: false });
    expect(state.activePath).toBe("/workspace/a.ts");
    expect(state.tabs[0]).toMatchObject({
      line: 7,
      column: 3,
      error: null,
    });
    expect(getEditorRootDir()).toBe("/workspace/src");
    expect(deps.syncSessionState).toHaveBeenCalled();
  });

  it("adds a loading placeholder for new tabs and syncs state", () => {
    const { state, deps, controller, getEditorRootDir } = createController();

    const result = controller.prepareOpenPath({
      wslPath: "/workspace/b.ts",
      line: 5,
      column: 1,
      rootDir: "/workspace/src",
    });

    expect(result).toEqual({ kind: "new" });
    expect(state.activePath).toBe("/workspace/b.ts");
    expect(state.tabs).toEqual([
      {
        wslPath: "/workspace/b.ts",
        content: "",
        languageId: "plaintext",
        dirty: false,
        line: 5,
        column: 1,
        loading: true,
        saving: false,
        error: null,
      },
    ]);
    expect(getEditorRootDir()).toBe("/workspace/src");
    expect(deps.syncSessionState).toHaveBeenCalled();
  });

  it("preserves the current root when opening a new tab without an explicit root", () => {
    const { controller, getEditorRootDir } = createController();

    controller.prepareOpenPath({
      wslPath: "/workspace/c.ts",
      line: null,
      column: null,
    });

    expect(getEditorRootDir()).toBe("/workspace");
  });
});

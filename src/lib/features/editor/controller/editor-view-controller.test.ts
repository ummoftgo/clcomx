import { describe, expect, it, vi } from "vitest";
import { createEditorRuntimeState } from "../state/editor-runtime-state.svelte";
import { createEditorViewController } from "./editor-view-controller";

describe("editor-view-controller", () => {
  function createController() {
    const state = createEditorRuntimeState();
    let editorRootDir = "";
    let editorViewMode: "terminal" | "editor" = "terminal";
    const deps = {
      getWorkDir: () => "/workspace",
      getEditorRootDir: () => editorRootDir,
      getQuickOpenVisible: () => false,
      setEditorRootDir: vi.fn((rootDir: string) => {
        editorRootDir = rootDir;
      }),
      setEditorViewMode: vi.fn((viewMode: "terminal" | "editor") => {
        editorViewMode = viewMode;
      }),
      ensureEditorViewMode: vi.fn(() => {
        editorViewMode = "editor";
      }),
      primeMonacoRuntime: vi.fn(),
      primeWorkspaceFiles: vi.fn(),
      openQuickOpen: vi.fn(),
      syncSessionState: vi.fn(),
    };
    const controller = createEditorViewController(state, deps);

    return {
      state,
      deps,
      controller,
      getEditorRootDir: () => editorRootDir,
      getEditorViewMode: () => editorViewMode,
    };
  }

  it("opens editor directories by syncing root and launching quick open", () => {
    const { controller, deps, getEditorRootDir } = createController();

    controller.openDirectory("/workspace/src");

    expect(getEditorRootDir()).toBe("/workspace/src");
    expect(deps.syncSessionState).toHaveBeenCalled();
    expect(deps.primeMonacoRuntime).toHaveBeenCalled();
    expect(deps.primeWorkspaceFiles).toHaveBeenCalledWith("/workspace/src");
    expect(deps.openQuickOpen).toHaveBeenCalledWith("/workspace/src", "");
  });

  it("switches to editor mode, primes editor services, and opens quick open when no tabs exist", () => {
    const { controller, deps, state, getEditorViewMode } = createController();
    state.statusText = "old";

    controller.requestSwitchToEditorMode();

    expect(deps.ensureEditorViewMode).toHaveBeenCalled();
    expect(deps.primeMonacoRuntime).toHaveBeenCalled();
    expect(deps.primeWorkspaceFiles).toHaveBeenCalledWith("/workspace");
    expect(state.statusText).toBeNull();
    expect(deps.openQuickOpen).toHaveBeenCalledWith("");
    expect(getEditorViewMode()).toBe("editor");
  });

  it("does not reopen quick open when it is already visible or tabs exist", () => {
    const state = createEditorRuntimeState();
    state.tabs = [
      {
        wslPath: "/workspace/a.ts",
        content: "alpha",
        languageId: "typescript",
        dirty: false,
      },
    ];
    const openQuickOpen = vi.fn();
    const controller = createEditorViewController(state, {
      getWorkDir: () => "/workspace",
      getEditorRootDir: () => "/workspace",
      getQuickOpenVisible: () => true,
      setEditorRootDir: vi.fn(),
      setEditorViewMode: vi.fn(),
      ensureEditorViewMode: vi.fn(),
      primeMonacoRuntime: vi.fn(),
      primeWorkspaceFiles: vi.fn(),
      openQuickOpen,
      syncSessionState: vi.fn(),
    });

    controller.requestSwitchToEditorMode();

    expect(openQuickOpen).not.toHaveBeenCalled();
  });

  it("syncs active path changes back into the session state shape", () => {
    const { controller, deps, state, getEditorViewMode } = createController();

    controller.handleActivePathChange("/workspace/a.ts");

    expect(state.activePath).toBe("/workspace/a.ts");
    expect(deps.setEditorViewMode).toHaveBeenCalledWith("editor");
    expect(deps.syncSessionState).toHaveBeenCalled();
    expect(getEditorViewMode()).toBe("editor");
  });
});

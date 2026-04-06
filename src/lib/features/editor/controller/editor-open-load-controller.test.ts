import { describe, expect, it, vi } from "vitest";
import { createEditorRuntimeState } from "../state/editor-runtime-state.svelte";
import { createEditorOpenLoadController } from "./editor-open-load-controller";

describe("editor-open-load-controller", () => {
  function createController() {
    const state = createEditorRuntimeState();
    const deps = {
      getSessionId: () => "session-1",
      getLoadingStatusLabel: () => "Loading",
      readSessionFile: vi.fn(),
      setStatus: vi.fn((message: string | null) => {
        state.statusText = message;
      }),
      setTabLoaded: vi.fn(),
      setTabError: vi.fn(),
      closeQuickOpen: vi.fn(),
      syncSessionState: vi.fn(),
    };
    const controller = createEditorOpenLoadController(state, deps);

    return { state, deps, controller };
  }

  it("loads a prepared tab from prefetched content and applies the loaded state", async () => {
    const { state, deps, controller } = createController();
    state.tabs = [
      {
        wslPath: "/workspace/a.ts",
        content: "",
        languageId: "plaintext",
        dirty: false,
        loading: true,
        saving: false,
        error: null,
      },
    ];

    await controller.loadPreparedOpenPath({
      wslPath: "/workspace/a.ts",
      line: 7,
      column: 3,
      prefetchedFile: {
        wslPath: "/workspace/a.ts",
        content: "alpha",
        languageId: "typescript",
      },
    });

    expect(deps.readSessionFile).not.toHaveBeenCalled();
    expect(deps.setTabLoaded).toHaveBeenCalledWith("/workspace/a.ts", {
      content: "alpha",
      languageId: "typescript",
      mtimeMs: 0,
      line: 7,
      column: 3,
    });
    expect(deps.closeQuickOpen).toHaveBeenCalled();
    expect(deps.syncSessionState).toHaveBeenCalled();
    expect(state.statusText).toBeNull();
  });

  it("reads session files when no prefetched snapshot matches", async () => {
    const { state, deps, controller } = createController();
    state.tabs = [
      {
        wslPath: "/workspace/b.ts",
        content: "",
        languageId: "plaintext",
        dirty: false,
        loading: true,
        saving: false,
        error: null,
      },
    ];
    deps.readSessionFile.mockResolvedValue({
      wslPath: "/workspace/b.ts",
      content: "beta",
      languageId: "typescript",
      sizeBytes: 4,
      mtimeMs: 21,
    });

    await controller.loadPreparedOpenPath({
      wslPath: "/workspace/b.ts",
      line: null,
      column: null,
    });

    expect(deps.readSessionFile).toHaveBeenCalledWith("session-1", "/workspace/b.ts");
    expect(deps.setTabLoaded).toHaveBeenCalledWith("/workspace/b.ts", {
      content: "beta",
      languageId: "typescript",
      mtimeMs: 21,
      line: null,
      column: null,
    });
  });

  it("returns early without syncing when the prepared tab disappears before the read resolves", async () => {
    const { state, deps, controller } = createController();
    state.tabs = [
      {
        wslPath: "/workspace/c.ts",
        content: "",
        languageId: "plaintext",
        dirty: false,
        loading: true,
        saving: false,
        error: null,
      },
    ];
    deps.readSessionFile.mockImplementation(async () => {
      state.tabs = [];
      return {
        wslPath: "/workspace/c.ts",
        content: "gamma",
        languageId: "typescript",
        sizeBytes: 5,
        mtimeMs: 9,
      };
    });

    await controller.loadPreparedOpenPath({
      wslPath: "/workspace/c.ts",
      line: null,
      column: null,
    });

    expect(deps.setTabLoaded).not.toHaveBeenCalled();
    expect(deps.setTabError).not.toHaveBeenCalled();
    expect(deps.syncSessionState).not.toHaveBeenCalled();
    expect(state.statusText).toBeNull();
  });

  it("clears loading status when the prepared tab disappears before a load failure resolves", async () => {
    const { state, deps, controller } = createController();
    state.tabs = [
      {
        wslPath: "/workspace/e.ts",
        content: "",
        languageId: "plaintext",
        dirty: false,
        loading: true,
        saving: false,
        error: null,
      },
    ];
    deps.readSessionFile.mockImplementation(async () => {
      state.tabs = [];
      throw new Error("missing");
    });

    await controller.loadPreparedOpenPath({
      wslPath: "/workspace/e.ts",
      line: null,
      column: null,
    });

    expect(deps.setTabLoaded).not.toHaveBeenCalled();
    expect(deps.setTabError).not.toHaveBeenCalled();
    expect(deps.syncSessionState).not.toHaveBeenCalled();
    expect(state.statusText).toBeNull();
  });

  it("applies error state and syncs when the file load fails", async () => {
    const { state, deps, controller } = createController();
    state.tabs = [
      {
        wslPath: "/workspace/d.ts",
        content: "",
        languageId: "plaintext",
        dirty: false,
        loading: true,
        saving: false,
        error: null,
      },
    ];
    deps.readSessionFile.mockRejectedValue(new Error("missing"));

    await controller.loadPreparedOpenPath({
      wslPath: "/workspace/d.ts",
      line: 1,
      column: 2,
    });

    expect(deps.setTabError).toHaveBeenCalledWith("/workspace/d.ts", "missing");
    expect(deps.syncSessionState).toHaveBeenCalled();
    expect(state.statusText).toBe("missing");
  });
});

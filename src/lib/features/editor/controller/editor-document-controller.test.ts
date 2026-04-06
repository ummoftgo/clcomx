import { describe, expect, it, vi } from "vitest";
import { createEditorDocumentController } from "./editor-document-controller";
import { createEditorRuntimeState } from "../state/editor-runtime-state.svelte";

describe("editor-document-controller", () => {
  function createController() {
    const state = createEditorRuntimeState();
    const deps = {
      getSessionId: () => "session-1",
      getSaveStatusLabel: () => "Save",
      readSessionFile: vi.fn(),
      writeSessionFile: vi.fn(),
      patchTab: vi.fn((wslPath: string, updates: Record<string, unknown>) => {
        state.tabs = state.tabs.map((tab) =>
          tab.wslPath === wslPath
            ? {
                ...tab,
                ...updates,
              }
            : tab,
        );
      }),
      setStatus: vi.fn((message: string | null) => {
        state.statusText = message;
      }),
      setTabError: vi.fn((wslPath: string, message: string) => {
        state.tabs = state.tabs.map((tab) =>
          tab.wslPath === wslPath
            ? {
                ...tab,
                loading: false,
                saving: false,
                error: message,
              }
            : tab,
        );
      }),
      setTabSaving: vi.fn((wslPath: string, saving: boolean) => {
        state.tabs = state.tabs.map((tab) =>
          tab.wslPath === wslPath
            ? {
                ...tab,
                saving,
                error: saving ? null : tab.error ?? null,
              }
            : tab,
        );
      }),
      syncSessionState: vi.fn(),
      upsertQuickOpenEntry: vi.fn(),
    };
    const controller = createEditorDocumentController(state, deps);

    return { state, deps, controller };
  }

  it("reads navigation content from a loaded tab before falling back to file I/O", async () => {
    const { state, deps, controller } = createController();
    state.tabs = [
      {
        wslPath: "/workspace/a.ts",
        content: "alpha",
        languageId: "typescript",
        dirty: true,
        loading: false,
        error: null,
      },
    ];

    const result = await controller.readNavigationFile("/workspace/a.ts");

    expect(result).toEqual({
      wslPath: "/workspace/a.ts",
      content: "alpha",
      languageId: "typescript",
    });
    expect(deps.readSessionFile).not.toHaveBeenCalled();
  });

  it("falls back to session file reads when a tab is unavailable for navigation", async () => {
    const { controller, deps } = createController();
    deps.readSessionFile.mockResolvedValue({
      wslPath: "/workspace/a.ts",
      content: "beta",
      languageId: "typescript",
      sizeBytes: 4,
      mtimeMs: 12,
    });

    const result = await controller.readNavigationFile("/workspace/a.ts");

    expect(result).toEqual({
      wslPath: "/workspace/a.ts",
      content: "beta",
      languageId: "typescript",
    });
    expect(deps.readSessionFile).toHaveBeenCalledWith("session-1", "/workspace/a.ts");
  });

  it("saves editor content and refreshes cached file metadata", async () => {
    const { state, controller, deps } = createController();
    state.tabs = [
      {
        wslPath: "/workspace/a.ts",
        content: "console.log('ok')",
        languageId: "typescript",
        dirty: true,
        loading: false,
        saving: false,
        error: null,
      },
    ];
    state.savedContentByPath = {
      "/workspace/a.ts": "old",
    };
    state.mtimeByPath = {
      "/workspace/a.ts": 10,
    };
    deps.writeSessionFile.mockResolvedValue({
      wslPath: "/workspace/a.ts",
      sizeBytes: 18,
      mtimeMs: 42,
    });

    await controller.saveTab("/workspace/a.ts");

    expect(deps.writeSessionFile).toHaveBeenCalledWith(
      "session-1",
      "/workspace/a.ts",
      "console.log('ok')",
      10,
    );
    expect(state.savedContentByPath["/workspace/a.ts"]).toBe("console.log('ok')");
    expect(state.mtimeByPath["/workspace/a.ts"]).toBe(42);
    expect(state.tabs[0]).toMatchObject({
      dirty: false,
      saving: false,
      error: null,
    });
    expect(deps.upsertQuickOpenEntry).toHaveBeenCalledWith("/workspace/a.ts");
    expect(deps.syncSessionState).toHaveBeenCalled();
    expect(state.statusText).toBeNull();
  });

  it("surfaces save failures without clearing the sync finally path", async () => {
    const { state, controller, deps } = createController();
    state.tabs = [
      {
        wslPath: "/workspace/a.ts",
        content: "broken",
        languageId: "typescript",
        dirty: true,
        loading: false,
        saving: false,
        error: null,
      },
    ];
    deps.writeSessionFile.mockRejectedValue(new Error("disk full"));

    await controller.saveTab("/workspace/a.ts");

    expect(state.tabs[0]).toMatchObject({
      saving: false,
      error: "disk full",
    });
    expect(state.statusText).toBe("disk full");
    expect(deps.syncSessionState).toHaveBeenCalled();
  });
});

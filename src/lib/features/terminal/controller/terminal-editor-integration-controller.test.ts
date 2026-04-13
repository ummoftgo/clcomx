import { describe, expect, it, vi } from "vitest";
import { createEditorQuickOpenState } from "../../editor/state/editor-quick-open-state.svelte";
import { createEditorRuntimeState } from "../../editor/state/editor-runtime-state.svelte";
import { createTerminalEditorIntegrationController } from "./terminal-editor-integration-controller";

describe("terminal-editor-integration-controller", () => {
  function createDeps() {
    return {
      runtimeState: createEditorRuntimeState(),
      quickOpenState: createEditorQuickOpenState(),
      getSessionId: () => "session-1",
      getSessionSnapshot: () => null,
      getWorkDir: () => "/workspace",
      getViewMode: () => "terminal" as const,
      setViewMode: vi.fn(),
      getRootDir: () => "/workspace",
      setRootDir: vi.fn(),
      prepareForEditorMode: vi.fn(),
      prepareForEditorPathOpen: vi.fn(),
      getLoadingStatusLabel: () => "Loading",
      getSaveStatusLabel: () => "Save",
      readSessionFile: vi.fn(async (_sessionId: string, wslPath: string) => ({
        wslPath,
        content: "alpha",
        languageId: "typescript",
        sizeBytes: 5,
        mtimeMs: 1,
      })),
      writeSessionFile: vi.fn(async (_sessionId: string, wslPath: string) => ({
        wslPath,
        sizeBytes: 5,
        mtimeMs: 2,
      })),
      getVisible: () => true,
      getTerminalReady: () => true,
      getTerminalStartupSettled: () => true,
      getThemeDefinition: () => null,
      warmMonacoRuntime: vi.fn(async () => {}),
      listSessionFiles: vi.fn(async () => ({
        rootDir: "/workspace",
        results: [],
        lastUpdatedMs: 1,
      })),
      reportForegroundError: vi.fn(),
    };
  }

  it("maps terminal callbacks into the editor facade dependency shape", () => {
    const deps = createDeps();
    const onEditorSessionStateChange = vi.fn();
    const returnedFacade = { marker: "editor-facade" } as any;
    const createEditorFacadeImpl = vi.fn((_facadeDeps: any) => returnedFacade);

    const result = createTerminalEditorIntegrationController({
      ...deps,
      onEditorSessionStateChange,
      createEditorFacadeImpl,
    });

    expect(result).toBe(returnedFacade);
    expect(createEditorFacadeImpl).toHaveBeenCalledTimes(1);
    const facadeDeps = createEditorFacadeImpl.mock.calls[0]?.[0];
    expect(facadeDeps).toBeTruthy();
    if (!facadeDeps) {
      throw new Error("Expected editor facade dependencies");
    }
    expect(facadeDeps.runtimeState).toBe(deps.runtimeState);
    expect(facadeDeps.quickOpenState).toBe(deps.quickOpenState);
    expect(facadeDeps.prepareForEditorMode).toBe(deps.prepareForEditorMode);
    expect(facadeDeps.prepareForEditorPathOpen).toBe(deps.prepareForEditorPathOpen);

    const sessionState = {
      viewMode: "editor" as const,
      editorRootDir: "/workspace",
      openEditorTabs: [],
      activeEditorPath: null,
      dirtyPaths: [],
    };
    facadeDeps.syncSessionState("session-1", sessionState);

    expect(onEditorSessionStateChange).toHaveBeenCalledWith(sessionState);
  });

  it("tolerates missing session-state listeners", () => {
    const deps = createDeps();
    const createEditorFacadeImpl = vi.fn((_facadeDeps: any) => ({}) as any);

    createTerminalEditorIntegrationController({
      ...deps,
      createEditorFacadeImpl,
    });

    const facadeDeps = createEditorFacadeImpl.mock.calls[0]?.[0];
    expect(facadeDeps).toBeTruthy();
    if (!facadeDeps) {
      throw new Error("Expected editor facade dependencies");
    }
    expect(() =>
      facadeDeps.syncSessionState("session-1", {
        viewMode: "terminal",
        editorRootDir: "/workspace",
        openEditorTabs: [],
        activeEditorPath: null,
        dirtyPaths: [],
      })
    ).not.toThrow();
  });
});

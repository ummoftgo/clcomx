import { describe, expect, it, vi } from "vitest";
import { createEditorPathOpenController } from "./editor-path-open-controller";

describe("editor-path-open-controller", () => {
  function createController(options?: {
    prepareOpenPathResult?: { kind: "existing"; wasLoading: boolean } | { kind: "new" };
    viewMode?: "terminal" | "editor";
  }) {
    let viewMode = options?.viewMode ?? "editor";
    let releaseUiUpdate: (() => void) | null = null;
    const deps = {
      prepareForEditorPathOpen: vi.fn(),
      getWorkDir: () => "/workspace",
      getEditorRootDir: () => "/workspace/root",
      getViewMode: () => viewMode,
      ensureEditorViewMode: vi.fn(() => {
        viewMode = "editor";
      }),
      primeMonacoRuntime: vi.fn(),
      primeWorkspaceFiles: vi.fn(),
      openEditorDirectory: vi.fn(async () => {}),
      prepareOpenPath: vi.fn(
        () => options?.prepareOpenPathResult ?? ({ kind: "new" } as const),
      ),
      loadPreparedOpenPath: vi.fn(async () => {}),
      closeQuickOpen: vi.fn(),
      clearStatus: vi.fn(),
      waitForUiUpdate: vi.fn(
        () =>
          new Promise<void>((resolve) => {
            releaseUiUpdate = resolve;
          }),
      ),
    };
    const controller = createEditorPathOpenController(deps);

    return {
      controller,
      deps,
      setViewMode: (nextViewMode: "terminal" | "editor") => {
        viewMode = nextViewMode;
      },
      releaseUiUpdate: () => {
        releaseUiUpdate?.();
      },
    };
  }

  it("delegates directory opens to the editor view controller", async () => {
    const { controller, deps } = createController();

    await controller.openPath({
      raw: "src",
      wslPath: "/workspace/src",
      copyText: "/workspace/src",
      windowsPath: "C:\\workspace\\src",
      line: null,
      column: null,
      isDirectory: true,
    });

    expect(deps.prepareForEditorPathOpen).toHaveBeenCalled();
    expect(deps.ensureEditorViewMode).toHaveBeenCalled();
    expect(deps.primeMonacoRuntime).toHaveBeenCalled();
    expect(deps.openEditorDirectory).toHaveBeenCalledWith("/workspace/src");
    expect(deps.prepareOpenPath).not.toHaveBeenCalled();
    expect(deps.loadPreparedOpenPath).not.toHaveBeenCalled();
  });

  it("reuses existing tabs and clears transient status after the UI update", async () => {
    const { controller, deps, releaseUiUpdate } = createController({
      prepareOpenPathResult: { kind: "existing", wasLoading: false },
    });

    await controller.openPath(
      {
        wslPath: "/workspace/root/src/a.ts",
        relativePath: "src/a.ts",
        basename: "a.ts",
        line: 7,
        column: 3,
      },
      { rootDir: "/workspace/root" },
    );

    expect(deps.primeWorkspaceFiles).toHaveBeenCalledWith("/workspace/root");
    expect(deps.prepareOpenPath).toHaveBeenCalledWith({
      wslPath: "/workspace/root/src/a.ts",
      line: 7,
      column: 3,
      rootDir: "/workspace/root",
    });
    expect(deps.closeQuickOpen).toHaveBeenCalled();
    expect(deps.loadPreparedOpenPath).not.toHaveBeenCalled();
    expect(deps.clearStatus).not.toHaveBeenCalled();

    releaseUiUpdate();
    await Promise.resolve();

    expect(deps.clearStatus).toHaveBeenCalled();
  });

  it("does not clear status when the reused tab was still loading", async () => {
    const { controller, deps, releaseUiUpdate } = createController({
      prepareOpenPathResult: { kind: "existing", wasLoading: true },
    });

    await controller.openPath({
      wslPath: "/workspace/root/src/a.ts",
      relativePath: "src/a.ts",
      basename: "a.ts",
    });
    releaseUiUpdate();
    await Promise.resolve();

    expect(deps.clearStatus).not.toHaveBeenCalled();
  });

  it("loads new paths through the prepared-open load controller", async () => {
    const { controller, deps } = createController();
    const prefetchedFile = {
      wslPath: "/workspace/root/src/b.ts",
      content: "beta",
      languageId: "typescript",
    };

    await controller.openPath(
      {
        wslPath: "/workspace/root/src/b.ts",
        relativePath: "src/b.ts",
        basename: "b.ts",
      },
      { prefetchedFile },
    );

    expect(deps.primeWorkspaceFiles).toHaveBeenCalledWith("/workspace/root");
    expect(deps.prepareOpenPath).toHaveBeenCalledWith({
      wslPath: "/workspace/root/src/b.ts",
      line: null,
      column: null,
      rootDir: undefined,
    });
    expect(deps.loadPreparedOpenPath).toHaveBeenCalledWith({
      wslPath: "/workspace/root/src/b.ts",
      line: null,
      column: null,
      prefetchedFile,
    });
  });

  it("falls back to the work dir when no explicit or current editor root is available", async () => {
    const deps = {
      prepareForEditorPathOpen: vi.fn(),
      getWorkDir: () => "/workspace",
      getEditorRootDir: () => "",
      getViewMode: () => "editor" as const,
      ensureEditorViewMode: vi.fn(),
      primeMonacoRuntime: vi.fn(),
      primeWorkspaceFiles: vi.fn(),
      openEditorDirectory: vi.fn(async () => {}),
      prepareOpenPath: vi.fn(() => ({ kind: "new" } as const)),
      loadPreparedOpenPath: vi.fn(async () => {}),
      closeQuickOpen: vi.fn(),
      clearStatus: vi.fn(),
      waitForUiUpdate: vi.fn(async () => {}),
    };
    const controller = createEditorPathOpenController(deps);

    await controller.openPath({
      wslPath: "/workspace/root/src/d.ts",
      relativePath: "src/d.ts",
      basename: "d.ts",
    });

    expect(deps.primeWorkspaceFiles).toHaveBeenCalledWith("/workspace");
  });

  it("skips deferred status clearing when the view mode changed before the UI settled", async () => {
    const { controller, deps, releaseUiUpdate, setViewMode } = createController({
      prepareOpenPathResult: { kind: "existing", wasLoading: false },
    });

    await controller.openPath({
      wslPath: "/workspace/root/src/c.ts",
      relativePath: "src/c.ts",
      basename: "c.ts",
    });
    setViewMode("terminal");
    releaseUiUpdate();
    await Promise.resolve();

    expect(deps.clearStatus).not.toHaveBeenCalled();
  });
});

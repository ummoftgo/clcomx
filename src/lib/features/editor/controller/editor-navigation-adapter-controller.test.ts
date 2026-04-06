import { describe, expect, it, vi } from "vitest";
import { createEditorNavigationAdapterController } from "./editor-navigation-adapter-controller";

describe("editor-navigation-adapter-controller", () => {
  function createController() {
    const openEditorPath = vi.fn();
    const openEditorDirectory = vi.fn();
    const computeQuickOpenEntryForRoot = vi.fn();
    const controller = createEditorNavigationAdapterController({
      getEditorRootDir: () => "/workspace/root",
      getQuickOpenRootDir: () => "/workspace/quick",
      getWorkDir: () => "/workspace",
      computeQuickOpenEntryForRoot,
      openEditorDirectory,
      openEditorPath,
    });

    return {
      controller,
      computeQuickOpenEntryForRoot,
      openEditorDirectory,
      openEditorPath,
    };
  }

  it("shapes navigation requests using quick-open metadata and focusExisting", () => {
    const { controller, computeQuickOpenEntryForRoot, openEditorPath } = createController();
    computeQuickOpenEntryForRoot.mockReturnValue({
      wslPath: "/workspace/root/src/a.ts",
      relativePath: "src/a.ts",
      basename: "a.ts",
    });

    controller.openNavigationLocation({
      wslPath: "/workspace/root/src/a.ts",
      line: 7,
      column: 3,
      snapshot: {
        wslPath: "/workspace/root/src/a.ts",
        content: "alpha",
        languageId: "typescript",
      },
    });

    expect(computeQuickOpenEntryForRoot).toHaveBeenCalledWith(
      "/workspace/root/src/a.ts",
      "/workspace/root",
    );
    expect(openEditorPath).toHaveBeenCalledWith(
      {
        wslPath: "/workspace/root/src/a.ts",
        relativePath: "src/a.ts",
        basename: "a.ts",
        line: 7,
        column: 3,
      },
      {
        rootDir: "/workspace/root",
        focusExisting: true,
        prefetchedFile: {
          wslPath: "/workspace/root/src/a.ts",
          content: "alpha",
          languageId: "typescript",
        },
      },
    );
  });

  it("falls back to plain path labels when quick-open metadata is unavailable", () => {
    const { controller, computeQuickOpenEntryForRoot, openEditorPath } = createController();
    computeQuickOpenEntryForRoot.mockReturnValue(null);

    controller.openNavigationLocation({
      wslPath: "/workspace/root/src/a.ts",
      rootDir: "/workspace/other",
    });

    expect(openEditorPath).toHaveBeenCalledWith(
      {
        wslPath: "/workspace/root/src/a.ts",
        relativePath: "/workspace/root/src/a.ts",
        basename: "a.ts",
        line: null,
        column: null,
      },
      {
        rootDir: "/workspace/other",
        focusExisting: true,
        prefetchedFile: undefined,
      },
    );
  });

  it("routes quick-open selections through openEditorPath with the quick-open root", () => {
    const { controller, openEditorPath } = createController();
    const result = {
      wslPath: "/workspace/quick/src/b.ts",
      relativePath: "src/b.ts",
      basename: "b.ts",
    };

    controller.openPathFromQuickResult(result);

    expect(openEditorPath).toHaveBeenCalledWith(result, {
      rootDir: "/workspace/quick",
      focusExisting: true,
    });
  });

  it("routes directory and file links to the correct editor open target", () => {
    const { controller, openEditorDirectory, openEditorPath } = createController();

    controller.openInternalEditorForLinkPath({
      raw: "src",
      wslPath: "/workspace/root/src",
      copyText: "/workspace/root/src",
      windowsPath: "C:\\src",
      line: null,
      column: null,
      isDirectory: true,
    });
    controller.openInternalEditorForLinkPath({
      raw: "src/a.ts",
      wslPath: "/workspace/root/src/a.ts",
      copyText: "/workspace/root/src/a.ts",
      windowsPath: "C:\\src\\a.ts",
      line: 9,
      column: 4,
      isDirectory: false,
    });

    expect(openEditorDirectory).toHaveBeenCalledWith("/workspace/root/src");
    expect(openEditorPath).toHaveBeenCalledWith(
      expect.objectContaining({
        wslPath: "/workspace/root/src/a.ts",
      }),
      { rootDir: "/workspace/root" },
    );
  });
});

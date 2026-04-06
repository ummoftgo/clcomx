import type { NavigationFileSnapshot } from "../../../editor/navigation";
import type { EditorSearchResult, ResolvedTerminalPath } from "../../../editors";

interface OpenEditorPathOptions {
  rootDir?: string;
  focusExisting?: boolean;
  prefetchedFile?: NavigationFileSnapshot;
}

interface EditorNavigationLocationDetail {
  wslPath: string;
  line?: number | null;
  column?: number | null;
  rootDir?: string;
  snapshot?: NavigationFileSnapshot;
}

interface EditorNavigationAdapterControllerDependencies {
  getEditorRootDir: () => string;
  getQuickOpenRootDir: () => string;
  getWorkDir: () => string;
  computeQuickOpenEntryForRoot: (
    wslPath: string,
    rootDir: string,
  ) => EditorSearchResult | null;
  openEditorDirectory: (rootDir: string) => void | Promise<void>;
  openEditorPath: (
    path: ResolvedTerminalPath | EditorSearchResult,
    options?: OpenEditorPathOptions,
  ) => void | Promise<void>;
}

export function createEditorNavigationAdapterController(
  deps: EditorNavigationAdapterControllerDependencies,
) {
  function openNavigationLocation(detail: EditorNavigationLocationDetail) {
    const rootDir = detail.rootDir || deps.getEditorRootDir() || deps.getWorkDir();
    const quickOpenEntry = deps.computeQuickOpenEntryForRoot(detail.wslPath, rootDir);
    void deps.openEditorPath(
      {
        wslPath: detail.wslPath,
        relativePath: quickOpenEntry?.relativePath || detail.wslPath,
        basename: quickOpenEntry?.basename || detail.wslPath.split("/").pop() || detail.wslPath,
        line: detail.line ?? null,
        column: detail.column ?? null,
      },
      { rootDir, focusExisting: true, prefetchedFile: detail.snapshot },
    );
  }

  function openPathFromQuickResult(result: EditorSearchResult) {
    void deps.openEditorPath(result, {
      rootDir: deps.getQuickOpenRootDir(),
      focusExisting: true,
    });
  }

  function openResolvedPath(path: ResolvedTerminalPath) {
    void deps.openEditorPath(path, { rootDir: deps.getEditorRootDir() });
  }

  function openResolvedDirectory(path: ResolvedTerminalPath) {
    void deps.openEditorDirectory(path.wslPath);
  }

  function openInternalEditorForLinkPath(path: ResolvedTerminalPath) {
    if (path.isDirectory) {
      openResolvedDirectory(path);
      return;
    }

    openResolvedPath(path);
  }

  return {
    openInternalEditorForLinkPath,
    openNavigationLocation,
    openPathFromQuickResult,
  };
}

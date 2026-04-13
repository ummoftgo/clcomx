import { tick } from "svelte";
import type { NavigationFileSnapshot } from "../../../editor/navigation";
import type { EditorSearchResult, ResolvedTerminalPath } from "../../../editors";
import type { SessionViewMode } from "../../../types";

export interface OpenEditorPathOptions {
  rootDir?: string;
  focusExisting?: boolean;
  prefetchedFile?: NavigationFileSnapshot;
}

interface PrepareOpenPathDetail {
  wslPath: string;
  line: number | null;
  column: number | null;
  rootDir?: string;
}

type PreparedOpenPathResult =
  | {
      kind: "existing";
      wasLoading: boolean;
    }
  | {
      kind: "new";
    };

interface LoadPreparedOpenPathOptions {
  wslPath: string;
  line: number | null;
  column: number | null;
  prefetchedFile?: NavigationFileSnapshot;
}

interface EditorPathOpenControllerDependencies {
  prepareForEditorPathOpen: () => void;
  getWorkDir: () => string;
  getEditorRootDir: () => string;
  getViewMode: () => SessionViewMode;
  ensureEditorViewMode: () => void;
  primeMonacoRuntime: () => void;
  primeWorkspaceFiles: (rootDir: string) => void;
  openEditorDirectory: (rootDir: string) => void | Promise<void>;
  prepareOpenPath: (detail: PrepareOpenPathDetail) => PreparedOpenPathResult;
  loadPreparedOpenPath: (options: LoadPreparedOpenPathOptions) => Promise<void>;
  closeQuickOpen: () => void;
  clearStatus: () => void;
  waitForUiUpdate?: () => Promise<void>;
}

export function createEditorPathOpenController(deps: EditorPathOpenControllerDependencies) {
  const waitForUiUpdate = deps.waitForUiUpdate ?? tick;

  async function openPath(
    path: ResolvedTerminalPath | EditorSearchResult,
    options?: OpenEditorPathOptions,
  ) {
    deps.prepareForEditorPathOpen();
    deps.ensureEditorViewMode();
    deps.primeMonacoRuntime();

    if ("isDirectory" in path && path.isDirectory) {
      await deps.openEditorDirectory(path.wslPath);
      return;
    }

    const nextRootDir = options?.rootDir || deps.getEditorRootDir() || deps.getWorkDir();
    deps.primeWorkspaceFiles(nextRootDir);

    const nextLine = "line" in path ? path.line ?? null : null;
    const nextColumn = "column" in path ? path.column ?? null : null;
    const preparedOpenPath = deps.prepareOpenPath({
      wslPath: path.wslPath,
      line: nextLine,
      column: nextColumn,
      rootDir: options?.rootDir,
    });

    if (preparedOpenPath.kind === "existing") {
      deps.closeQuickOpen();
      void waitForUiUpdate().then(() => {
        if (deps.getViewMode() === "editor" && !preparedOpenPath.wasLoading) {
          deps.clearStatus();
        }
      });
      return;
    }

    await deps.loadPreparedOpenPath({
      wslPath: path.wslPath,
      line: nextLine,
      column: nextColumn,
      prefetchedFile: options?.prefetchedFile,
    });
  }

  return {
    openPath,
  };
}

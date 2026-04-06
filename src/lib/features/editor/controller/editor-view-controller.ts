import type { EditorRuntimeState } from "../state/editor-runtime-state.svelte";

interface EditorViewControllerDependencies {
  getWorkDir: () => string;
  getEditorRootDir: () => string;
  getQuickOpenVisible: () => boolean;
  setEditorRootDir: (rootDir: string) => void;
  setEditorViewMode: (viewMode: "terminal" | "editor") => void;
  ensureEditorViewMode: () => void;
  primeMonacoRuntime: () => void;
  primeWorkspaceFiles: (rootDir: string) => void;
  openQuickOpen: (rootDir?: string, query?: string) => void | Promise<void>;
  syncSessionState: () => void;
}

export function createEditorViewController(
  state: EditorRuntimeState,
  deps: EditorViewControllerDependencies,
) {
  function openDirectory(rootDir: string) {
    const nextRootDir = rootDir || deps.getWorkDir();
    deps.setEditorRootDir(nextRootDir);
    deps.syncSessionState();
    deps.primeMonacoRuntime();
    deps.primeWorkspaceFiles(nextRootDir);
    void deps.openQuickOpen(nextRootDir, "");
  }

  function requestSwitchToEditorMode() {
    deps.ensureEditorViewMode();
    deps.primeMonacoRuntime();
    deps.primeWorkspaceFiles(deps.getEditorRootDir() || deps.getWorkDir());
    state.statusText = null;
    if (!deps.getQuickOpenVisible() && state.tabs.length === 0) {
      void deps.openQuickOpen(deps.getEditorRootDir());
    }
  }

  function handleActivePathChange(wslPath: string) {
    state.activePath = wslPath;
    deps.setEditorViewMode("editor");
    deps.syncSessionState();
  }

  return {
    handleActivePathChange,
    openDirectory,
    requestSwitchToEditorMode,
  };
}

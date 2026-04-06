import type { NavigationFileSnapshot } from "../../../editor/navigation";
import type { ReadSessionFileResult } from "../../../editors";
import type { EditorRuntimeState } from "../state/editor-runtime-state.svelte";

interface LoadPreparedOpenPathOptions {
  wslPath: string;
  line: number | null;
  column: number | null;
  prefetchedFile?: NavigationFileSnapshot;
}

interface EditorOpenLoadControllerDependencies {
  getSessionId: () => string;
  getLoadingStatusLabel: () => string;
  readSessionFile: (sessionId: string, wslPath: string) => Promise<ReadSessionFileResult>;
  setStatus: (message: string | null) => void;
  setTabLoaded: (
    wslPath: string,
    detail: {
      content: string;
      languageId: string;
      mtimeMs: number;
      line?: number | null;
      column?: number | null;
    },
  ) => void;
  setTabError: (wslPath: string, message: string) => void;
  closeQuickOpen: () => void;
  syncSessionState: () => void;
}

type LoadedEditorFile = NavigationFileSnapshot | ReadSessionFileResult;

export function createEditorOpenLoadController(
  state: EditorRuntimeState,
  deps: EditorOpenLoadControllerDependencies,
) {
  function hasPreparedTab(wslPath: string) {
    return state.tabs.some((tab) => tab.wslPath === wslPath);
  }

  function resolveFileMtimeMs(file: LoadedEditorFile) {
    return "mtimeMs" in file
      ? file.mtimeMs
      : (state.mtimeByPath[file.wslPath] ?? 0);
  }

  async function loadPreparedOpenPath(options: LoadPreparedOpenPathOptions) {
    deps.setStatus(deps.getLoadingStatusLabel());

    try {
      const file =
        options.prefetchedFile && options.prefetchedFile.wslPath === options.wslPath
          ? options.prefetchedFile
          : await deps.readSessionFile(deps.getSessionId(), options.wslPath);
      if (!hasPreparedTab(options.wslPath)) {
        deps.setStatus(null);
        return;
      }

      deps.setTabLoaded(options.wslPath, {
        content: file.content,
        languageId: file.languageId || "plaintext",
        mtimeMs: resolveFileMtimeMs(file),
        line: options.line,
        column: options.column,
      });
      deps.setStatus(null);
      deps.closeQuickOpen();
    } catch (error) {
      if (!hasPreparedTab(options.wslPath)) {
        deps.setStatus(null);
        return;
      }

      const message = error instanceof Error ? error.message : String(error);
      deps.setTabError(options.wslPath, message);
      deps.setStatus(message);
    }

    deps.syncSessionState();
  }

  return {
    loadPreparedOpenPath,
  };
}

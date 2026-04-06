import type { InternalEditorTab } from "../../../editor/contracts";
import type { EditorRuntimeState } from "../state/editor-runtime-state.svelte";

interface PrepareOpenPathDetail {
  wslPath: string;
  line: number | null;
  column: number | null;
  rootDir?: string;
}

interface EditorOpenStateControllerDependencies {
  setEditorRootDir: (rootDir: string) => void;
  syncSessionState: () => void;
}

type PreparedOpenPathResult =
  | {
      kind: "existing";
      wasLoading: boolean;
    }
  | {
      kind: "new";
    };

export function createEditorOpenStateController(
  state: EditorRuntimeState,
  deps: EditorOpenStateControllerDependencies,
) {
  function prepareOpenPath(detail: PrepareOpenPathDetail): PreparedOpenPathResult {
    const existingTabIndex = state.tabs.findIndex((tab) => tab.wslPath === detail.wslPath);

    if (existingTabIndex >= 0) {
      const currentTab = state.tabs[existingTabIndex];
      state.tabs = state.tabs.map((tab) =>
        tab.wslPath !== detail.wslPath
          ? tab
          : {
              ...tab,
              line: detail.line ?? tab.line ?? null,
              column: detail.column ?? tab.column ?? null,
              error: null,
            },
      );
      state.activePath = detail.wslPath;
      if (detail.rootDir) {
        deps.setEditorRootDir(detail.rootDir);
      }
      deps.syncSessionState();
      return {
        kind: "existing",
        wasLoading: Boolean(currentTab.loading),
      };
    }

    const newTab: InternalEditorTab = {
      wslPath: detail.wslPath,
      content: "",
      languageId: "plaintext",
      dirty: false,
      line: detail.line,
      column: detail.column,
      loading: true,
      saving: false,
      error: null,
    };

    state.tabs = [...state.tabs, newTab];
    state.activePath = detail.wslPath;
    if (detail.rootDir) {
      deps.setEditorRootDir(detail.rootDir);
    }
    deps.syncSessionState();
    return {
      kind: "new",
    };
  }

  return {
    prepareOpenPath,
  };
}

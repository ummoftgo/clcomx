import type { InternalEditorTab } from "../../../editor/contracts";
import type { EditorTabRef, SessionCore, SessionEditorSnapshot, SessionViewMode } from "../../../types";
import type { EditorRuntimeState } from "../state/editor-runtime-state.svelte";

export interface EditorTabLoadedDetail {
  content: string;
  languageId: string;
  mtimeMs: number;
  line?: number | null;
  column?: number | null;
}

interface EditorRuntimeControllerDependencies {
  getSessionId: () => string;
  getSessions: () => EditorSessionState[];
  getViewMode: () => SessionViewMode;
  getRootDir: () => string;
  setSessionViewMode: (id: string, viewMode: SessionViewMode) => void;
  setSessionEditorRootDir: (id: string, rootDir: string) => void;
  setSessionOpenEditorTabs: (id: string, openEditorTabs: EditorTabRef[]) => void;
  setSessionActiveEditorPath: (id: string, activeEditorPath: string | null) => void;
  setSessionDirtyPaths: (id: string, dirtyPaths: string[]) => void;
}

type EditorSessionState = Pick<SessionCore, "id"> & SessionEditorSnapshot;

export function createEditorRuntimeController(
  state: EditorRuntimeState,
  deps: EditorRuntimeControllerDependencies,
) {
  function getCurrentSessionState() {
    return deps.getSessions().find((entry) => entry.id === deps.getSessionId()) ?? null;
  }

  function getOpenRefTabs() {
    return state.tabs.map((tab) => ({
      wslPath: tab.wslPath,
      line: tab.line ?? null,
      column: tab.column ?? null,
    }));
  }

  function syncSessionState() {
    const sessionId = deps.getSessionId();
    deps.setSessionViewMode(sessionId, deps.getViewMode());
    deps.setSessionEditorRootDir(sessionId, deps.getRootDir());
    deps.setSessionOpenEditorTabs(sessionId, getOpenRefTabs());
    deps.setSessionActiveEditorPath(sessionId, state.activePath);
    deps.setSessionDirtyPaths(
      sessionId,
      state.tabs.filter((tab) => tab.dirty).map((tab) => tab.wslPath),
    );
  }

  function setStatus(message: string | null) {
    state.statusText = message;
  }

  function setTabs(nextTabs: InternalEditorTab[]) {
    state.tabs = nextTabs;
    syncSessionState();
  }

  function patchTab(wslPath: string, updates: Partial<InternalEditorTab>) {
    let changed = false;
    state.tabs = state.tabs.map((tab) => {
      if (tab.wslPath !== wslPath) {
        return tab;
      }

      changed = true;
      return {
        ...tab,
        ...updates,
      };
    });

    if (changed) {
      syncSessionState();
    }
  }

  function removeTab(wslPath: string) {
    const nextTabs = state.tabs.filter((tab) => tab.wslPath !== wslPath);
    if (nextTabs.length === state.tabs.length) {
      return false;
    }

    delete state.savedContentByPath[wslPath];
    delete state.mtimeByPath[wslPath];
    state.tabs = nextTabs;

    if (state.activePath === wslPath) {
      state.activePath = nextTabs[nextTabs.length - 1]?.wslPath ?? null;
    }

    syncSessionState();
    return true;
  }

  function setTabLoaded(wslPath: string, detail: EditorTabLoadedDetail) {
    state.savedContentByPath = {
      ...state.savedContentByPath,
      [wslPath]: detail.content,
    };
    state.mtimeByPath = {
      ...state.mtimeByPath,
      [wslPath]: detail.mtimeMs,
    };
    patchTab(wslPath, {
      content: detail.content,
      languageId: detail.languageId,
      dirty: false,
      loading: false,
      saving: false,
      error: null,
      line: detail.line ?? null,
      column: detail.column ?? null,
    });
  }

  function setTabError(wslPath: string, message: string) {
    patchTab(wslPath, {
      loading: false,
      saving: false,
      error: message,
    });
  }

  function setTabSaving(wslPath: string, saving: boolean) {
    patchTab(wslPath, {
      saving,
      error: saving ? null : undefined,
    });
  }

  function requestCloseTab(wslPath: string, force = false) {
    const tab = state.tabs.find((entry) => entry.wslPath === wslPath);
    if (!tab) {
      return;
    }

    if (tab.dirty && !force) {
      state.closeConfirmPath = wslPath;
      state.closeConfirmVisible = true;
      return;
    }

    removeTab(wslPath);
  }

  function confirmCloseTab() {
    if (!state.closeConfirmPath) {
      state.closeConfirmVisible = false;
      return;
    }

    const wslPath = state.closeConfirmPath;
    state.closeConfirmVisible = false;
    state.closeConfirmPath = null;
    requestCloseTab(wslPath, true);
  }

  function cancelCloseTab() {
    state.closeConfirmVisible = false;
    state.closeConfirmPath = null;
  }

  function handleContentChange(detail: { wslPath: string; content: string }) {
    patchTab(detail.wslPath, {
      content: detail.content,
      dirty: detail.content !== (state.savedContentByPath[detail.wslPath] ?? ""),
      error: null,
    });
  }

  return {
    cancelCloseTab,
    confirmCloseTab,
    getCurrentSessionState,
    getOpenRefTabs,
    handleContentChange,
    patchTab,
    removeTab,
    requestCloseTab,
    setStatus,
    setTabError,
    setTabLoaded,
    setTabSaving,
    setTabs,
    syncSessionState,
  };
}

import type { ReadSessionFileResult, WriteSessionFileResult } from "../../../editors";
import type { EditorRuntimeState } from "../state/editor-runtime-state.svelte";

interface EditorDocumentControllerDependencies {
  getSessionId: () => string;
  getSaveStatusLabel: () => string;
  readSessionFile: (sessionId: string, wslPath: string) => Promise<ReadSessionFileResult>;
  writeSessionFile: (
    sessionId: string,
    wslPath: string,
    content: string,
    expectedMtimeMs: number,
  ) => Promise<WriteSessionFileResult>;
  patchTab: (
    wslPath: string,
    updates: Partial<EditorRuntimeState["tabs"][number]>,
  ) => void;
  setStatus: (message: string | null) => void;
  setTabError: (wslPath: string, message: string) => void;
  setTabSaving: (wslPath: string, saving: boolean) => void;
  syncSessionState: () => void;
  upsertQuickOpenEntry: (wslPath: string) => void;
}

export function createEditorDocumentController(
  state: EditorRuntimeState,
  deps: EditorDocumentControllerDependencies,
) {
  async function readNavigationFile(
    wslPath: string,
  ): Promise<Pick<ReadSessionFileResult, "wslPath" | "content" | "languageId">> {
    const existingTab = state.tabs.find(
      (tab) => tab.wslPath === wslPath && !tab.loading && !tab.error,
    );
    if (existingTab) {
      return {
        wslPath,
        content: existingTab.content,
        languageId: existingTab.languageId,
      };
    }

    const file = await deps.readSessionFile(deps.getSessionId(), wslPath);
    return {
      wslPath: file.wslPath,
      content: file.content,
      languageId: file.languageId,
    };
  }

  async function saveTab(wslPath: string) {
    const tab = state.tabs.find((entry) => entry.wslPath === wslPath);
    if (!tab) {
      return;
    }

    const contentToSave = tab.content;
    const expectedMtimeMs = state.mtimeByPath[wslPath] ?? 0;
    deps.setTabSaving(wslPath, true);
    deps.setStatus(deps.getSaveStatusLabel());

    try {
      const result = await deps.writeSessionFile(
        deps.getSessionId(),
        wslPath,
        contentToSave,
        expectedMtimeMs,
      );
      const latestTab = state.tabs.find((entry) => entry.wslPath === wslPath);
      if (!latestTab) {
        return;
      }

      state.savedContentByPath = {
        ...state.savedContentByPath,
        [wslPath]: contentToSave,
      };
      state.mtimeByPath = {
        ...state.mtimeByPath,
        [wslPath]: result.mtimeMs,
      };
      deps.patchTab(wslPath, {
        dirty: latestTab.content !== contentToSave,
        saving: false,
        error: null,
      });
      deps.upsertQuickOpenEntry(wslPath);
      deps.setStatus(null);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      deps.setTabError(wslPath, message);
      deps.setStatus(message);
    } finally {
      deps.syncSessionState();
    }
  }

  return {
    readNavigationFile,
    saveTab,
  };
}

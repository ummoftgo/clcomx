import type { InternalEditorTab } from "../../../editor/contracts";
import type { ReadSessionFileResult } from "../../../editors";
import type {
  SessionEditorSnapshot,
  SessionEditorState,
  SessionViewMode,
} from "../../../types";
import {
  buildEditorHydrationPlaceholderTabs,
  loadHydratedEditorTabs,
  resolveHydratedActivePath,
  splitHydratedEditorTabs,
} from "../service/editor-session-hydration";
import type { EditorQuickOpenState } from "../state/editor-quick-open-state.svelte";
import type { EditorRuntimeState } from "../state/editor-runtime-state.svelte";

type EditorHydrationSource = Pick<
  SessionEditorSnapshot,
  "viewMode" | "editorRootDir" | "openEditorTabs" | "activeEditorPath"
>;

interface EditorSessionHydrationControllerDependencies {
  runtimeState: EditorRuntimeState;
  quickOpenState: EditorQuickOpenState;
  getSessionId: () => string;
  getSessionSnapshot: () => EditorHydrationSource | null;
  getWorkDir: () => string;
  setViewMode: (viewMode: SessionViewMode) => void;
  setRootDir: (rootDir: string) => void;
  readSessionFile: (sessionId: string, wslPath: string) => Promise<ReadSessionFileResult>;
  setTabs: (tabs: InternalEditorTab[]) => void;
  syncSessionState: () => void;
}

export function createEditorSessionHydrationController(
  deps: EditorSessionHydrationControllerDependencies,
) {
  let hydratedSessionId: string | null = null;
  let hydratedSessionSnapshotKey: string | null = null;
  let hydrationToken = 0;

  function buildHydrationSourceKey(source: EditorHydrationSource | null) {
    return JSON.stringify({
      sessionId: deps.getSessionId(),
      viewMode: source?.viewMode ?? "terminal",
      editorRootDir: source?.editorRootDir || deps.getWorkDir(),
      openEditorTabs: (source?.openEditorTabs ?? []).map((entry) => ({
        wslPath: entry.wslPath,
        line: entry.line ?? null,
        column: entry.column ?? null,
      })),
      activeEditorPath: source?.activeEditorPath ?? null,
    });
  }

  function buildSessionStateHydrationKey(sessionState: SessionEditorState) {
    return buildHydrationSourceKey({
      viewMode: sessionState.viewMode,
      editorRootDir: sessionState.editorRootDir,
      openEditorTabs: sessionState.openEditorTabs,
      activeEditorPath: sessionState.activeEditorPath,
    });
  }

  function markSessionStateSynced(sessionId: string, sessionState: SessionEditorState) {
    hydratedSessionId = sessionId;
    hydratedSessionSnapshotKey = buildSessionStateHydrationKey(sessionState);
  }

  async function hydrateFromSession() {
    const session = deps.getSessionSnapshot();
    const token = ++hydrationToken;
    hydratedSessionId = deps.getSessionId();
    hydratedSessionSnapshotKey = buildHydrationSourceKey(session);
    deps.setViewMode(session?.viewMode ?? "terminal");
    deps.setRootDir(session?.editorRootDir || deps.getWorkDir());
    deps.quickOpenState.rootDir = session?.editorRootDir || deps.getWorkDir();
    deps.runtimeState.activePath = session?.activeEditorPath ?? null;
    deps.runtimeState.savedContentByPath = {};
    deps.runtimeState.mtimeByPath = {};

    const refs = session?.openEditorTabs ?? [];
    if (refs.length === 0) {
      deps.setTabs([]);
      return;
    }

    deps.setTabs(buildEditorHydrationPlaceholderTabs(refs));

    const loadedTabs = await loadHydratedEditorTabs(
      { readSessionFile: deps.readSessionFile },
      deps.getSessionId(),
      refs,
    );

    if (token !== hydrationToken) {
      return;
    }

    const { tabs, savedContentByPath, mtimeByPath } = splitHydratedEditorTabs(loadedTabs);
    deps.runtimeState.savedContentByPath = savedContentByPath;
    deps.runtimeState.mtimeByPath = mtimeByPath;
    deps.runtimeState.tabs = tabs;
    deps.runtimeState.activePath = resolveHydratedActivePath(deps.runtimeState.activePath, tabs);

    deps.syncSessionState();
  }

  async function ensureRuntimeReady() {
    const nextSessionId = deps.getSessionId();
    const nextSessionSnapshotKey = buildHydrationSourceKey(deps.getSessionSnapshot());
    if (
      hydratedSessionId === nextSessionId
      && hydratedSessionSnapshotKey === nextSessionSnapshotKey
    ) {
      return;
    }

    await hydrateFromSession();
  }

  return {
    ensureRuntimeReady,
    hydrateFromSession,
    markSessionStateSynced,
  };
}

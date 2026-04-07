import { tick } from "svelte";
import type { NavigationFileSnapshot } from "../../../editor/navigation";
import type {
  EditorSearchResult,
  ListSessionFilesResult,
  ReadSessionFileResult,
  ResolvedTerminalPath,
  WriteSessionFileResult,
} from "../../../editors";
import type {
  SessionEditorSnapshot,
  SessionEditorState,
  SessionViewMode,
} from "../../../types";
import { createEditorDocumentController } from "./editor-document-controller";
import { createEditorNavigationAdapterController } from "./editor-navigation-adapter-controller";
import { createEditorOpenLoadController } from "./editor-open-load-controller";
import { createEditorOpenStateController } from "./editor-open-state-controller";
import { createEditorQuickOpenController } from "./editor-quick-open-controller";
import { createEditorRuntimeController } from "./editor-runtime-controller";
import { createEditorViewController } from "./editor-view-controller";
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

interface OpenEditorPathOptions {
  rootDir?: string;
  focusExisting?: boolean;
  prefetchedFile?: NavigationFileSnapshot;
}

interface EditorFacadeDependencies {
  runtimeState: EditorRuntimeState;
  quickOpenState: EditorQuickOpenState;
  getSessionId: () => string;
  getSessionSnapshot: () => EditorHydrationSource | null;
  getWorkDir: () => string;
  getViewMode: () => SessionViewMode;
  setViewMode: (viewMode: SessionViewMode) => void;
  getRootDir: () => string;
  setRootDir: (rootDir: string) => void;
  syncSessionState: (sessionId: string, sessionState: SessionEditorState) => void;
  prepareForEditorMode: () => void;
  prepareForEditorPathOpen: () => void;
  getLoadingStatusLabel: () => string;
  getSaveStatusLabel: () => string;
  readSessionFile: (sessionId: string, wslPath: string) => Promise<ReadSessionFileResult>;
  writeSessionFile: (
    sessionId: string,
    wslPath: string,
    content: string,
    expectedMtimeMs: number,
  ) => Promise<WriteSessionFileResult>;
  getVisible: () => boolean;
  getTerminalReady: () => boolean;
  getTerminalStartupSettled: () => boolean;
  getThemeDefinition: () => any;
  warmMonacoRuntime: (themeDefinition: any) => Promise<void>;
  listSessionFiles: (
    sessionId: string,
    rootDir: string,
    forceRefresh: boolean,
  ) => Promise<ListSessionFilesResult>;
  reportForegroundError: (message: string) => void;
}

export function createEditorFacade(deps: EditorFacadeDependencies) {
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

  const quickOpenController = createEditorQuickOpenController(deps.quickOpenState, {
    getSessionId: deps.getSessionId,
    getWorkDir: deps.getWorkDir,
    getEditorRootDir: deps.getRootDir,
    getVisible: deps.getVisible,
    getTerminalReady: deps.getTerminalReady,
    getTerminalStartupSettled: deps.getTerminalStartupSettled,
    getThemeDefinition: deps.getThemeDefinition,
    warmMonacoRuntime: deps.warmMonacoRuntime,
    listSessionFiles: deps.listSessionFiles,
    reportForegroundError: deps.reportForegroundError,
  });

  function ensureEditorViewMode() {
    if (deps.getViewMode() === "editor") {
      return;
    }

    deps.prepareForEditorMode();
    deps.setViewMode("editor");
    runtimeController.syncSessionState();
  }

  function switchToTerminalView() {
    deps.setViewMode("terminal");
    quickOpenController.closeQuickOpen();
    deps.runtimeState.closeConfirmVisible = false;
    deps.runtimeState.closeConfirmPath = null;
    runtimeController.syncSessionState();
  }

  const runtimeController = createEditorRuntimeController(deps.runtimeState, {
    getSessionId: deps.getSessionId,
    getViewMode: deps.getViewMode,
    getRootDir: deps.getRootDir,
    syncSessionState: (sessionId, sessionState) => {
      hydratedSessionId = sessionId;
      hydratedSessionSnapshotKey = buildSessionStateHydrationKey(sessionState);
      deps.syncSessionState(sessionId, sessionState);
    },
  });
  const documentController = createEditorDocumentController(deps.runtimeState, {
    getSessionId: deps.getSessionId,
    getSaveStatusLabel: deps.getSaveStatusLabel,
    readSessionFile: deps.readSessionFile,
    writeSessionFile: deps.writeSessionFile,
    patchTab: runtimeController.patchTab,
    setStatus: runtimeController.setStatus,
    setTabError: runtimeController.setTabError,
    setTabSaving: runtimeController.setTabSaving,
    syncSessionState: runtimeController.syncSessionState,
    upsertQuickOpenEntry: quickOpenController.upsertEntry,
  });
  const openStateController = createEditorOpenStateController(deps.runtimeState, {
    setEditorRootDir: deps.setRootDir,
    syncSessionState: runtimeController.syncSessionState,
  });
  const openLoadController = createEditorOpenLoadController(deps.runtimeState, {
    getSessionId: deps.getSessionId,
    getLoadingStatusLabel: deps.getLoadingStatusLabel,
    readSessionFile: deps.readSessionFile,
    setStatus: runtimeController.setStatus,
    setTabLoaded: runtimeController.setTabLoaded,
    setTabError: runtimeController.setTabError,
    closeQuickOpen: quickOpenController.closeQuickOpen,
    syncSessionState: runtimeController.syncSessionState,
  });
  const viewController = createEditorViewController(deps.runtimeState, {
    getWorkDir: deps.getWorkDir,
    getEditorRootDir: deps.getRootDir,
    getQuickOpenVisible: () => deps.quickOpenState.visible,
    setEditorRootDir: deps.setRootDir,
    setEditorViewMode: deps.setViewMode,
    ensureEditorViewMode,
    primeMonacoRuntime: quickOpenController.primeMonacoRuntime,
    primeWorkspaceFiles: quickOpenController.primeWorkspaceFiles,
    openQuickOpen: quickOpenController.openQuickOpen,
    syncSessionState: runtimeController.syncSessionState,
  });

  async function hydrateFromSession() {
    const session = deps.getSessionSnapshot();
    const token = ++hydrationToken;
    hydratedSessionId = deps.getSessionId();
    hydratedSessionSnapshotKey = buildHydrationSourceKey(session);
    deps.setViewMode(session?.viewMode ?? "terminal");
    deps.setRootDir(session?.editorRootDir || deps.getWorkDir());
    deps.quickOpenState.rootDir = deps.getRootDir();
    deps.runtimeState.activePath = session?.activeEditorPath ?? null;
    deps.runtimeState.savedContentByPath = {};
    deps.runtimeState.mtimeByPath = {};

    const refs = session?.openEditorTabs ?? [];
    if (refs.length === 0) {
      runtimeController.setTabs([]);
      return;
    }

    runtimeController.setTabs(buildEditorHydrationPlaceholderTabs(refs));

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

    runtimeController.syncSessionState();
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

  async function openPath(
    path: ResolvedTerminalPath | EditorSearchResult,
    options?: OpenEditorPathOptions,
  ) {
    deps.prepareForEditorPathOpen();
    ensureEditorViewMode();
    quickOpenController.primeMonacoRuntime();

    if ("isDirectory" in path && path.isDirectory) {
      await viewController.openDirectory(path.wslPath);
      return;
    }

    const wslPath = path.wslPath;
    const nextRootDir = options?.rootDir || deps.getRootDir() || deps.getWorkDir();
    quickOpenController.primeWorkspaceFiles(nextRootDir);
    const nextLine = "line" in path ? path.line ?? null : null;
    const nextColumn = "column" in path ? path.column ?? null : null;

    const preparedOpenPath = openStateController.prepareOpenPath({
      wslPath,
      line: nextLine,
      column: nextColumn,
      rootDir: options?.rootDir,
    });

    if (preparedOpenPath.kind === "existing") {
      quickOpenController.closeQuickOpen();
      void tick().then(() => {
        if (deps.getViewMode() === "editor" && !preparedOpenPath.wasLoading) {
          deps.runtimeState.statusText = null;
        }
      });
      return;
    }

    await openLoadController.loadPreparedOpenPath({
      wslPath,
      line: nextLine,
      column: nextColumn,
      prefetchedFile: options?.prefetchedFile,
    });
  }

  const navigationController = createEditorNavigationAdapterController({
    getEditorRootDir: deps.getRootDir,
    getQuickOpenRootDir: () => deps.quickOpenState.rootDir,
    getWorkDir: deps.getWorkDir,
    computeQuickOpenEntryForRoot: quickOpenController.computeEntryForRoot,
    openEditorDirectory: viewController.openDirectory,
    openEditorPath: openPath,
  });

  return {
    cancelCloseTab: runtimeController.cancelCloseTab,
    cancelMonacoPrewarm: quickOpenController.cancelMonacoPrewarm,
    cancelQuickOpenPrewarm: quickOpenController.cancelPrewarm,
    confirmCloseTab: runtimeController.confirmCloseTab,
    ensureRuntimeReady,
    handleActivePathChange: viewController.handleActivePathChange,
    handleContentChange: runtimeController.handleContentChange,
    invalidateQuickOpenRequest: quickOpenController.invalidateRequest,
    listWorkspaceFiles: quickOpenController.listWorkspaceFiles,
    openDirectory: viewController.openDirectory,
    openInternalEditorForLinkPath: navigationController.openInternalEditorForLinkPath,
    openNavigationLocation: navigationController.openNavigationLocation,
    openPath,
    openPathFromQuickResult: navigationController.openPathFromQuickResult,
    openQuickOpen: quickOpenController.openQuickOpen,
    primeMonacoRuntime: quickOpenController.primeMonacoRuntime,
    primeWorkspaceFiles: quickOpenController.primeWorkspaceFiles,
    readNavigationFile: documentController.readNavigationFile,
    refreshQuickOpenEntries: quickOpenController.refreshEntries,
    requestCloseTab: runtimeController.requestCloseTab,
    requestSwitchToEditorMode: viewController.requestSwitchToEditorMode,
    saveTab: documentController.saveTab,
    scheduleMonacoPrewarm: quickOpenController.scheduleMonacoPrewarm,
    scheduleQuickOpenPrewarm: quickOpenController.schedulePrewarm,
    setStatus: runtimeController.setStatus,
    setTabs: runtimeController.setTabs,
    switchToTerminalView,
    syncSessionState: runtimeController.syncSessionState,
    upsertQuickOpenEntry: quickOpenController.upsertEntry,
    closeQuickOpen: quickOpenController.closeQuickOpen,
  };
}

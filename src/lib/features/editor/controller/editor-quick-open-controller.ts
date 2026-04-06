import type { EditorSearchResult, ListSessionFilesResult } from "../../../editors";
import type { EditorQuickOpenState } from "../state/editor-quick-open-state.svelte";

const QUICK_OPEN_CACHE_STALE_MS = 30_000;

interface EditorQuickOpenControllerDependencies {
  getSessionId: () => string;
  getWorkDir: () => string;
  getEditorRootDir: () => string;
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

export function createEditorQuickOpenController(
  state: EditorQuickOpenState,
  deps: EditorQuickOpenControllerDependencies,
) {
  function invalidateRequest() {
    state.requestToken += 1;
  }

  function clearPrewarmHandle() {
    if (state.prewarmHandle === null) {
      return;
    }

    const idleWindow = window as Window & {
      cancelIdleCallback?: (handle: number) => void;
    };
    if (
      typeof state.prewarmHandle === "number" &&
      typeof idleWindow.cancelIdleCallback === "function"
    ) {
      idleWindow.cancelIdleCallback(state.prewarmHandle);
    } else {
      clearTimeout(state.prewarmHandle);
    }
    state.prewarmHandle = null;
  }

  function cancelPrewarm() {
    state.prewarmToken += 1;
    state.prewarmRequestedRootDir = "";
    clearPrewarmHandle();
  }

  function clearMonacoPrewarmHandle() {
    if (state.monacoPrewarmHandle === null) {
      return;
    }

    const idleWindow = window as Window & {
      cancelIdleCallback?: (handle: number) => void;
    };
    if (
      typeof state.monacoPrewarmHandle === "number" &&
      typeof idleWindow.cancelIdleCallback === "function"
    ) {
      idleWindow.cancelIdleCallback(state.monacoPrewarmHandle);
    } else {
      clearTimeout(state.monacoPrewarmHandle);
    }
    state.monacoPrewarmHandle = null;
  }

  function cancelMonacoPrewarm() {
    state.monacoPrewarmToken += 1;
    clearMonacoPrewarmHandle();
  }

  function isCacheStale() {
    if (!state.lastUpdatedMs) {
      return true;
    }

    return Date.now() - state.lastUpdatedMs > QUICK_OPEN_CACHE_STALE_MS;
  }

  function resetState({
    resetRootDir = false,
    clearEntries = false,
  }: { resetRootDir?: boolean; clearEntries?: boolean } = {}) {
    invalidateRequest();
    state.busy = false;
    if (clearEntries) {
      state.entries = [];
      state.lastUpdatedMs = 0;
    }
    if (resetRootDir) {
      state.rootDir = "";
    }
  }

  function closeQuickOpen() {
    state.visible = false;
    resetState();
  }

  async function refreshEntries(
    forceRefresh = false,
    rootDir = state.rootDir || deps.getWorkDir(),
    options?: { background?: boolean },
  ) {
    const requestToken = ++state.requestToken;
    const normalizedRootDir = rootDir || deps.getWorkDir();
    const background = options?.background ?? false;

    if (!background) {
      state.busy = true;
    }

    try {
      const result = await deps.listSessionFiles(
        deps.getSessionId(),
        normalizedRootDir,
        forceRefresh,
      );
      if (requestToken !== state.requestToken) {
        return;
      }

      state.rootDir = result.rootDir;
      state.entries = result.results;
      state.lastUpdatedMs = result.lastUpdatedMs;
    } catch (error) {
      if (requestToken !== state.requestToken) {
        return;
      }

      if (!background) {
        deps.reportForegroundError(error instanceof Error ? error.message : String(error));
      }
    } finally {
      if (!background && requestToken === state.requestToken) {
        state.busy = false;
      }
    }
  }

  async function listWorkspaceFiles(rootDir: string) {
    const normalizedRootDir = rootDir || deps.getEditorRootDir() || deps.getWorkDir();
    if (state.rootDir === normalizedRootDir && state.entries.length > 0) {
      if (!isCacheStale()) {
        return state.entries;
      }

      void refreshEntries(false, normalizedRootDir, { background: true });
      return state.entries;
    }

    const result = await deps.listSessionFiles(deps.getSessionId(), normalizedRootDir, false);
    if (state.rootDir === normalizedRootDir || !state.visible) {
      state.rootDir = result.rootDir;
      state.entries = result.results;
      state.lastUpdatedMs = result.lastUpdatedMs;
    }
    return result.results;
  }

  function primeWorkspaceFiles(rootDir = deps.getEditorRootDir() || deps.getWorkDir()) {
    const normalizedRootDir = rootDir || deps.getWorkDir();
    if (!normalizedRootDir) {
      return;
    }

    if (state.rootDir === normalizedRootDir && state.entries.length > 0 && !isCacheStale()) {
      return;
    }

    if (
      state.prewarmRequestedRootDir === normalizedRootDir ||
      state.prewarmInFlightRootDir === normalizedRootDir
    ) {
      return;
    }

    state.prewarmInFlightRootDir = normalizedRootDir;
    void refreshEntries(false, normalizedRootDir, { background: true }).finally(() => {
      if (state.prewarmInFlightRootDir === normalizedRootDir) {
        state.prewarmInFlightRootDir = "";
      }
    });
  }

  function primeMonacoRuntime() {
    if (state.monacoPrewarmed || state.monacoPrewarming) {
      return;
    }

    clearMonacoPrewarmHandle();
    const prewarmToken = ++state.monacoPrewarmToken;
    requestAnimationFrame(() => {
      if (
        prewarmToken !== state.monacoPrewarmToken ||
        state.monacoPrewarmed ||
        state.monacoPrewarming
      ) {
        return;
      }

      state.monacoPrewarming = true;
      const themeDef = deps.getThemeDefinition();
      void deps.warmMonacoRuntime(themeDef)
        .then(() => {
          state.monacoPrewarmed = true;
        })
        .finally(() => {
          state.monacoPrewarming = false;
        });
    });
  }

  function schedulePrewarm(rootDir = deps.getEditorRootDir() || deps.getWorkDir()) {
    const normalizedRootDir = rootDir || deps.getWorkDir();
    if (
      !deps.getTerminalReady() ||
      !deps.getTerminalStartupSettled() ||
      !deps.getVisible() ||
      state.visible
    ) {
      return;
    }

    if (!normalizedRootDir) {
      return;
    }

    if (state.rootDir === normalizedRootDir && state.lastUpdatedMs > 0 && !isCacheStale()) {
      return;
    }

    if (
      state.prewarmRequestedRootDir === normalizedRootDir ||
      state.prewarmInFlightRootDir === normalizedRootDir
    ) {
      return;
    }

    clearPrewarmHandle();
    const prewarmToken = ++state.prewarmToken;
    state.prewarmRequestedRootDir = normalizedRootDir;

    const runPrewarm = () => {
      if (prewarmToken !== state.prewarmToken) {
        return;
      }

      state.prewarmHandle = null;
      state.prewarmRequestedRootDir = "";
      if (
        !deps.getTerminalReady() ||
        !deps.getTerminalStartupSettled() ||
        !deps.getVisible() ||
        state.visible
      ) {
        return;
      }

      state.prewarmInFlightRootDir = normalizedRootDir;
      void refreshEntries(false, normalizedRootDir, { background: true }).finally(() => {
        if (state.prewarmInFlightRootDir === normalizedRootDir) {
          state.prewarmInFlightRootDir = "";
        }
      });
    };

    const idleWindow = window as Window & {
      requestIdleCallback?: (
        callback: IdleRequestCallback,
        options?: IdleRequestOptions,
      ) => number;
    };

    if (typeof idleWindow.requestIdleCallback === "function") {
      state.prewarmHandle = idleWindow.requestIdleCallback(runPrewarm, { timeout: 1200 });
      return;
    }

    state.prewarmHandle = window.setTimeout(runPrewarm, 250);
  }

  function scheduleMonacoPrewarm() {
    if (
      state.monacoPrewarmed ||
      state.monacoPrewarming ||
      !deps.getTerminalReady() ||
      !deps.getTerminalStartupSettled() ||
      !deps.getVisible()
    ) {
      return;
    }

    clearMonacoPrewarmHandle();
    const prewarmToken = ++state.monacoPrewarmToken;
    const runPrewarm = () => {
      if (prewarmToken !== state.monacoPrewarmToken) {
        return;
      }

      state.monacoPrewarmHandle = null;
      if (
        state.monacoPrewarmed ||
        state.monacoPrewarming ||
        !deps.getTerminalReady() ||
        !deps.getTerminalStartupSettled() ||
        !deps.getVisible()
      ) {
        return;
      }

      state.monacoPrewarming = true;
      const themeDef = deps.getThemeDefinition();
      void deps.warmMonacoRuntime(themeDef)
        .then(() => {
          state.monacoPrewarmed = true;
        })
        .finally(() => {
          state.monacoPrewarming = false;
        });
    };

    const idleWindow = window as Window & {
      requestIdleCallback?: (
        callback: IdleRequestCallback,
        options?: IdleRequestOptions,
      ) => number;
    };

    if (typeof idleWindow.requestIdleCallback === "function") {
      state.monacoPrewarmHandle = idleWindow.requestIdleCallback(runPrewarm, { timeout: 1500 });
      return;
    }

    state.monacoPrewarmHandle = window.setTimeout(runPrewarm, 350);
  }

  function computeEntryForRoot(
    wslPath: string,
    rootDir = state.rootDir || deps.getEditorRootDir() || deps.getWorkDir(),
  ): EditorSearchResult | null {
    const normalizedRoot = rootDir.replace(/\/+$/, "") || "/";
    if (wslPath !== normalizedRoot && !wslPath.startsWith(`${normalizedRoot}/`)) {
      return null;
    }

    const basename = wslPath.split("/").pop() || wslPath;
    const relativePath =
      wslPath === normalizedRoot ? basename : wslPath.slice(normalizedRoot.length + 1);

    return {
      wslPath,
      relativePath,
      basename,
    };
  }

  function upsertEntry(wslPath: string) {
    const entry = computeEntryForRoot(wslPath);
    if (!entry) {
      return;
    }

    const index = state.entries.findIndex((candidate) => candidate.wslPath === wslPath);
    if (index < 0) {
      state.entries = [...state.entries, entry];
    } else {
      state.entries = state.entries.map((candidate) =>
        candidate.wslPath === wslPath ? entry : candidate,
      );
    }
    state.lastUpdatedMs = Date.now();
  }

  function openQuickOpen(rootDir = deps.getEditorRootDir(), query = "") {
    const normalizedRoot = rootDir || deps.getWorkDir();
    primeMonacoRuntime();
    primeWorkspaceFiles(normalizedRoot);
    const rootChanged = state.rootDir !== normalizedRoot;
    if (rootChanged) {
      resetState({ clearEntries: true });
    }

    state.rootDir = normalizedRoot;
    state.query = query;
    state.visible = true;
    state.openKey += 1;

    if (isCacheStale()) {
      void refreshEntries(false, normalizedRoot);
    }
  }

  return {
    cancelMonacoPrewarm,
    cancelPrewarm,
    closeQuickOpen,
    computeEntryForRoot,
    invalidateRequest,
    isCacheStale,
    listWorkspaceFiles,
    openQuickOpen,
    primeMonacoRuntime,
    primeWorkspaceFiles,
    refreshEntries,
    resetState,
    scheduleMonacoPrewarm,
    schedulePrewarm,
    upsertEntry,
  };
}

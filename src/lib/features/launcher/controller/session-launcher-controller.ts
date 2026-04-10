import type { AgentId } from "../../../agents";
import type { TabHistoryEntry } from "../../../types";
import type { WslEntry } from "../../../wsl";

export type SessionLauncherStep = "home" | "browser";

export interface SessionLauncherState {
  step: SessionLauncherStep;
  distros: string[];
  selectedDistro: string;
  selectedAgentId: AgentId;
  currentPath: string;
  selectedPath: string;
  directories: WslEntry[];
  loading: boolean;
  agentPickerOpen: boolean;
  distroPickerOpen: boolean;
  pathInput: string;
  error: string;
  historyDeleteError: string;
  pendingDeleteEntry: TabHistoryEntry | null;
  deletingHistoryEntry: boolean;
  navigationHistory: string[];
  navigationIndex: number;
}

export interface SessionLauncherControllerDependencies {
  state: SessionLauncherState;
  getDefaultAgentId: () => AgentId;
  getDefaultDistro: () => string;
  getDefaultStartPathsByDistro: () => Record<string, string>;
  getAvailableAgentIds: () => AgentId[];
  listWslDistros: () => Promise<string[]>;
  listWslDirectories: (distro: string, path: string) => Promise<WslEntry[]>;
  removeHistoryEntry: (entry: TabHistoryEntry) => Promise<void>;
  onOpenHistory: (entry: TabHistoryEntry) => void;
  onConfirm: (agentId: AgentId, distro: string, workDir: string) => void;
  formatNoDistrosError: () => string;
  formatLoadDistrosError: (error: unknown) => string;
  formatLoadDirectoriesError: (error: unknown) => string;
  formatDeleteHistoryError: (error: unknown) => string;
}

export function createSessionLauncherState(defaultAgentId: AgentId): SessionLauncherState {
  return {
    step: "home",
    distros: [],
    selectedDistro: "",
    selectedAgentId: defaultAgentId || "claude",
    currentPath: "/home",
    selectedPath: "/home",
    directories: [],
    loading: false,
    agentPickerOpen: false,
    distroPickerOpen: false,
    pathInput: "/home",
    error: "",
    historyDeleteError: "",
    pendingDeleteEntry: null,
    deletingHistoryEntry: false,
    navigationHistory: ["/home"],
    navigationIndex: 0,
  };
}

export function getParentPath(path: string) {
  return path.replace(/\/[^/]+\/?$/, "") || "/";
}

function getLaunchPath(state: Pick<SessionLauncherState, "pathInput" | "selectedPath" | "currentPath">) {
  return state.pathInput.trim() || state.selectedPath || state.currentPath;
}

export function createSessionLauncherController(
  deps: SessionLauncherControllerDependencies,
) {
  const { state } = deps;

  function syncSelectedAgentId() {
    const availableAgentIds = new Set(deps.getAvailableAgentIds());
    const preferredAgentId = deps.getDefaultAgentId() || "claude";
    if (!state.selectedAgentId || !availableAgentIds.has(state.selectedAgentId)) {
      state.selectedAgentId = availableAgentIds.has(preferredAgentId)
        ? preferredAgentId
        : "claude";
    }
  }

  async function ensureDistrosLoaded() {
    if (state.distros.length > 0) return state.distros;
    if (state.loading) return state.distros;

    state.loading = true;
    state.error = "";
    try {
      state.distros = await deps.listWslDistros();
      const defaultDistro = deps.getDefaultDistro();
      if (!state.selectedDistro && defaultDistro && state.distros.includes(defaultDistro)) {
        state.selectedDistro = defaultDistro;
      }
      if (state.distros.length === 0) {
        state.error = deps.formatNoDistrosError();
      }
    } catch (error) {
      state.error = deps.formatLoadDistrosError(error);
    } finally {
      state.loading = false;
    }
    return state.distros;
  }

  function resetToHome() {
    state.step = "home";
    state.selectedDistro = "";
    state.selectedAgentId = deps.getDefaultAgentId() || "claude";
    state.currentPath = "/home";
    state.selectedPath = "/home";
    state.pathInput = "/home";
    state.directories = [];
    state.navigationHistory = ["/home"];
    state.navigationIndex = 0;
    state.agentPickerOpen = false;
    state.distroPickerOpen = false;
    state.pendingDeleteEntry = null;
    state.historyDeleteError = "";
    state.deletingHistoryEntry = false;
    state.error = "";
    state.loading = false;
  }

  function getDefaultPathForDistro(distro: string) {
    return deps.getDefaultStartPathsByDistro()[distro]?.trim() || "/home";
  }

  function recordNavigation(path: string) {
    if (state.navigationHistory[state.navigationIndex] === path) return;
    state.navigationHistory = [...state.navigationHistory.slice(0, state.navigationIndex + 1), path];
    state.navigationIndex = state.navigationHistory.length - 1;
  }

  async function navigateTo(path: string, options: { recordHistory?: boolean } = {}) {
    state.currentPath = path;
    state.selectedPath = path;
    state.pathInput = path;
    if (options.recordHistory !== false) {
      recordNavigation(path);
    }
    state.loading = true;
    state.error = "";
    try {
      state.directories = await deps.listWslDirectories(state.selectedDistro, path);
    } catch (error) {
      state.error = deps.formatLoadDirectoriesError(error);
      state.directories = [];
    } finally {
      state.loading = false;
    }
  }

  async function selectDistro(distro: string) {
    state.selectedDistro = distro;
    await navigateTo(getDefaultPathForDistro(distro));
  }

  async function beginNewSession() {
    state.step = "browser";
    state.selectedAgentId = state.selectedAgentId || deps.getDefaultAgentId() || "claude";
    const loadedDistros = await ensureDistrosLoaded();
    const defaultDistro = deps.getDefaultDistro().trim();
    const preferredDistro =
      (defaultDistro && loadedDistros.includes(defaultDistro) ? defaultDistro : "")
      || loadedDistros[0]
      || "";

    if (preferredDistro) {
      await selectDistro(preferredDistro);
    }
  }

  function selectHistory(entry: TabHistoryEntry, options: { embedded: boolean }) {
    deps.onOpenHistory(entry);
    if (!options.embedded) {
      resetToHome();
    }
  }

  function promptDeleteHistory(entry: TabHistoryEntry) {
    state.pendingDeleteEntry = entry;
    state.historyDeleteError = "";
  }

  function dismissDeleteHistoryDialog() {
    if (state.deletingHistoryEntry) return;
    state.pendingDeleteEntry = null;
    state.historyDeleteError = "";
  }

  async function confirmDeleteHistory() {
    if (!state.pendingDeleteEntry || state.deletingHistoryEntry) return;

    state.deletingHistoryEntry = true;
    state.historyDeleteError = "";

    try {
      await deps.removeHistoryEntry(state.pendingDeleteEntry);
      state.pendingDeleteEntry = null;
    } catch (error) {
      state.historyDeleteError = deps.formatDeleteHistoryError(error);
    } finally {
      state.deletingHistoryEntry = false;
    }
  }

  function openAgentPicker() {
    state.agentPickerOpen = true;
  }

  function closeAgentPicker() {
    state.agentPickerOpen = false;
  }

  function selectAgent(agentId: AgentId) {
    state.selectedAgentId = agentId;
    state.agentPickerOpen = false;
  }

  function openDistroPicker() {
    state.distroPickerOpen = true;
  }

  function closeDistroPicker() {
    state.distroPickerOpen = false;
  }

  function selectDistroAndClose(distro: string) {
    void selectDistro(distro);
    state.distroPickerOpen = false;
  }

  function selectPath(path: string) {
    state.selectedPath = path;
    state.pathInput = path;
  }

  async function goUp() {
    await navigateTo(getParentPath(state.currentPath));
  }

  async function goBackHistory() {
    if (state.navigationIndex <= 0) return;
    state.navigationIndex -= 1;
    await navigateTo(state.navigationHistory[state.navigationIndex], { recordHistory: false });
  }

  async function goForwardHistory() {
    if (state.navigationIndex >= state.navigationHistory.length - 1) return;
    state.navigationIndex += 1;
    await navigateTo(state.navigationHistory[state.navigationIndex], { recordHistory: false });
  }

  async function openSelectedDirectory() {
    await navigateTo(getLaunchPath(state));
  }

  function confirmDirectory() {
    deps.onConfirm(state.selectedAgentId, state.selectedDistro, getLaunchPath(state));
    resetToHome();
  }

  return {
    syncSelectedAgentId,
    ensureDistrosLoaded,
    resetToHome,
    selectDistro,
    beginNewSession,
    selectHistory,
    promptDeleteHistory,
    dismissDeleteHistoryDialog,
    confirmDeleteHistory,
    openAgentPicker,
    closeAgentPicker,
    selectAgent,
    openDistroPicker,
    closeDistroPicker,
    selectDistroAndClose,
    selectPath,
    navigateTo,
    goUp,
    goBackHistory,
    goForwardHistory,
    openSelectedDirectory,
    confirmDirectory,
  };
}

import type {
  Session,
  WorkspaceSnapshot,
  WorkspaceTabSnapshot,
  WorkspaceWindowSnapshot,
} from "../types";
import { saveWorkspaceSnapshot } from "../workspace";

let sessions = $state<Session[]>([]);
let activeSessionId = $state<string | null>(null);
let sessionsInitialized = false;
let lastSavedWorkspace = "";
let saveQueue: Promise<void> = Promise.resolve();
let currentWindowLabel = "main";
let currentWindowName = $state("main");

const MAIN_WINDOW_LABEL = "main";

function getDefaultTitle(workDir: string) {
  return workDir.split("/").pop() || workDir;
}

function createRuntimeSession(tab: WorkspaceTabSnapshot): Session {
  return {
    id: tab.sessionId,
    ptyId: tab.ptyId ?? -1,
    auxPtyId: tab.auxPtyId ?? -1,
    auxVisible: tab.auxVisible ?? false,
    auxHeightPercent: tab.auxHeightPercent ?? null,
    agentId: tab.agentId ?? "claude",
    resumeToken: tab.resumeToken ?? null,
    title: tab.title || getDefaultTitle(tab.workDir),
    pinned: tab.pinned ?? false,
    locked: tab.locked ?? false,
    terminal: null,
    element: null,
    distro: tab.distro,
    workDir: tab.workDir,
    viewMode: tab.viewMode ?? "terminal",
    editorRootDir: tab.editorRootDir || tab.workDir,
    openEditorTabs: (tab.openEditorTabs ?? []).map((entry) => ({
      wslPath: entry.wslPath,
      line: entry.line ?? null,
      column: entry.column ?? null,
    })),
    activeEditorPath: tab.activeEditorPath ?? null,
    dirtyPaths: [],
  };
}

function createWindowSnapshot(label = currentWindowLabel): WorkspaceWindowSnapshot {
  return {
    label,
    name: currentWindowName || label,
    role: label === MAIN_WINDOW_LABEL ? "main" : "secondary",
      tabs: sessions.map((session) => ({
        sessionId: session.id,
        agentId: session.agentId,
        distro: session.distro,
        workDir: session.workDir,
        title: session.title,
        pinned: session.pinned,
        locked: session.locked,
        resumeToken: session.resumeToken,
        ptyId: session.ptyId >= 0 ? session.ptyId : null,
        auxPtyId: session.auxPtyId >= 0 ? session.auxPtyId : null,
        auxVisible: session.auxVisible,
        auxHeightPercent: session.auxHeightPercent,
        viewMode: session.viewMode,
        editorRootDir: session.editorRootDir,
        openEditorTabs: session.openEditorTabs.map((entry) => ({
          wslPath: entry.wslPath,
          line: entry.line ?? null,
          column: entry.column ?? null,
        })),
        activeEditorPath: session.activeEditorPath,
      })),
    activeSessionId,
  };
}

function applyWindowSnapshot(windowSnapshot?: WorkspaceWindowSnapshot, preservePtyIds = true) {
  const nextSessions = (windowSnapshot?.tabs ?? [])
    .filter((tab) => tab.sessionId && tab.distro && tab.workDir)
    .map((tab) => {
      const existing = sessions.find((session) => session.id === tab.sessionId);
      if (existing) {
        const nextOpenEditorTabs = (tab.openEditorTabs ?? []).map((entry) => ({
          wslPath: entry.wslPath,
          line: entry.line ?? null,
          column: entry.column ?? null,
        }));
        const nextOpenEditorPathSet = new Set(nextOpenEditorTabs.map((entry) => entry.wslPath));
        existing.title = tab.title || getDefaultTitle(tab.workDir);
        existing.pinned = tab.pinned ?? false;
        existing.locked = tab.locked ?? false;
        existing.agentId = tab.agentId ?? "claude";
        existing.resumeToken = tab.resumeToken ?? null;
        existing.distro = tab.distro;
        existing.workDir = tab.workDir;
        existing.auxVisible = tab.auxVisible ?? false;
        existing.auxHeightPercent = tab.auxHeightPercent ?? null;
        existing.viewMode = tab.viewMode ?? "terminal";
        existing.editorRootDir = tab.editorRootDir || tab.workDir;
        existing.openEditorTabs = nextOpenEditorTabs;
        existing.activeEditorPath = tab.activeEditorPath ?? null;
        existing.dirtyPaths = existing.dirtyPaths.filter((wslPath) =>
          nextOpenEditorPathSet.has(wslPath),
        );
        if (preservePtyIds && typeof tab.ptyId === "number") {
          existing.ptyId = tab.ptyId;
        } else if (!preservePtyIds) {
          existing.ptyId = -1;
        }
        if (preservePtyIds && typeof tab.auxPtyId === "number") {
          existing.auxPtyId = tab.auxPtyId;
        } else if (!preservePtyIds) {
          existing.auxPtyId = -1;
        }
        return existing;
      }

      return createRuntimeSession({
        ...tab,
        ptyId: preservePtyIds ? tab.ptyId : null,
      });
    });

  sessions.splice(0, sessions.length, ...nextSessions);
  currentWindowName = windowSnapshot?.name || currentWindowLabel;
  const preferredActiveId = windowSnapshot?.activeSessionId ?? null;
  activeSessionId = sessions.some((session) => session.id === preferredActiveId)
    ? preferredActiveId
    : sessions[0]?.id ?? null;
}

export function getSessions() {
  return sessions;
}

export function getActiveSessionId() {
  return activeSessionId;
}

export function getActiveSession(): Session | undefined {
  return sessions.find((s) => s.id === activeSessionId);
}

export function areSessionsInitialized() {
  return sessionsInitialized;
}

export function getCurrentWindowLabel() {
  return currentWindowLabel;
}

export function getCurrentWindowName() {
  return currentWindowName;
}

export function initializeSessionsFromWorkspace(
  workspace: WorkspaceSnapshot | null,
  windowLabel = MAIN_WINDOW_LABEL,
) {
  currentWindowLabel = windowLabel;
  const windowSnapshot = workspace?.windows.find((window) => window.label === windowLabel);
  applyWindowSnapshot(windowSnapshot, true);
  sessionsInitialized = true;
  lastSavedWorkspace = JSON.stringify(getWorkspaceSnapshot(windowLabel));
}

export function syncSessionsFromWorkspace(workspace: WorkspaceSnapshot | null) {
  const windowSnapshot = workspace?.windows.find((window) => window.label === currentWindowLabel);
  applyWindowSnapshot(windowSnapshot);
  lastSavedWorkspace = JSON.stringify(getWorkspaceSnapshot(currentWindowLabel));
}

export function addSession(session: Session) {
  sessions.push(session);
  activeSessionId = session.id;
}

export function removeSession(id: string) {
  const idx = sessions.findIndex((s) => s.id === id);
  if (idx === -1) return;

  sessions.splice(idx, 1);

  if (activeSessionId === id) {
    if (sessions.length > 0) {
      const newIdx = Math.min(idx, sessions.length - 1);
      activeSessionId = sessions[newIdx].id;
    } else {
      activeSessionId = null;
    }
  }
}

export function setActiveSession(id: string) {
  activeSessionId = id;
}

export function setSessionPtyId(id: string, ptyId: number) {
  const session = sessions.find((entry) => entry.id === id);
  if (session) {
    session.ptyId = ptyId;
  }
}

export function setSessionAuxState(
  id: string,
  auxPtyId: number,
  auxVisible: boolean,
  auxHeightPercent: number | null,
) {
  const session = sessions.find((entry) => entry.id === id);
  if (!session) return;
  session.auxPtyId = auxPtyId;
  session.auxVisible = auxVisible;
  session.auxHeightPercent = auxHeightPercent;
}

export function setSessionResumeToken(id: string, resumeToken: string | null) {
  const session = sessions.find((entry) => entry.id === id);
  if (!session) return;
  session.resumeToken = resumeToken;
}

export function setSessionTitle(id: string, title: string) {
  const session = sessions.find((entry) => entry.id === id);
  if (!session) return;
  session.title = title;
}

export function setSessionViewMode(id: string, viewMode: Session["viewMode"]) {
  const session = sessions.find((entry) => entry.id === id);
  if (!session) return;
  session.viewMode = viewMode;
}

export function setSessionEditorRootDir(id: string, rootDir: string) {
  const session = sessions.find((entry) => entry.id === id);
  if (!session) return;
  session.editorRootDir = rootDir || session.workDir;
}

export function setSessionOpenEditorTabs(id: string, openEditorTabs: Session["openEditorTabs"]) {
  const session = sessions.find((entry) => entry.id === id);
  if (!session) return;
  session.openEditorTabs = openEditorTabs.map((entry) => ({
    wslPath: entry.wslPath,
    line: entry.line ?? null,
    column: entry.column ?? null,
  }));
}

export function setSessionActiveEditorPath(id: string, activeEditorPath: string | null) {
  const session = sessions.find((entry) => entry.id === id);
  if (!session) return;
  session.activeEditorPath = activeEditorPath;
}

export function setSessionDirtyPaths(id: string, dirtyPaths: string[]) {
  const session = sessions.find((entry) => entry.id === id);
  if (!session) return;
  session.dirtyPaths = [...dirtyPaths];
}

function firstUnpinnedIndex() {
  return sessions.findIndex((session) => !session.pinned);
}

export function setSessionPinned(id: string, pinned: boolean) {
  const fromIndex = sessions.findIndex((session) => session.id === id);
  if (fromIndex === -1) return;

  const session = sessions[fromIndex];
  if (session.pinned === pinned) return;

  sessions.splice(fromIndex, 1);
  session.pinned = pinned;

  if (pinned) {
    const insertIndex = firstUnpinnedIndex();
    sessions.splice(insertIndex === -1 ? sessions.length : insertIndex, 0, session);
    return;
  }

  const pinnedCount = sessions.filter((entry) => entry.pinned).length;
  sessions.splice(pinnedCount, 0, session);
}

export function setSessionLocked(id: string, locked: boolean) {
  const session = sessions.find((entry) => entry.id === id);
  if (!session) return;
  session.locked = locked;
}

export function setCurrentWindowName(name: string) {
  currentWindowName = name;
}

export function moveSession(id: string, toIndex: number) {
  const fromIndex = sessions.findIndex((session) => session.id === id);
  if (fromIndex === -1 || toIndex < 0 || toIndex >= sessions.length || fromIndex === toIndex) {
    return;
  }

  const [session] = sessions.splice(fromIndex, 1);
  sessions.splice(toIndex, 0, session);
}

export function getWorkspaceSnapshot(
  windowLabel = currentWindowLabel,
): WorkspaceSnapshot {
  return {
    windows: [createWindowSnapshot(windowLabel)],
  };
}

export function persistWorkspace(windowLabel = currentWindowLabel): Promise<void> {
  if (!sessionsInitialized) {
    return saveQueue;
  }

  const snapshot = getWorkspaceSnapshot(windowLabel);
  const serialized = JSON.stringify(snapshot);
  if (serialized === lastSavedWorkspace) {
    return saveQueue;
  }

  saveQueue = saveQueue
    .catch(() => {})
    .then(async () => {
      try {
        await saveWorkspaceSnapshot(snapshot);
        lastSavedWorkspace = serialized;
      } catch (error) {
        console.error("Failed to save workspace", error);
      }
    });

  return saveQueue;
}

import type {
  Session,
  SessionCore,
  SessionEditorSnapshot,
  SessionPersistedState,
  SessionShellRuntimeState,
  WorkspaceSnapshot,
  WorkspaceTabSnapshot,
  WorkspaceWindowSnapshot,
} from "../../types";

export const MAIN_WINDOW_LABEL = "main";

export function getDefaultSessionTitle(workDir: string) {
  return workDir.split("/").pop() || workDir;
}

function createSessionCore(tab: WorkspaceTabSnapshot): SessionCore {
  return {
    id: tab.sessionId,
    agentId: tab.agentId ?? "claude",
    resumeToken: tab.resumeToken ?? null,
    title: tab.title || getDefaultSessionTitle(tab.workDir),
    pinned: tab.pinned ?? false,
    locked: tab.locked ?? false,
    distro: tab.distro,
    workDir: tab.workDir,
  };
}

function createSessionShellRuntimeState(
  tab: WorkspaceTabSnapshot,
): SessionShellRuntimeState {
  return {
    ptyId: tab.ptyId ?? -1,
    auxPtyId: tab.auxPtyId ?? -1,
    auxVisible: tab.auxVisible ?? false,
    auxHeightPercent: tab.auxHeightPercent ?? null,
  };
}

function createSessionEditorSnapshot(tab: WorkspaceTabSnapshot): SessionEditorSnapshot {
  return {
    viewMode: tab.viewMode ?? "terminal",
    editorRootDir: tab.editorRootDir || tab.workDir,
    openEditorTabs: (tab.openEditorTabs ?? []).map((entry) => ({
      wslPath: entry.wslPath,
      line: entry.line ?? null,
      column: entry.column ?? null,
    })),
    activeEditorPath: tab.activeEditorPath ?? null,
  };
}

function createWorkspaceTabSnapshot(session: SessionPersistedState): WorkspaceTabSnapshot {
  return {
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
  };
}

export function createRuntimeSession(tab: WorkspaceTabSnapshot): Session {
  return {
    ...createSessionCore(tab),
    ...createSessionShellRuntimeState(tab),
    ...createSessionEditorSnapshot(tab),
    dirtyPaths: [],
  };
}

export function createWorkspaceWindowSnapshot(params: {
  sessions: SessionPersistedState[];
  activeSessionId: string | null;
  currentWindowLabel: string;
  currentWindowName: string;
  windowLabel?: string;
}): WorkspaceWindowSnapshot {
  const windowLabel = params.windowLabel ?? params.currentWindowLabel;
  return {
    label: windowLabel,
    name: params.currentWindowName || windowLabel,
    role: windowLabel === MAIN_WINDOW_LABEL ? "main" : "secondary",
    tabs: params.sessions.map(createWorkspaceTabSnapshot),
    activeSessionId: params.activeSessionId,
  };
}

export function createWorkspaceSnapshotForWindow(params: {
  sessions: SessionPersistedState[];
  activeSessionId: string | null;
  currentWindowLabel: string;
  currentWindowName: string;
  windowLabel?: string;
}): WorkspaceSnapshot {
  return {
    windows: [createWorkspaceWindowSnapshot(params)],
  };
}

export function applyWorkspaceWindowSnapshot(params: {
  sessions: Session[];
  windowSnapshot?: WorkspaceWindowSnapshot;
  currentWindowLabel: string;
  preservePtyIds?: boolean;
}): {
  sessions: Session[];
  activeSessionId: string | null;
  currentWindowName: string;
} {
  const preservePtyIds = params.preservePtyIds ?? true;
  const nextSessions = (params.windowSnapshot?.tabs ?? [])
    .filter((tab) => tab.sessionId && tab.distro && tab.workDir)
    .map((tab) => {
      const existing = params.sessions.find((session) => session.id === tab.sessionId);
      if (!existing) {
        return createRuntimeSession({
          ...tab,
          ptyId: preservePtyIds ? tab.ptyId : null,
        });
      }

      const nextOpenEditorTabs = (tab.openEditorTabs ?? []).map((entry) => ({
        wslPath: entry.wslPath,
        line: entry.line ?? null,
        column: entry.column ?? null,
      }));
      const nextOpenEditorPathSet = new Set(nextOpenEditorTabs.map((entry) => entry.wslPath));
      existing.title = tab.title || getDefaultSessionTitle(tab.workDir);
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
    });

  const preferredActiveId = params.windowSnapshot?.activeSessionId ?? null;
  return {
    sessions: nextSessions,
    currentWindowName: params.windowSnapshot?.name || params.currentWindowLabel,
    activeSessionId: nextSessions.some((session) => session.id === preferredActiveId)
      ? preferredActiveId
      : nextSessions[0]?.id ?? null,
  };
}

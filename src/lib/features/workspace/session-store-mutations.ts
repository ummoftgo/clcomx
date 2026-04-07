import type { EditorTabRef, Session, SessionViewMode } from "../../types";

export function removeSessionAndResolveActive(
  sessions: Session[],
  activeSessionId: string | null,
  id: string,
) {
  const idx = sessions.findIndex((session) => session.id === id);
  if (idx === -1) {
    return activeSessionId;
  }

  sessions.splice(idx, 1);

  if (activeSessionId !== id) {
    return activeSessionId;
  }

  if (sessions.length === 0) {
    return null;
  }

  const nextIndex = Math.min(idx, sessions.length - 1);
  return sessions[nextIndex].id;
}

export function setSessionPtyIdInList(sessions: Session[], id: string, ptyId: number) {
  const session = sessions.find((entry) => entry.id === id);
  if (session) {
    session.ptyId = ptyId;
  }
}

export function setSessionAuxStateInList(
  sessions: Session[],
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

export function setSessionResumeTokenInList(
  sessions: Session[],
  id: string,
  resumeToken: string | null,
) {
  const session = sessions.find((entry) => entry.id === id);
  if (session) {
    session.resumeToken = resumeToken;
  }
}

export function setSessionTitleInList(sessions: Session[], id: string, title: string) {
  const session = sessions.find((entry) => entry.id === id);
  if (session) {
    session.title = title;
  }
}

export function setSessionViewModeInList(
  sessions: Session[],
  id: string,
  viewMode: SessionViewMode,
) {
  const session = sessions.find((entry) => entry.id === id);
  if (session) {
    session.viewMode = viewMode;
  }
}

export function setSessionEditorRootDirInList(sessions: Session[], id: string, rootDir: string) {
  const session = sessions.find((entry) => entry.id === id);
  if (session) {
    session.editorRootDir = rootDir || session.workDir;
  }
}

export function setSessionOpenEditorTabsInList(
  sessions: Session[],
  id: string,
  openEditorTabs: EditorTabRef[],
) {
  const session = sessions.find((entry) => entry.id === id);
  if (!session) return;
  session.openEditorTabs = openEditorTabs.map((entry) => ({
    wslPath: entry.wslPath,
    line: entry.line ?? null,
    column: entry.column ?? null,
  }));
}

export function setSessionActiveEditorPathInList(
  sessions: Session[],
  id: string,
  activeEditorPath: string | null,
) {
  const session = sessions.find((entry) => entry.id === id);
  if (session) {
    session.activeEditorPath = activeEditorPath;
  }
}

export function setSessionDirtyPathsInList(sessions: Session[], id: string, dirtyPaths: string[]) {
  const session = sessions.find((entry) => entry.id === id);
  if (session) {
    session.dirtyPaths = [...dirtyPaths];
  }
}

function firstUnpinnedIndex(sessions: Session[]) {
  return sessions.findIndex((session) => !session.pinned);
}

export function setSessionPinnedInList(sessions: Session[], id: string, pinned: boolean) {
  const fromIndex = sessions.findIndex((session) => session.id === id);
  if (fromIndex === -1) return;

  const session = sessions[fromIndex];
  if (session.pinned === pinned) return;

  sessions.splice(fromIndex, 1);
  session.pinned = pinned;

  if (pinned) {
    const insertIndex = firstUnpinnedIndex(sessions);
    sessions.splice(insertIndex === -1 ? sessions.length : insertIndex, 0, session);
    return;
  }

  const pinnedCount = sessions.filter((entry) => entry.pinned).length;
  sessions.splice(pinnedCount, 0, session);
}

export function setSessionLockedInList(sessions: Session[], id: string, locked: boolean) {
  const session = sessions.find((entry) => entry.id === id);
  if (session) {
    session.locked = locked;
  }
}

export function moveSessionInList(sessions: Session[], id: string, toIndex: number) {
  const fromIndex = sessions.findIndex((session) => session.id === id);
  if (fromIndex === -1 || toIndex < 0 || toIndex >= sessions.length || fromIndex === toIndex) {
    return;
  }

  const [session] = sessions.splice(fromIndex, 1);
  sessions.splice(toIndex, 0, session);
}

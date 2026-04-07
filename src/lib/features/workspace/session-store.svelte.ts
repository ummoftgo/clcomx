import type { EditorTabRef, Session, SessionViewMode, WorkspaceSnapshot } from "../../types";
import {
  applyWorkspaceWindowSnapshot,
  createWorkspaceSnapshotForWindow,
  MAIN_WINDOW_LABEL,
} from "./session-store-snapshot";
import {
  createWorkspacePersistenceState,
  markWorkspacePersistenceInitialized,
  persistWorkspaceSnapshot as queueWorkspaceSnapshotSave,
  syncWorkspacePersistenceSnapshot,
} from "./session-store-persistence";
import {
  moveSessionInList,
  removeSessionAndResolveActive,
  setSessionActiveEditorPathInList,
  setSessionAuxStateInList,
  setSessionDirtyPathsInList,
  setSessionEditorRootDirInList,
  setSessionLockedInList,
  setSessionOpenEditorTabsInList,
  setSessionPinnedInList,
  setSessionPtyIdInList,
  setSessionResumeTokenInList,
  setSessionTitleInList,
  setSessionViewModeInList,
} from "./session-store-mutations";

let sessions = $state<Session[]>([]);
let activeSessionId = $state<string | null>(null);
let currentWindowLabel = "main";
let currentWindowName = $state("main");
const workspacePersistence = createWorkspacePersistenceState();

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
  return workspacePersistence.sessionsInitialized;
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
  const result = applyWorkspaceWindowSnapshot({
    sessions,
    windowSnapshot,
    currentWindowLabel,
    preservePtyIds: true,
  });
  sessions.splice(0, sessions.length, ...result.sessions);
  currentWindowName = result.currentWindowName;
  activeSessionId = result.activeSessionId;
  markWorkspacePersistenceInitialized(workspacePersistence, getWorkspaceSnapshot(windowLabel));
}

export function syncSessionsFromWorkspace(workspace: WorkspaceSnapshot | null) {
  const windowSnapshot = workspace?.windows.find((window) => window.label === currentWindowLabel);
  const result = applyWorkspaceWindowSnapshot({
    sessions,
    windowSnapshot,
    currentWindowLabel,
  });
  sessions.splice(0, sessions.length, ...result.sessions);
  currentWindowName = result.currentWindowName;
  activeSessionId = result.activeSessionId;
  syncWorkspacePersistenceSnapshot(workspacePersistence, getWorkspaceSnapshot(currentWindowLabel));
}

export function addSession(session: Session) {
  sessions.push(session);
  activeSessionId = session.id;
}

export function removeSession(id: string) {
  activeSessionId = removeSessionAndResolveActive(sessions, activeSessionId, id);
}

export function setActiveSession(id: string) {
  activeSessionId = id;
}

export function setSessionPtyId(id: string, ptyId: number) {
  setSessionPtyIdInList(sessions, id, ptyId);
}

export function setSessionAuxState(
  id: string,
  auxPtyId: number,
  auxVisible: boolean,
  auxHeightPercent: number | null,
) {
  setSessionAuxStateInList(sessions, id, auxPtyId, auxVisible, auxHeightPercent);
}

export function setSessionResumeToken(id: string, resumeToken: string | null) {
  setSessionResumeTokenInList(sessions, id, resumeToken);
}

export function setSessionTitle(id: string, title: string) {
  setSessionTitleInList(sessions, id, title);
}

export function setSessionViewMode(id: string, viewMode: SessionViewMode) {
  setSessionViewModeInList(sessions, id, viewMode);
}

export function setSessionEditorRootDir(id: string, rootDir: string) {
  setSessionEditorRootDirInList(sessions, id, rootDir);
}

export function setSessionOpenEditorTabs(id: string, openEditorTabs: EditorTabRef[]) {
  setSessionOpenEditorTabsInList(sessions, id, openEditorTabs);
}

export function setSessionActiveEditorPath(id: string, activeEditorPath: string | null) {
  setSessionActiveEditorPathInList(sessions, id, activeEditorPath);
}

export function setSessionDirtyPaths(id: string, dirtyPaths: string[]) {
  setSessionDirtyPathsInList(sessions, id, dirtyPaths);
}

export function setSessionPinned(id: string, pinned: boolean) {
  setSessionPinnedInList(sessions, id, pinned);
}

export function setSessionLocked(id: string, locked: boolean) {
  setSessionLockedInList(sessions, id, locked);
}

export function setCurrentWindowName(name: string) {
  currentWindowName = name;
}

export function moveSession(id: string, toIndex: number) {
  moveSessionInList(sessions, id, toIndex);
}

export function getWorkspaceSnapshot(windowLabel = currentWindowLabel): WorkspaceSnapshot {
  return createWorkspaceSnapshotForWindow({
    sessions,
    activeSessionId,
    currentWindowLabel,
    currentWindowName,
    windowLabel,
  });
}

export function persistWorkspace(windowLabel = currentWindowLabel): Promise<void> {
  return queueWorkspaceSnapshotSave(workspacePersistence, getWorkspaceSnapshot(windowLabel));
}

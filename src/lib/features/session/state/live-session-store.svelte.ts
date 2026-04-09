import type {
  EditorTabRef,
  Session,
  SessionEditorState,
  SessionViewMode,
} from "../../../types";
import {
  moveSessionInList,
  removeSessionAndResolveActive,
  setSessionActiveEditorPathInList,
  setSessionAuxStateInList,
  setSessionDirtyPathsInList,
  setSessionEditorRootDirInList,
  setSessionEditorStateInList,
  setSessionLockedInList,
  setSessionOpenEditorTabsInList,
  setSessionPinnedInList,
  setSessionPtyIdInList,
  setSessionResumeTokenInList,
  setSessionTitleInList,
  setSessionViewModeInList,
} from "../service/live-session-mutations";

let sessions = $state<Session[]>([]);
let activeSessionId = $state<string | null>(null);

export function getSessions() {
  return sessions;
}

export function getActiveSessionId() {
  return activeSessionId;
}

export function getActiveSession(): Session | undefined {
  return sessions.find((session) => session.id === activeSessionId);
}

export function replaceLiveSessions(nextSessions: Session[], nextActiveSessionId: string | null) {
  sessions.splice(0, sessions.length, ...nextSessions);
  activeSessionId = nextActiveSessionId;
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

export function setSessionEditorState(id: string, editorState: SessionEditorState) {
  setSessionEditorStateInList(sessions, id, editorState);
}

export function setSessionPinned(id: string, pinned: boolean) {
  setSessionPinnedInList(sessions, id, pinned);
}

export function setSessionLocked(id: string, locked: boolean) {
  setSessionLockedInList(sessions, id, locked);
}

export function moveSession(id: string, toIndex: number) {
  moveSessionInList(sessions, id, toIndex);
}

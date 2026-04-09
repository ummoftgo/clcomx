import type { WorkspaceSnapshot } from "../../types";
import {
  getActiveSessionId as getLiveActiveSessionId,
  getSessions as getLiveSessions,
  replaceLiveSessions,
} from "../session/state/live-session-store.svelte";
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

let currentWindowLabel = "main";
let currentWindowName = $state("main");
const workspacePersistence = createWorkspacePersistenceState();

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
  const sessions = getLiveSessions();
  const windowSnapshot = workspace?.windows.find((window) => window.label === windowLabel);
  const result = applyWorkspaceWindowSnapshot({
    sessions,
    windowSnapshot,
    currentWindowLabel,
    preservePtyIds: true,
  });
  replaceLiveSessions(result.sessions, result.activeSessionId);
  currentWindowName = result.currentWindowName;
  markWorkspacePersistenceInitialized(workspacePersistence, getWorkspaceSnapshot(windowLabel));
}

export function syncSessionsFromWorkspace(workspace: WorkspaceSnapshot | null) {
  const sessions = getLiveSessions();
  const windowSnapshot = workspace?.windows.find((window) => window.label === currentWindowLabel);
  const result = applyWorkspaceWindowSnapshot({
    sessions,
    windowSnapshot,
    currentWindowLabel,
  });
  replaceLiveSessions(result.sessions, result.activeSessionId);
  currentWindowName = result.currentWindowName;
  syncWorkspacePersistenceSnapshot(workspacePersistence, getWorkspaceSnapshot(currentWindowLabel));
}

export function setCurrentWindowName(name: string) {
  currentWindowName = name;
}

export function getWorkspaceSnapshot(windowLabel = currentWindowLabel): WorkspaceSnapshot {
  return createWorkspaceSnapshotForWindow({
    sessions: getLiveSessions(),
    activeSessionId: getLiveActiveSessionId(),
    currentWindowLabel,
    currentWindowName,
    windowLabel,
  });
}

export function persistWorkspace(windowLabel = currentWindowLabel): Promise<void> {
  return queueWorkspaceSnapshotSave(workspacePersistence, getWorkspaceSnapshot(windowLabel));
}

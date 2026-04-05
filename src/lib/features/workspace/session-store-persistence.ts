import type { WorkspaceSnapshot } from "../../types";
import { saveWorkspaceSnapshot } from "../../workspace";

export interface WorkspacePersistenceState {
  sessionsInitialized: boolean;
  lastSavedWorkspace: string;
  saveQueue: Promise<void>;
}

export function createWorkspacePersistenceState(): WorkspacePersistenceState {
  return {
    sessionsInitialized: false,
    lastSavedWorkspace: "",
    saveQueue: Promise.resolve(),
  };
}

export function markWorkspacePersistenceInitialized(
  state: WorkspacePersistenceState,
  snapshot: WorkspaceSnapshot,
) {
  state.sessionsInitialized = true;
  state.lastSavedWorkspace = JSON.stringify(snapshot);
}

export function syncWorkspacePersistenceSnapshot(
  state: WorkspacePersistenceState,
  snapshot: WorkspaceSnapshot,
) {
  state.lastSavedWorkspace = JSON.stringify(snapshot);
}

export function persistWorkspaceSnapshot(
  state: WorkspacePersistenceState,
  snapshot: WorkspaceSnapshot,
): Promise<void> {
  const serialized = JSON.stringify(snapshot);
  if (!state.sessionsInitialized || serialized === state.lastSavedWorkspace) {
    return state.saveQueue;
  }

  state.saveQueue = state.saveQueue
    .catch(() => {})
    .then(async () => {
      try {
        await saveWorkspaceSnapshot(snapshot);
        state.lastSavedWorkspace = serialized;
      } catch (error) {
        console.error("Failed to save workspace", error);
      }
    });

  return state.saveQueue;
}

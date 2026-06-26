import type {
  SessionPersistedState,
  WorkspaceSnapshot,
  WorkspaceTabSnapshot,
  WorkspaceWindowSnapshot,
} from "../../types";
export {
  applyWorkspaceWindowSnapshot,
  createRuntimeSession,
} from "../session/service/live-session-workspace-sync";

export const MAIN_WINDOW_LABEL = "main";

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
    // direct runtime 식별 필드(10 §3.2). 미지정이면 복원 정규화에서 "pty"로 취급되므로 그대로 전달.
    runtimeKind: session.runtimeKind,
    agentRuntime: session.agentRuntime,
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

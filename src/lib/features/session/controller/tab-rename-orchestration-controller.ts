import type { AgentId } from "../../../agents";
import type { Session } from "../../../types";
import { resolveRenamedSessionTitle } from "../service/session-tab-behavior";

type RenameDialogKind = "tab" | "window" | null;

type TabRenameSession = Pick<
  Session,
  "agentId" | "distro" | "resumeToken" | "title" | "workDir"
>;

interface TabRenameOrchestrationControllerDependencies {
  getSession: (sessionId: string) => TabRenameSession | null;
  getRenameDialogKind: () => RenameDialogKind;
  getRenameDialogValue: () => string;
  getRenameTargetSessionId: () => string | null;
  setRenameDialogKind: (kind: RenameDialogKind) => void;
  setRenameDialogValue: (value: string) => void;
  setRenameTargetSessionId: (sessionId: string | null) => void;
  setSessionTitle: (sessionId: string, title: string) => void;
  recordTabHistory: (
    agentId: AgentId,
    distro: string,
    workDir: string,
    title: string,
    resumeToken?: string | null,
  ) => Promise<void>;
}

export function createTabRenameOrchestrationController(
  deps: TabRenameOrchestrationControllerDependencies,
) {
  const dismissRenameDialog = () => {
    deps.setRenameDialogKind(null);
    deps.setRenameDialogValue("");
    deps.setRenameTargetSessionId(null);
  };

  const requestRenameTab = (sessionId: string) => {
    const session = deps.getSession(sessionId);
    if (!session) {
      return false;
    }

    deps.setRenameDialogKind("tab");
    deps.setRenameTargetSessionId(sessionId);
    deps.setRenameDialogValue(session.title);
    return true;
  };

  const confirmRename = () => {
    if (deps.getRenameDialogKind() !== "tab") {
      return false;
    }

    const sessionId = deps.getRenameTargetSessionId();
    if (!sessionId) {
      dismissRenameDialog();
      return true;
    }

    const session = deps.getSession(sessionId);
    if (!session) {
      dismissRenameDialog();
      return true;
    }

    const nextTitle = resolveRenamedSessionTitle(session, deps.getRenameDialogValue());
    deps.setSessionTitle(sessionId, nextTitle);
    void deps.recordTabHistory(
      session.agentId,
      session.distro,
      session.workDir,
      nextTitle,
      session.resumeToken ?? null,
    );
    dismissRenameDialog();
    return true;
  };

  const reconcilePendingRenameDialog = () => {
    if (deps.getRenameDialogKind() !== "tab") {
      return false;
    }

    const sessionId = deps.getRenameTargetSessionId();
    if (!sessionId || deps.getSession(sessionId)) {
      return false;
    }

    dismissRenameDialog();
    return true;
  };

  return {
    dismissRenameDialog,
    requestRenameTab,
    confirmRename,
    reconcilePendingRenameDialog,
  };
}

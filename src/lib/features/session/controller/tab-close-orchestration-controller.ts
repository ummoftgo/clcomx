import type { Session } from "../../../types";
import { resolveCloseTabRequest, type CloseTabRequest } from "../service/session-tab-behavior";

interface TabCloseOrchestrationControllerDependencies {
  getSession: (sessionId: string) => Session | null;
  getPendingCloseSessionId: () => string | null;
  setPendingCloseSessionId: (sessionId: string | null) => void;
  getShowCloseTabDialog: () => boolean;
  getShowDirtyTabDialog: () => boolean;
  setShowCloseTabDialog: (open: boolean) => void;
  setShowDirtyTabDialog: (open: boolean) => void;
  closeTab: (sessionId: string) => Promise<void>;
}

function openCloseTabDialog(
  deps: TabCloseOrchestrationControllerDependencies,
  sessionId: string,
) {
  deps.setPendingCloseSessionId(sessionId);
  deps.setShowDirtyTabDialog(false);
  deps.setShowCloseTabDialog(true);
  return true;
}

function openDirtyTabDialog(
  deps: TabCloseOrchestrationControllerDependencies,
  sessionId: string,
) {
  deps.setPendingCloseSessionId(sessionId);
  deps.setShowCloseTabDialog(false);
  deps.setShowDirtyTabDialog(true);
  return true;
}

export function createTabCloseOrchestrationController(
  deps: TabCloseOrchestrationControllerDependencies,
) {
  const dismissCloseTabDialog = () => {
    deps.setShowCloseTabDialog(false);
    deps.setPendingCloseSessionId(null);
  };

  const dismissDirtyTabDialog = () => {
    deps.setShowDirtyTabDialog(false);
    deps.setPendingCloseSessionId(null);
  };

  const requestCloseTab = (sessionId: string): CloseTabRequest => {
    const session = deps.getSession(sessionId);
    switch (resolveCloseTabRequest(session)) {
      case "blocked":
        return "blocked";
      case "dirty-warning":
        openDirtyTabDialog(deps, sessionId);
        return "dirty-warning";
      case "close-confirm":
        openCloseTabDialog(deps, sessionId);
        return "close-confirm";
      case "close-now":
        void deps.closeTab(sessionId);
        return "close-now";
    }
  };

  const confirmCloseTab = async () => {
    const sessionId = deps.getPendingCloseSessionId();
    if (!sessionId) return false;

    dismissCloseTabDialog();
    await deps.closeTab(sessionId);
    return true;
  };

  const continueCloseTabAfterDirtyWarning = () => {
    const sessionId = deps.getPendingCloseSessionId();
    if (!sessionId) return "blocked" as const;

    deps.setShowDirtyTabDialog(false);
    const session = deps.getSession(sessionId);
    if (!session) {
      deps.setPendingCloseSessionId(null);
      return "blocked" as const;
    }

    if (session.ptyId >= 0) {
      openCloseTabDialog(deps, sessionId);
      return "close-confirm" as const;
    }

    deps.setPendingCloseSessionId(null);
    deps.setShowCloseTabDialog(false);
    void deps.closeTab(sessionId);
    return "close-now" as const;
  };

  const reconcilePendingCloseTab = () => {
    const sessionId = deps.getPendingCloseSessionId();
    if (!sessionId || deps.getSession(sessionId)) {
      return false;
    }

    if (deps.getShowCloseTabDialog()) {
      dismissCloseTabDialog();
      return true;
    }

    if (deps.getShowDirtyTabDialog()) {
      dismissDirtyTabDialog();
      return true;
    }

    deps.setPendingCloseSessionId(null);
    return true;
  };

  return {
    dismissCloseTabDialog,
    dismissDirtyTabDialog,
    openCloseTabDialog: (sessionId: string) => openCloseTabDialog(deps, sessionId),
    requestCloseTab,
    confirmCloseTab,
    continueCloseTabAfterDirtyWarning,
    reconcilePendingCloseTab,
  };
}

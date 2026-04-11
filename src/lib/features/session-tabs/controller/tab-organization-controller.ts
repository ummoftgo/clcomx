import { resolveAdjacentSessionMoveIndex } from "../../session/service/session-tab-behavior";

interface SessionTabOrganizationSession {
  id: string;
  pinned: boolean;
  locked: boolean;
}

interface TabOrganizationControllerDependencies {
  getSessions: () => SessionTabOrganizationSession[];
  setActiveSession: (sessionId: string) => void;
  moveSession: (sessionId: string, targetIndex: number) => void;
  setSessionPinned: (sessionId: string, pinned: boolean) => void;
  setSessionLocked: (sessionId: string, locked: boolean) => void;
}

export function createTabOrganizationController(
  deps: TabOrganizationControllerDependencies,
) {
  const togglePin = (sessionId: string) => {
    const session = deps.getSessions().find((entry) => entry.id === sessionId);
    if (!session) {
      return false;
    }

    deps.setSessionPinned(sessionId, !session.pinned);
    deps.setActiveSession(sessionId);
    return true;
  };

  const toggleLock = (sessionId: string) => {
    const session = deps.getSessions().find((entry) => entry.id === sessionId);
    if (!session) {
      return false;
    }

    deps.setSessionLocked(sessionId, !session.locked);
    deps.setActiveSession(sessionId);
    return true;
  };

  const moveLeft = (sessionId: string) => {
    const targetIndex = resolveAdjacentSessionMoveIndex(deps.getSessions(), sessionId, "left");
    if (targetIndex === null) {
      return false;
    }

    deps.moveSession(sessionId, targetIndex);
    deps.setActiveSession(sessionId);
    return true;
  };

  const moveRight = (sessionId: string) => {
    const targetIndex = resolveAdjacentSessionMoveIndex(deps.getSessions(), sessionId, "right");
    if (targetIndex === null) {
      return false;
    }

    deps.moveSession(sessionId, targetIndex);
    deps.setActiveSession(sessionId);
    return true;
  };

  return {
    togglePin,
    toggleLock,
    moveLeft,
    moveRight,
  };
}

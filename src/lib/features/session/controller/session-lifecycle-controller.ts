import type { AgentId } from "../../../agents";
import type { PtyResumeCaptureResult } from "../../../workspace";
import type { Session, TabHistoryEntry } from "../../../types";
import type { SessionShellAuxState } from "../contracts/session-shell";
import {
  applySessionAuxState,
  clearSessionResumeFallback,
  registerSessionPty,
  type SessionRuntimeDependencies,
} from "../service/session-runtime";
import { launchSession, launchSessionFromHistoryEntry } from "./session-launch-controller";

interface SessionLifecycleLaunchDependencies {
  addSession: (session: Session) => void;
  hideSessionLauncher: () => void;
  ensureSessionShellComponent: () => void | Promise<void>;
}

export interface SessionLifecycleControllerDependencies
  extends SessionLifecycleLaunchDependencies,
    SessionRuntimeDependencies {
  getSession: (sessionId: string) => Session | null;
  getSessions: () => Session[];
  clearSessionPty: (sessionId: string) => Promise<void>;
  closeSession: (sessionId: string) => Promise<void>;
  closeSessionByPtyId: (ptyId: number) => Promise<void>;
  closePtyAndCaptureResume: (
    ptyId: number,
    agentId: AgentId,
  ) => Promise<PtyResumeCaptureResult>;
  killPty: (ptyId: number) => Promise<void>;
}

function createLaunchDependencies(
  deps: SessionLifecycleLaunchDependencies & Pick<
    SessionRuntimeDependencies,
    "persistWorkspace"
  >,
) {
  return {
    addSession: deps.addSession,
    hideSessionLauncher: deps.hideSessionLauncher,
    persistWorkspace: deps.persistWorkspace,
    ensureSessionShellComponent: deps.ensureSessionShellComponent,
  };
}

export function createSessionLifecycleController(
  deps: SessionLifecycleControllerDependencies,
) {
  let capturingResumeOnAppClose = false;
  const pendingResumeCapturePtyIds = new Set<number>();

  const captureSessionResumeTokenForSession = async (
    session: Session,
  ): Promise<string | null> => {
    const existingResumeToken = session.resumeToken ?? null;
    if (session.ptyId < 0) {
      return existingResumeToken;
    }

    const ptyId = session.ptyId;
    pendingResumeCapturePtyIds.add(ptyId);
    try {
      const result = await deps.closePtyAndCaptureResume(ptyId, session.agentId);
      const nextResumeToken = result.resumeToken ?? existingResumeToken;
      deps.setSessionPtyId(session.id, -1);
      deps.setSessionResumeToken(session.id, nextResumeToken ?? null);
      await deps.clearSessionPty(session.id);
      await deps.persistSessionResumeToken(session.id, nextResumeToken ?? null);
      return nextResumeToken ?? null;
    } catch (error) {
      deps.reportError("Failed to capture session resume token", error);
      deps.setSessionPtyId(session.id, -1);
      deps.setSessionResumeToken(session.id, existingResumeToken);
      try {
        await deps.clearSessionPty(session.id);
        await deps.persistSessionResumeToken(session.id, existingResumeToken);
      } catch (persistError) {
        deps.reportError("Failed to persist resume state after capture failure", persistError);
      }
      return existingResumeToken;
    } finally {
      pendingResumeCapturePtyIds.delete(ptyId);
    }
  };

  const createSession = (
    agentId: AgentId,
    distro: string,
    workDir: string,
    title = workDir.split("/").pop() || workDir,
    resumeToken: string | null = null,
  ) => {
    launchSession(createLaunchDependencies(deps), {
      agentId,
      distro,
      workDir,
      title,
      resumeToken,
    });
  };

  const openHistoryEntry = (entry: TabHistoryEntry) => {
    launchSessionFromHistoryEntry(createLaunchDependencies(deps), entry);
  };

  const handlePtyId = async (sessionId: string, ptyId: number) => {
    const session = deps.getSession(sessionId);
    if (!session) return;

    await registerSessionPty(deps, sessionId, session, ptyId);
  };

  const handleAuxTerminalState = async (
    sessionId: string,
    state: SessionShellAuxState,
  ) => {
    await applySessionAuxState(deps, sessionId, state);
  };

  const handleExit = async (ptyId: number) => {
    if (capturingResumeOnAppClose || pendingResumeCapturePtyIds.has(ptyId)) return;

    try {
      await deps.closeSessionByPtyId(ptyId);
    } catch (error) {
      deps.reportError("Failed to close exited session", error);
    }
  };

  const handleResumeFallback = async (sessionId: string) => {
    await clearSessionResumeFallback(deps, sessionId);
  };

  const captureSessionResumeToken = async (sessionId: string): Promise<string | null> => {
    const session = deps.getSession(sessionId);
    if (!session) {
      return null;
    }
    return captureSessionResumeTokenForSession(session);
  };

  const captureResumeIdsBeforeAppClose = async () => {
    capturingResumeOnAppClose = true;
    try {
      const sessions = [...deps.getSessions()];
      for (const session of sessions) {
        const resumeToken = await captureSessionResumeTokenForSession(session);
        if (session.auxPtyId >= 0) {
          try {
            await deps.killPty(session.auxPtyId);
          } catch (error) {
            deps.reportError("Failed to stop auxiliary terminal PTY", error);
          }
        }

        deps.setSessionAuxState(session.id, -1, false, session.auxHeightPercent);
        try {
          await deps.persistSessionAuxState(
            session.id,
            null,
            false,
            session.auxHeightPercent,
          );
        } catch (error) {
          deps.reportError("Failed to clear auxiliary terminal state", error);
        }

        await deps.recordTabHistory(
          session.agentId,
          session.distro,
          session.workDir,
          session.title,
          resumeToken,
        );
      }

      await deps.persistWorkspace();
    } finally {
      capturingResumeOnAppClose = false;
    }
  };

  const handleCloseTab = async (sessionId: string) => {
    const session = deps.getSession(sessionId);
    if (!session) return;

    try {
      const resumeToken = await captureSessionResumeTokenForSession(session);
      await deps.recordTabHistory(
        session.agentId,
        session.distro,
        session.workDir,
        session.title,
        resumeToken,
      );
      await deps.closeSession(sessionId);
    } catch (error) {
      deps.reportError("Failed to close session", error);
    }
  };

  return {
    createSession,
    openHistoryEntry,
    handlePtyId,
    handleAuxTerminalState,
    handleExit,
    handleResumeFallback,
    captureSessionResumeToken,
    captureResumeIdsBeforeAppClose,
    handleCloseTab,
  };
}

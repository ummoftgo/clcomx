import type { AgentId } from "../../../agents";
import type { PtyResumeCaptureResult } from "../../../workspace";
import type { Session, TabHistoryEntry } from "../../../types";
import type { SessionRuntimeKind } from "../../agent-runtime/contracts/metadata";
import type { SessionShellAuxState } from "../contracts/session-shell";
import { clearResumeKeys } from "../../agent-runtime/service/resume-store";
import { clearTranscriptCache } from "../../agent-runtime/service/transcript-cache";
import {
  applySessionAuxState,
  clearSessionResumeFallback,
  registerSessionPty,
  recordSessionHistory,
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
    runtimeKind?: SessionRuntimeKind,
  ) => {
    launchSession(createLaunchDependencies(deps), {
      agentId,
      distro,
      workDir,
      title,
      resumeToken,
      runtimeKind,
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

        await recordSessionHistory(deps.recordTabHistory, session, session.title, resumeToken);
      }

      await deps.persistWorkspace();
    } finally {
      capturingResumeOnAppClose = false;
    }
  };

  /**
   * OQ-16 Task 11: 사용자가 direct 세션 탭을 명시적으로 닫을 때 고아 파일을 막기 위한 GC.
   * 암호화 재개 id 파일(clearResumeKeys)과 transcript 캐시 파일(clearTranscriptCache)을 정리한다.
   * best-effort — 실패해도 탭 닫기 흐름 자체를 막지 않는다(개별 catch로 격리).
   * [중요] 이 GC는 오직 사용자의 명시적 탭 닫기(handleCloseTab)에서만 호출한다.
   * 앱 종료(captureResumeIdsBeforeAppClose)·webview reload·컴포넌트 destroy 같은 teardown 경로는
   * 재시작 후 복원에 그 파일들이 필요하므로 절대 GC하지 않는다(component teardown은
   * AgentTranscriptSurface.disposeSurfaceRuntime이 별도로 담당하며 여기와 무관하다).
   */
  const gcDirectSessionFiles = async (sessionId: string, runtimeKind?: SessionRuntimeKind) => {
    if (!runtimeKind?.startsWith("direct-")) return;

    try {
      await clearResumeKeys(sessionId);
    } catch (error) {
      deps.reportError("Failed to clear resume keys on tab close", error);
    }
    try {
      await clearTranscriptCache(sessionId);
    } catch (error) {
      deps.reportError("Failed to clear transcript cache on tab close", error);
    }
  };

  const handleCloseTab = async (sessionId: string) => {
    const session = deps.getSession(sessionId);
    if (!session) return;

    try {
      const resumeToken = await captureSessionResumeTokenForSession(session);
      await recordSessionHistory(deps.recordTabHistory, session, session.title, resumeToken);
      await deps.closeSession(sessionId);
    } catch (error) {
      deps.reportError("Failed to close session", error);
    }

    await gcDirectSessionFiles(sessionId, session.runtimeKind);
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

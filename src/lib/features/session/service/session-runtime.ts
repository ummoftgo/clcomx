import type { Session } from "../../../types";
import type { SessionShellAuxState } from "../contracts/session-shell";

export interface SessionRuntimeDependencies {
  setSessionPtyId: (sessionId: string, ptyId: number) => void;
  persistSessionPty: (sessionId: string, ptyId: number) => Promise<void>;
  recordTabHistory: (
    agentId: Session["agentId"],
    distro: string,
    workDir: string,
    title: string,
    resumeToken: string | null,
  ) => void | Promise<void>;
  setSessionAuxState: (
    sessionId: string,
    auxPtyId: number,
    auxVisible: boolean,
    auxHeightPercent: number | null,
  ) => void;
  persistSessionAuxState: (
    sessionId: string,
    auxPtyId: number | null,
    auxVisible: boolean,
    auxHeightPercent: number | null,
  ) => Promise<void>;
  setSessionResumeToken: (sessionId: string, resumeToken: string | null) => void;
  persistSessionResumeToken: (sessionId: string, resumeToken: string | null) => Promise<void>;
  persistWorkspace: () => void | Promise<void>;
  reportError: (message: string, error: unknown) => void;
}

export async function registerSessionPty(
  deps: SessionRuntimeDependencies,
  sessionId: string,
  session: Session,
  ptyId: number,
) {
  deps.setSessionPtyId(sessionId, ptyId);
  try {
    await deps.persistSessionPty(sessionId, ptyId);
  } catch (error) {
    deps.reportError("Failed to register session PTY", error);
  }
  void deps.recordTabHistory(
    session.agentId,
    session.distro,
    session.workDir,
    session.title,
    session.resumeToken ?? null,
  );
}

export async function applySessionAuxState(
  deps: SessionRuntimeDependencies,
  sessionId: string,
  state: SessionShellAuxState,
) {
  deps.setSessionAuxState(
    sessionId,
    state.auxPtyId,
    state.auxVisible,
    state.auxHeightPercent,
  );
  try {
    await deps.persistSessionAuxState(
      sessionId,
      state.auxPtyId >= 0 ? state.auxPtyId : null,
      state.auxVisible,
      state.auxHeightPercent,
    );
  } catch (error) {
    deps.reportError("Failed to persist auxiliary terminal state", error);
  }
}

export async function clearSessionResumeFallback(
  deps: SessionRuntimeDependencies,
  sessionId: string,
) {
  deps.setSessionResumeToken(sessionId, null);
  try {
    await deps.persistSessionResumeToken(sessionId, null);
  } catch (error) {
    deps.reportError("Failed to clear invalid resume token", error);
  }
  void deps.persistWorkspace();
}

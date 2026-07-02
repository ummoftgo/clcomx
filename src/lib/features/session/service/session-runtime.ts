import type { AgentId } from "../../../agents";
import type { SessionCore } from "../../../types";
import type { SessionRuntimeKind } from "../../agent-runtime/contracts/metadata";
import type { SessionShellAuxState } from "../contracts/session-shell";

type SessionHistorySource = Pick<
  SessionCore,
  "agentId" | "resumeToken" | "title" | "distro" | "workDir" | "runtimeKind"
>;

export interface SessionRuntimeDependencies {
  setSessionPtyId: (sessionId: string, ptyId: number) => void;
  persistSessionPty: (sessionId: string, ptyId: number) => Promise<void>;
  recordTabHistory: (
    agentId: AgentId,
    distro: string,
    workDir: string,
    title: string,
    resumeToken: string | null,
    runtimeKind?: SessionRuntimeKind,
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

/** 최근 항목에는 direct 재실행에 필요한 runtime 표식만 저장하고, PTY는 legacy 형식으로 둔다. */
export function runtimeKindForHistory(runtimeKind?: SessionRuntimeKind) {
  return runtimeKind?.startsWith("direct-") ? runtimeKind : undefined;
}

/**
 * 세션 정보를 최근 항목에 기록한다.
 * @param recordTabHistory 최근 항목 저장 콜백.
 * @param session 기록할 세션의 핵심 정보.
 * @param title 저장할 제목. 생략하면 현재 세션 제목을 쓴다.
 * @param resumeToken 저장 경로에 전달할 resume token. history 계층에서 다시 제거된다.
 */
export function recordSessionHistory(
  recordTabHistory: SessionRuntimeDependencies["recordTabHistory"],
  session: SessionHistorySource,
  title = session.title,
  resumeToken: string | null = session.resumeToken ?? null,
) {
  const runtimeKind = runtimeKindForHistory(session.runtimeKind);
  if (runtimeKind) {
    return recordTabHistory(
      session.agentId,
      session.distro,
      session.workDir,
      title,
      resumeToken,
      runtimeKind,
    );
  }

  return recordTabHistory(
    session.agentId,
    session.distro,
    session.workDir,
    title,
    resumeToken,
  );
}

export async function registerSessionPty(
  deps: SessionRuntimeDependencies,
  sessionId: string,
  session: SessionHistorySource,
  ptyId: number,
) {
  deps.setSessionPtyId(sessionId, ptyId);
  try {
    await deps.persistSessionPty(sessionId, ptyId);
  } catch (error) {
    deps.reportError("Failed to register session PTY", error);
  }
  void recordSessionHistory(deps.recordTabHistory, session);
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

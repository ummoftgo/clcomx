import type { SessionCore, SessionEditorState, SessionShellRuntimeState } from "../../../types";

type SessionTabState = Pick<SessionCore, "id" | "pinned">;
type SessionCloseState =
  | (Pick<SessionCore, "locked" | "runtimeKind"> &
      Pick<SessionShellRuntimeState, "ptyId"> &
      Pick<SessionEditorState, "dirtyPaths">)
  | null
  | undefined;
type SessionRuntimeCloseState =
  | (Pick<SessionCore, "runtimeKind"> & Pick<SessionShellRuntimeState, "ptyId">)
  | null
  | undefined;

export type CloseTabRequest = "blocked" | "dirty-warning" | "close-confirm" | "close-now";
export type SessionMoveDirection = "left" | "right";

export function hasDirtyEditorState(session: SessionCloseState) {
  return Boolean(session && session.dirtyPaths.length > 0);
}

/** 세션 닫기 확인이 필요한 실행 중 host인지 판정한다. */
export function hasLiveSessionRuntime(session: SessionRuntimeCloseState) {
  return Boolean(session && (session.ptyId >= 0 || session.runtimeKind?.startsWith("direct-")));
}

export function resolveCloseTabRequest(session: SessionCloseState): CloseTabRequest {
  if (!session || session.locked) {
    return "blocked";
  }
  if (hasDirtyEditorState(session)) {
    return "dirty-warning";
  }
  if (hasLiveSessionRuntime(session)) {
    return "close-confirm";
  }
  return "close-now";
}

export function resolveAdjacentSessionMoveIndex(
  sessions: SessionTabState[],
  sessionId: string,
  direction: SessionMoveDirection,
): number | null {
  const session = sessions.find((entry) => entry.id === sessionId);
  if (!session) {
    return null;
  }

  const group = sessions.filter((entry) => entry.pinned === session.pinned);
  const groupIndex = group.findIndex((entry) => entry.id === sessionId);
  const targetGroupIndex = direction === "left" ? groupIndex - 1 : groupIndex + 1;
  const targetId = group[targetGroupIndex]?.id;
  if (!targetId) {
    return null;
  }

  const targetIndex = sessions.findIndex((entry) => entry.id === targetId);
  return targetIndex >= 0 ? targetIndex : null;
}

export function resolveRenamedSessionTitle(
  session: Pick<SessionCore, "workDir">,
  rawValue: string,
): string {
  const trimmed = rawValue.trim();
  const fallbackTitle = session.workDir.split("/").pop() || session.workDir;
  return trimmed || fallbackTitle;
}

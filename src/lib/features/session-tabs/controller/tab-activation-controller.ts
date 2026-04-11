type ActivateTabHandler = ((sessionId: string) => void) | undefined;
type RequestFocusHandler = ((sessionId: string) => void) | undefined;
type AnimationFrameScheduler = ((callback: FrameRequestCallback) => number) | undefined;

function getDefaultScheduler(): AnimationFrameScheduler {
  return typeof requestAnimationFrame === "function" ? requestAnimationFrame : undefined;
}

export function activateSessionTab(
  sessionId: string,
  draggingSessionId: string | null,
  activateTab: ActivateTabHandler,
) {
  if (draggingSessionId) {
    return false;
  }

  activateTab?.(sessionId);
  return true;
}

export function finalizeSessionTabPointerInteraction(
  dragCandidateId: string | null,
  draggingSessionId: string | null,
  activateTab: ActivateTabHandler,
) {
  const focusedSessionId = draggingSessionId ?? dragCandidateId;
  if (!focusedSessionId) {
    return null;
  }

  activateTab?.(focusedSessionId);
  return focusedSessionId;
}

export function requestSessionTabFocus(
  sessionId: string | null | undefined,
  requestSessionFocus: RequestFocusHandler,
) {
  if (!sessionId) {
    return false;
  }

  requestSessionFocus?.(sessionId);
  return true;
}

export function scheduleSessionTabFocus(
  sessionId: string,
  requestSessionFocus: RequestFocusHandler,
  schedule: AnimationFrameScheduler = getDefaultScheduler(),
) {
  if (!schedule) {
    requestSessionFocus?.(sessionId);
    return;
  }

  schedule(() => {
    requestSessionFocus?.(sessionId);
  });
}

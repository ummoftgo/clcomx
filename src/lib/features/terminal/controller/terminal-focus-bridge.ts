export const ACTIVE_TERMINAL_FOCUS_EVENT = "clcomx:focus-active-terminal";

type FocusRequestListenerTarget = Pick<Window, "addEventListener" | "removeEventListener">;
type FocusRequestDispatchTarget = Pick<Window, "dispatchEvent">;

export function addTerminalFocusRequestListener(
  target: FocusRequestListenerTarget,
  listener: EventListenerOrEventListenerObject,
) {
  target.addEventListener(ACTIVE_TERMINAL_FOCUS_EVENT, listener);
}

export function removeTerminalFocusRequestListener(
  target: FocusRequestListenerTarget,
  listener: EventListenerOrEventListenerObject,
) {
  target.removeEventListener(ACTIVE_TERMINAL_FOCUS_EVENT, listener);
}

export function dispatchTerminalFocusRequest(
  target: FocusRequestDispatchTarget,
  sessionId: string | null | undefined,
) {
  if (!sessionId) {
    return false;
  }

  target.dispatchEvent(new CustomEvent(ACTIVE_TERMINAL_FOCUS_EVENT, {
    detail: { sessionId },
  }));
  return true;
}

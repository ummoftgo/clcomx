import {
  finalizeSessionTabPointerInteraction,
  requestSessionTabFocus,
} from "./tab-activation-controller";
import type { SessionTabViewModel } from "../contracts/tab-bar";

const TAB_DRAG_THRESHOLD = 6;
const TAB_DRAG_PREVIEW_OFFSET_X = 14;
const TAB_DRAG_PREVIEW_OFFSET_Y = 12;
const TAB_DRAG_PREVIEW_WIDTH = 230;
const TAB_DRAG_PREVIEW_HEIGHT = 44;
const TAB_DRAG_PREVIEW_MIN_X = 10;
const TAB_DRAG_PREVIEW_MIN_Y = 8;

type ActivateTabHandler = ((sessionId: string) => void) | undefined;
type RequestFocusHandler = ((sessionId: string) => void) | undefined;
type PointerCaptureElement = Pick<
  HTMLElement,
  "hasPointerCapture" | "releasePointerCapture" | "setPointerCapture"
>;
type TabElement = Pick<HTMLDivElement, "getBoundingClientRect">;

export type SessionTabDragSession = Pick<SessionTabViewModel, "id" | "pinned" | "title">;

export interface SessionTabDragState {
  dragCandidateId: string | null;
  draggingSessionId: string | null;
  dragPointerId: number | null;
  dragStartX: number;
  dragStartY: number;
  dragCurrentX: number;
  dragCurrentY: number;
  dragSourceElement: PointerCaptureElement | null;
}

export interface SessionTabDragMoveResult {
  draggingSessionId: string;
  targetIndex: number | null;
}

export interface SessionTabDragFinalizeOptions {
  activateTab: ActivateTabHandler;
  requestSessionFocus: RequestFocusHandler;
  settleView?: (() => void | Promise<void>) | undefined;
}

export interface SessionTabDragCancelOptions {
  activeSessionId: string | null;
  requestSessionFocus: RequestFocusHandler;
  settleView?: (() => void | Promise<void>) | undefined;
}

export interface SessionTabDragPreviewViewport {
  innerHeight: number;
  innerWidth: number;
}

export interface SessionTabPointerEventLike {
  button?: number;
  clientX: number;
  clientY: number;
  currentTarget?: EventTarget | null;
  pointerId: number;
}

function releasePointerCapture(state: SessionTabDragState) {
  if (
    state.dragSourceElement &&
    state.dragPointerId !== null &&
    state.dragSourceElement.hasPointerCapture?.(state.dragPointerId)
  ) {
    state.dragSourceElement.releasePointerCapture(state.dragPointerId);
  }
}

function resetSessionTabDrag(state: SessionTabDragState) {
  releasePointerCapture(state);
  state.dragCandidateId = null;
  state.draggingSessionId = null;
  state.dragPointerId = null;
  state.dragSourceElement = null;
}

function resolveSessionTabDragTargetIndex(
  sessions: SessionTabDragSession[],
  draggingSessionId: string,
  hoveredSessionId: string | null,
) {
  if (!hoveredSessionId || hoveredSessionId === draggingSessionId) {
    return null;
  }

  const draggingSession = sessions.find((session) => session.id === draggingSessionId);
  const hoveredSession = sessions.find((session) => session.id === hoveredSessionId);
  if (!draggingSession || !hoveredSession || draggingSession.pinned !== hoveredSession.pinned) {
    return null;
  }

  const targetIndex = sessions.findIndex((session) => session.id === hoveredSessionId);
  return targetIndex >= 0 ? targetIndex : null;
}

export function createSessionTabDragState(): SessionTabDragState {
  return {
    dragCandidateId: null,
    draggingSessionId: null,
    dragPointerId: null,
    dragStartX: 0,
    dragStartY: 0,
    dragCurrentX: 0,
    dragCurrentY: 0,
    dragSourceElement: null,
  };
}

export function createSessionTabElementRegistry() {
  const tabElements = new Map<string, TabElement>();

  const trackTab = (element: HTMLDivElement, sessionId: string) => {
    tabElements.set(sessionId, element);
    return {
      update(nextSessionId: string) {
        if (nextSessionId !== sessionId) {
          tabElements.delete(sessionId);
          sessionId = nextSessionId;
          tabElements.set(sessionId, element);
        }
      },
      destroy() {
        tabElements.delete(sessionId);
      },
    };
  };

  const findHoveredSessionId = (clientX: number, clientY: number) => {
    const hits: Array<{ centerDistance: number; left: number; sessionId: string }> = [];

    for (const [sessionId, element] of tabElements.entries()) {
      const rect = element.getBoundingClientRect();
      if (
        clientX >= rect.left &&
        clientX <= rect.right &&
        clientY >= rect.top &&
        clientY <= rect.bottom
      ) {
        hits.push({
          centerDistance: Math.abs(((rect.left + rect.right) / 2) - clientX),
          left: rect.left,
          sessionId,
        });
      }
    }

    hits.sort((left, right) => (
      left.centerDistance - right.centerDistance ||
      left.left - right.left
    ));
    return hits[0]?.sessionId ?? null;
  };

  return {
    findHoveredSessionId,
    trackTab,
  };
}

export function beginSessionTabDrag(
  state: SessionTabDragState,
  event: SessionTabPointerEventLike,
  sessionId: string,
) {
  if (event.button !== 0) {
    return false;
  }

  state.dragCandidateId = sessionId;
  state.dragPointerId = event.pointerId;
  state.dragStartX = event.clientX;
  state.dragStartY = event.clientY;
  state.dragCurrentX = event.clientX;
  state.dragCurrentY = event.clientY;
  state.dragSourceElement = (event.currentTarget as PointerCaptureElement | null) ?? null;
  state.dragSourceElement?.setPointerCapture?.(event.pointerId);
  return true;
}

export function updateSessionTabDrag(
  state: SessionTabDragState,
  event: SessionTabPointerEventLike,
  sessions: SessionTabDragSession[],
  findHoveredSessionId: (clientX: number, clientY: number) => string | null,
): SessionTabDragMoveResult | null {
  if (!state.dragCandidateId || state.dragPointerId !== event.pointerId) {
    return null;
  }

  state.dragCurrentX = event.clientX;
  state.dragCurrentY = event.clientY;

  const moved = Math.hypot(event.clientX - state.dragStartX, event.clientY - state.dragStartY);
  if (!state.draggingSessionId && moved < TAB_DRAG_THRESHOLD) {
    return null;
  }

  state.draggingSessionId = state.dragCandidateId;
  const hoveredSessionId = findHoveredSessionId(event.clientX, event.clientY);
  return {
    draggingSessionId: state.draggingSessionId,
    targetIndex: resolveSessionTabDragTargetIndex(
      sessions,
      state.draggingSessionId,
      hoveredSessionId,
    ),
  };
}

export function finalizeSessionTabDrag(
  state: SessionTabDragState,
  pointerId: number,
  activateTab: ActivateTabHandler,
) {
  if (!state.dragCandidateId || state.dragPointerId !== pointerId) {
    return null;
  }

  const focusedSessionId = finalizeSessionTabPointerInteraction(
    state.dragCandidateId,
    state.draggingSessionId,
    activateTab,
  );
  resetSessionTabDrag(state);
  return focusedSessionId;
}

export async function finalizeSessionTabDragInteraction(
  state: SessionTabDragState,
  pointerId: number,
  options: SessionTabDragFinalizeOptions,
) {
  const focusedSessionId = finalizeSessionTabDrag(state, pointerId, options.activateTab);
  if (!focusedSessionId) {
    return null;
  }

  await options.settleView?.();
  requestSessionTabFocus(focusedSessionId, options.requestSessionFocus);
  return focusedSessionId;
}

export function cancelSessionTabDrag(
  state: SessionTabDragState,
  pointerId: number,
) {
  if (!state.dragCandidateId || state.dragPointerId !== pointerId) {
    return false;
  }

  resetSessionTabDrag(state);
  return true;
}

export async function cancelSessionTabDragInteraction(
  state: SessionTabDragState,
  pointerId: number,
  options: SessionTabDragCancelOptions,
) {
  if (!cancelSessionTabDrag(state, pointerId)) {
    return false;
  }

  await options.settleView?.();
  requestSessionTabFocus(options.activeSessionId, options.requestSessionFocus);
  return true;
}

export function getSessionTabDragPreviewTitle(
  sessions: SessionTabDragSession[],
  draggingSessionId: string | null,
) {
  if (!draggingSessionId) {
    return "";
  }

  return sessions.find((session) => session.id === draggingSessionId)?.title ?? "";
}

export function getSessionTabDragPreviewStyle(
  state: Pick<SessionTabDragState, "dragCurrentX" | "dragCurrentY">,
  viewport: SessionTabDragPreviewViewport,
) {
  const maxX = Math.max(TAB_DRAG_PREVIEW_MIN_X, viewport.innerWidth - TAB_DRAG_PREVIEW_WIDTH);
  const maxY = Math.max(TAB_DRAG_PREVIEW_MIN_Y, viewport.innerHeight - TAB_DRAG_PREVIEW_HEIGHT);
  const x = Math.min(maxX, Math.max(TAB_DRAG_PREVIEW_MIN_X, state.dragCurrentX + TAB_DRAG_PREVIEW_OFFSET_X));
  const y = Math.min(maxY, Math.max(TAB_DRAG_PREVIEW_MIN_Y, state.dragCurrentY + TAB_DRAG_PREVIEW_OFFSET_Y));
  return `left:${x}px;top:${y}px;`;
}

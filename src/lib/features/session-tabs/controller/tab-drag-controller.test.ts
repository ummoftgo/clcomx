import { describe, expect, it, vi } from "vitest";
import {
  beginSessionTabDrag,
  cancelSessionTabDrag,
  cancelSessionTabDragInteraction,
  createSessionTabElementRegistry,
  createSessionTabDragState,
  finalizeSessionTabDrag,
  finalizeSessionTabDragInteraction,
  getSessionTabDragPreviewStyle,
  getSessionTabDragPreviewTitle,
  updateSessionTabDrag,
} from "./tab-drag-controller";

const SESSIONS = [
  { id: "session-a", pinned: false, title: "Alpha" },
  { id: "session-b", pinned: false, title: "Beta" },
  { id: "session-c", pinned: true, title: "Gamma" },
];

describe("tab-drag-controller", () => {
  it("starts drag tracking only for the primary pointer button", () => {
    const state = createSessionTabDragState();
    const sourceElement = {
      setPointerCapture: vi.fn(),
    };

    expect(beginSessionTabDrag(state, {
      button: 1,
      clientX: 10,
      clientY: 20,
      currentTarget: sourceElement as unknown as EventTarget,
      pointerId: 7,
    }, "session-a")).toBe(false);
    expect(sourceElement.setPointerCapture).not.toHaveBeenCalled();

    expect(beginSessionTabDrag(state, {
      button: 0,
      clientX: 10,
      clientY: 20,
      currentTarget: sourceElement as unknown as EventTarget,
      pointerId: 7,
    }, "session-a")).toBe(true);
    expect(sourceElement.setPointerCapture).toHaveBeenCalledWith(7);
    expect(state.dragCandidateId).toBe("session-a");
  });

  it("keeps click-sized motion below the drag threshold", () => {
    const state = createSessionTabDragState();

    beginSessionTabDrag(state, {
      button: 0,
      clientX: 10,
      clientY: 20,
      currentTarget: null,
      pointerId: 7,
    }, "session-b");

    const result = updateSessionTabDrag(
      state,
      {
        clientX: 13,
        clientY: 23,
        pointerId: 7,
      },
      SESSIONS,
      () => "session-a",
    );

    expect(result).toBeNull();
    expect(state.draggingSessionId).toBeNull();
  });

  it("returns a reorder target when dragging across a tab in the same pin group", () => {
    const state = createSessionTabDragState();

    beginSessionTabDrag(state, {
      button: 0,
      clientX: 10,
      clientY: 20,
      currentTarget: null,
      pointerId: 7,
    }, "session-b");

    const result = updateSessionTabDrag(
      state,
      {
        clientX: 30,
        clientY: 40,
        pointerId: 7,
      },
      SESSIONS,
      () => "session-a",
    );

    expect(result).toEqual({
      draggingSessionId: "session-b",
      targetIndex: 0,
    });
    expect(state.draggingSessionId).toBe("session-b");
  });

  it("keeps drag active but blocks reorder across a pinned boundary", () => {
    const state = createSessionTabDragState();

    beginSessionTabDrag(state, {
      button: 0,
      clientX: 10,
      clientY: 20,
      currentTarget: null,
      pointerId: 7,
    }, "session-b");

    const result = updateSessionTabDrag(
      state,
      {
        clientX: 30,
        clientY: 40,
        pointerId: 7,
      },
      SESSIONS,
      () => "session-c",
    );

    expect(result).toEqual({
      draggingSessionId: "session-b",
      targetIndex: null,
    });
    expect(state.draggingSessionId).toBe("session-b");
  });

  it("finalizes the drag, activates the resolved session, and releases pointer capture", () => {
    const releasePointerCapture = vi.fn();
    const activateTab = vi.fn();
    const state = createSessionTabDragState();
    const sourceElement = {
      hasPointerCapture: () => true,
      releasePointerCapture,
      setPointerCapture: vi.fn(),
    };

    beginSessionTabDrag(state, {
      button: 0,
      clientX: 10,
      clientY: 20,
      currentTarget: sourceElement as unknown as EventTarget,
      pointerId: 7,
    }, "session-b");

    updateSessionTabDrag(
      state,
      {
        clientX: 30,
        clientY: 40,
        pointerId: 7,
      },
      SESSIONS,
      () => "session-a",
    );

    const focusedSessionId = finalizeSessionTabDrag(state, 7, activateTab);

    expect(focusedSessionId).toBe("session-b");
    expect(activateTab).toHaveBeenCalledWith("session-b");
    expect(releasePointerCapture).toHaveBeenCalledWith(7);
    expect(state.dragCandidateId).toBeNull();
    expect(state.draggingSessionId).toBeNull();
  });

  it("cancels drag only for the active pointer id", () => {
    const state = createSessionTabDragState();

    beginSessionTabDrag(state, {
      button: 0,
      clientX: 10,
      clientY: 20,
      currentTarget: null,
      pointerId: 7,
    }, "session-b");

    expect(cancelSessionTabDrag(state, 8)).toBe(false);
    expect(state.dragCandidateId).toBe("session-b");

    expect(cancelSessionTabDrag(state, 7)).toBe(true);
    expect(state.dragCandidateId).toBeNull();
  });

  it("settles the view and requests focus when a drag interaction finalizes", async () => {
    const activateTab = vi.fn();
    const requestSessionFocus = vi.fn();
    const settleView = vi.fn();
    const state = createSessionTabDragState();

    beginSessionTabDrag(state, {
      button: 0,
      clientX: 10,
      clientY: 20,
      currentTarget: null,
      pointerId: 7,
    }, "session-b");

    await finalizeSessionTabDragInteraction(state, 7, {
      activateTab,
      requestSessionFocus,
      settleView,
    });

    expect(activateTab).toHaveBeenCalledWith("session-b");
    expect(settleView).toHaveBeenCalledOnce();
    expect(requestSessionFocus).toHaveBeenCalledWith("session-b");
  });

  it("settles the view and restores focus when a drag interaction cancels", async () => {
    const requestSessionFocus = vi.fn();
    const settleView = vi.fn();
    const state = createSessionTabDragState();

    beginSessionTabDrag(state, {
      button: 0,
      clientX: 10,
      clientY: 20,
      currentTarget: null,
      pointerId: 7,
    }, "session-b");

    await cancelSessionTabDragInteraction(state, 7, {
      activeSessionId: "session-a",
      requestSessionFocus,
      settleView,
    });

    expect(settleView).toHaveBeenCalledOnce();
    expect(requestSessionFocus).toHaveBeenCalledWith("session-a");
  });

  it("resolves preview title and clamps preview style within the viewport", () => {
    const state = createSessionTabDragState();
    state.dragCurrentX = 990;
    state.dragCurrentY = 990;

    expect(getSessionTabDragPreviewTitle(SESSIONS, "session-c")).toBe("Gamma");
    expect(getSessionTabDragPreviewStyle(state, {
      innerHeight: 600,
      innerWidth: 800,
    })).toBe("left:570px;top:556px;");
  });

  it("resolves hovered session by geometry instead of map insertion order", () => {
    const registry = createSessionTabElementRegistry();
    const rightElement = {
      getBoundingClientRect: () => ({
        bottom: 40,
        left: 100,
        right: 200,
        top: 0,
      }),
    } as HTMLDivElement;
    const leftElement = {
      getBoundingClientRect: () => ({
        bottom: 40,
        left: 0,
        right: 100,
        top: 0,
      }),
    } as HTMLDivElement;

    registry.trackTab(rightElement, "session-b");
    registry.trackTab(leftElement, "session-a");

    expect(registry.findHoveredSessionId(100, 20)).toBe("session-a");
  });
});

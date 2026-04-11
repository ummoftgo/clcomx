import { describe, expect, it, vi } from "vitest";
import type { SessionTabViewModel } from "../contracts/tab-bar";
import { createTabOrganizationController } from "./tab-organization-controller";

function createSession(overrides: Partial<SessionTabViewModel> = {}): SessionTabViewModel {
  return {
    id: "session-a",
    agentId: "claude",
    title: "Alpha",
    pinned: false,
    locked: false,
    ...overrides,
  };
}

function createController(sessions: SessionTabViewModel[] = [createSession()]) {
  const setActiveSession = vi.fn();
  const moveSession = vi.fn();
  const setSessionPinned = vi.fn();
  const setSessionLocked = vi.fn();
  const controller = createTabOrganizationController({
    getSessions: () => sessions,
    setActiveSession,
    moveSession,
    setSessionPinned,
    setSessionLocked,
  });

  return {
    controller,
    setActiveSession,
    moveSession,
    setSessionPinned,
    setSessionLocked,
  };
}

describe("tab-organization-controller", () => {
  it("toggles pinned state and activates the target session", () => {
    const { controller, setActiveSession, setSessionPinned } = createController([
      createSession({ id: "session-a", pinned: false }),
    ]);

    expect(controller.togglePin("session-a")).toBe(true);
    expect(setSessionPinned).toHaveBeenCalledWith("session-a", true);
    expect(setActiveSession).toHaveBeenCalledWith("session-a");
  });

  it("toggles locked state and activates the target session", () => {
    const { controller, setActiveSession, setSessionLocked } = createController([
      createSession({ id: "session-a", locked: true }),
    ]);

    expect(controller.toggleLock("session-a")).toBe(true);
    expect(setSessionLocked).toHaveBeenCalledWith("session-a", false);
    expect(setActiveSession).toHaveBeenCalledWith("session-a");
  });

  it("moves a session left within the same pin group and re-activates it", () => {
    const { controller, moveSession, setActiveSession } = createController([
      createSession({ id: "session-a", pinned: false }),
      createSession({ id: "session-b", pinned: false, title: "Beta" }),
      createSession({ id: "session-c", pinned: true, title: "Gamma" }),
    ]);

    expect(controller.moveLeft("session-b")).toBe(true);
    expect(moveSession).toHaveBeenCalledWith("session-b", 0);
    expect(setActiveSession).toHaveBeenCalledWith("session-b");
  });

  it("moves a session right within the same pin group and re-activates it", () => {
    const { controller, moveSession, setActiveSession } = createController([
      createSession({ id: "session-a", pinned: false }),
      createSession({ id: "session-b", pinned: false, title: "Beta" }),
      createSession({ id: "session-c", pinned: true, title: "Gamma" }),
      createSession({ id: "session-d", pinned: true, title: "Delta" }),
    ]);

    expect(controller.moveRight("session-c")).toBe(true);
    expect(moveSession).toHaveBeenCalledWith("session-c", 3);
    expect(setActiveSession).toHaveBeenCalledWith("session-c");
  });

  it("does nothing when the session is missing or cannot move in that direction", () => {
    const { controller, moveSession, setActiveSession, setSessionPinned, setSessionLocked } =
      createController([
        createSession({ id: "session-a", pinned: false }),
        createSession({ id: "session-b", pinned: false, title: "Beta" }),
      ]);

    expect(controller.togglePin("missing")).toBe(false);
    expect(controller.toggleLock("missing")).toBe(false);
    expect(controller.moveLeft("session-a")).toBe(false);
    expect(controller.moveRight("session-b")).toBe(false);

    expect(moveSession).not.toHaveBeenCalled();
    expect(setActiveSession).not.toHaveBeenCalled();
    expect(setSessionPinned).not.toHaveBeenCalled();
    expect(setSessionLocked).not.toHaveBeenCalled();
  });
});

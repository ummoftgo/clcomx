import { describe, expect, it, vi } from "vitest";
import {
  activateSessionTab,
  finalizeSessionTabPointerInteraction,
  requestSessionTabFocus,
  scheduleSessionTabFocus,
} from "./tab-activation-controller";

describe("tab-activation-controller", () => {
  it("skips click activation while a drag session is active", () => {
    const activateTab = vi.fn();

    const activated = activateSessionTab("session-a", "session-b", activateTab);

    expect(activated).toBe(false);
    expect(activateTab).not.toHaveBeenCalled();
  });

  it("activates the dragged session on pointer finalize", () => {
    const activateTab = vi.fn();

    const focusedSessionId = finalizeSessionTabPointerInteraction(
      "session-a",
      "session-b",
      activateTab,
    );

    expect(focusedSessionId).toBe("session-b");
    expect(activateTab).toHaveBeenCalledWith("session-b");
  });

  it("schedules focus restore for tab actions", () => {
    const requestTerminalFocus = vi.fn();
    const schedule = vi.fn((callback: FrameRequestCallback) => {
      callback(16);
      return 1;
    });

    scheduleSessionTabFocus("session-a", requestTerminalFocus, schedule);

    expect(schedule).toHaveBeenCalledTimes(1);
    expect(requestTerminalFocus).toHaveBeenCalledWith("session-a");
  });

  it("falls back to direct focus restore when requestAnimationFrame is unavailable", () => {
    const requestTerminalFocus = vi.fn();
    vi.stubGlobal("requestAnimationFrame", undefined);

    scheduleSessionTabFocus("session-a", requestTerminalFocus);

    expect(requestTerminalFocus).toHaveBeenCalledWith("session-a");
    vi.unstubAllGlobals();
  });

  it("requests focus only when a session id exists", () => {
    const requestTerminalFocus = vi.fn();

    expect(requestSessionTabFocus(null, requestTerminalFocus)).toBe(false);
    expect(requestSessionTabFocus("session-a", requestTerminalFocus)).toBe(true);
    expect(requestTerminalFocus).toHaveBeenCalledOnce();
    expect(requestTerminalFocus).toHaveBeenCalledWith("session-a");
  });
});

import { describe, expect, it, vi } from "vitest";
import { createTerminalTestBridgeController } from "./terminal-test-bridge-controller";
import {
  ACTIVE_TERMINAL_FOCUS_EVENT,
  addTerminalFocusRequestListener,
  dispatchTerminalFocusRequest,
  removeTerminalFocusRequestListener,
} from "./terminal-focus-bridge";

describe("terminal-focus-bridge", () => {
  it("dispatches a terminal focus request event with the session id", () => {
    const dispatchedEvents: Event[] = [];
    const target = {
      dispatchEvent(event: Event) {
        dispatchedEvents.push(event);
        return true;
      },
    };

    const dispatched = dispatchTerminalFocusRequest(target, "session-a");

    expect(dispatched).toBe(true);
    expect(dispatchedEvents).toHaveLength(1);
    expect(dispatchedEvents[0]).toBeInstanceOf(CustomEvent);
    expect((dispatchedEvents[0] as CustomEvent).type).toBe(ACTIVE_TERMINAL_FOCUS_EVENT);
    expect((dispatchedEvents[0] as CustomEvent).detail).toEqual({ sessionId: "session-a" });
  });

  it("registers and removes the terminal focus listener with the same event name", () => {
    const calls: Array<{ type: string; listener: EventListenerOrEventListenerObject }> = [];
    const listener = () => {};
    const target = {
      addEventListener(type: string, nextListener: EventListenerOrEventListenerObject) {
        calls.push({ type: `add:${type}`, listener: nextListener });
      },
      removeEventListener(type: string, nextListener: EventListenerOrEventListenerObject) {
        calls.push({ type: `remove:${type}`, listener: nextListener });
      },
    };

    addTerminalFocusRequestListener(target, listener);
    removeTerminalFocusRequestListener(target, listener);

    expect(calls).toEqual([
      { type: `add:${ACTIVE_TERMINAL_FOCUS_EVENT}`, listener },
      { type: `remove:${ACTIVE_TERMINAL_FOCUS_EVENT}`, listener },
    ]);
  });

  it("delivers the focus request through the window listener to the terminal focus handler", () => {
    const focusOutput = vi.fn();
    const controller = createTerminalTestBridgeController({
      getSessionId: () => "session-a",
      focusOutput,
      isTestBridgeEnabled: () => false,
      openClipboardPreview: () => {},
      setClipboardNotice: () => {},
      getLivePtyId: () => -1,
      getAuxPtyId: () => -1,
      getPtyOutputSnapshot: async () => null,
      getTerminal: () => null,
      getTestHooks: () => ({}),
      openUrlMenu: () => {},
      openFileMenu: async () => {},
    });

    addTerminalFocusRequestListener(window, controller.handleFocusRequest);
    try {
      dispatchTerminalFocusRequest(window, "session-a");
      expect(focusOutput).toHaveBeenCalledOnce();
    } finally {
      removeTerminalFocusRequestListener(window, controller.handleFocusRequest);
    }
  });

  it("ignores a focus request for a different session", () => {
    const focusOutput = vi.fn();
    const controller = createTerminalTestBridgeController({
      getSessionId: () => "session-a",
      focusOutput,
      isTestBridgeEnabled: () => false,
      openClipboardPreview: () => {},
      setClipboardNotice: () => {},
      getLivePtyId: () => -1,
      getAuxPtyId: () => -1,
      getPtyOutputSnapshot: async () => null,
      getTerminal: () => null,
      getTestHooks: () => ({}),
      openUrlMenu: () => {},
      openFileMenu: async () => {},
    });

    addTerminalFocusRequestListener(window, controller.handleFocusRequest);
    try {
      dispatchTerminalFocusRequest(window, "session-b");
      expect(focusOutput).not.toHaveBeenCalled();
    } finally {
      removeTerminalFocusRequestListener(window, controller.handleFocusRequest);
    }
  });
});

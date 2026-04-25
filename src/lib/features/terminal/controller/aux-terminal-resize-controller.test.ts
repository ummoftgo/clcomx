import { describe, expect, it, vi, afterEach } from "vitest";
import {
  calculateAuxResizeHeightPercent,
  clampAuxHeightPercent,
  createAuxTerminalResizeController,
} from "./aux-terminal-resize-controller";

function pointerEventStub(
  overrides: Partial<Pick<PointerEvent, "button" | "clientY" | "pointerId">> = {},
) {
  return {
    button: overrides.button ?? 0,
    clientY: overrides.clientY ?? 0,
    pointerId: overrides.pointerId ?? 1,
    preventDefault: vi.fn(),
  } as unknown as PointerEvent & { preventDefault: ReturnType<typeof vi.fn> };
}

function createController(overrides: {
  auxVisible?: boolean;
  shellHeight?: number | null;
  assistPanelHeight?: number;
  defaultHeightPercent?: number;
  heightPercent?: number;
} = {}) {
  let heightPercent = overrides.heightPercent ?? 28;
  let heightCustomized = false;
  const controller = createAuxTerminalResizeController({
    getAuxVisible: () => overrides.auxVisible ?? true,
    getDefaultHeightPercent: () => overrides.defaultHeightPercent ?? 28,
    getShellHeight: () => overrides.shellHeight ?? 500,
    getAssistPanelHeight: () => overrides.assistPanelHeight ?? 100,
    getHeightPercent: () => heightPercent,
    setHeightPercent: (value) => {
      heightPercent = value;
    },
    markHeightCustomized: () => {
      heightCustomized = true;
    },
  });

  return {
    controller,
    getHeightPercent: () => heightPercent,
    getHeightCustomized: () => heightCustomized,
  };
}

function getRegisteredWindowListener(
  spy: { mock: { calls: unknown[][] } },
  type: string,
) {
  const listener = spy.mock.calls.find(([eventType]) => eventType === type)?.[1];
  if (typeof listener !== "function") {
    throw new Error(`Expected ${type} listener to be registered`);
  }
  return listener as (event: PointerEvent) => void;
}

afterEach(() => {
  vi.restoreAllMocks();
  document.body.style.removeProperty("cursor");
  document.body.style.removeProperty("user-select");
});

describe("aux-terminal-resize-controller", () => {
  it("clamps aux panel height to the allowed range", () => {
    expect(clampAuxHeightPercent(10, 28)).toBe(18);
    expect(clampAuxHeightPercent(71, 28)).toBe(70);
    expect(clampAuxHeightPercent(35.6, 28)).toBe(36);
    expect(clampAuxHeightPercent(Number.NaN, 42)).toBe(42);
    expect(clampAuxHeightPercent(Number.NaN, Number.NaN)).toBe(28);
  });

  it("calculates drag resize percentages from shell and assist panel height", () => {
    expect(
      calculateAuxResizeHeightPercent({
        startY: 500,
        currentY: 450,
        startPercent: 28,
        shellHeight: 500,
        assistPanelHeight: 100,
        defaultHeightPercent: 28,
      }),
    ).toBe(41);
  });

  it("starts resize tracking only for visible aux panel left-button drags", () => {
    const addSpy = vi.spyOn(window, "addEventListener");
    const { controller } = createController({ auxVisible: false });
    const hiddenEvent = pointerEventStub({ button: 0 });

    controller.handleResizeStart(hiddenEvent);

    expect(hiddenEvent.preventDefault).not.toHaveBeenCalled();
    expect(addSpy).not.toHaveBeenCalled();

    const visibleController = createController({ auxVisible: true }).controller;
    const rightClick = pointerEventStub({ button: 2 });

    visibleController.handleResizeStart(rightClick);

    expect(rightClick.preventDefault).not.toHaveBeenCalled();
    expect(addSpy).not.toHaveBeenCalled();
  });

  it("updates height and customized state during matching pointer drags", () => {
    const addSpy = vi.spyOn(window, "addEventListener");
    const { controller, getHeightPercent, getHeightCustomized } = createController({
      heightPercent: 28,
      shellHeight: 500,
      assistPanelHeight: 100,
    });

    controller.handleResizeStart(pointerEventStub({ pointerId: 7, clientY: 500 }));
    try {
      const moveListener = getRegisteredWindowListener(addSpy, "pointermove");
      const wrongPointerMove = pointerEventStub({ pointerId: 8, clientY: 450 });

      moveListener(wrongPointerMove);

      expect(wrongPointerMove.preventDefault).not.toHaveBeenCalled();
      expect(getHeightPercent()).toBe(28);
      expect(getHeightCustomized()).toBe(false);

      const matchingPointerMove = pointerEventStub({ pointerId: 7, clientY: 450 });

      moveListener(matchingPointerMove);

      expect(matchingPointerMove.preventDefault).toHaveBeenCalledTimes(1);
      expect(getHeightPercent()).toBe(41);
      expect(getHeightCustomized()).toBe(true);
    } finally {
      controller.stopResize();
    }
  });

  it("stops resize tracking and clears global pointer affordances", () => {
    const removeSpy = vi.spyOn(window, "removeEventListener");
    const { controller } = createController();

    controller.handleResizeStart(pointerEventStub({ pointerId: 7, clientY: 500 }));
    try {
      expect(document.body.style.cursor).toBe("ns-resize");
      expect(document.body.style.userSelect).toBe("none");
    } finally {
      controller.stopResize();
    }

    expect(removeSpy).toHaveBeenCalledWith("pointermove", expect.any(Function), true);
    expect(removeSpy).toHaveBeenCalledWith("pointerup", expect.any(Function), true);
    expect(removeSpy).toHaveBeenCalledWith("pointercancel", expect.any(Function), true);
    expect(document.body.style.cursor).toBe("");
    expect(document.body.style.userSelect).toBe("");
  });
});

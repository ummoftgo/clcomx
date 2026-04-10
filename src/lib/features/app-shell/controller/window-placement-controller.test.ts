import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createWindowPlacementController,
  WINDOW_PLACEMENT_INITIAL_DELAY_MS,
  WINDOW_PLACEMENT_PERSIST_DELAY_MS,
} from "./window-placement-controller";

function createController(options: {
  isMainWindow?: boolean;
  currentWindowLabel?: string;
  getCurrentMonitorNameImpl?: () => Promise<string | null>;
  updateWindowGeometryImpl?: () => Promise<void>;
} = {}) {
  const deps = {
    isMainWindow: vi.fn(() => options.isMainWindow ?? true),
    currentWindowLabel: vi.fn(() => options.currentWindowLabel ?? "main"),
    getWindowPosition: vi.fn(async () => ({ x: 12, y: 34 })),
    getWindowSize: vi.fn(async () => ({ width: 900, height: 640 })),
    isWindowMaximized: vi.fn(async () => false),
    getCurrentMonitorName: vi.fn(options.getCurrentMonitorNameImpl ?? (async () => "DISPLAY-1")),
    updateMainWindowPlacement: vi.fn(),
    updateWindowGeometry: vi.fn(options.updateWindowGeometryImpl ?? (async () => {})),
    reportError: vi.fn(),
  };

  return {
    controller: createWindowPlacementController(deps),
    deps,
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("window-placement-controller", () => {
  it("persists main window placement to settings and workspace geometry", async () => {
    const { controller, deps } = createController();

    await controller.persistNow();

    expect(deps.updateMainWindowPlacement).toHaveBeenCalledWith({
      monitor: "DISPLAY-1",
      x: 12,
      y: 34,
      width: 900,
      height: 640,
      maximized: false,
    });
    expect(deps.updateWindowGeometry).toHaveBeenCalledWith(
      "main",
      12,
      34,
      900,
      640,
      false,
    );
  });

  it("persists secondary window geometry without updating main window settings", async () => {
    const { controller, deps } = createController({
      isMainWindow: false,
      currentWindowLabel: "secondary-1",
    });

    await controller.persistNow();

    expect(deps.updateMainWindowPlacement).not.toHaveBeenCalled();
    expect(deps.updateWindowGeometry).toHaveBeenCalledWith(
      "secondary-1",
      12,
      34,
      900,
      640,
      false,
    );
  });

  it("continues persisting geometry when monitor lookup fails", async () => {
    const { controller, deps } = createController({
      getCurrentMonitorNameImpl: async () => {
        throw new Error("monitor unavailable");
      },
    });

    await controller.persistNow();

    expect(deps.updateMainWindowPlacement).toHaveBeenCalledWith(
      expect.objectContaining({ monitor: null }),
    );
    expect(deps.updateWindowGeometry).toHaveBeenCalledTimes(1);
  });

  it("reports geometry persistence failures without throwing", async () => {
    const error = new Error("geometry failed");
    const { controller, deps } = createController({
      updateWindowGeometryImpl: async () => {
        throw error;
      },
    });

    await expect(controller.persistNow()).resolves.toBeUndefined();

    expect(deps.reportError).toHaveBeenCalledWith("Failed to update window geometry", error);
  });

  it("debounces placement persistence", async () => {
    vi.useFakeTimers();
    const { controller, deps } = createController();

    controller.schedulePersist();
    controller.schedulePersist();

    await vi.advanceTimersByTimeAsync(WINDOW_PLACEMENT_PERSIST_DELAY_MS - 1);
    expect(deps.getWindowPosition).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(deps.getWindowPosition).toHaveBeenCalledTimes(1);
    expect(deps.updateWindowGeometry).toHaveBeenCalledTimes(1);
  });

  it("schedules initial placement persistence after the startup delay and debounce", async () => {
    vi.useFakeTimers();
    const { controller, deps } = createController();

    controller.scheduleInitialPersist();

    await vi.advanceTimersByTimeAsync(WINDOW_PLACEMENT_INITIAL_DELAY_MS);
    expect(deps.getWindowPosition).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(WINDOW_PLACEMENT_PERSIST_DELAY_MS);
    expect(deps.getWindowPosition).toHaveBeenCalledTimes(1);
  });

  it("clears pending placement timers on dispose", async () => {
    vi.useFakeTimers();
    const { controller, deps } = createController();

    controller.schedulePersist();
    controller.scheduleInitialPersist();
    controller.dispose();

    await vi.advanceTimersByTimeAsync(
      WINDOW_PLACEMENT_INITIAL_DELAY_MS + WINDOW_PLACEMENT_PERSIST_DELAY_MS,
    );

    expect(deps.getWindowPosition).not.toHaveBeenCalled();
  });
});

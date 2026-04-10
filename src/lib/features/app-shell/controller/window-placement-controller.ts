import type { WindowPlacement } from "../../../types";

interface WindowPlacementControllerDeps {
  isMainWindow: () => boolean;
  currentWindowLabel: () => string;
  getWindowPosition: () => Promise<{ x: number; y: number }>;
  getWindowSize: () => Promise<{ width: number; height: number }>;
  isWindowMaximized: () => Promise<boolean>;
  getCurrentMonitorName: () => Promise<string | null>;
  updateMainWindowPlacement: (placement: WindowPlacement) => void;
  updateWindowGeometry: (
    label: string,
    x: number,
    y: number,
    width: number,
    height: number,
    maximized: boolean,
  ) => Promise<void>;
  reportError: (message: string, error: unknown) => void;
  setTimeoutFn?: typeof setTimeout;
  clearTimeoutFn?: typeof clearTimeout;
}

export const WINDOW_PLACEMENT_PERSIST_DELAY_MS = 150;
export const WINDOW_PLACEMENT_INITIAL_DELAY_MS = 500;

export function createWindowPlacementController(deps: WindowPlacementControllerDeps) {
  const setTimer = deps.setTimeoutFn ?? setTimeout;
  const clearTimer = deps.clearTimeoutFn ?? clearTimeout;
  let placementSaveTimer: ReturnType<typeof setTimeout> | null = null;
  let initialPlacementTimer: ReturnType<typeof setTimeout> | null = null;

  const persistNow = async () => {
    const [position, size, maximized, monitorName] = await Promise.all([
      deps.getWindowPosition(),
      deps.getWindowSize(),
      deps.isWindowMaximized(),
      deps.getCurrentMonitorName().catch(() => null),
    ]);

    const placement: WindowPlacement = {
      monitor: monitorName,
      x: position.x,
      y: position.y,
      width: size.width,
      height: size.height,
      maximized,
    };

    if (deps.isMainWindow()) {
      deps.updateMainWindowPlacement(placement);
    }

    try {
      await deps.updateWindowGeometry(
        deps.currentWindowLabel(),
        placement.x,
        placement.y,
        placement.width,
        placement.height,
        placement.maximized,
      );
    } catch (error) {
      deps.reportError("Failed to update window geometry", error);
    }
  };

  const schedulePersist = () => {
    if (placementSaveTimer) {
      clearTimer(placementSaveTimer);
    }
    placementSaveTimer = setTimer(() => {
      void persistNow();
    }, WINDOW_PLACEMENT_PERSIST_DELAY_MS);
  };

  const scheduleInitialPersist = () => {
    if (initialPlacementTimer) {
      clearTimer(initialPlacementTimer);
    }
    initialPlacementTimer = setTimer(() => {
      schedulePersist();
    }, WINDOW_PLACEMENT_INITIAL_DELAY_MS);
  };

  const dispose = () => {
    if (initialPlacementTimer) {
      clearTimer(initialPlacementTimer);
      initialPlacementTimer = null;
    }
    if (placementSaveTimer) {
      clearTimer(placementSaveTimer);
      placementSaveTimer = null;
    }
  };

  return {
    persistNow,
    schedulePersist,
    scheduleInitialPersist,
    dispose,
  };
}

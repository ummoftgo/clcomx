export interface NewWindowGeometry {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface WindowSessionDetachOrchestrationControllerDependencies {
  openEmptyWindow: (
    x: number,
    y: number,
    width: number,
    height: number,
  ) => Promise<string>;
  waitForWindowReady: (targetLabel: string) => Promise<boolean>;
  moveSessionToWindow: (sessionId: string, targetLabel: string) => Promise<void>;
  reportError: (message: string, error: unknown) => void;
}

export function createWindowSessionDetachOrchestrationController(
  deps: WindowSessionDetachOrchestrationControllerDependencies,
) {
  const moveSessionToNewWindow = async (
    sessionId: string,
    geometry: NewWindowGeometry,
  ) => {
    try {
      const targetLabel = await deps.openEmptyWindow(
        geometry.x,
        geometry.y,
        geometry.width,
        geometry.height,
      );

      const ready = await deps.waitForWindowReady(targetLabel);
      if (!ready) {
        deps.reportError("New window did not become ready", targetLabel);
        return false;
      }

      await deps.moveSessionToWindow(sessionId, targetLabel);
      return true;
    } catch (error) {
      deps.reportError("Failed to detach tab", error);
      return false;
    }
  };

  return {
    moveSessionToNewWindow,
  };
}

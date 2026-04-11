const WINDOW_READY_POLL_INTERVAL_MS = 50;
const DEFAULT_WINDOW_READY_TIMEOUT_MS = 8000;

interface WindowSessionMoveOrchestrationControllerDependencies {
  isWindowReady: (targetLabel: string) => Promise<boolean>;
  moveSessionToWindow: (sessionId: string, targetLabel: string) => Promise<void>;
  reportError: (message: string, error: unknown) => void;
  wait: (ms: number) => Promise<void>;
  now: () => number;
}

export function createWindowSessionMoveOrchestrationController(
  deps: WindowSessionMoveOrchestrationControllerDependencies,
) {
  const waitForWindowReady = async (
    targetLabel: string,
    timeoutMs = DEFAULT_WINDOW_READY_TIMEOUT_MS,
  ): Promise<boolean> => {
    const start = deps.now();
    while (deps.now() - start < timeoutMs) {
      try {
        if (await deps.isWindowReady(targetLabel)) {
          return true;
        }
      } catch (error) {
        deps.reportError("Failed to query window readiness", error);
      }

      await deps.wait(WINDOW_READY_POLL_INTERVAL_MS);
    }

    return false;
  };

  const moveSessionToExistingWindow = async (
    sessionId: string,
    targetLabel: string,
    timeoutMs = DEFAULT_WINDOW_READY_TIMEOUT_MS,
  ) => {
    try {
      if (targetLabel !== "main") {
        const ready = await waitForWindowReady(targetLabel, timeoutMs);
        if (!ready) {
          deps.reportError("Target window did not become ready", targetLabel);
          return false;
        }
      }

      await deps.moveSessionToWindow(sessionId, targetLabel);
      return true;
    } catch (error) {
      deps.reportError("Failed to move session to window", error);
      return false;
    }
  };

  return {
    waitForWindowReady,
    moveSessionToExistingWindow,
  };
}

interface AppStartupControllerDeps {
  isMainWindow: () => boolean;
  currentWindowLabel: () => string;
  installCanonicalScreenAuthority: () => Promise<() => void>;
  notifyWindowReady: (label: string) => Promise<void>;
  scheduleInitialPlacementPersist: () => void;
  primeEditorsDetection: (delayMs: number) => void;
  reportError: (message: string, error: unknown) => void;
  editorDetectionDelayMs?: number;
}

export const APP_STARTUP_EDITOR_DETECTION_DELAY_MS = 1200;

export function createAppStartupController(deps: AppStartupControllerDeps) {
  let disposed = false;
  let startPromise: Promise<void> | null = null;
  let canonicalAuthorityCleanup: (() => void) | null = null;

  const disposeCanonicalAuthority = () => {
    canonicalAuthorityCleanup?.();
    canonicalAuthorityCleanup = null;
  };

  const start = () => {
    if (startPromise) {
      return startPromise;
    }

    startPromise = (async () => {
      if (disposed) {
        return;
      }

      if (deps.isMainWindow()) {
        try {
          const cleanup = await deps.installCanonicalScreenAuthority();
          if (disposed) {
            cleanup();
            return;
          }
          disposeCanonicalAuthority();
          canonicalAuthorityCleanup = cleanup;
        } catch (error) {
          deps.reportError("Failed to install canonical screen authority", error);
          if (disposed) {
            return;
          }
        }
      }

      try {
        await deps.notifyWindowReady(deps.currentWindowLabel());
      } catch (error) {
        deps.reportError("Failed to notify window readiness", error);
      }

      if (disposed) {
        return;
      }

      deps.scheduleInitialPlacementPersist();
      deps.primeEditorsDetection(
        deps.editorDetectionDelayMs ?? APP_STARTUP_EDITOR_DETECTION_DELAY_MS,
      );
    })();

    return startPromise;
  };

  const dispose = () => {
    disposed = true;
    disposeCanonicalAuthority();
  };

  return {
    start,
    dispose,
  };
}

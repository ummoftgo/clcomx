export const DIRTY_STATE_QUERY_EVENT = "clcomx:dirty-state-query";
export const DIRTY_STATE_RESPONSE_EVENT = "clcomx:dirty-state-response";

export interface DirtyStateQueryPayload {
  requestId: string;
  replyLabel: string;
}

export interface DirtyStateResponsePayload {
  requestId: string;
  windowLabel: string;
  dirtyCount: number;
}

type WindowCloseRequestResult =
  | { kind: "show-dirty-app-dialog"; dirtyCount: number }
  | { kind: "show-close-window-dialog" }
  | { kind: "closed" }
  | { kind: "noop" };

type CloseWindowSessionsResult =
  | { kind: "show-dirty-window-dialog" }
  | { kind: "closed" }
  | { kind: "noop" };

interface WindowCloseOrchestrationDependencies {
  isMainWindow: () => boolean;
  currentWindowLabel: () => string;
  getSessionsCount: () => number;
  getLocalDirtySessionCount: () => number;
  getOtherWindowLabels: () => string[];
  emitDirtyStateQuery: (label: string, payload: DirtyStateQueryPayload) => Promise<void>;
  listenDirtyStateResponse: (
    listener: (payload: DirtyStateResponsePayload) => void,
  ) => Promise<() => void>;
  closeCurrentWindow: () => Promise<void>;
  removeCurrentWindow: () => Promise<void>;
  captureResumeIdsBeforeAppClose: () => Promise<void>;
  closeApp: () => Promise<void>;
  closeWindowSessions: () => Promise<void>;
  moveWindowSessionsToMain: () => Promise<void>;
  reportError: (message: string, error: unknown) => void;
  createRequestId: () => string;
  wait: (ms: number) => Promise<void>;
}

export function createWindowCloseOrchestrationController(
  deps: WindowCloseOrchestrationDependencies,
) {
  let appCloseRequested = false;
  let secondaryWindowActionInFlight = false;

  const runSecondaryWindowAction = async (
    action: () => Promise<void>,
    errorMessage: string,
  ) => {
    if (secondaryWindowActionInFlight) {
      return false;
    }

    secondaryWindowActionInFlight = true;
    try {
      await action();
      return true;
    } catch (error) {
      deps.reportError(errorMessage, error);
      return false;
    } finally {
      secondaryWindowActionInFlight = false;
    }
  };

  const queryOtherWindowDirtySessionCount = async (timeoutMs = 700) => {
    const targetLabels = deps.getOtherWindowLabels().filter(Boolean);
    if (targetLabels.length === 0) {
      return { dirtyCount: 0, incomplete: false };
    }

    const requestId = deps.createRequestId();
    const responded = new Set<string>();
    let dirtyCount = 0;
    let resolveWait: (() => void) | null = null;
    const done = new Promise<void>((resolve) => {
      resolveWait = resolve;
    });

    const unlisten = await deps.listenDirtyStateResponse((payload) => {
      if (!payload || payload.requestId !== requestId || responded.has(payload.windowLabel)) {
        return;
      }

      responded.add(payload.windowLabel);
      dirtyCount += Math.max(0, payload.dirtyCount);
      if (responded.size >= targetLabels.length) {
        resolveWait?.();
      }
    });

    try {
      await Promise.all(
        targetLabels.map((label) =>
          deps.emitDirtyStateQuery(label, {
            requestId,
            replyLabel: deps.currentWindowLabel(),
          }).catch(() => {}),
        ),
      );

      await Promise.race([
        done,
        deps.wait(timeoutMs),
      ]);
    } finally {
      unlisten();
    }

    return {
      dirtyCount,
      incomplete: responded.size < targetLabels.length,
    };
  };

  const getAppCloseDirtySessionCount = async () => {
    const localDirtyCount = deps.getLocalDirtySessionCount();
    const otherWindowState = await queryOtherWindowDirtySessionCount();
    if (otherWindowState.incomplete) {
      return Math.max(1, localDirtyCount + otherWindowState.dirtyCount);
    }
    return localDirtyCount + otherWindowState.dirtyCount;
  };

  const performAppClose = async () => {
    if (appCloseRequested) return false;
    appCloseRequested = true;
    try {
      await deps.captureResumeIdsBeforeAppClose();
      await deps.closeApp();
      return true;
    } catch (error) {
      appCloseRequested = false;
      deps.reportError("Failed to close app", error);
      return false;
    }
  };

  const handleSecondaryCloseRequest = async (): Promise<WindowCloseRequestResult> => {
    if (deps.getSessionsCount() > 0) {
      return { kind: "show-close-window-dialog" };
    }

    const closed = await runSecondaryWindowAction(async () => {
      await deps.removeCurrentWindow();
      await deps.closeCurrentWindow();
    }, "Failed to close secondary window");

    return closed ? { kind: "closed" } : { kind: "noop" };
  };

  const handleCloseRequested = async (): Promise<WindowCloseRequestResult> => {
    if (deps.isMainWindow()) {
      const totalDirtyCount = await getAppCloseDirtySessionCount();
      if (totalDirtyCount > 0) {
        return { kind: "show-dirty-app-dialog", dirtyCount: totalDirtyCount };
      }

      await performAppClose();
      return { kind: "closed" };
    }

    return handleSecondaryCloseRequest();
  };

  const confirmDirtyWindowClose = async () => {
    return runSecondaryWindowAction(async () => {
      await deps.closeWindowSessions();
      await deps.closeCurrentWindow();
    }, "Failed to close secondary window sessions");
  };

  const moveWindowSessionsToMainAndClose = async () => {
    return runSecondaryWindowAction(async () => {
      await deps.moveWindowSessionsToMain();
      await deps.closeCurrentWindow();
    }, "Failed to move window sessions to main");
  };

  const handleCloseWindowSessions = async (): Promise<CloseWindowSessionsResult> => {
    if (deps.getLocalDirtySessionCount() > 0) {
      return { kind: "show-dirty-window-dialog" };
    }

    const closed = await confirmDirtyWindowClose();
    return closed ? { kind: "closed" } : { kind: "noop" };
  };

  return {
    queryOtherWindowDirtySessionCount,
    getAppCloseDirtySessionCount,
    performAppClose,
    handleSecondaryCloseRequest,
    handleCloseRequested,
    confirmDirtyWindowClose,
    moveWindowSessionsToMainAndClose,
    handleCloseWindowSessions,
  };
}

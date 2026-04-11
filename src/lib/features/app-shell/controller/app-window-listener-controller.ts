import type { WorkspaceSnapshot } from "../../../types";
import type {
  DirtyStateQueryPayload,
  DirtyStateResponsePayload,
} from "./window-close-orchestration-controller";

type UnlistenFn = () => void;

interface CloseRequestedEvent {
  preventDefault(): void;
}

type WindowCloseRequestResult =
  | { kind: "show-dirty-app-dialog"; dirtyCount: number }
  | { kind: "show-close-window-dialog" }
  | { kind: "closed" }
  | { kind: "noop" };

interface AppWindowListenerControllerDeps {
  onCloseRequested: (
    listener: (event: CloseRequestedEvent) => void | Promise<void>,
  ) => Promise<UnlistenFn>;
  onMoved: (listener: () => void | Promise<void>) => Promise<UnlistenFn>;
  onResized: (listener: () => void | Promise<void>) => Promise<UnlistenFn>;
  listenWorkspaceUpdated: (
    listener: (workspace: WorkspaceSnapshot) => void,
  ) => Promise<UnlistenFn>;
  listenDirtyStateQuery: (
    listener: (payload: DirtyStateQueryPayload) => void,
  ) => Promise<UnlistenFn>;
  emitDirtyStateResponse: (
    label: string,
    payload: DirtyStateResponsePayload,
  ) => Promise<void>;
  consumeNativeCloseAllowance: () => boolean;
  handleCloseRequested: () => Promise<WindowCloseRequestResult>;
  showDirtyAppDialog: (dirtyCount: number) => void;
  showCloseWindowDialog: () => void;
  schedulePlacementPersist: () => void;
  syncWorkspaceSnapshot: (workspace: WorkspaceSnapshot) => void;
  syncSessionsFromWorkspace: (workspace: WorkspaceSnapshot) => void;
  currentWindowLabel: () => string;
  getLocalDirtySessionCount: () => number;
}

export function createAppWindowListenerController(
  deps: AppWindowListenerControllerDeps,
) {
  let unlisteners: UnlistenFn[] = [];
  let disposed = false;

  const handleCloseRequested = async (event: CloseRequestedEvent) => {
    if (deps.consumeNativeCloseAllowance()) {
      return;
    }

    event.preventDefault();

    const closeResult = await deps.handleCloseRequested();
    if (closeResult.kind === "show-dirty-app-dialog") {
      deps.showDirtyAppDialog(closeResult.dirtyCount);
      return;
    }

    if (closeResult.kind === "show-close-window-dialog") {
      deps.showCloseWindowDialog();
    }
  };

  const handleWorkspaceUpdated = (workspace: WorkspaceSnapshot) => {
    deps.syncWorkspaceSnapshot(workspace);
    deps.syncSessionsFromWorkspace(workspace);
  };

  const handleDirtyStateQuery = (payload: DirtyStateQueryPayload) => {
    if (!payload?.requestId || !payload.replyLabel) {
      return;
    }

    void deps.emitDirtyStateResponse(payload.replyLabel, {
      requestId: payload.requestId,
      windowLabel: deps.currentWindowLabel(),
      dirtyCount: deps.getLocalDirtySessionCount(),
    }).catch(() => {});
  };

  const register = async () => {
    disposed = false;
    const nextUnlisteners = await Promise.all([
      deps.onCloseRequested(handleCloseRequested),
      deps.onMoved(() => deps.schedulePlacementPersist()),
      deps.onResized(() => deps.schedulePlacementPersist()),
      deps.listenWorkspaceUpdated(handleWorkspaceUpdated),
      deps.listenDirtyStateQuery(handleDirtyStateQuery),
    ]);

    if (disposed) {
      for (const unlisten of nextUnlisteners) {
        unlisten();
      }
      return nextUnlisteners;
    }

    unlisteners = nextUnlisteners;
    return unlisteners;
  };

  const dispose = () => {
    disposed = true;
    for (const unlisten of unlisteners) {
      unlisten();
    }
    unlisteners = [];
  };

  return {
    register,
    dispose,
  };
}

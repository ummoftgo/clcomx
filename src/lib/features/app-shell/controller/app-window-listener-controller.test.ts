import { describe, expect, it, vi } from "vitest";
import type { WorkspaceSnapshot } from "../../../types";
import type { DirtyStateQueryPayload } from "./window-close-orchestration-controller";
import { createAppWindowListenerController } from "./app-window-listener-controller";

type WindowCloseRequestResult = Awaited<
  ReturnType<
    Parameters<typeof createAppWindowListenerController>[0]["handleCloseRequested"]
  >
>;

function createWorkspace(label = "main"): WorkspaceSnapshot {
  return {
    windows: [
      {
        label,
        name: label,
        role: "main",
        tabs: [],
        activeSessionId: null,
      },
    ],
  };
}

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

function createController(options: { deferRegistration?: boolean } = {}) {
  let closeListener: ((event: { preventDefault(): void }) => void | Promise<void>) | null = null;
  let movedListener: (() => void | Promise<void>) | null = null;
  let resizedListener: (() => void | Promise<void>) | null = null;
  let workspaceUpdatedListener: ((workspace: WorkspaceSnapshot) => void) | null = null;
  let dirtyStateQueryListener: ((payload: DirtyStateQueryPayload) => void) | null = null;
  const unlisteners = [vi.fn(), vi.fn(), vi.fn(), vi.fn(), vi.fn()];
  const registrationGate = createDeferred<void>();

  const waitForRegistration = async () => {
    if (!options.deferRegistration) {
      return;
    }
    await registrationGate.promise;
  };

  const deps = {
    onCloseRequested: vi.fn(async (listener: typeof closeListener) => {
      closeListener = listener;
      await waitForRegistration();
      return unlisteners[0];
    }),
    onMoved: vi.fn(async (listener: typeof movedListener) => {
      movedListener = listener;
      await waitForRegistration();
      return unlisteners[1];
    }),
    onResized: vi.fn(async (listener: typeof resizedListener) => {
      resizedListener = listener;
      await waitForRegistration();
      return unlisteners[2];
    }),
    listenWorkspaceUpdated: vi.fn(async (listener: typeof workspaceUpdatedListener) => {
      workspaceUpdatedListener = listener;
      await waitForRegistration();
      return unlisteners[3];
    }),
    listenDirtyStateQuery: vi.fn(async (listener: typeof dirtyStateQueryListener) => {
      dirtyStateQueryListener = listener;
      await waitForRegistration();
      return unlisteners[4];
    }),
    emitDirtyStateResponse: vi.fn(async () => {}),
    consumeNativeCloseAllowance: vi.fn(() => false),
    handleCloseRequested: vi.fn(async (): Promise<WindowCloseRequestResult> => ({ kind: "noop" })),
    showDirtyAppDialog: vi.fn(),
    showCloseWindowDialog: vi.fn(),
    schedulePlacementPersist: vi.fn(),
    syncWorkspaceSnapshot: vi.fn(),
    syncSessionsFromWorkspace: vi.fn(),
    currentWindowLabel: vi.fn(() => "secondary-2"),
    getLocalDirtySessionCount: vi.fn(() => 3),
  };
  const controller = createAppWindowListenerController(deps);

  return {
    controller,
    deps,
    unlisteners,
    emitCloseRequested: async () => {
      const event = { preventDefault: vi.fn() };
      await closeListener?.(event);
      return event;
    },
    emitMoved: () => movedListener?.(),
    emitResized: () => resizedListener?.(),
    emitWorkspaceUpdated: (workspace = createWorkspace()) => {
      workspaceUpdatedListener?.(workspace);
      return workspace;
    },
    emitDirtyStateQuery: (payload: DirtyStateQueryPayload) => {
      dirtyStateQueryListener?.(payload);
    },
    resolveRegistration: () => {
      registrationGate.resolve();
    },
  };
}

describe("app-window-listener-controller", () => {
  it("registers window and app-shell event listeners", async () => {
    const { controller, deps } = createController();

    await controller.register();

    expect(deps.onCloseRequested).toHaveBeenCalledTimes(1);
    expect(deps.onMoved).toHaveBeenCalledTimes(1);
    expect(deps.onResized).toHaveBeenCalledTimes(1);
    expect(deps.listenWorkspaceUpdated).toHaveBeenCalledTimes(1);
    expect(deps.listenDirtyStateQuery).toHaveBeenCalledTimes(1);
  });

  it("consumes native close allowance without preventing the close request", async () => {
    const runtime = createController();
    runtime.deps.consumeNativeCloseAllowance.mockReturnValueOnce(true);
    await runtime.controller.register();

    const event = await runtime.emitCloseRequested();

    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(runtime.deps.handleCloseRequested).not.toHaveBeenCalled();
  });

  it("shows dirty app dialog for dirty app close results", async () => {
    const runtime = createController();
    runtime.deps.handleCloseRequested.mockResolvedValueOnce({
      kind: "show-dirty-app-dialog",
      dirtyCount: 4,
    });
    await runtime.controller.register();

    const event = await runtime.emitCloseRequested();

    expect(event.preventDefault).toHaveBeenCalledTimes(1);
    expect(runtime.deps.showDirtyAppDialog).toHaveBeenCalledWith(4);
    expect(runtime.deps.showCloseWindowDialog).not.toHaveBeenCalled();
  });

  it("shows close-window dialog for secondary window close results", async () => {
    const runtime = createController();
    runtime.deps.handleCloseRequested.mockResolvedValueOnce({
      kind: "show-close-window-dialog",
    });
    await runtime.controller.register();

    await runtime.emitCloseRequested();

    expect(runtime.deps.showCloseWindowDialog).toHaveBeenCalledTimes(1);
  });

  it("does not show close UI for completed or noop close results", async () => {
    for (const closeResult of [{ kind: "closed" }, { kind: "noop" }] as const) {
      const runtime = createController();
      runtime.deps.handleCloseRequested.mockResolvedValueOnce(closeResult);
      await runtime.controller.register();

      await runtime.emitCloseRequested();

      expect(runtime.deps.showDirtyAppDialog).not.toHaveBeenCalled();
      expect(runtime.deps.showCloseWindowDialog).not.toHaveBeenCalled();
    }
  });

  it("schedules placement persistence for moved and resized events", async () => {
    const runtime = createController();
    await runtime.controller.register();

    runtime.emitMoved();
    runtime.emitResized();

    expect(runtime.deps.schedulePlacementPersist).toHaveBeenCalledTimes(2);
  });

  it("syncs workspace snapshot and sessions on workspace updates", async () => {
    const runtime = createController();
    const workspace = createWorkspace("secondary-1");
    await runtime.controller.register();

    runtime.emitWorkspaceUpdated(workspace);

    expect(runtime.deps.syncWorkspaceSnapshot).toHaveBeenCalledWith(workspace);
    expect(runtime.deps.syncSessionsFromWorkspace).toHaveBeenCalledWith(workspace);
  });

  it("responds to valid dirty-state queries", async () => {
    const runtime = createController();
    await runtime.controller.register();

    runtime.emitDirtyStateQuery({
      requestId: "request-1",
      replyLabel: "main",
    });

    expect(runtime.deps.emitDirtyStateResponse).toHaveBeenCalledWith("main", {
      requestId: "request-1",
      windowLabel: "secondary-2",
      dirtyCount: 3,
    });
  });

  it("ignores invalid dirty-state queries", async () => {
    const runtime = createController();
    await runtime.controller.register();

    runtime.emitDirtyStateQuery({ requestId: "", replyLabel: "main" });
    runtime.emitDirtyStateQuery({ requestId: "request-1", replyLabel: "" });

    expect(runtime.deps.emitDirtyStateResponse).not.toHaveBeenCalled();
  });

  it("does not throw when dirty-state response emit fails", async () => {
    const runtime = createController();
    runtime.deps.emitDirtyStateResponse.mockRejectedValueOnce(new Error("emit failed"));
    await runtime.controller.register();

    expect(() => runtime.emitDirtyStateQuery({
      requestId: "request-1",
      replyLabel: "main",
    })).not.toThrow();
    await Promise.resolve();

    expect(runtime.deps.emitDirtyStateResponse).toHaveBeenCalledTimes(1);
  });

  it("disposes registered listeners", async () => {
    const { controller, unlisteners } = createController();
    await controller.register();

    controller.dispose();

    for (const unlisten of unlisteners) {
      expect(unlisten).toHaveBeenCalledTimes(1);
    }
  });

  it("does not dispose registered listeners more than once", async () => {
    const { controller, unlisteners } = createController();
    await controller.register();

    controller.dispose();
    controller.dispose();

    for (const unlisten of unlisteners) {
      expect(unlisten).toHaveBeenCalledTimes(1);
    }
  });

  it("cleans up listeners that finish registering after dispose", async () => {
    const { controller, unlisteners, resolveRegistration } = createController({
      deferRegistration: true,
    });

    const registerPromise = controller.register();
    controller.dispose();
    resolveRegistration();
    await registerPromise;

    for (const unlisten of unlisteners) {
      expect(unlisten).toHaveBeenCalledTimes(1);
    }
  });
});

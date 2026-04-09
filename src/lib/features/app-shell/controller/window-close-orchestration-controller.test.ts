import { describe, expect, it, vi } from "vitest";
import {
  createWindowCloseOrchestrationController,
  type DirtyStateQueryPayload,
  type DirtyStateResponsePayload,
} from "./window-close-orchestration-controller";

function createDeps(
  overrides: Partial<Parameters<typeof createWindowCloseOrchestrationController>[0]> = {},
) {
  let dirtyStateListener: ((payload: DirtyStateResponsePayload) => void) | null = null;

  const deps = {
    isMainWindow: vi.fn(() => true),
    currentWindowLabel: vi.fn(() => "main"),
    getSessionsCount: vi.fn(() => 0),
    getLocalDirtySessionCount: vi.fn(() => 0),
    getOtherWindowLabels: vi.fn(() => [] as string[]),
    emitDirtyStateQuery: vi.fn(async (_label: string, _payload: DirtyStateQueryPayload) => {}),
    listenDirtyStateResponse: vi.fn(async (listener: (payload: DirtyStateResponsePayload) => void) => {
      dirtyStateListener = listener;
      return () => {
        dirtyStateListener = null;
      };
    }),
    closeCurrentWindow: vi.fn(async () => {}),
    removeCurrentWindow: vi.fn(async () => {}),
    captureResumeIdsBeforeAppClose: vi.fn(async () => {}),
    closeApp: vi.fn(async () => {}),
    closeWindowSessions: vi.fn(async () => {}),
    moveWindowSessionsToMain: vi.fn(async () => {}),
    reportError: vi.fn(),
    createRequestId: vi.fn(() => "request-1"),
    wait: vi.fn(async () => {}),
    ...overrides,
  };

  return {
    deps,
    emitDirtyStateResponse(payload: DirtyStateResponsePayload) {
      dirtyStateListener?.(payload);
    },
  };
}

function createDeferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe("window-close-orchestration-controller", () => {
  it("shows dirty app dialog when another window reports dirty sessions", async () => {
    const { deps, emitDirtyStateResponse } = createDeps({
      isMainWindow: vi.fn(() => true),
      getLocalDirtySessionCount: vi.fn(() => 1),
      getOtherWindowLabels: vi.fn(() => ["secondary-1"]),
      emitDirtyStateQuery: vi.fn(async (_label: string) => {
        emitDirtyStateResponse({
          requestId: "request-1",
          windowLabel: "secondary-1",
          dirtyCount: 2,
        });
      }),
    });
    const controller = createWindowCloseOrchestrationController(deps);

    await expect(controller.handleCloseRequested()).resolves.toEqual({
      kind: "show-dirty-app-dialog",
      dirtyCount: 3,
    });
    expect(deps.closeApp).not.toHaveBeenCalled();
  });

  it("guards app close while a previous close is already in progress", async () => {
    let resolveCapture!: () => void;
    const captureResumeIdsBeforeAppClose = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveCapture = resolve;
        }),
    );
    const { deps } = createDeps({
      captureResumeIdsBeforeAppClose,
    });
    const controller = createWindowCloseOrchestrationController(deps);

    const firstClose = controller.performAppClose();
    const secondClose = controller.performAppClose();
    resolveCapture();

    await expect(firstClose).resolves.toBe(true);
    await expect(secondClose).resolves.toBe(false);
    expect(captureResumeIdsBeforeAppClose).toHaveBeenCalledTimes(1);
    expect(deps.closeApp).toHaveBeenCalledTimes(1);
  });

  it("shows close-window dialog for a non-empty secondary window", async () => {
    const { deps } = createDeps({
      isMainWindow: vi.fn(() => false),
      getSessionsCount: vi.fn(() => 2),
    });
    const controller = createWindowCloseOrchestrationController(deps);

    await expect(controller.handleCloseRequested()).resolves.toEqual({
      kind: "show-close-window-dialog",
    });
    expect(deps.closeCurrentWindow).not.toHaveBeenCalled();
  });

  it("guards empty secondary-window close while a previous close is in progress", async () => {
    const deferred = createDeferred();
    const { deps } = createDeps({
      isMainWindow: vi.fn(() => false),
      getSessionsCount: vi.fn(() => 0),
      removeCurrentWindow: vi.fn(async () => {
        await deferred.promise;
      }),
    });
    const controller = createWindowCloseOrchestrationController(deps);

    const firstClose = controller.handleCloseRequested();
    const secondClose = controller.handleCloseRequested();
    deferred.resolve();

    await expect(firstClose).resolves.toEqual({ kind: "closed" });
    await expect(secondClose).resolves.toEqual({ kind: "noop" });
    expect(deps.removeCurrentWindow).toHaveBeenCalledTimes(1);
  });

  it("shows dirty-window dialog before closing window sessions", async () => {
    const { deps } = createDeps({
      getLocalDirtySessionCount: vi.fn(() => 2),
    });
    const controller = createWindowCloseOrchestrationController(deps);

    await expect(controller.handleCloseWindowSessions()).resolves.toEqual({
      kind: "show-dirty-window-dialog",
    });
    expect(deps.closeWindowSessions).not.toHaveBeenCalled();
  });

  it("moves window sessions to main and closes the current window", async () => {
    const { deps } = createDeps();
    const controller = createWindowCloseOrchestrationController(deps);

    await expect(controller.moveWindowSessionsToMainAndClose()).resolves.toBe(true);
    expect(deps.moveWindowSessionsToMain).toHaveBeenCalledTimes(1);
    expect(deps.closeCurrentWindow).toHaveBeenCalledTimes(1);
  });

  it("closes secondary window sessions after dirty confirmation", async () => {
    const { deps } = createDeps();
    const controller = createWindowCloseOrchestrationController(deps);

    await expect(controller.confirmDirtyWindowClose()).resolves.toBe(true);
    expect(deps.closeWindowSessions).toHaveBeenCalledTimes(1);
    expect(deps.closeCurrentWindow).toHaveBeenCalledTimes(1);
  });

  it("guards dirty-window confirmation while close is already in progress", async () => {
    const deferred = createDeferred();
    const { deps } = createDeps({
      closeWindowSessions: vi.fn(async () => {
        await deferred.promise;
      }),
    });
    const controller = createWindowCloseOrchestrationController(deps);

    const firstConfirm = controller.confirmDirtyWindowClose();
    const secondConfirm = controller.confirmDirtyWindowClose();
    deferred.resolve();

    await expect(firstConfirm).resolves.toBe(true);
    await expect(secondConfirm).resolves.toBe(false);
    expect(deps.closeWindowSessions).toHaveBeenCalledTimes(1);
  });

  it("guards move-to-main while a previous move is already in progress", async () => {
    const deferred = createDeferred();
    const { deps } = createDeps({
      moveWindowSessionsToMain: vi.fn(async () => {
        await deferred.promise;
      }),
    });
    const controller = createWindowCloseOrchestrationController(deps);

    const firstMove = controller.moveWindowSessionsToMainAndClose();
    const secondMove = controller.moveWindowSessionsToMainAndClose();
    deferred.resolve();

    await expect(firstMove).resolves.toBe(true);
    await expect(secondMove).resolves.toBe(false);
    expect(deps.moveWindowSessionsToMain).toHaveBeenCalledTimes(1);
  });
});

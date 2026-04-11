import { describe, expect, it, vi } from "vitest";
import { createWindowCloseDialogController } from "./window-close-dialog-controller";

type CloseWindowSessionsResult =
  | { kind: "show-dirty-window-dialog" }
  | { kind: "closed" }
  | { kind: "noop" };

function createRuntime() {
  const state = {
    showDirtyAppDialog: false,
    dirtyAppCloseCount: 0,
    showCloseWindowDialog: false,
    showDirtyWindowCloseDialog: false,
  };

  const deps = {
    dismissPendingTabCloseUi: vi.fn(),
    setShowDirtyAppDialog: vi.fn((open: boolean) => {
      state.showDirtyAppDialog = open;
    }),
    setDirtyAppCloseCount: vi.fn((count: number) => {
      state.dirtyAppCloseCount = count;
    }),
    setShowCloseWindowDialog: vi.fn((open: boolean) => {
      state.showCloseWindowDialog = open;
    }),
    setShowDirtyWindowCloseDialog: vi.fn((open: boolean) => {
      state.showDirtyWindowCloseDialog = open;
    }),
    performAppClose: vi.fn(async () => true),
    confirmDirtyWindowClose: vi.fn(async () => true),
    moveWindowSessionsToMainAndClose: vi.fn(async () => true),
    handleCloseWindowSessions: vi.fn(
      async (): Promise<CloseWindowSessionsResult> => ({ kind: "closed" }),
    ),
  };

  return {
    state,
    deps,
    controller: createWindowCloseDialogController(deps),
  };
}

describe("window-close-dialog-controller", () => {
  it("shows the dirty app dialog and resets competing close UI", () => {
    const { state, deps, controller } = createRuntime();
    state.showCloseWindowDialog = true;
    state.showDirtyWindowCloseDialog = true;

    controller.showDirtyAppDialog(4);

    expect(deps.dismissPendingTabCloseUi).toHaveBeenCalledTimes(1);
    expect(state).toMatchObject({
      showDirtyAppDialog: true,
      dirtyAppCloseCount: 4,
      showCloseWindowDialog: false,
      showDirtyWindowCloseDialog: false,
    });
  });

  it("dismisses and confirms dirty app close through the orchestration", async () => {
    const { state, deps, controller } = createRuntime();
    state.showDirtyAppDialog = true;
    state.dirtyAppCloseCount = 3;

    await expect(controller.confirmDirtyAppClose()).resolves.toBe(true);
    expect(deps.performAppClose).toHaveBeenCalledTimes(1);
    expect(state).toMatchObject({
      showDirtyAppDialog: false,
      dirtyAppCloseCount: 0,
    });
  });

  it("opens the close-window dialog and can dismiss it", () => {
    const { state, controller } = createRuntime();
    state.showDirtyWindowCloseDialog = true;

    controller.showCloseWindowDialog();
    expect(state).toMatchObject({
      showCloseWindowDialog: true,
      showDirtyWindowCloseDialog: false,
    });

    controller.dismissCloseWindowDialog();
    expect(state.showCloseWindowDialog).toBe(false);
  });

  it("keeps the close-window dialog open while showing dirty-window confirmation", async () => {
    const { state, deps, controller } = createRuntime();
    state.showCloseWindowDialog = true;
    deps.handleCloseWindowSessions.mockResolvedValueOnce({
      kind: "show-dirty-window-dialog",
    });

    await expect(controller.confirmCloseWindowSessions()).resolves.toEqual({
      kind: "show-dirty-window-dialog",
    });
    expect(state).toMatchObject({
      showCloseWindowDialog: true,
      showDirtyWindowCloseDialog: true,
    });
  });

  it("confirms dirty-window close and collapses both dialogs", async () => {
    const { state, deps, controller } = createRuntime();
    state.showCloseWindowDialog = true;
    state.showDirtyWindowCloseDialog = true;

    await expect(controller.confirmDirtyWindowCloseDialog()).resolves.toBe(true);
    expect(deps.confirmDirtyWindowClose).toHaveBeenCalledTimes(1);
    expect(state).toMatchObject({
      showCloseWindowDialog: false,
      showDirtyWindowCloseDialog: false,
    });
  });

  it("moves window tabs to main and closes the dialog", async () => {
    const { state, deps, controller } = createRuntime();
    state.showCloseWindowDialog = true;

    await expect(controller.moveWindowToMainAndClose()).resolves.toBe(true);
    expect(deps.moveWindowSessionsToMainAndClose).toHaveBeenCalledTimes(1);
    expect(state.showCloseWindowDialog).toBe(false);
  });

  it("closes the regular close-window dialog after a non-dirty close-tabs result", async () => {
    const { state, controller } = createRuntime();
    state.showCloseWindowDialog = true;

    await expect(controller.confirmCloseWindowSessions()).resolves.toEqual({
      kind: "closed",
    });
    expect(state).toMatchObject({
      showCloseWindowDialog: false,
      showDirtyWindowCloseDialog: false,
    });
  });
});

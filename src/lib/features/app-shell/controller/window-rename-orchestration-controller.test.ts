import { describe, expect, it, vi } from "vitest";
import { createWindowRenameOrchestrationController } from "./window-rename-orchestration-controller";

function createRuntime() {
  const state = {
    renameDialogKind: null as "tab" | "window" | null,
    renameDialogValue: "",
    renameTargetSessionId: "session-1" as string | null,
    currentWindowName: "main",
  };

  const setCurrentWindowName = vi.fn((name: string) => {
    state.currentWindowName = name;
  });

  const controller = createWindowRenameOrchestrationController({
    getCurrentWindowName: () => state.currentWindowName,
    getCurrentWindowLabel: () => "main",
    getRenameDialogKind: () => state.renameDialogKind,
    getRenameDialogValue: () => state.renameDialogValue,
    setRenameDialogKind: (kind) => {
      state.renameDialogKind = kind;
    },
    setRenameDialogValue: (value) => {
      state.renameDialogValue = value;
    },
    setRenameTargetSessionId: (sessionId) => {
      state.renameTargetSessionId = sessionId;
    },
    setCurrentWindowName,
  });

  return {
    state,
    setCurrentWindowName,
    controller,
  };
}

describe("window-rename-orchestration-controller", () => {
  it("opens the window rename dialog with the current window name", () => {
    const { state, controller } = createRuntime();

    controller.requestRenameWindow();

    expect(state).toMatchObject({
      renameDialogKind: "window",
      renameDialogValue: "main",
      renameTargetSessionId: null,
    });
  });

  it("confirms window rename and dismisses the dialog", () => {
    const { state, setCurrentWindowName, controller } = createRuntime();
    state.renameDialogKind = "window";
    state.renameDialogValue = "  workspace-2  ";

    expect(controller.confirmRename()).toBe(true);
    expect(setCurrentWindowName).toHaveBeenCalledWith("workspace-2");
    expect(state).toMatchObject({
      renameDialogKind: null,
      renameDialogValue: "",
      renameTargetSessionId: null,
    });
  });

  it("falls back to the window label when confirming a blank name", () => {
    const { state, setCurrentWindowName, controller } = createRuntime();
    state.renameDialogKind = "window";
    state.renameDialogValue = "   ";

    expect(controller.confirmRename()).toBe(true);
    expect(setCurrentWindowName).toHaveBeenCalledWith("main");
  });

  it("ignores non-window rename requests and still supports dismiss", () => {
    const { state, setCurrentWindowName, controller } = createRuntime();
    state.renameDialogKind = "tab";
    state.renameDialogValue = "Demo";
    state.renameTargetSessionId = "session-1";

    expect(controller.confirmRename()).toBe(false);
    expect(setCurrentWindowName).not.toHaveBeenCalled();

    controller.dismissRenameDialog();
    expect(state).toMatchObject({
      renameDialogKind: null,
      renameDialogValue: "",
      renameTargetSessionId: null,
    });
  });
});

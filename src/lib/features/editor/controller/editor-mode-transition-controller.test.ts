import { describe, expect, it, vi } from "vitest";
import { createEditorRuntimeState } from "../state/editor-runtime-state.svelte";
import { createEditorModeTransitionController } from "./editor-mode-transition-controller";

describe("editor-mode-transition-controller", () => {
  it("switches into editor mode only when needed", () => {
    const state = createEditorRuntimeState();
    let viewMode: "terminal" | "editor" = "terminal";
    const prepareForEditorMode = vi.fn();
    const syncSessionState = vi.fn();

    const controller = createEditorModeTransitionController({
      state,
      getViewMode: () => viewMode,
      setViewMode: (nextViewMode) => {
        viewMode = nextViewMode;
      },
      prepareForEditorMode,
      closeQuickOpen: vi.fn(),
      syncSessionState,
    });

    expect(controller.ensureEditorViewMode()).toBe(true);
    expect(viewMode).toBe("editor");
    expect(prepareForEditorMode).toHaveBeenCalledTimes(1);
    expect(syncSessionState).toHaveBeenCalledTimes(1);

    expect(controller.ensureEditorViewMode()).toBe(false);
    expect(prepareForEditorMode).toHaveBeenCalledTimes(1);
    expect(syncSessionState).toHaveBeenCalledTimes(1);
  });

  it("switches back to terminal mode and clears quick-open/close-confirm state", () => {
    const state = createEditorRuntimeState();
    let viewMode: "terminal" | "editor" = "editor";
    state.closeConfirmVisible = true;
    state.closeConfirmPath = "/workspace/a.ts";
    const closeQuickOpen = vi.fn();
    const syncSessionState = vi.fn();

    const controller = createEditorModeTransitionController({
      state,
      getViewMode: () => viewMode,
      setViewMode: (nextViewMode) => {
        viewMode = nextViewMode;
      },
      prepareForEditorMode: vi.fn(),
      closeQuickOpen,
      syncSessionState,
    });

    controller.switchToTerminalView();

    expect(viewMode).toBe("terminal");
    expect(closeQuickOpen).toHaveBeenCalledTimes(1);
    expect(state.closeConfirmVisible).toBe(false);
    expect(state.closeConfirmPath).toBeNull();
    expect(syncSessionState).toHaveBeenCalledTimes(1);
  });
});

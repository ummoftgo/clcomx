import { describe, expect, it, vi } from "vitest";
import { createTerminalEditorPreflightController } from "./terminal-editor-preflight-controller";

describe("terminal-editor-preflight-controller", () => {
  function createController(options?: { auxVisible?: boolean; draftOpen?: boolean }) {
    let auxVisible = options?.auxVisible ?? false;
    let draftOpen = options?.draftOpen ?? false;
    const hideAuxTerminal = vi.fn();
    const closeDraft = vi.fn();
    const controller = createTerminalEditorPreflightController({
      getAuxVisible: () => auxVisible,
      getDraftOpen: () => draftOpen,
      hideAuxTerminal,
      closeDraft,
    });

    return {
      controller,
      hideAuxTerminal,
      closeDraft,
      setAuxVisible: (nextValue: boolean) => {
        auxVisible = nextValue;
      },
      setDraftOpen: (nextValue: boolean) => {
        draftOpen = nextValue;
      },
    };
  }

  it("closes both aux terminal and draft before switching into editor mode", () => {
    const { controller, hideAuxTerminal, closeDraft } = createController({
      auxVisible: true,
      draftOpen: true,
    });

    controller.prepareForEditorMode();

    expect(hideAuxTerminal).toHaveBeenCalledWith({ restoreFocus: false });
    expect(closeDraft).toHaveBeenCalledWith({ restoreFocus: false });
  });

  it("closes only the draft before opening an editor path", () => {
    const { controller, hideAuxTerminal, closeDraft } = createController({
      auxVisible: true,
      draftOpen: true,
    });

    controller.prepareForEditorPathOpen();

    expect(hideAuxTerminal).not.toHaveBeenCalled();
    expect(closeDraft).toHaveBeenCalledWith({ restoreFocus: false });
  });

  it("does nothing when aux and draft are already closed", () => {
    const { controller, hideAuxTerminal, closeDraft } = createController();

    controller.prepareForEditorMode();
    controller.prepareForEditorPathOpen();

    expect(hideAuxTerminal).not.toHaveBeenCalled();
    expect(closeDraft).not.toHaveBeenCalled();
  });
});

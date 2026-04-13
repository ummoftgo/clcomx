interface TerminalEditorPreflightControllerDependencies {
  getAuxVisible: () => boolean;
  getDraftOpen: () => boolean;
  hideAuxTerminal: (options?: { restoreFocus?: boolean }) => void;
  closeDraft: (options?: { restoreFocus?: boolean }) => void;
}

export function createTerminalEditorPreflightController(
  deps: TerminalEditorPreflightControllerDependencies,
) {
  function prepareForEditorMode() {
    if (deps.getAuxVisible()) {
      deps.hideAuxTerminal({ restoreFocus: false });
    }
    if (deps.getDraftOpen()) {
      deps.closeDraft({ restoreFocus: false });
    }
  }

  function prepareForEditorPathOpen() {
    if (deps.getDraftOpen()) {
      deps.closeDraft({ restoreFocus: false });
    }
  }

  return {
    prepareForEditorMode,
    prepareForEditorPathOpen,
  };
}

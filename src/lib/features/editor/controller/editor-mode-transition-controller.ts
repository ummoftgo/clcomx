import type { EditorRuntimeState } from "../state/editor-runtime-state.svelte";

interface EditorModeTransitionControllerDependencies {
  state: EditorRuntimeState;
  getViewMode: () => "terminal" | "editor";
  setViewMode: (viewMode: "terminal" | "editor") => void;
  prepareForEditorMode: () => void;
  closeQuickOpen: () => void;
  syncSessionState: () => void;
}

export function createEditorModeTransitionController(
  deps: EditorModeTransitionControllerDependencies,
) {
  const ensureEditorViewMode = () => {
    if (deps.getViewMode() === "editor") {
      return false;
    }

    deps.prepareForEditorMode();
    deps.setViewMode("editor");
    deps.syncSessionState();
    return true;
  };

  const switchToTerminalView = () => {
    deps.setViewMode("terminal");
    deps.closeQuickOpen();
    deps.state.closeConfirmVisible = false;
    deps.state.closeConfirmPath = null;
    deps.syncSessionState();
  };

  return {
    ensureEditorViewMode,
    switchToTerminalView,
  };
}

type RenameDialogKind = "tab" | "window" | null;

interface WindowRenameOrchestrationControllerDependencies {
  getCurrentWindowName: () => string;
  getCurrentWindowLabel: () => string;
  getRenameDialogKind: () => RenameDialogKind;
  getRenameDialogValue: () => string;
  setRenameDialogKind: (kind: RenameDialogKind) => void;
  setRenameDialogValue: (value: string) => void;
  setRenameTargetSessionId: (sessionId: string | null) => void;
  setCurrentWindowName: (name: string) => void;
}

export function createWindowRenameOrchestrationController(
  deps: WindowRenameOrchestrationControllerDependencies,
) {
  const dismissRenameDialog = () => {
    deps.setRenameDialogKind(null);
    deps.setRenameDialogValue("");
    deps.setRenameTargetSessionId(null);
  };

  const requestRenameWindow = () => {
    deps.setRenameDialogKind("window");
    deps.setRenameTargetSessionId(null);
    deps.setRenameDialogValue(deps.getCurrentWindowName());
  };

  const confirmRename = () => {
    if (deps.getRenameDialogKind() !== "window") {
      return false;
    }

    const trimmed = deps.getRenameDialogValue().trim();
    deps.setCurrentWindowName(trimmed || deps.getCurrentWindowLabel());
    dismissRenameDialog();
    return true;
  };

  return {
    dismissRenameDialog,
    requestRenameWindow,
    confirmRename,
  };
}

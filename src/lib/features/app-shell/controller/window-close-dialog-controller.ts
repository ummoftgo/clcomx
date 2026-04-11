type CloseWindowSessionsResult =
  | { kind: "show-dirty-window-dialog" }
  | { kind: "closed" }
  | { kind: "noop" };

interface WindowCloseDialogControllerDependencies {
  dismissPendingTabCloseUi: () => void;
  setShowDirtyAppDialog: (open: boolean) => void;
  setDirtyAppCloseCount: (count: number) => void;
  setShowCloseWindowDialog: (open: boolean) => void;
  setShowDirtyWindowCloseDialog: (open: boolean) => void;
  performAppClose: () => Promise<boolean>;
  confirmDirtyWindowClose: () => Promise<boolean>;
  moveWindowSessionsToMainAndClose: () => Promise<boolean>;
  handleCloseWindowSessions: () => Promise<CloseWindowSessionsResult>;
}

export function createWindowCloseDialogController(
  deps: WindowCloseDialogControllerDependencies,
) {
  const showDirtyAppDialog = (dirtyCount: number) => {
    deps.dismissPendingTabCloseUi();
    deps.setShowCloseWindowDialog(false);
    deps.setShowDirtyWindowCloseDialog(false);
    deps.setDirtyAppCloseCount(dirtyCount);
    deps.setShowDirtyAppDialog(true);
  };

  const showCloseWindowDialog = () => {
    deps.setShowDirtyWindowCloseDialog(false);
    deps.setShowCloseWindowDialog(true);
  };

  const dismissDirtyAppDialog = () => {
    deps.setShowDirtyAppDialog(false);
    deps.setDirtyAppCloseCount(0);
  };

  const confirmDirtyAppClose = async () => {
    dismissDirtyAppDialog();
    return deps.performAppClose();
  };

  const dismissCloseWindowDialog = () => {
    deps.setShowCloseWindowDialog(false);
  };

  const dismissDirtyWindowCloseDialog = () => {
    deps.setShowDirtyWindowCloseDialog(false);
  };

  const confirmDirtyWindowCloseDialog = async () => {
    deps.setShowDirtyWindowCloseDialog(false);
    deps.setShowCloseWindowDialog(false);
    return deps.confirmDirtyWindowClose();
  };

  const moveWindowToMainAndClose = async () => {
    const moved = await deps.moveWindowSessionsToMainAndClose();
    deps.setShowCloseWindowDialog(false);
    return moved;
  };

  const confirmCloseWindowSessions = async () => {
    const result = await deps.handleCloseWindowSessions();
    if (result.kind === "show-dirty-window-dialog") {
      deps.setShowCloseWindowDialog(true);
      deps.setShowDirtyWindowCloseDialog(true);
      return result;
    }

    deps.setShowCloseWindowDialog(false);
    return result;
  };

  return {
    showDirtyAppDialog,
    showCloseWindowDialog,
    dismissDirtyAppDialog,
    confirmDirtyAppClose,
    dismissCloseWindowDialog,
    dismissDirtyWindowCloseDialog,
    confirmDirtyWindowCloseDialog,
    moveWindowToMainAndClose,
    confirmCloseWindowSessions,
  };
}

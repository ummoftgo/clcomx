interface PreviewPanelSessionActionControllerDependencies {
  getActiveSessionId: () => string | null;
  requestRenameTab: (sessionId: string) => boolean;
  requestCloseTab: (sessionId: string) => void;
}

export function createPreviewPanelSessionActionController(
  deps: PreviewPanelSessionActionControllerDependencies,
) {
  const openRenameDialog = () => {
    const activeSessionId = deps.getActiveSessionId();
    if (!activeSessionId) {
      return false;
    }

    return deps.requestRenameTab(activeSessionId);
  };

  const openCloseDialog = () => {
    const activeSessionId = deps.getActiveSessionId();
    if (!activeSessionId) {
      return false;
    }

    deps.requestCloseTab(activeSessionId);
    return true;
  };

  return {
    openRenameDialog,
    openCloseDialog,
  };
}

interface PreviewOverlayResetControllerDependencies {
  hideSessionLauncher: () => void;
  closeSettingsPanel: () => void;
  closeWindowDialog: () => void;
  dismissCloseTabDialog: () => void;
  dismissRenameDialog: () => void;
}

export function createPreviewOverlayResetController(
  deps: PreviewOverlayResetControllerDependencies,
) {
  const resetOverlays = () => {
    deps.hideSessionLauncher();
    deps.closeSettingsPanel();
    deps.closeWindowDialog();
    deps.dismissCloseTabDialog();
    deps.dismissRenameDialog();
  };

  return {
    resetOverlays,
  };
}

interface AppOverlayVisibilityControllerDependencies {
  getSessionsCount: () => number;
  getShowSessionLauncher: () => boolean;
  setShowSessionLauncher: (open: boolean) => void;
  getShowSettings: () => boolean;
  setShowSettings: (open: boolean) => void;
  setShowPreviewControls: (open: boolean) => void;
  syncPreviewControlsVisible: (visible: boolean) => void;
  ensureSettingsLoaded: () => Promise<void>;
}

export function createAppOverlayVisibilityController(
  deps: AppOverlayVisibilityControllerDependencies,
) {
  const requestNewTab = () => {
    if (deps.getSessionsCount() === 0) {
      return false;
    }

    deps.setShowSessionLauncher(true);
    return true;
  };

  const hideSessionLauncher = () => {
    deps.setShowSessionLauncher(false);
  };

  const toggleSessionLauncher = () => {
    deps.setShowSessionLauncher(!deps.getShowSessionLauncher());
  };

  const openSettingsPanel = async () => {
    await deps.ensureSettingsLoaded();
    deps.setShowSettings(true);
    return true;
  };

  const closeSettingsPanel = () => {
    deps.setShowSettings(false);
  };

  const togglePreviewSettings = async () => {
    if (deps.getShowSettings()) {
      closeSettingsPanel();
      return false;
    }

    await openSettingsPanel();
    return true;
  };

  const setPreviewControlsVisible = (visible: boolean) => {
    deps.setShowPreviewControls(visible);
    deps.syncPreviewControlsVisible(visible);
  };

  return {
    requestNewTab,
    hideSessionLauncher,
    toggleSessionLauncher,
    openSettingsPanel,
    closeSettingsPanel,
    togglePreviewSettings,
    setPreviewControlsVisible,
  };
}

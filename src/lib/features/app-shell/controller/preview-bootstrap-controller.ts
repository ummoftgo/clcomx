import type { AppBootstrap } from "../../../types";
import type { PreviewPresetId } from "../../../preview/runtime";

interface PreviewBootstrapControllerDeps {
  isBrowserPreview: () => boolean;
  currentWindowLabel: () => string;
  applyPreviewPreset: (presetId: PreviewPresetId) => AppBootstrap;
  getActivePreviewPresetId: () => PreviewPresetId;
  setActivePreviewPresetId: (presetId: PreviewPresetId) => void;
  setBootstrapSnapshot: (bootstrap: AppBootstrap) => void;
  setLocalBootstrap: (bootstrap: AppBootstrap) => void;
  initializeSettings: (settings: AppBootstrap["settings"]) => void;
  initializeTabHistory: (tabHistory: AppBootstrap["tabHistory"]) => void;
  initializeWorkspaceSnapshot: (
    workspace: AppBootstrap["workspace"],
    currentWindowLabel: string,
  ) => void;
  initializeSessionsFromWorkspace: (
    workspace: AppBootstrap["workspace"],
    currentWindowLabel: string,
  ) => void;
  resetOverlays: () => void;
}

export function createPreviewBootstrapController(
  deps: PreviewBootstrapControllerDeps,
) {
  const applyBootstrap = (nextBootstrap: AppBootstrap) => {
    const currentWindowLabel = deps.currentWindowLabel();

    deps.setBootstrapSnapshot(nextBootstrap);
    deps.setLocalBootstrap(nextBootstrap);
    deps.initializeSettings(nextBootstrap.settings);
    deps.initializeTabHistory(nextBootstrap.tabHistory);
    deps.initializeWorkspaceSnapshot(nextBootstrap.workspace, currentWindowLabel);
    deps.initializeSessionsFromWorkspace(nextBootstrap.workspace, currentWindowLabel);
    deps.resetOverlays();
  };

  const handlePresetChange = (nextPresetId: PreviewPresetId) => {
    if (!deps.isBrowserPreview()) return;

    const nextBootstrap = deps.applyPreviewPreset(nextPresetId);
    deps.setActivePreviewPresetId(deps.getActivePreviewPresetId());
    applyBootstrap(nextBootstrap);
  };

  return {
    applyBootstrap,
    handlePresetChange,
  };
}

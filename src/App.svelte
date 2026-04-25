<script lang="ts">
  import type { Component } from "svelte";
  import { onMount, onDestroy } from "svelte";
  import { emitTo, listen } from "./lib/tauri/event";
  import { currentMonitor, getCurrentWindow } from "./lib/tauri/window";
  import TabBar from "./lib/features/session-tabs/view/TabBar.svelte";
  import SessionLauncher from "./lib/features/launcher/view/SessionLauncher.svelte";
  import SessionViewport from "./lib/features/session/view/SessionViewport.svelte";
  import PreviewControlPanel from "./lib/components/PreviewControlPanel.svelte";
  import {
    createWindowCloseOrchestrationController,
    DIRTY_STATE_QUERY_EVENT,
    DIRTY_STATE_RESPONSE_EVENT,
    type DirtyStateQueryPayload,
    type DirtyStateResponsePayload,
  } from "./lib/features/app-shell/controller/window-close-orchestration-controller";
  import { createAppOverlayVisibilityController } from "./lib/features/app-shell/controller/app-overlay-visibility-controller";
  import { createAppWindowListenerController } from "./lib/features/app-shell/controller/app-window-listener-controller";
  import { createAppStartupController } from "./lib/features/app-shell/controller/app-startup-controller";
  import { createPreviewBootstrapController } from "./lib/features/app-shell/controller/preview-bootstrap-controller";
  import { createPreviewOverlayResetController } from "./lib/features/app-shell/controller/preview-overlay-reset-controller";
  import { createPreviewPanelSessionActionController } from "./lib/features/app-shell/controller/preview-panel-session-action-controller";
  import { createSettingsModalLoaderController } from "./lib/features/app-shell/controller/settings-modal-loader-controller";
  import { createWindowCloseDialogController } from "./lib/features/app-shell/controller/window-close-dialog-controller";
  import { createWindowRenameOrchestrationController } from "./lib/features/app-shell/controller/window-rename-orchestration-controller";
  import { createWindowSessionDetachOrchestrationController } from "./lib/features/app-shell/controller/window-session-detach-orchestration-controller";
  import { createWindowSessionMoveOrchestrationController } from "./lib/features/app-shell/controller/window-session-move-orchestration-controller";
  import AppDialogStack from "./lib/features/app-shell/view/AppDialogStack.svelte";
  import {
    createPreviewUrlStateController,
    PREVIEW_FRAME_OPTIONS,
    type PreviewFrameMode,
  } from "./lib/features/app-shell/controller/preview-url-state-controller";
  import { createWindowPlacementController } from "./lib/features/app-shell/controller/window-placement-controller";
  import {
    addSession,
    getActiveSessionId,
    getSessions,
    moveSession,
    setActiveSession,
    setSessionAuxState,
    setSessionEditorState,
    setSessionLocked,
    setSessionPtyId,
    setSessionPinned,
    setSessionResumeToken,
    setSessionTitle,
  } from "./lib/features/session/state/live-session-store.svelte";
  import {
    areSessionsInitialized,
    getCurrentWindowName,
    initializeSessionsFromWorkspace,
    persistWorkspace,
    setCurrentWindowName,
    syncSessionsFromWorkspace,
  } from "./lib/features/workspace/session-store.svelte";
  import { createWorkspaceAutosaveController } from "./lib/features/workspace/controller/workspace-autosave-controller";
  import {
    getOtherWindows,
    initializeWorkspaceSnapshot,
    syncWorkspaceSnapshot,
  } from "./lib/stores/workspace.svelte";
  import { getSettings, initializeSettings, updateSettings } from "./lib/stores/settings.svelte";
  import {
    getTabHistory,
    initializeTabHistory,
    recordTabHistory,
  } from "./lib/stores/tab-history.svelte";
  import { primeEditorsDetection } from "./lib/stores/editors.svelte";
  import { getBootstrap, setBootstrap } from "./lib/bootstrap";
  import { setLanguagePreference } from "./lib/i18n";
  import { TEST_IDS } from "./lib/testids";
  import { getThemeById } from "./lib/themes";
  import { applyRuntimeStyleLayer, Button } from "./lib/ui";
  import {
    closeApp,
    closeSessionByPtyId,
    closeWindowSessions,
    isWindowReady,
    moveSessionToWindow,
    moveWindowSessionsToMain,
    notifyWindowReady,
    openEmptyWindow,
    removeWindow,
    setSessionAuxTerminalState as persistSessionAuxTerminalState,
    setSessionPty,
    closePtyAndCaptureResume,
    clearSessionPty,
    closeSession,
    setSessionResumeToken as persistSessionResumeToken,
    updateWindowGeometry,
  } from "./lib/workspace";
  import { killPty } from "./lib/pty";
  import type { TabHistoryEntry, WorkspaceSnapshot } from "./lib/types";
  import type { AgentId } from "./lib/agents";
  import { createSessionLifecycleController } from "./lib/features/session/controller/session-lifecycle-controller";
  import { createTabCloseOrchestrationController } from "./lib/features/session/controller/tab-close-orchestration-controller";
  import { createTabRenameOrchestrationController } from "./lib/features/session/controller/tab-rename-orchestration-controller";
  import { loadSessionShellComponent } from "./lib/features/session/service/session-shell-loader";
  import { createTabOrganizationController } from "./lib/features/session-tabs/controller/tab-organization-controller";
  import { dispatchTerminalFocusRequest } from "./lib/features/terminal/controller/terminal-focus-bridge";
  import { installCanonicalScreenAuthority } from "./lib/terminal/canonical-screen-authority";
  import type { SessionShellAuxState } from "./lib/features/session/contracts/session-shell";
  import {
    applyPreviewPreset,
    getActivePreviewPresetId,
    getAvailablePreviewPresets,
    isBrowserPreview,
    type PreviewPresetId,
  } from "./lib/preview/runtime";
  import { createRuntimeId } from "./lib/ids";

  const appWindow = getCurrentWindow();
  const currentWindowLabel = appWindow.label;
  const isMainWindow = currentWindowLabel === "main";
  const browserPreview = isBrowserPreview();
  const settings = getSettings();
  const previewPresetOptions = getAvailablePreviewPresets();
  const previewUrlState = createPreviewUrlStateController({
    isBrowserPreview: () => browserPreview,
    getCurrentHref: () => (typeof window === "undefined" ? null : window.location.href),
    replaceUrl: (url) => {
      if (typeof window === "undefined") return;
      window.history.replaceState(window.history.state, "", url);
    },
  });
  let bootstrap = $state(getBootstrap());

  $effect(() => {
    const theme = getThemeById(settings.interface.theme)?.theme;
    applyRuntimeStyleLayer(document, settings, theme);
  });

  $effect(() => {
    setLanguagePreference(settings.language, navigator.language);
  });

  const sessions = $derived(getSessions());
  const activeSessionId = $derived(getActiveSessionId());
  const currentWindowName = $derived(getCurrentWindowName());
  const historyEntries = $derived(getTabHistory());
  const otherWindows = $derived(getOtherWindows());

  let showSessionLauncher = $state(false);
  let showSettings = $state(false);
  let showCloseWindowDialog = $state(false);
  let showCloseTabDialog = $state(false);
  let showDirtyTabDialog = $state(false);
  let showDirtyAppDialog = $state(false);
  let showDirtyWindowCloseDialog = $state(false);
  let dirtyAppCloseCount = $state(0);
  let pendingCloseSessionId = $state<string | null>(null);
  let renameDialogKind = $state<"tab" | "window" | null>(null);
  let renameDialogValue = $state("");
  let renameTargetSessionId = $state<string | null>(null);
  let allowNativeClose = false;
  let SessionShellComponent = $state<Component<any> | null>(null);
  let SettingsModalComponent = $state<Component<any> | null>(null);
  let previewPresetId = $state<PreviewPresetId>(getActivePreviewPresetId());
  let previewFrameMode = $state<PreviewFrameMode>(previewUrlState.getInitialFrameMode());
  let showPreviewControls = $state(previewUrlState.getInitialControlsVisible());
  let terminalLoadPromise: Promise<void> | null = null;
  const previewFrameWidth = $derived(
    previewFrameMode === "desktop"
      ? "1380px"
      : previewFrameMode === "narrow"
        ? "1080px"
        : "100%",
  );
  const pendingCloseSession = $derived(
    pendingCloseSessionId
      ? sessions.find((session) => session.id === pendingCloseSessionId) ?? null
      : null,
  );
  const dirtySessions = $derived(sessions.filter((session) => session.dirtyPaths.length > 0));

  function getLocalDirtySessionCount() {
    return dirtySessions.length;
  }

  $effect(() => {
    const normalizedName = currentWindowName.trim();
    const nextTitle =
      currentWindowLabel === "main" && (!normalizedName || normalizedName === "main")
        ? "CLCOMX"
        : `CLCOMX - ${normalizedName || currentWindowLabel}`;
    void appWindow.setTitle(nextTitle);
  });

  async function ensureSessionShellComponent() {
    if (SessionShellComponent) return;
    if (terminalLoadPromise) {
      await terminalLoadPromise;
      return;
    }

    terminalLoadPromise = (
      loadSessionShellComponent(browserPreview)
    )
      .then((component) => {
        SessionShellComponent = component;
      })
      .finally(() => {
        terminalLoadPromise = null;
      });

    await terminalLoadPromise;
  }

  async function closeCurrentWindow() {
    allowNativeClose = true;
    await appWindow.close();
  }

  const settingsModalLoader = createSettingsModalLoaderController({
    getComponent: () => SettingsModalComponent,
    setComponent: (component) => {
      SettingsModalComponent = component;
    },
    loadComponent: async () => (await import("./lib/components/SettingsModal.svelte")).default,
  });

  const windowPlacement = createWindowPlacementController({
    isMainWindow: () => isMainWindow,
    currentWindowLabel: () => currentWindowLabel,
    getWindowPosition: () => appWindow.outerPosition(),
    getWindowSize: () => appWindow.innerSize(),
    isWindowMaximized: () => appWindow.isMaximized(),
    getCurrentMonitorName: async () => (await currentMonitor())?.name ?? null,
    updateMainWindowPlacement: (mainWindow) => {
      updateSettings({ mainWindow });
    },
    updateWindowGeometry,
    reportError: (message, error) => {
      console.error(message, error);
    },
  });

  const workspaceAutosave = createWorkspaceAutosaveController({
    persistWorkspace,
  });

  const previewBootstrapController = createPreviewBootstrapController({
    isBrowserPreview: () => browserPreview,
    currentWindowLabel: () => currentWindowLabel,
    applyPreviewPreset,
    getActivePreviewPresetId,
    setActivePreviewPresetId: (nextPresetId) => {
      previewPresetId = nextPresetId;
    },
    setBootstrapSnapshot: setBootstrap,
    setLocalBootstrap: (nextBootstrap) => {
      bootstrap = nextBootstrap;
    },
    initializeSettings,
    initializeTabHistory,
    initializeWorkspaceSnapshot,
    initializeSessionsFromWorkspace,
    resetOverlays: () => previewOverlayReset.resetOverlays(),
  });

  const windowCloseOrchestration = createWindowCloseOrchestrationController({
    isMainWindow: () => isMainWindow,
    currentWindowLabel: () => currentWindowLabel,
    getSessionsCount: () => sessions.length,
    getLocalDirtySessionCount,
    getOtherWindowLabels: () => otherWindows.map((window) => window.label).filter(Boolean),
    emitDirtyStateQuery: (label, payload) => emitTo<DirtyStateQueryPayload>(label, DIRTY_STATE_QUERY_EVENT, payload),
    listenDirtyStateResponse: async (listener) => {
      const unlisten = await listen<DirtyStateResponsePayload>(DIRTY_STATE_RESPONSE_EVENT, (event) => {
        listener(event.payload);
      });
      return unlisten;
    },
    closeCurrentWindow,
    removeCurrentWindow: () => removeWindow(currentWindowLabel),
    captureResumeIdsBeforeAppClose,
    closeApp,
    closeWindowSessions: () => closeWindowSessions(currentWindowLabel),
    moveWindowSessionsToMain: () => moveWindowSessionsToMain(currentWindowLabel),
    reportError: (message, error) => {
      console.error(message, error);
    },
    createRequestId: createRuntimeId,
    wait: (ms) => new Promise<void>((resolve) => {
      setTimeout(resolve, ms);
    }),
  });

  const appStartup = createAppStartupController({
    isMainWindow: () => isMainWindow,
    currentWindowLabel: () => currentWindowLabel,
    installCanonicalScreenAuthority,
    notifyWindowReady,
    scheduleInitialPlacementPersist: () => {
      windowPlacement.scheduleInitialPersist();
    },
    primeEditorsDetection,
    reportError: (message, error) => {
      console.error(message, error);
    },
  });

  const appOverlayVisibility = createAppOverlayVisibilityController({
    getSessionsCount: () => sessions.length,
    getShowSessionLauncher: () => showSessionLauncher,
    setShowSessionLauncher: (open) => {
      showSessionLauncher = open;
    },
    getShowSettings: () => showSettings,
    setShowSettings: (open) => {
      showSettings = open;
    },
    setShowPreviewControls: (open) => {
      showPreviewControls = open;
    },
    syncPreviewControlsVisible: (visible) => {
      previewUrlState.setControlsVisible(visible);
    },
    ensureSettingsLoaded: () => settingsModalLoader.ensureLoaded(),
  });

  const previewOverlayReset = createPreviewOverlayResetController({
    hideSessionLauncher: appOverlayVisibility.hideSessionLauncher,
    closeSettingsPanel: appOverlayVisibility.closeSettingsPanel,
    closeWindowDialog: () => {
      showCloseWindowDialog = false;
    },
    dismissCloseTabDialog: () => tabCloseOrchestration.dismissCloseTabDialog(),
    dismissRenameDialog: () => dismissRenameDialog(),
  });

  function usesKoreanCopy() {
    if (settings.language === "ko") return true;
    if (settings.language === "en") return false;
    return typeof navigator !== "undefined" && navigator.language.toLowerCase().startsWith("ko");
  }

  onMount(() => {
    void (async () => {
      await appWindowListeners.register();
      await appStartup.start();
    })();
  });

  onDestroy(() => {
    appStartup.dispose();
    windowPlacement.dispose();
    workspaceAutosave.dispose();
    appWindowListeners.dispose();
  });

  $effect(() => {
    if (!areSessionsInitialized()) return;

    sessions.map((session) => ({
      id: session.id,
      agentId: session.agentId,
      title: session.title,
      pinned: session.pinned,
      locked: session.locked,
      resumeToken: session.resumeToken,
      distro: session.distro,
      workDir: session.workDir,
      viewMode: session.viewMode,
      editorRootDir: session.editorRootDir,
      openEditorTabs: session.openEditorTabs,
      activeEditorPath: session.activeEditorPath,
      ptyId: session.ptyId,
      auxPtyId: session.auxPtyId,
      auxVisible: session.auxVisible,
      auxHeightPercent: session.auxHeightPercent,
    }));
    activeSessionId;
    currentWindowName;

    workspaceAutosave.schedule();
  });

  $effect(() => {
    if (sessions.length > 0) {
      void ensureSessionShellComponent();
    }
  });

  $effect(() => {
    if ((showCloseTabDialog || showDirtyTabDialog) && pendingCloseSessionId && !pendingCloseSession) {
      tabCloseOrchestration.reconcilePendingCloseTab();
    }
  });

  $effect(() => {
    if (renameDialogKind === "tab" && renameTargetSessionId) {
      tabRenameOrchestration.reconcilePendingRenameDialog();
    }
  });

  function handlePreviewPresetChange(nextPresetId: PreviewPresetId) {
    previewBootstrapController.handlePresetChange(nextPresetId);
  }

  function handlePreviewFrameModeChange(nextFrameMode: string) {
    previewFrameMode = previewUrlState.normalizeFrameMode(nextFrameMode);
    previewUrlState.setFrameMode(previewFrameMode);
  }

  const reportSessionLifecycleError = (message: string, error: unknown) => {
    console.error(message, error);
  };

  const sessionLifecycle = createSessionLifecycleController({
    addSession,
    hideSessionLauncher: appOverlayVisibility.hideSessionLauncher,
    ensureSessionShellComponent,
    persistWorkspace,
    getSession: (sessionId) => sessions.find((entry) => entry.id === sessionId) ?? null,
    getSessions: () => sessions,
    setSessionPtyId,
    persistSessionPty: setSessionPty,
    recordTabHistory,
    setSessionAuxState,
    persistSessionAuxState: persistSessionAuxTerminalState,
    setSessionResumeToken,
    persistSessionResumeToken,
    clearSessionPty,
    closeSession,
    closeSessionByPtyId,
    closePtyAndCaptureResume,
    killPty,
    reportError: reportSessionLifecycleError,
  });

  function createSession(
    agentId: AgentId,
    distro: string,
    workDir: string,
    title = workDir.split("/").pop() || workDir,
    resumeToken: string | null = null,
  ) {
    sessionLifecycle.createSession(agentId, distro, workDir, title, resumeToken);
  }

  function openHistoryEntry(entry: TabHistoryEntry) {
    sessionLifecycle.openHistoryEntry(entry);
  }

  async function handlePtyId(sessionId: string, ptyId: number) {
    await sessionLifecycle.handlePtyId(sessionId, ptyId);
  }

  async function handleAuxTerminalState(
    sessionId: string,
    auxPtyId: number,
    auxVisible: boolean,
    auxHeightPercent: number | null,
  ) {
    await sessionLifecycle.handleAuxTerminalState(sessionId, {
      auxPtyId,
      auxVisible,
      auxHeightPercent,
    });
  }

  async function handleExit(ptyId: number) {
    await sessionLifecycle.handleExit(ptyId);
  }

  async function handleResumeFallback(sessionId: string) {
    await sessionLifecycle.handleResumeFallback(sessionId);
  }

  async function captureResumeIdsBeforeAppClose() {
    await sessionLifecycle.captureResumeIdsBeforeAppClose();
  }

  async function handleCloseTab(sessionId: string) {
    await sessionLifecycle.handleCloseTab(sessionId);
  }

  const tabCloseOrchestration = createTabCloseOrchestrationController({
    getSession: (sessionId) => sessions.find((entry) => entry.id === sessionId) ?? null,
    getPendingCloseSessionId: () => pendingCloseSessionId,
    setPendingCloseSessionId: (sessionId) => {
      pendingCloseSessionId = sessionId;
    },
    getShowCloseTabDialog: () => showCloseTabDialog,
    getShowDirtyTabDialog: () => showDirtyTabDialog,
    setShowCloseTabDialog: (open) => {
      showCloseTabDialog = open;
    },
    setShowDirtyTabDialog: (open) => {
      showDirtyTabDialog = open;
    },
    closeTab: handleCloseTab,
  });

  const tabRenameOrchestration = createTabRenameOrchestrationController({
    getSession: (sessionId) => sessions.find((entry) => entry.id === sessionId) ?? null,
    getRenameDialogKind: () => renameDialogKind,
    getRenameDialogValue: () => renameDialogValue,
    getRenameTargetSessionId: () => renameTargetSessionId,
    setRenameDialogKind: (kind) => {
      renameDialogKind = kind;
    },
    setRenameDialogValue: (value) => {
      renameDialogValue = value;
    },
    setRenameTargetSessionId: (sessionId) => {
      renameTargetSessionId = sessionId;
    },
    setSessionTitle,
    recordTabHistory,
  });

  const previewPanelSessionActions = createPreviewPanelSessionActionController({
    getActiveSessionId: () => activeSessionId,
    requestRenameTab: (sessionId) => tabRenameOrchestration.requestRenameTab(sessionId),
    requestCloseTab: (sessionId) => {
      tabCloseOrchestration.requestCloseTab(sessionId);
    },
  });

  const windowRenameOrchestration = createWindowRenameOrchestrationController({
    getCurrentWindowName: () => currentWindowName,
    getCurrentWindowLabel: () => currentWindowLabel,
    getRenameDialogKind: () => renameDialogKind,
    getRenameDialogValue: () => renameDialogValue,
    setRenameDialogKind: (kind) => {
      renameDialogKind = kind;
    },
    setRenameDialogValue: (value) => {
      renameDialogValue = value;
    },
    setRenameTargetSessionId: (sessionId) => {
      renameTargetSessionId = sessionId;
    },
    setCurrentWindowName,
  });

  const windowSessionMoveOrchestration = createWindowSessionMoveOrchestrationController({
    isWindowReady,
    moveSessionToWindow,
    reportError: (message, error) => {
      console.error(message, error);
    },
    wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: () => Date.now(),
  });

  const windowSessionDetachOrchestration = createWindowSessionDetachOrchestrationController({
    openEmptyWindow,
    waitForWindowReady: windowSessionMoveOrchestration.waitForWindowReady,
    moveSessionToWindow,
    reportError: (message, error) => {
      console.error(message, error);
    },
  });

  const windowCloseDialogController = createWindowCloseDialogController({
    dismissPendingTabCloseUi: () => {
      showCloseTabDialog = false;
      showDirtyTabDialog = false;
      pendingCloseSessionId = null;
    },
    setShowDirtyAppDialog: (open) => {
      showDirtyAppDialog = open;
    },
    setDirtyAppCloseCount: (count) => {
      dirtyAppCloseCount = count;
    },
    setShowCloseWindowDialog: (open) => {
      showCloseWindowDialog = open;
    },
    setShowDirtyWindowCloseDialog: (open) => {
      showDirtyWindowCloseDialog = open;
    },
    performAppClose: () => windowCloseOrchestration.performAppClose(),
    confirmDirtyWindowClose: () => windowCloseOrchestration.confirmDirtyWindowClose(),
    moveWindowSessionsToMainAndClose: () => windowCloseOrchestration.moveWindowSessionsToMainAndClose(),
    handleCloseWindowSessions: () => windowCloseOrchestration.handleCloseWindowSessions(),
  });

  const appWindowListeners = createAppWindowListenerController({
    onCloseRequested: (listener) => appWindow.onCloseRequested(listener),
    onMoved: (listener) => appWindow.onMoved(listener),
    onResized: (listener) => appWindow.onResized(listener),
    listenWorkspaceUpdated: async (listener) => {
      const unlisten = await listen<WorkspaceSnapshot>("workspace-updated", (event) => {
        listener(event.payload);
      });
      return unlisten;
    },
    listenDirtyStateQuery: async (listener) => {
      const unlisten = await listen<DirtyStateQueryPayload>(DIRTY_STATE_QUERY_EVENT, (event) => {
        listener(event.payload);
      });
      return unlisten;
    },
    emitDirtyStateResponse: (label, payload) =>
      emitTo<DirtyStateResponsePayload>(label, DIRTY_STATE_RESPONSE_EVENT, payload),
    consumeNativeCloseAllowance: () => {
      if (!allowNativeClose) return false;
      allowNativeClose = false;
      return true;
    },
    handleCloseRequested: () => windowCloseOrchestration.handleCloseRequested(),
    showDirtyAppDialog: (dirtyCount) => windowCloseDialogController.showDirtyAppDialog(dirtyCount),
    showCloseWindowDialog: () => windowCloseDialogController.showCloseWindowDialog(),
    schedulePlacementPersist: () => windowPlacement.schedulePersist(),
    syncWorkspaceSnapshot,
    syncSessionsFromWorkspace,
    currentWindowLabel: () => currentWindowLabel,
    getLocalDirtySessionCount,
  });

  const tabOrganizationController = createTabOrganizationController({
    getSessions: () => sessions,
    setActiveSession,
    moveSession,
    setSessionPinned,
    setSessionLocked,
  });

  function dismissDirtyAppDialog() {
    windowCloseDialogController.dismissDirtyAppDialog();
  }

  function confirmDirtyAppClose() {
    void windowCloseDialogController.confirmDirtyAppClose();
  }

  function dismissDirtyWindowCloseDialog() {
    windowCloseDialogController.dismissDirtyWindowCloseDialog();
  }

  async function confirmDirtyWindowCloseDialog() {
    await windowCloseDialogController.confirmDirtyWindowCloseDialog();
  }

  async function handleMoveTabToNewWindow(sessionId: string) {
    try {
      const position = await appWindow.outerPosition();
      const { measureWindowSizeForTerminal } = await import("./lib/window-size");
      const defaultWindowSize = await measureWindowSizeForTerminal(settings);
      await windowSessionDetachOrchestration.moveSessionToNewWindow(sessionId, {
        x: Math.max(0, position.x + 72),
        y: Math.max(0, position.y + 72),
        width: defaultWindowSize.width,
        height: defaultWindowSize.height,
      });
    } catch (error) {
      console.error("Failed to detach tab", error);
    }
  }

  async function handleMoveTabToWindow(sessionId: string, targetLabel: string) {
    await windowSessionMoveOrchestration.moveSessionToExistingWindow(sessionId, targetLabel);
  }

  function handleActivateTab(sessionId: string) {
    setActiveSession(sessionId);
  }

  function handleReorderTab(sessionId: string, targetIndex: number) {
    moveSession(sessionId, targetIndex);
  }

  function handleRequestTabSessionFocus(sessionId: string) {
    dispatchTerminalFocusRequest(window, sessionId);
  }

  function requestRenameTab(sessionId: string) {
    tabRenameOrchestration.requestRenameTab(sessionId);
  }

  function requestRenameWindow() {
    windowRenameOrchestration.requestRenameWindow();
  }

  function dismissRenameDialog() {
    windowRenameOrchestration.dismissRenameDialog();
  }

  function confirmRename() {
    if (tabRenameOrchestration.confirmRename()) {
      return;
    }

    if (windowRenameOrchestration.confirmRename()) {
      return;
    }
    dismissRenameDialog();
  }

  async function handleMoveWindowToMain() {
    await windowCloseDialogController.moveWindowToMainAndClose();
  }

  async function handleCloseWindowSessions() {
    await windowCloseDialogController.confirmCloseWindowSessions();
  }

  function handleKeydown(e: KeyboardEvent) {
    if (e.ctrlKey && e.key === "t") {
      e.preventDefault();
      appOverlayVisibility.requestNewTab();
    }
    if (e.ctrlKey && e.key === "w") {
      e.preventDefault();
      if (activeSessionId) {
        tabCloseOrchestration.requestCloseTab(activeSessionId);
      }
    }
  }
</script>

<svelte:window onkeydown={handleKeydown} />

<div
  class:app--browser-preview={browserPreview}
  class:app--preview-controls-hidden={browserPreview && !showPreviewControls}
  class="app"
  data-testid={TEST_IDS.appRoot}
  data-window-label={currentWindowLabel}
  data-session-count={sessions.length}
  data-test-mode={bootstrap.testMode ? "true" : "false"}
  data-debug-terminal-hooks={bootstrap.debugTerminalHooks ? "true" : "false"}
>
  {#if browserPreview && showPreviewControls}
    <PreviewControlPanel
      presetId={previewPresetId}
      presetOptions={previewPresetOptions}
      frameMode={previewFrameMode}
      frameOptions={PREVIEW_FRAME_OPTIONS}
      launcherOpen={showSessionLauncher}
      settingsOpen={showSettings}
      hasSessions={sessions.length > 0}
      onPresetChange={handlePreviewPresetChange}
      onFrameModeChange={handlePreviewFrameModeChange}
      onToggleLauncher={appOverlayVisibility.toggleSessionLauncher}
      onToggleSettings={() => { void appOverlayVisibility.togglePreviewSettings(); }}
      onOpenRename={previewPanelSessionActions.openRenameDialog}
      onOpenCloseDialog={previewPanelSessionActions.openCloseDialog}
      onResetOverlays={previewOverlayReset.resetOverlays}
      onToggleVisibility={() => { appOverlayVisibility.setPreviewControlsVisible(false); }}
    />
  {:else if browserPreview}
    <div class="preview-control-toggle">
      <Button
        size="sm"
        variant="secondary"
        onclick={() => { appOverlayVisibility.setPreviewControlsVisible(true); }}
      >
        Preview Tools
      </Button>
    </div>
  {/if}

  <div
    class="app-frame"
    data-preview-frame={browserPreview ? previewFrameMode : undefined}
    style:--preview-frame-width={browserPreview ? previewFrameWidth : undefined}
  >
    <TabBar
      {sessions}
      {activeSessionId}
      onNewTab={appOverlayVisibility.requestNewTab}
      onActivateTab={handleActivateTab}
      onReorderTab={handleReorderTab}
      onRequestSessionFocus={handleRequestTabSessionFocus}
      onSettings={() => { void appOverlayVisibility.openSettingsPanel(); }}
      onCloseTab={tabCloseOrchestration.requestCloseTab}
      onRenameTab={requestRenameTab}
      onRenameWindow={requestRenameWindow}
      onTogglePinTab={tabOrganizationController.togglePin}
      onToggleLockTab={tabOrganizationController.toggleLock}
      onMoveTabLeft={tabOrganizationController.moveLeft}
      onMoveTabRight={tabOrganizationController.moveRight}
      onMoveTabToNewWindow={handleMoveTabToNewWindow}
      onMoveTabToWindow={handleMoveTabToWindow}
      availableWindows={otherWindows.map((window) => ({
        label: window.label,
        name: window.name,
      }))}
    />

    <SessionViewport
      {sessions}
      {activeSessionId}
      {historyEntries}
      {SessionShellComponent}
      SessionLauncherComponent={SessionLauncher}
      onOpenHistory={openHistoryEntry}
      onConfirmSession={createSession}
      onSessionEditorStateChange={(sessionId, state) => {
        setSessionEditorState(sessionId, state);
      }}
      onSessionPtyId={handlePtyId}
      onSessionAuxStateChange={(sessionId: string, state: SessionShellAuxState) =>
        handleAuxTerminalState(
          sessionId,
          state.auxPtyId,
          state.auxVisible,
          state.auxHeightPercent,
        )}
      onSessionExit={handleExit}
      onSessionResumeFallback={handleResumeFallback}
    />
  </div>

  <SessionLauncher
    visible={showSessionLauncher}
    historyEntries={historyEntries}
    onOpenHistory={openHistoryEntry}
    onConfirm={createSession}
    onCancel={appOverlayVisibility.hideSessionLauncher}
  />

  {#if SettingsModalComponent}
    <SettingsModalComponent
      visible={showSettings}
      onClose={appOverlayVisibility.closeSettingsPanel}
    />
  {/if}

  <AppDialogStack
    {showDirtyTabDialog}
    {showCloseTabDialog}
    {showDirtyAppDialog}
    {showDirtyWindowCloseDialog}
    {showCloseWindowDialog}
    hasPendingCloseSession={pendingCloseSession !== null}
    pendingCloseSessionTitle={pendingCloseSession?.title ?? ""}
    {dirtyAppCloseCount}
    dirtyWindowCloseCount={dirtySessions.length}
    {renameDialogKind}
    bind:renameDialogValue
    useKoreanDirtyCopy={usesKoreanCopy()}
    onDismissDirtyTab={tabCloseOrchestration.dismissDirtyTabDialog}
    onContinueDirtyTabClose={tabCloseOrchestration.continueCloseTabAfterDirtyWarning}
    onDismissCloseTab={tabCloseOrchestration.dismissCloseTabDialog}
    onConfirmCloseTab={tabCloseOrchestration.confirmCloseTab}
    onDismissDirtyApp={dismissDirtyAppDialog}
    onConfirmDirtyAppClose={confirmDirtyAppClose}
    onDismissDirtyWindowClose={dismissDirtyWindowCloseDialog}
    onConfirmDirtyWindowClose={confirmDirtyWindowCloseDialog}
    onDismissCloseWindow={windowCloseDialogController.dismissCloseWindowDialog}
    onMoveWindowToMain={handleMoveWindowToMain}
    onCloseWindowSessions={handleCloseWindowSessions}
    onDismissRename={dismissRenameDialog}
    onConfirmRename={confirmRename}
  />
</div>

<style>
  .app {
    box-sizing: border-box;
    display: flex;
    flex-direction: column;
    height: 100vh;
    width: 100vw;
    overflow: hidden;
  }

  .app--browser-preview {
    --preview-top-gutter: 86px;
    padding: var(--preview-top-gutter) 14px 14px;
    background:
      radial-gradient(circle at top left, rgba(var(--ui-accent-rgb, 84, 160, 255), 0.14), transparent 28%),
      linear-gradient(180deg, color-mix(in srgb, var(--ui-bg-app) 86%, black 14%), color-mix(in srgb, var(--ui-bg-app) 92%, black 8%));
    overflow: auto;
  }

  .app--preview-controls-hidden {
    --preview-top-gutter: 68px;
  }

  .app-frame {
    width: 100%;
    display: flex;
    flex: 1;
    min-width: 0;
    min-height: 0;
    flex-direction: column;
  }

  .app--browser-preview .app-frame {
    width: min(var(--preview-frame-width), 100%);
    min-height: calc(100vh - 100px);
    margin: 0 auto;
    border: 1px solid color-mix(in srgb, var(--ui-border-subtle) 82%, transparent);
    border-radius: 24px;
    overflow: hidden;
    background: color-mix(in srgb, var(--ui-bg-app) 94%, #05070d);
    box-shadow:
      0 28px 70px rgba(var(--ui-shadow-rgb), 0.24),
      inset 0 1px 0 rgba(255, 255, 255, 0.04);
  }

  @media (max-width: 960px) {
    .app--browser-preview {
      --preview-top-gutter: 168px;
    }

    .app--preview-controls-hidden {
      --preview-top-gutter: 60px;
    }

    .app-frame {
      min-height: calc(100vh - 182px);
      border-radius: 18px;
    }
  }

  .preview-control-toggle {
    position: fixed;
    top: 16px;
    right: 18px;
    z-index: 50;
  }

  @media (max-width: 960px) {
    .preview-control-toggle {
      top: 12px;
      right: 12px;
    }
  }
</style>

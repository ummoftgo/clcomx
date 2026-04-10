<script lang="ts">
  import type { Component } from "svelte";
  import { onMount, onDestroy } from "svelte";
  import { emitTo, listen, type UnlistenFn } from "./lib/tauri/event";
  import { currentMonitor, getCurrentWindow } from "./lib/tauri/window";
  import TabBar from "./lib/components/TabBar.svelte";
  import SessionLauncher from "./lib/components/SessionLauncher.svelte";
  import SessionViewport from "./lib/features/session/view/SessionViewport.svelte";
  import PreviewControlPanel from "./lib/components/PreviewControlPanel.svelte";
  import {
    createWindowCloseOrchestrationController,
    DIRTY_STATE_QUERY_EVENT,
    DIRTY_STATE_RESPONSE_EVENT,
    type DirtyStateQueryPayload,
    type DirtyStateResponsePayload,
  } from "./lib/features/app-shell/controller/window-close-orchestration-controller";
  import { createSettingsModalLoaderController } from "./lib/features/app-shell/controller/settings-modal-loader-controller";
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
  import { setLanguagePreference, t } from "./lib/i18n";
  import { TEST_IDS } from "./lib/testids";
  import { getThemeById } from "./lib/themes";
  import { applyRuntimeStyleLayer, Button, ModalShell } from "./lib/ui";
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
  import type { AppBootstrap, TabHistoryEntry, WorkspaceSnapshot } from "./lib/types";
  import type { AgentId } from "./lib/agents";
  import { createSessionLifecycleController } from "./lib/features/session/controller/session-lifecycle-controller";
  import { loadSessionShellComponent } from "./lib/features/session/service/session-shell-loader";
  import {
    resolveAdjacentSessionMoveIndex,
    resolveCloseTabRequest,
    resolveRenamedSessionTitle,
  } from "./lib/features/session/service/session-tab-behavior";
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

  type PreviewFrameMode = "fluid" | "desktop" | "narrow";

  const PREVIEW_FRAME_OPTIONS = [
    { id: "fluid", label: "Fluid" },
    { id: "desktop", label: "Desktop" },
    { id: "narrow", label: "Narrow" },
  ] as const;
  const appWindow = getCurrentWindow();
  const currentWindowLabel = appWindow.label;
  const isMainWindow = currentWindowLabel === "main";
  const browserPreview = isBrowserPreview();
  const settings = getSettings();
  const previewPresetOptions = getAvailablePreviewPresets();
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
  let windowListeners: UnlistenFn[] = [];
  let workspaceSaveTimer: ReturnType<typeof setTimeout> | null = null;
  let SessionShellComponent = $state<Component<any> | null>(null);
  let SettingsModalComponent = $state<Component<any> | null>(null);
  let previewPresetId = $state<PreviewPresetId>(getActivePreviewPresetId());
  let previewFrameMode = $state<PreviewFrameMode>(getInitialPreviewFrameMode());
  let showPreviewControls = $state(getInitialPreviewControlsVisible());
  let terminalLoadPromise: Promise<void> | null = null;
  let canonicalAuthorityCleanup: (() => void) | null = null;
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

  function usesKoreanCopy() {
    if (settings.language === "ko") return true;
    if (settings.language === "en") return false;
    return typeof navigator !== "undefined" && navigator.language.toLowerCase().startsWith("ko");
  }

  function getDirtyCloseDialogCopy(
    kind: "tab" | "app" | "window",
    options: { title?: string; count?: number } = {},
  ) {
    const isKo = usesKoreanCopy();
    const count = Math.max(0, options.count ?? 0);

    if (kind === "tab") {
      return isKo
        ? {
            title: "저장되지 않은 변경 사항",
            description: `"${options.title || "이 탭"}"에 저장되지 않은 편집 내용이 있습니다. 닫으면 변경 사항이 버려집니다.`,
            confirm: "그대로 닫기",
          }
        : {
            title: "Unsaved Changes",
            description: `"${options.title || "This tab"}" has unsaved editor changes. Closing it will discard them.`,
            confirm: "Close Anyway",
          };
    }

    if (kind === "window") {
      return isKo
        ? {
            title: "저장되지 않은 변경 사항",
            description: `이 창에는 저장되지 않은 편집 내용이 있는 세션이 ${count}개 있습니다. 닫으면 모두 버려집니다.`,
            confirm: "그대로 닫기",
          }
        : {
            title: "Unsaved Changes",
            description: `This window has ${count} session${count === 1 ? "" : "s"} with unsaved editor changes. Closing it will discard them.`,
            confirm: "Close Anyway",
          };
    }

    return isKo
      ? {
          title: "저장되지 않은 변경 사항",
          description: `저장되지 않은 편집 내용이 있는 세션이 ${count}개 있습니다. 앱을 닫으면 모두 버려집니다.`,
          confirm: "그대로 종료",
        }
      : {
          title: "Unsaved Changes",
          description: `There ${count === 1 ? "is" : "are"} ${count} dirty editor session${count === 1 ? "" : "s"}. Closing the app will discard them.`,
          confirm: "Quit Anyway",
        };
  }

  async function waitForWindowReady(targetLabel: string, timeoutMs = 8000): Promise<boolean> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      try {
        if (await isWindowReady(targetLabel)) {
          return true;
        }
      } catch (error) {
        console.error("Failed to query window readiness", error);
      }

      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    return false;
  }

  onMount(() => {
    void (async () => {
      windowListeners = await Promise.all([
        appWindow.onCloseRequested(async (event) => {
          if (allowNativeClose) {
            allowNativeClose = false;
            return;
          }

          event.preventDefault();

          const closeResult = await windowCloseOrchestration.handleCloseRequested();
          if (closeResult.kind === "show-dirty-app-dialog") {
            dirtyAppCloseCount = closeResult.dirtyCount;
            showCloseTabDialog = false;
            showDirtyTabDialog = false;
            showCloseWindowDialog = false;
            showDirtyWindowCloseDialog = false;
            pendingCloseSessionId = null;
            showDirtyAppDialog = true;
            return;
          }

          if (closeResult.kind === "show-close-window-dialog") {
            showCloseWindowDialog = true;
            return;
          }

          if (closeResult.kind === "noop") {
            return;
          }
        }),
        appWindow.onMoved(() => windowPlacement.schedulePersist()),
        appWindow.onResized(() => windowPlacement.schedulePersist()),
        listen<WorkspaceSnapshot>("workspace-updated", (event) => {
          syncWorkspaceSnapshot(event.payload);
          syncSessionsFromWorkspace(event.payload);
        }),
        listen<DirtyStateQueryPayload>(DIRTY_STATE_QUERY_EVENT, (event) => {
          const payload = event.payload;
          if (!payload?.requestId || !payload.replyLabel) {
            return;
          }

          void emitTo<DirtyStateResponsePayload>(payload.replyLabel, DIRTY_STATE_RESPONSE_EVENT, {
            requestId: payload.requestId,
            windowLabel: currentWindowLabel,
            dirtyCount: getLocalDirtySessionCount(),
          }).catch(() => {});
        }),
      ]);

      if (isMainWindow) {
        try {
          canonicalAuthorityCleanup = await installCanonicalScreenAuthority();
        } catch (error) {
          console.error("Failed to install canonical screen authority", error);
        }
      }

      try {
        await notifyWindowReady(currentWindowLabel);
      } catch (error) {
        console.error("Failed to notify window readiness", error);
      }

      windowPlacement.scheduleInitialPersist();

      primeEditorsDetection(1200);
    })();
  });

  onDestroy(() => {
    windowPlacement.dispose();
    if (workspaceSaveTimer) {
      clearTimeout(workspaceSaveTimer);
      void persistWorkspace();
    }
    canonicalAuthorityCleanup?.();
    canonicalAuthorityCleanup = null;
    for (const unlisten of windowListeners) {
      unlisten();
    }
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

    if (workspaceSaveTimer) {
      clearTimeout(workspaceSaveTimer);
    }
    workspaceSaveTimer = setTimeout(() => {
      void persistWorkspace();
    }, 120);
  });

  $effect(() => {
    if (sessions.length > 0) {
      void ensureSessionShellComponent();
    }
  });

  $effect(() => {
    if (showCloseTabDialog && pendingCloseSessionId && !pendingCloseSession) {
      dismissCloseTabDialog();
    }
  });

  function requestNewTab() {
    if (sessions.length === 0) return;
    showSessionLauncher = true;
  }

  function normalizePreviewFrameMode(value: string | null): PreviewFrameMode {
    return PREVIEW_FRAME_OPTIONS.some((option) => option.id === value)
      ? (value as PreviewFrameMode)
      : "desktop";
  }

  function getInitialPreviewFrameMode(): PreviewFrameMode {
    if (!browserPreview || typeof window === "undefined") return "desktop";
    const frame = new URL(window.location.href).searchParams.get("frame");
    return normalizePreviewFrameMode(frame);
  }

  function getInitialPreviewControlsVisible() {
    if (!browserPreview || typeof window === "undefined") return false;
    return new URL(window.location.href).searchParams.get("controls") !== "hidden";
  }

  function setPreviewUrlParam(name: string, value: string | null) {
    if (!browserPreview || typeof window === "undefined") return;
    const url = new URL(window.location.href);
    if (value && value.length > 0) {
      url.searchParams.set(name, value);
    } else {
      url.searchParams.delete(name);
    }
    window.history.replaceState(window.history.state, "", url);
  }

  function resetPreviewOverlays() {
    showSessionLauncher = false;
    showSettings = false;
    showCloseWindowDialog = false;
    dismissCloseTabDialog();
    dismissRenameDialog();
  }

  function setPreviewControlsVisible(visible: boolean) {
    showPreviewControls = visible;
    setPreviewUrlParam("controls", visible ? null : "hidden");
  }

  function applyPreviewBootstrap(nextBootstrap: AppBootstrap) {
    setBootstrap(nextBootstrap);
    bootstrap = nextBootstrap;
    initializeSettings(nextBootstrap.settings);
    initializeTabHistory(nextBootstrap.tabHistory);
    initializeWorkspaceSnapshot(nextBootstrap.workspace, currentWindowLabel);
    initializeSessionsFromWorkspace(nextBootstrap.workspace, currentWindowLabel);
    resetPreviewOverlays();
  }

  function handlePreviewPresetChange(nextPresetId: PreviewPresetId) {
    if (!browserPreview) return;
    const nextBootstrap = applyPreviewPreset(nextPresetId);
    previewPresetId = getActivePreviewPresetId();
    applyPreviewBootstrap(nextBootstrap);
  }

  function handlePreviewFrameModeChange(nextFrameMode: string) {
    previewFrameMode = normalizePreviewFrameMode(nextFrameMode);
    setPreviewUrlParam(
      "frame",
      previewFrameMode === "desktop" ? null : previewFrameMode,
    );
  }

  async function togglePreviewSettings() {
    if (showSettings) {
      showSettings = false;
      return;
    }
    await openSettingsPanel();
  }

  function openPreviewRenameDialog() {
    if (!activeSessionId) return;
    requestRenameTab(activeSessionId);
  }

  function openPreviewCloseDialog() {
    if (!activeSessionId) return;
    pendingCloseSessionId = activeSessionId;
    showCloseTabDialog = true;
  }

  const reportSessionLifecycleError = (message: string, error: unknown) => {
    console.error(message, error);
  };

  const sessionLifecycle = createSessionLifecycleController({
    addSession,
    hideSessionLauncher: () => {
      showSessionLauncher = false;
    },
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

  function dismissCloseTabDialog() {
    showCloseTabDialog = false;
    pendingCloseSessionId = null;
  }

  function dismissDirtyTabDialog() {
    showDirtyTabDialog = false;
    pendingCloseSessionId = null;
  }

  function requestCloseTab(sessionId: string) {
    const session = sessions.find((entry) => entry.id === sessionId);
    switch (resolveCloseTabRequest(session)) {
      case "blocked":
        return;
      case "dirty-warning":
        pendingCloseSessionId = sessionId;
        showDirtyTabDialog = true;
        return;
      case "close-confirm":
        pendingCloseSessionId = sessionId;
        showCloseTabDialog = true;
        return;
      case "close-now":
        void handleCloseTab(sessionId);
        return;
    }
  }

  async function confirmCloseTab() {
    if (!pendingCloseSessionId) return;
    const sessionId = pendingCloseSessionId;
    dismissCloseTabDialog();
    await handleCloseTab(sessionId);
  }

  function continueCloseTabAfterDirtyWarning() {
    if (!pendingCloseSessionId) return;
    const sessionId = pendingCloseSessionId;
    showDirtyTabDialog = false;
    const session = sessions.find((entry) => entry.id === sessionId);
    if (!session) {
      pendingCloseSessionId = null;
      return;
    }

    if (session.ptyId >= 0) {
      showCloseTabDialog = true;
      return;
    }

    pendingCloseSessionId = null;
    void handleCloseTab(sessionId);
  }

  function dismissDirtyAppDialog() {
    showDirtyAppDialog = false;
    dirtyAppCloseCount = 0;
  }

  function confirmDirtyAppClose() {
    showDirtyAppDialog = false;
    dirtyAppCloseCount = 0;
    void windowCloseOrchestration.performAppClose();
  }

  function dismissDirtyWindowCloseDialog() {
    showDirtyWindowCloseDialog = false;
  }

  async function confirmDirtyWindowCloseDialog() {
    showDirtyWindowCloseDialog = false;
    showCloseWindowDialog = false;
    await windowCloseOrchestration.confirmDirtyWindowClose();
  }

  async function handleMoveTabToNewWindow(sessionId: string) {
    try {
      const position = await appWindow.outerPosition();
      const { measureWindowSizeForTerminal } = await import("./lib/window-size");
      const defaultWindowSize = await measureWindowSizeForTerminal(settings);
      const targetLabel = await openEmptyWindow(
        Math.max(0, position.x + 72),
        Math.max(0, position.y + 72),
        defaultWindowSize.width,
        defaultWindowSize.height,
      );

      const ready = await waitForWindowReady(targetLabel);
      if (!ready) {
        console.error("New window did not become ready", targetLabel);
        return;
      }

      await moveSessionToWindow(sessionId, targetLabel);
    } catch (error) {
      console.error("Failed to detach tab", error);
    }
  }

  async function handleMoveTabToWindow(sessionId: string, targetLabel: string) {
    try {
      if (targetLabel !== "main") {
        const ready = await waitForWindowReady(targetLabel);
        if (!ready) {
          console.error("Target window did not become ready", targetLabel);
          return;
        }
      }

      await moveSessionToWindow(sessionId, targetLabel);
    } catch (error) {
      console.error("Failed to move session to window", error);
    }
  }

  function handleMoveTabLeft(sessionId: string) {
    const targetIndex = resolveAdjacentSessionMoveIndex(sessions, sessionId, "left");
    if (targetIndex === null) return;
    moveSession(sessionId, targetIndex);
    setActiveSession(sessionId);
  }

  function handleMoveTabRight(sessionId: string) {
    const targetIndex = resolveAdjacentSessionMoveIndex(sessions, sessionId, "right");
    if (targetIndex === null) return;
    moveSession(sessionId, targetIndex);
    setActiveSession(sessionId);
  }

  function requestRenameTab(sessionId: string) {
    const session = sessions.find((entry) => entry.id === sessionId);
    if (!session) return;
    renameDialogKind = "tab";
    renameTargetSessionId = sessionId;
    renameDialogValue = session.title;
  }

  function requestRenameWindow() {
    renameDialogKind = "window";
    renameTargetSessionId = null;
    renameDialogValue = currentWindowName;
  }

  function dismissRenameDialog() {
    renameDialogKind = null;
    renameDialogValue = "";
    renameTargetSessionId = null;
  }

  function confirmRename() {
    const trimmed = renameDialogValue.trim();

    if (renameDialogKind === "tab" && renameTargetSessionId) {
      const session = sessions.find((entry) => entry.id === renameTargetSessionId);
      if (session) {
        const nextTitle = resolveRenamedSessionTitle(session, trimmed);
        setSessionTitle(renameTargetSessionId, nextTitle);
        void recordTabHistory(
          session.agentId,
          session.distro,
          session.workDir,
          nextTitle,
          session.resumeToken ?? null,
        );
      }
    } else if (renameDialogKind === "window") {
      setCurrentWindowName(trimmed || currentWindowLabel);
    }

    dismissRenameDialog();
  }

  function handleTogglePinTab(sessionId: string) {
    const session = sessions.find((entry) => entry.id === sessionId);
    if (!session) return;
    setSessionPinned(sessionId, !session.pinned);
    setActiveSession(sessionId);
  }

  function handleToggleLockTab(sessionId: string) {
    const session = sessions.find((entry) => entry.id === sessionId);
    if (!session) return;
    setSessionLocked(sessionId, !session.locked);
    setActiveSession(sessionId);
  }

  async function handleMoveWindowToMain() {
    await windowCloseOrchestration.moveWindowSessionsToMainAndClose();
    showCloseWindowDialog = false;
  }

  async function handleCloseWindowSessions() {
    const result = await windowCloseOrchestration.handleCloseWindowSessions();
    if (result.kind === "show-dirty-window-dialog") {
      showDirtyWindowCloseDialog = true;
      return;
    }
    showCloseWindowDialog = false;
  }

  function handleKeydown(e: KeyboardEvent) {
    if (e.ctrlKey && e.key === "t") {
      e.preventDefault();
      requestNewTab();
    }
    if (e.ctrlKey && e.key === "w") {
      e.preventDefault();
      if (activeSessionId) {
        requestCloseTab(activeSessionId);
      }
    }
  }

  async function openSettingsPanel() {
    await settingsModalLoader.ensureLoaded();
    showSettings = true;
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
      onToggleLauncher={() => { showSessionLauncher = !showSessionLauncher; }}
      onToggleSettings={() => { void togglePreviewSettings(); }}
      onOpenRename={openPreviewRenameDialog}
      onOpenCloseDialog={openPreviewCloseDialog}
      onResetOverlays={resetPreviewOverlays}
      onToggleVisibility={() => { setPreviewControlsVisible(false); }}
    />
  {:else if browserPreview}
    <div class="preview-control-toggle">
      <Button size="sm" variant="secondary" onclick={() => { setPreviewControlsVisible(true); }}>
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
      onNewTab={requestNewTab}
      onSettings={() => { void openSettingsPanel(); }}
      onCloseTab={requestCloseTab}
      onRenameTab={requestRenameTab}
      onRenameWindow={requestRenameWindow}
      onTogglePinTab={handleTogglePinTab}
      onToggleLockTab={handleToggleLockTab}
      onMoveTabLeft={handleMoveTabLeft}
      onMoveTabRight={handleMoveTabRight}
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
    onCancel={() => { showSessionLauncher = false; }}
  />

  {#if SettingsModalComponent}
    <SettingsModalComponent
      visible={showSettings}
      onClose={() => { showSettings = false; }}
    />
  {/if}

  <ModalShell
    open={showDirtyTabDialog && pendingCloseSession !== null}
    size="sm"
    onClose={dismissDirtyTabDialog}
  >
    <div class="window-close-panel" data-testid={TEST_IDS.closeTabDialog}>
      <h2>{getDirtyCloseDialogCopy("tab", { title: pendingCloseSession?.title ?? "" }).title}</h2>
      <p>{getDirtyCloseDialogCopy("tab", { title: pendingCloseSession?.title ?? "" }).description}</p>
      <div class="window-close-actions">
        <Button variant="danger" onclick={continueCloseTabAfterDirtyWarning}>
          {getDirtyCloseDialogCopy("tab", { title: pendingCloseSession?.title ?? "" }).confirm}
        </Button>
        <Button onclick={dismissDirtyTabDialog}>
          {$t("common.actions.cancel")}
        </Button>
      </div>
    </div>
  </ModalShell>

  <ModalShell
    open={showCloseTabDialog && pendingCloseSession !== null}
    size="sm"
    onClose={dismissCloseTabDialog}
  >
    <div class="window-close-panel" data-testid={TEST_IDS.closeTabDialog}>
      <h2>{$t("app.closeTab.title")}</h2>
      <p>{$t("app.closeTab.description", {
        values: { title: pendingCloseSession?.title ?? "" },
      })}</p>
      <div class="window-close-actions">
        <Button variant="danger" onclick={confirmCloseTab}>
          {$t("app.closeTab.confirm")}
        </Button>
        <Button onclick={dismissCloseTabDialog}>
          {$t("common.actions.cancel")}
        </Button>
      </div>
    </div>
  </ModalShell>

  <ModalShell
    open={showDirtyAppDialog}
    size="sm"
    onClose={dismissDirtyAppDialog}
  >
    <div class="window-close-panel" data-testid={TEST_IDS.closeWindowDialog}>
      <h2>{getDirtyCloseDialogCopy("app", { count: dirtyAppCloseCount }).title}</h2>
      <p>{getDirtyCloseDialogCopy("app", { count: dirtyAppCloseCount }).description}</p>
      <div class="window-close-actions">
        <Button variant="danger" onclick={confirmDirtyAppClose}>
          {getDirtyCloseDialogCopy("app", { count: dirtyAppCloseCount }).confirm}
        </Button>
        <Button onclick={dismissDirtyAppDialog}>
          {$t("common.actions.cancel")}
        </Button>
      </div>
    </div>
  </ModalShell>

  <ModalShell
    open={showDirtyWindowCloseDialog && showCloseWindowDialog}
    size="sm"
    onClose={dismissDirtyWindowCloseDialog}
  >
    <div class="window-close-panel" data-testid={TEST_IDS.closeWindowDialog}>
      <h2>{getDirtyCloseDialogCopy("window", { count: dirtySessions.length }).title}</h2>
      <p>{getDirtyCloseDialogCopy("window", { count: dirtySessions.length }).description}</p>
      <div class="window-close-actions">
        <Button variant="danger" onclick={confirmDirtyWindowCloseDialog}>
          {getDirtyCloseDialogCopy("window", { count: dirtySessions.length }).confirm}
        </Button>
        <Button onclick={dismissDirtyWindowCloseDialog}>
          {$t("common.actions.cancel")}
        </Button>
      </div>
    </div>
  </ModalShell>

  <ModalShell
    open={showCloseWindowDialog && !showDirtyWindowCloseDialog}
    size="sm"
    onClose={() => { showCloseWindowDialog = false; }}
  >
    <div class="window-close-panel" data-testid={TEST_IDS.closeWindowDialog}>
      <h2>{$t("app.closeWindow.title")}</h2>
      <p>{$t("app.closeWindow.description")}</p>
      <div class="window-close-actions">
        <Button variant="primary" onclick={handleMoveWindowToMain}>
          {$t("app.closeWindow.moveTabsToMain")}
        </Button>
        <Button variant="danger" onclick={handleCloseWindowSessions}>
          {$t("app.closeWindow.closeTabs")}
        </Button>
        <Button onclick={() => { showCloseWindowDialog = false; }}>
          {$t("common.actions.cancel")}
        </Button>
      </div>
    </div>
  </ModalShell>

  <ModalShell
    open={renameDialogKind !== null}
    size="sm"
    onClose={dismissRenameDialog}
  >
    <div class="window-close-panel rename-panel">
      <h2>{$t(renameDialogKind === "window" ? "rename.window.title" : "rename.tab.title")}</h2>
      <p>{$t(renameDialogKind === "window" ? "rename.window.description" : "rename.tab.description")}</p>
      <div class="rename-field">
        <label for="rename-input">
          {$t(renameDialogKind === "window" ? "rename.window.label" : "rename.tab.label")}
        </label>
        <input
          id="rename-input"
          class="rename-input"
          type="text"
          bind:value={renameDialogValue}
          onkeydown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              confirmRename();
            }
          }}
        />
      </div>
      <div class="window-close-actions">
        <Button variant="primary" onclick={confirmRename}>
          {$t(renameDialogKind === "window" ? "rename.window.confirm" : "rename.tab.confirm")}
        </Button>
        <Button onclick={dismissRenameDialog}>
          {$t("common.actions.cancel")}
        </Button>
      </div>
    </div>
  </ModalShell>
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

  .window-close-panel {
    padding: 24px;
    color: var(--ui-text-primary);
  }

  .window-close-panel h2 {
    margin: 0 0 10px;
    font-size: 19px;
    line-height: 1.2;
  }

  .window-close-panel p {
    margin: 0 0 18px;
    color: var(--ui-text-muted);
    font-size: 14px;
    line-height: 1.55;
  }

  .window-close-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 10px;
    justify-content: flex-end;
  }

  .rename-panel {
    display: grid;
    gap: 16px;
  }

  .rename-field {
    display: grid;
    gap: 8px;
  }

  .rename-field label {
    font-size: 14px;
    color: var(--ui-text-secondary);
  }

  .rename-input {
    min-height: 42px;
    padding: 0 14px;
    border: 1px solid var(--ui-border-subtle);
    border-radius: var(--ui-radius-md);
    background: color-mix(in srgb, var(--ui-bg-elevated) 90%, transparent);
    color: var(--ui-text-primary);
    font-size: var(--ui-font-size-base);
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

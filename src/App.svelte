<script lang="ts">
  import type { Component } from "svelte";
  import { onMount, onDestroy } from "svelte";
  import { listen, type UnlistenFn } from "@tauri-apps/api/event";
  import { currentMonitor, getCurrentWindow } from "@tauri-apps/api/window";
  import TabBar from "./lib/components/TabBar.svelte";
  import SessionLauncher from "./lib/components/SessionLauncher.svelte";
  import CompactAgentTree from "./lib/components/CompactAgentTree.svelte";
  import {
    addSession,
    areSessionsInitialized,
    getActiveSessionId,
    getCurrentWindowName,
    getSessions,
    moveSession,
    persistWorkspace,
    setActiveSession,
    setSessionAuxState,
    setCurrentWindowName,
    setSessionLocked,
    setSessionPtyId,
    setSessionPinned,
    setSessionResumeToken,
    setSessionTmuxState,
    setSessionTitle,
    syncSessionsFromWorkspace,
  } from "./lib/stores/sessions.svelte";
  import {
    applyTmuxAgentSnapshot,
    getSelectedAgentWorkspacePaneId,
    initializeAgentWorkspaceRuntime,
    getAgentWorkspaceSession,
    selectAgentWorkspaceNode,
    sessionHasChildAgents,
    syncAgentWorkspaceSessions,
  } from "./lib/stores/agent-workspace.svelte";
  import {
    getTmuxSessionSnapshot,
    initializeTmuxSnapshotRuntime,
    syncTmuxSnapshotSessions,
  } from "./lib/stores/tmux-snapshots.svelte";
  import { getOtherWindows, syncWorkspaceSnapshot } from "./lib/stores/workspace.svelte";
  import { getSettings, updateSettings } from "./lib/stores/settings.svelte";
  import { getTabHistory, recordTabHistory } from "./lib/stores/tab-history.svelte";
  import { primeEditorsDetection } from "./lib/stores/editors.svelte";
  import { getBootstrap } from "./lib/bootstrap";
  import { setLanguagePreference, t } from "./lib/i18n";
  import { TEST_IDS } from "./lib/testids";
  import { getThemeById } from "./lib/themes";
  import { applyUiPreferenceVariables, applyUiThemeVariables, Button, ModalShell } from "./lib/ui";
  import {
    closeApp,
    closePtyAndCaptureResume,
    clearSessionPty,
    closeSession,
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
    setSessionResumeToken as persistSessionResumeToken,
    updateWindowGeometry,
  } from "./lib/workspace";
  import { killPty } from "./lib/pty";
  import { killTmuxSession } from "./lib/tmux";
  import type { Session, SessionRuntimeMode, TabHistoryEntry, WorkspaceSnapshot } from "./lib/types";
  import type { AgentId } from "./lib/agents";

  const appWindow = getCurrentWindow();
  const currentWindowLabel = appWindow.label;
  const isMainWindow = currentWindowLabel === "main";
  const settings = getSettings();
  const bootstrap = getBootstrap();

  $effect(() => {
    const theme = getThemeById(settings.interface.theme)?.theme;
    const root = document.documentElement;
    applyUiPreferenceVariables(root, settings);
    if (!theme) return;
    root.style.setProperty("--app-bg", theme.background ?? "#1e1e2e");
    root.style.setProperty("--tab-text", theme.foreground ?? "#cdd6f4");
    root.style.setProperty("--tab-bg", theme.background ?? "#1e1e2e");
    root.style.setProperty("--tab-active-bg", theme.selectionBackground ?? "#313244");
    root.style.setProperty("--tab-border", theme.selectionBackground ?? "#45475a");
    applyUiThemeVariables(root, theme);
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
  let pendingCloseSessionId = $state<string | null>(null);
  let renameDialogKind = $state<"tab" | "window" | null>(null);
  let renameDialogValue = $state("");
  let renameTargetSessionId = $state<string | null>(null);
  let appCloseRequested = false;
  let capturingResumeOnAppClose = false;
  const pendingResumeCapturePtyIds = new Set<number>();
  let allowNativeClose = false;
  let windowListeners: UnlistenFn[] = [];
  let placementSaveTimer: ReturnType<typeof setTimeout> | null = null;
  let initialPlacementTimer: ReturnType<typeof setTimeout> | null = null;
  let workspaceSaveTimer: ReturnType<typeof setTimeout> | null = null;
  let TerminalComponent = $state<Component<any> | null>(null);
  let TmuxTerminalComponent = $state<Component<any> | null>(null);
  let SettingsModalComponent = $state<Component<any> | null>(null);
  let terminalLoadPromise: Promise<void> | null = null;
  let tmuxTerminalLoadPromise: Promise<void> | null = null;
  let settingsLoadPromise: Promise<void> | null = null;
  const pendingCloseSession = $derived(
    pendingCloseSessionId
      ? sessions.find((session) => session.id === pendingCloseSessionId) ?? null
      : null,
  );

  $effect(() => {
    const normalizedName = currentWindowName.trim();
    const nextTitle =
      currentWindowLabel === "main" && (!normalizedName || normalizedName === "main")
        ? "CLCOMX"
        : `CLCOMX - ${normalizedName || currentWindowLabel}`;
    void appWindow.setTitle(nextTitle);
  });

  async function ensureTerminalComponent() {
    if (TerminalComponent) return;
    if (terminalLoadPromise) {
      await terminalLoadPromise;
      return;
    }

    terminalLoadPromise = import("./lib/components/Terminal.svelte")
      .then((module) => {
        TerminalComponent = module.default;
      })
      .finally(() => {
        terminalLoadPromise = null;
      });

    await terminalLoadPromise;
  }

  async function ensureTmuxTerminalComponent() {
    if (TmuxTerminalComponent) return;
    if (tmuxTerminalLoadPromise) {
      await tmuxTerminalLoadPromise;
      return;
    }

    tmuxTerminalLoadPromise = import("./lib/components/TmuxTerminal.svelte")
      .then((module) => {
        TmuxTerminalComponent = module.default;
      })
      .finally(() => {
        tmuxTerminalLoadPromise = null;
      });

    await tmuxTerminalLoadPromise;
  }

  async function ensureSettingsModalComponent() {
    if (SettingsModalComponent) return;
    if (settingsLoadPromise) {
      await settingsLoadPromise;
      return;
    }

    settingsLoadPromise = import("./lib/components/SettingsModal.svelte")
      .then((module) => {
        SettingsModalComponent = module.default;
      })
      .finally(() => {
        settingsLoadPromise = null;
      });

    await settingsLoadPromise;
  }

  async function persistWindowState() {
    const [position, size, maximized, monitor] = await Promise.all([
      appWindow.outerPosition(),
      appWindow.innerSize(),
      appWindow.isMaximized(),
      currentMonitor().catch(() => null),
    ]);

    if (isMainWindow) {
      updateSettings({
        mainWindow: {
          monitor: monitor?.name ?? null,
          x: position.x,
          y: position.y,
          width: size.width,
          height: size.height,
          maximized,
        },
      });
    }

    try {
      await updateWindowGeometry(
        currentWindowLabel,
        position.x,
        position.y,
        size.width,
        size.height,
        maximized,
      );
    } catch (error) {
      console.error("Failed to update window geometry", error);
    }
  }

  function scheduleWindowPlacementPersist() {
    if (placementSaveTimer) {
      clearTimeout(placementSaveTimer);
    }
    placementSaveTimer = setTimeout(() => {
      void persistWindowState();
    }, 150);
  }

  async function closeCurrentWindow() {
    allowNativeClose = true;
    await appWindow.close();
  }

  async function handleSecondaryCloseRequest() {
    if (sessions.length > 0) {
      showCloseWindowDialog = true;
      return;
    }

    await removeWindow(currentWindowLabel);
    await closeCurrentWindow();
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

          if (isMainWindow) {
            if (appCloseRequested) return;
            appCloseRequested = true;
            try {
              await captureResumeIdsBeforeAppClose();
              await closeApp();
            } catch (error) {
              appCloseRequested = false;
              console.error("Failed to close app", error);
            }
            return;
          }

          await handleSecondaryCloseRequest();
        }),
        appWindow.onMoved(() => scheduleWindowPlacementPersist()),
        appWindow.onResized(() => scheduleWindowPlacementPersist()),
        listen<WorkspaceSnapshot>("workspace-updated", (event) => {
          syncWorkspaceSnapshot(event.payload);
          syncSessionsFromWorkspace(event.payload);
        }),
      ]);
      try {
        await initializeTmuxSnapshotRuntime();
        await initializeAgentWorkspaceRuntime();
        await notifyWindowReady(currentWindowLabel);
      } catch (error) {
        console.error("Failed to notify window readiness", error);
      }

      initialPlacementTimer = setTimeout(() => {
        scheduleWindowPlacementPersist();
      }, 500);

      primeEditorsDetection(1200);
    })();
  });

  onDestroy(() => {
    if (initialPlacementTimer) {
      clearTimeout(initialPlacementTimer);
    }
    if (placementSaveTimer) {
      clearTimeout(placementSaveTimer);
    }
    if (workspaceSaveTimer) {
      clearTimeout(workspaceSaveTimer);
      void persistWorkspace();
    }
    for (const unlisten of windowListeners) {
      unlisten();
    }
  });

  $effect(() => {
    if (!areSessionsInitialized()) return;

    sessions.map((session) => ({
      id: session.id,
      runtimeMode: session.runtimeMode,
      agentId: session.agentId,
      title: session.title,
      pinned: session.pinned,
      locked: session.locked,
      resumeToken: session.resumeToken,
      distro: session.distro,
      workDir: session.workDir,
      ptyId: session.ptyId,
      auxPtyId: session.auxPtyId,
      auxVisible: session.auxVisible,
      auxHeightPercent: session.auxHeightPercent,
      tmuxSessionName: session.tmuxSessionName,
      tmuxActivePaneId: session.tmuxActivePaneId,
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
    syncAgentWorkspaceSessions(sessions);
  });

  $effect(() => {
    syncTmuxSnapshotSessions(sessions);
  });

  $effect(() => {
    sessions.map((session) => session.id);
    for (const session of sessions) {
      if (session.runtimeMode !== "tmux") continue;
      const snapshot = getTmuxSessionSnapshot(session.id);
      if (!snapshot) continue;
      applyTmuxAgentSnapshot(session.id, snapshot);
    }
  });

  $effect(() => {
    if (sessions.length > 0) {
      void ensureTerminalComponent();
      if (sessions.some((session) => session.runtimeMode === "tmux")) {
        void ensureTmuxTerminalComponent();
      }
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

  function createSession(
    agentId: AgentId,
    distro: string,
    workDir: string,
    title = workDir.split("/").pop() || workDir,
    resumeToken: string | null = null,
    runtimeMode: SessionRuntimeMode = "plain",
  ) {
    const session: Session = {
      id: crypto.randomUUID(),
      runtimeMode,
      ptyId: -1,
      auxPtyId: -1,
      auxVisible: false,
      auxHeightPercent: null,
      tmuxSessionName: null,
      tmuxActivePaneId: null,
      agentId,
      resumeToken,
      title,
      pinned: false,
      locked: false,
      terminal: null,
      element: null,
      distro,
      workDir,
    };
    addSession(session);
    showSessionLauncher = false;
    void persistWorkspace();
    void ensureTerminalComponent();
    if (runtimeMode === "tmux") {
      void ensureTmuxTerminalComponent();
    }
  }

  function createLauncherSession(
    agentId: AgentId,
    distro: string,
    workDir: string,
    runtimeMode: SessionRuntimeMode,
  ) {
    createSession(
      agentId,
      distro,
      workDir,
      workDir.split("/").pop() || workDir,
      null,
      runtimeMode,
    );
  }

  function openHistoryEntry(entry: TabHistoryEntry) {
    createSession(
      entry.agentId ?? "claude",
      entry.distro,
      entry.workDir,
      entry.title,
      entry.resumeToken ?? null,
      "plain",
    );
  }

  async function handlePtyId(sessionId: string, ptyId: number) {
    const session = sessions.find((entry) => entry.id === sessionId);
    if (!session) return;

    setSessionPtyId(sessionId, ptyId);
    try {
      await setSessionPty(sessionId, ptyId);
    } catch (error) {
      console.error("Failed to register session PTY", error);
    }
    void recordTabHistory(
      session.agentId,
      session.distro,
      session.workDir,
      session.title,
      session.resumeToken ?? null,
    );
  }

  async function handleAuxTerminalState(
    sessionId: string,
    auxPtyId: number,
    auxVisible: boolean,
    auxHeightPercent: number | null,
  ) {
    setSessionAuxState(sessionId, auxPtyId, auxVisible, auxHeightPercent);
    try {
      await persistSessionAuxTerminalState(
        sessionId,
        auxPtyId >= 0 ? auxPtyId : null,
        auxVisible,
        auxHeightPercent,
      );
    } catch (error) {
      console.error("Failed to persist auxiliary terminal state", error);
    }
  }

  async function handleExit(ptyId: number) {
    if (capturingResumeOnAppClose || pendingResumeCapturePtyIds.has(ptyId)) return;
    try {
      await closeSessionByPtyId(ptyId);
    } catch (error) {
      console.error("Failed to close exited session", error);
    }
  }

  function handleTmuxState(
    sessionId: string,
    tmuxSessionName: string | null,
    tmuxActivePaneId: string | null,
  ) {
    setSessionTmuxState(sessionId, tmuxSessionName, tmuxActivePaneId);
  }

  async function handleResumeFallback(sessionId: string) {
    setSessionResumeToken(sessionId, null);
    try {
      await persistSessionResumeToken(sessionId, null);
    } catch (error) {
      console.error("Failed to clear invalid resume token", error);
    }
    void persistWorkspace();
  }

  async function captureSessionResumeToken(session: Session): Promise<string | null> {
    const existingResumeToken = session.resumeToken ?? null;
    if (session.ptyId < 0) {
      return existingResumeToken;
    }

    const ptyId = session.ptyId;
    pendingResumeCapturePtyIds.add(ptyId);
    try {
      const result = await closePtyAndCaptureResume(ptyId, session.agentId);
      const nextResumeToken = result.resumeToken ?? existingResumeToken;
      setSessionPtyId(session.id, -1);
      setSessionResumeToken(session.id, nextResumeToken ?? null);
      await clearSessionPty(session.id);
      await persistSessionResumeToken(session.id, nextResumeToken ?? null);
      return nextResumeToken ?? null;
    } catch (error) {
      console.error("Failed to capture session resume token", error);
      setSessionPtyId(session.id, -1);
      setSessionResumeToken(session.id, existingResumeToken);
      try {
        await clearSessionPty(session.id);
        await persistSessionResumeToken(session.id, existingResumeToken);
      } catch (persistError) {
        console.error("Failed to persist resume state after capture failure", persistError);
      }
      return existingResumeToken;
    } finally {
      pendingResumeCapturePtyIds.delete(ptyId);
    }
  }

  async function captureResumeIdsBeforeAppClose() {
    capturingResumeOnAppClose = true;
    try {
      for (const session of sessions) {
        if (session.runtimeMode === "tmux") {
          if (session.tmuxSessionName) {
            try {
              await killTmuxSession(session.distro, session.tmuxSessionName);
            } catch (error) {
              console.error("Failed to stop tmux session during app close", error);
            }
          }
          continue;
        }
        const resumeToken = await captureSessionResumeToken(session);
        if (session.auxPtyId >= 0) {
          try {
            await killPty(session.auxPtyId);
          } catch (error) {
            console.error("Failed to stop auxiliary terminal PTY", error);
          }
        }
        setSessionAuxState(session.id, -1, false, session.auxHeightPercent);
        try {
          await persistSessionAuxTerminalState(
            session.id,
            null,
            false,
            session.auxHeightPercent,
          );
        } catch (error) {
          console.error("Failed to clear auxiliary terminal state", error);
        }
        await recordTabHistory(session.agentId, session.distro, session.workDir, session.title, resumeToken);
      }

      await persistWorkspace();
    } finally {
      capturingResumeOnAppClose = false;
    }
  }

  async function handleCloseTab(sessionId: string) {
    const session = sessions.find((entry) => entry.id === sessionId);
    if (!session) return;

    try {
      if (session.runtimeMode === "tmux") {
        if (session.tmuxSessionName) {
          await killTmuxSession(session.distro, session.tmuxSessionName);
        }
        await closeSession(sessionId);
        return;
      }

      const resumeToken = await captureSessionResumeToken(session);
      await recordTabHistory(session.agentId, session.distro, session.workDir, session.title, resumeToken);
      await closeSession(sessionId);
    } catch (error) {
      console.error("Failed to close session", error);
    }
  }

  function dismissCloseTabDialog() {
    showCloseTabDialog = false;
    pendingCloseSessionId = null;
  }

  function requestCloseTab(sessionId: string) {
    const session = sessions.find((entry) => entry.id === sessionId);
    if (!session) return;
    if (session.locked) return;

    if (session.runtimeMode === "tmux" || session.ptyId >= 0) {
      pendingCloseSessionId = sessionId;
      showCloseTabDialog = true;
      return;
    }

    void handleCloseTab(sessionId);
  }

  async function confirmCloseTab() {
    if (!pendingCloseSessionId) return;
    const sessionId = pendingCloseSessionId;
    dismissCloseTabDialog();
    await handleCloseTab(sessionId);
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
    const session = sessions.find((entry) => entry.id === sessionId);
    if (!session) return;
    const group = sessions.filter((entry) => entry.pinned === session.pinned);
    const groupIndex = group.findIndex((entry) => entry.id === sessionId);
    if (groupIndex <= 0) return;
    const targetId = group[groupIndex - 1]?.id;
    const targetIndex = sessions.findIndex((entry) => entry.id === targetId);
    if (targetIndex < 0) return;
    moveSession(sessionId, targetIndex);
    setActiveSession(sessionId);
  }

  function handleMoveTabRight(sessionId: string) {
    const session = sessions.find((entry) => entry.id === sessionId);
    if (!session) return;
    const group = sessions.filter((entry) => entry.pinned === session.pinned);
    const groupIndex = group.findIndex((entry) => entry.id === sessionId);
    if (groupIndex < 0 || groupIndex >= group.length - 1) return;
    const targetId = group[groupIndex + 1]?.id;
    const targetIndex = sessions.findIndex((entry) => entry.id === targetId);
    if (targetIndex < 0) return;
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
        const fallbackTitle = session.workDir.split("/").pop() || session.workDir;
        const nextTitle = trimmed || fallbackTitle;
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
    try {
      await moveWindowSessionsToMain(currentWindowLabel);
      await closeCurrentWindow();
    } catch (error) {
      console.error("Failed to move window sessions to main", error);
    } finally {
      showCloseWindowDialog = false;
    }
  }

  async function handleCloseWindowSessions() {
    try {
      await closeWindowSessions(currentWindowLabel);
      await closeCurrentWindow();
    } catch (error) {
      console.error("Failed to close secondary window sessions", error);
    } finally {
      showCloseWindowDialog = false;
    }
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
    await ensureSettingsModalComponent();
    showSettings = true;
  }

  function getWorkspaceSessionState(sessionId: string) {
    return getAgentWorkspaceSession(sessionId);
  }

  function hasWorkspaceChildAgents(sessionId: string) {
    return sessionHasChildAgents(sessionId);
  }
</script>

<svelte:window onkeydown={handleKeydown} />

<div
  class="app"
  data-testid={TEST_IDS.appRoot}
  data-window-label={currentWindowLabel}
  data-session-count={sessions.length}
  data-test-mode={bootstrap.testMode ? "true" : "false"}
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

  <div class="terminal-area">
    <div
      class="welcome-layer"
      style:display={sessions.length === 0 ? "block" : "none"}
    >
      <SessionLauncher
        visible={sessions.length === 0}
        embedded={true}
        historyEntries={historyEntries}
        onOpenHistory={openHistoryEntry}
        onConfirm={createLauncherSession}
      />
    </div>

    <div
      class="sessions-layer"
      style:display={sessions.length > 0 ? "block" : "none"}
    >
      {#if TerminalComponent}
        {#each sessions as session (session.id)}
          {@const showAgentWorkspaceChrome = session.runtimeMode === "tmux" && hasWorkspaceChildAgents(session.id)}
          <section
            class="session-workspace"
            class:session-workspace--active={session.id === activeSessionId}
            class:session-workspace--agent-centric={showAgentWorkspaceChrome}
          >
            {#if showAgentWorkspaceChrome}
              <CompactAgentTree
                state={getWorkspaceSessionState(session.id)}
                onSelect={(agentNodeId: string) => selectAgentWorkspaceNode(session.id, agentNodeId)}
              />
            {/if}

            <div class="session-runtime">
              {#if session.runtimeMode === "tmux"}
                {#if TmuxTerminalComponent}
                  <TmuxTerminalComponent
                    sessionId={session.id}
                    visible={session.id === activeSessionId}
                    agentId={session.agentId}
                    distro={session.distro}
                    workDir={session.workDir}
                    resumeToken={session.resumeToken}
                    tmuxSessionName={session.tmuxSessionName}
                    tmuxActivePaneId={session.tmuxActivePaneId}
                    agentCentric={showAgentWorkspaceChrome}
                    primaryPaneId={getSelectedAgentWorkspacePaneId(session.id)}
                    onStateChange={(state: { tmuxSessionName: string | null; tmuxActivePaneId: string | null }) =>
                      handleTmuxState(session.id, state.tmuxSessionName, state.tmuxActivePaneId)}
                  />
                {/if}
              {:else}
                <TerminalComponent
                  sessionId={session.id}
                  visible={session.id === activeSessionId}
                  agentId={session.agentId}
                  distro={session.distro}
                  workDir={session.workDir}
                  ptyId={session.ptyId}
                  storedAuxPtyId={session.auxPtyId}
                  storedAuxVisible={session.auxVisible}
                  storedAuxHeightPercent={session.auxHeightPercent}
                  resumeToken={session.resumeToken}
                  onPtyId={(ptyId: number) => handlePtyId(session.id, ptyId)}
                  onAuxStateChange={(state: {
                    auxPtyId: number;
                    auxVisible: boolean;
                    auxHeightPercent: number | null;
                  }) =>
                    void handleAuxTerminalState(
                      session.id,
                      state.auxPtyId,
                      state.auxVisible,
                      state.auxHeightPercent,
                    )}
                  onExit={handleExit}
                  onResumeFallback={() => void handleResumeFallback(session.id)}
                />
              {/if}
            </div>

          </section>
        {/each}
      {:else}
        <div class="terminal-loading">
          <div class="terminal-loading-card">{$t("common.labels.loading")}</div>
        </div>
      {/if}
    </div>
  </div>

  <SessionLauncher
    visible={showSessionLauncher}
    historyEntries={historyEntries}
    onOpenHistory={openHistoryEntry}
    onConfirm={createLauncherSession}
    onCancel={() => { showSessionLauncher = false; }}
  />

  {#if SettingsModalComponent}
    <SettingsModalComponent
      visible={showSettings}
      onClose={() => { showSettings = false; }}
    />
  {/if}

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
    open={showCloseWindowDialog}
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
    display: flex;
    flex-direction: column;
    height: 100vh;
    width: 100vw;
    overflow: hidden;
  }

  .terminal-area {
    flex: 1;
    position: relative;
    overflow: hidden;
  }

  .welcome-layer,
  .sessions-layer {
    width: 100%;
    height: 100%;
  }

  .session-workspace {
    display: none;
    width: 100%;
    height: 100%;
    min-width: 0;
    min-height: 0;
    grid-template-columns: minmax(0, 1fr);
    background:
      linear-gradient(180deg, rgba(var(--ui-shadow-rgb), 0.06), transparent 18%),
      var(--ui-bg-canvas, transparent);
  }

  .session-workspace--agent-centric {
    grid-template-columns: auto minmax(0, 1fr);
  }

  .session-workspace--active {
    display: grid;
  }

  .session-runtime {
    position: relative;
    width: 100%;
    height: 100%;
    min-width: 0;
    min-height: 0;
    display: grid;
    overflow: hidden;
  }

  .terminal-loading {
    width: 100%;
    height: 100%;
    display: grid;
    place-items: center;
    padding: 24px;
  }

  .terminal-loading-card {
    min-width: 180px;
    padding: 14px 18px;
    border: 1px solid var(--ui-border-subtle);
    border-radius: 14px;
    background: var(--ui-bg-surface);
    color: var(--ui-text-secondary);
    text-align: center;
    box-shadow: 0 12px 32px rgba(var(--ui-shadow-rgb), 0.18);
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

  @media (max-width: 1180px) {
    .session-workspace--agent-centric {
      grid-template-columns: 168px minmax(0, 1fr);
    }
  }
</style>

import { fireEvent, render, screen, waitFor, within } from "@testing-library/svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App.svelte";
import { setBootstrap } from "./lib/bootstrap";
import { initializeI18n } from "./lib/i18n";
import { replaceLiveSessions, getSessions } from "./lib/features/session/state/live-session-store.svelte";
import { getCurrentWindowName, setCurrentWindowName } from "./lib/features/workspace/session-store.svelte";
import { initializeSettings } from "./lib/stores/settings.svelte";
import { DEFAULT_SETTINGS, type Session } from "./lib/types";
import { isWindowReady, moveSessionToWindow, openEmptyWindow } from "./lib/workspace";
import { measureWindowSizeForTerminal } from "./lib/window-size";

type CloseWindowSessionsResult =
  | { kind: "show-dirty-window-dialog" }
  | { kind: "closed" }
  | { kind: "noop" };

const {
  recordTabHistoryMock,
  appWindowListenerControllerRuntime,
  previewRuntimeMock,
  windowCloseOrchestrationMock,
  settingsModalLoaderRuntime,
} = vi.hoisted(() => ({
  recordTabHistoryMock: vi.fn(async () => {}),
  appWindowListenerControllerRuntime: {
    latestDeps: null as null | {
      showDirtyAppDialog: (dirtyCount: number) => void;
      showCloseWindowDialog: () => void;
    },
  },
  previewRuntimeMock: {
    isBrowserPreview: false,
  },
  windowCloseOrchestrationMock: {
    handleCloseRequested: vi.fn(async () => ({ kind: "noop" as const })),
    performAppClose: vi.fn(async () => true),
    confirmDirtyWindowClose: vi.fn(async () => true),
    moveWindowSessionsToMainAndClose: vi.fn(async () => true),
    handleCloseWindowSessions: vi.fn(
      async (): Promise<CloseWindowSessionsResult> => ({ kind: "closed" }),
    ),
  },
  settingsModalLoaderRuntime: {
    latestDeps: null as null | {
      getComponent: () => unknown;
      setComponent: (component: unknown) => void;
      loadComponent: () => Promise<unknown>;
    },
    ensureLoaded: vi.fn(async () => {}),
  },
}));

vi.mock("./lib/features/session-tabs/view/TabBar.svelte", async () => {
  // @ts-ignore test fixture Svelte component import
  const module = await import("./test-fixtures/app/AppTabBarRenameProbe.svelte");
  return { default: module.default };
});

vi.mock("./lib/features/session/view/SessionViewport.svelte", async () => {
  // @ts-ignore test fixture Svelte component import
  const module = await import("./test-fixtures/app/AppSessionViewportStub.svelte");
  return { default: module.default };
});

vi.mock("./lib/features/launcher/view/SessionLauncher.svelte", async () => {
  // @ts-ignore test fixture Svelte component import
  const module = await import("./test-fixtures/app/AppSessionLauncherStub.svelte");
  return { default: module.default };
});

vi.mock("./lib/components/PreviewControlPanel.svelte", async () => {
  // @ts-ignore test fixture Svelte component import
  const module = await import("./test-fixtures/app/AppPreviewControlPanelStub.svelte");
  return { default: module.default };
});

vi.mock("./lib/window-size", () => ({
  measureWindowSizeForTerminal: vi.fn(async () => ({
    width: 900,
    height: 700,
  })),
}));

vi.mock("./lib/tauri/event", () => ({
  emitTo: vi.fn(async () => {}),
  listen: vi.fn(async () => () => {}),
}));

vi.mock("./lib/tauri/window", () => ({
  currentMonitor: vi.fn(async () => ({ name: "Primary" })),
  getCurrentWindow: () => ({
    label: "main",
    setTitle: vi.fn(async () => {}),
    outerPosition: vi.fn(async () => ({ x: 40, y: 80 })),
    innerSize: vi.fn(async () => ({ width: 1200, height: 800 })),
    isMaximized: vi.fn(async () => false),
    onCloseRequested: vi.fn(async () => () => {}),
    onMoved: vi.fn(async () => () => {}),
    onResized: vi.fn(async () => () => {}),
    close: vi.fn(async () => {}),
  }),
}));

vi.mock("./lib/features/app-shell/controller/window-close-orchestration-controller", () => ({
  DIRTY_STATE_QUERY_EVENT: "clcomx:dirty-state-query",
  DIRTY_STATE_RESPONSE_EVENT: "clcomx:dirty-state-response",
  createWindowCloseOrchestrationController: vi.fn(() => windowCloseOrchestrationMock),
}));

vi.mock("./lib/features/app-shell/controller/app-window-listener-controller", () => ({
  createAppWindowListenerController: vi.fn((deps) => {
    appWindowListenerControllerRuntime.latestDeps = deps;
    return {
    register: vi.fn(async () => {}),
    dispose: vi.fn(),
    };
  }),
}));

vi.mock("./lib/features/app-shell/controller/app-startup-controller", () => ({
  createAppStartupController: vi.fn(() => ({
    start: vi.fn(async () => {}),
    dispose: vi.fn(),
  })),
}));

vi.mock("./lib/features/app-shell/controller/preview-bootstrap-controller", () => ({
  createPreviewBootstrapController: vi.fn(() => ({
    handlePresetChange: vi.fn(),
  })),
}));

vi.mock("./lib/features/app-shell/controller/settings-modal-loader-controller", async () => {
  // @ts-ignore test fixture Svelte component import
  const module = await import("./test-fixtures/app/AppSettingsModalStub.svelte");
  return {
    createSettingsModalLoaderController: vi.fn((deps) => {
      settingsModalLoaderRuntime.latestDeps = deps;
      return {
        ensureLoaded: settingsModalLoaderRuntime.ensureLoaded.mockImplementation(async () => {
          deps.setComponent(module.default);
        }),
      };
    }),
  };
});

vi.mock("./lib/features/app-shell/controller/preview-url-state-controller", () => ({
  PREVIEW_FRAME_OPTIONS: [],
  createPreviewUrlStateController: vi.fn(() => ({
    getInitialFrameMode: () => "desktop",
    getInitialControlsVisible: () => false,
    normalizeFrameMode: (value: string) => value,
    setFrameMode: vi.fn(),
    setControlsVisible: vi.fn(),
  })),
}));

vi.mock("./lib/features/app-shell/controller/window-placement-controller", () => ({
  createWindowPlacementController: vi.fn(() => ({
    schedulePersist: vi.fn(),
    scheduleInitialPersist: vi.fn(),
    dispose: vi.fn(),
  })),
}));

vi.mock("./lib/features/workspace/controller/workspace-autosave-controller", () => ({
  createWorkspaceAutosaveController: vi.fn(() => ({
    schedule: vi.fn(),
    dispose: vi.fn(),
  })),
}));

vi.mock("./lib/stores/tab-history.svelte", () => ({
  getTabHistory: () => [],
  initializeTabHistory: vi.fn(),
  recordTabHistory: recordTabHistoryMock,
}));

vi.mock("./lib/stores/workspace.svelte", () => ({
  getOtherWindows: () => [],
  initializeWorkspaceSnapshot: vi.fn(),
  syncWorkspaceSnapshot: vi.fn(),
}));

vi.mock("./lib/stores/editors.svelte", () => ({
  primeEditorsDetection: vi.fn(async () => {}),
}));

vi.mock("./lib/workspace", () => ({
  closeApp: vi.fn(async () => {}),
  closeSessionByPtyId: vi.fn(async () => {}),
  closeWindowSessions: vi.fn(async () => {}),
  isWindowReady: vi.fn(async () => true),
  moveSessionToWindow: vi.fn(async () => {}),
  moveWindowSessionsToMain: vi.fn(async () => {}),
  notifyWindowReady: vi.fn(async () => {}),
  openEmptyWindow: vi.fn(async () => "secondary"),
  removeWindow: vi.fn(async () => {}),
  setSessionAuxTerminalState: vi.fn(async () => {}),
  setSessionPty: vi.fn(async () => {}),
  closePtyAndCaptureResume: vi.fn(async () => ({ resumeToken: null })),
  clearSessionPty: vi.fn(async () => {}),
  closeSession: vi.fn(async () => {}),
  setSessionResumeToken: vi.fn(async () => {}),
  updateWindowGeometry: vi.fn(async () => {}),
}));

vi.mock("./lib/pty", () => ({
  killPty: vi.fn(async () => {}),
}));

vi.mock("./lib/features/session/controller/session-lifecycle-controller", () => ({
  createSessionLifecycleController: vi.fn(() => ({
    createSession: vi.fn(),
    openHistoryEntry: vi.fn(),
    handlePtyId: vi.fn(async () => {}),
    handleAuxTerminalState: vi.fn(async () => {}),
    handleExit: vi.fn(async () => {}),
    handleResumeFallback: vi.fn(async () => {}),
    captureResumeIdsBeforeAppClose: vi.fn(async () => {}),
    handleCloseTab: vi.fn(async () => {}),
  })),
}));

vi.mock("./lib/features/session/service/session-shell-loader", () => ({
  loadSessionShellComponent: vi.fn(async () => null),
}));

vi.mock("./lib/features/terminal/controller/terminal-focus-bridge", () => ({
  dispatchTerminalFocusRequest: vi.fn(),
}));

vi.mock("./lib/terminal/canonical-screen-authority", () => ({
  installCanonicalScreenAuthority: vi.fn(),
}));

vi.mock("./lib/preview/runtime", () => ({
  applyPreviewPreset: vi.fn(),
  getActivePreviewPresetId: () => "default",
  getAvailablePreviewPresets: () => [],
  isBrowserPreview: () => previewRuntimeMock.isBrowserPreview,
}));

function createSession(overrides: Partial<Session> = {}): Session {
  return {
    id: "session-1",
    agentId: "claude",
    resumeToken: "resume-1",
    title: "Demo",
    pinned: false,
    locked: false,
    distro: "Ubuntu",
    workDir: "/workspace/demo",
    ptyId: 10,
    auxPtyId: -1,
    auxVisible: false,
    auxHeightPercent: null,
    viewMode: "terminal",
    editorRootDir: "/workspace/demo",
    openEditorTabs: [],
    activeEditorPath: null,
    dirtyPaths: [],
    ...overrides,
  };
}

function getAppWindowListenerDeps() {
  expect(appWindowListenerControllerRuntime.latestDeps).not.toBeNull();
  return appWindowListenerControllerRuntime.latestDeps!;
}

describe("App", () => {
  beforeEach(() => {
    initializeI18n("ko", "ko-KR");
    initializeSettings(DEFAULT_SETTINGS);
    setBootstrap({
      settings: null,
      tabHistory: [],
      workspace: null,
      themePack: null,
      testMode: false,
      debugTerminalHooks: false,
      softFollowExperiment: null,
    });
    replaceLiveSessions([createSession()], "session-1");
    setCurrentWindowName("main");
    previewRuntimeMock.isBrowserPreview = false;
    recordTabHistoryMock.mockClear();
    appWindowListenerControllerRuntime.latestDeps = null;
    windowCloseOrchestrationMock.handleCloseRequested.mockReset();
    windowCloseOrchestrationMock.performAppClose.mockReset();
    windowCloseOrchestrationMock.confirmDirtyWindowClose.mockReset();
    windowCloseOrchestrationMock.moveWindowSessionsToMainAndClose.mockReset();
    windowCloseOrchestrationMock.handleCloseWindowSessions.mockReset();
    windowCloseOrchestrationMock.handleCloseRequested.mockResolvedValue({ kind: "noop" });
    windowCloseOrchestrationMock.performAppClose.mockResolvedValue(true);
    windowCloseOrchestrationMock.confirmDirtyWindowClose.mockResolvedValue(true);
    windowCloseOrchestrationMock.moveWindowSessionsToMainAndClose.mockResolvedValue(true);
    windowCloseOrchestrationMock.handleCloseWindowSessions.mockResolvedValue({ kind: "closed" });
    settingsModalLoaderRuntime.latestDeps = null;
    settingsModalLoaderRuntime.ensureLoaded.mockReset();
    settingsModalLoaderRuntime.ensureLoaded.mockImplementation(async () => {
      settingsModalLoaderRuntime.latestDeps?.setComponent(
        (await import("./test-fixtures/app/AppSettingsModalStub.svelte")).default,
      );
    });
    vi.mocked(isWindowReady).mockClear();
    vi.mocked(moveSessionToWindow).mockClear();
    vi.mocked(openEmptyWindow).mockClear();
    vi.mocked(measureWindowSizeForTerminal).mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("opens the tab rename dialog from the tab bar trigger and confirms the renamed title", async () => {
    render(App);

    await fireEvent.click(screen.getByTestId("rename-tab-trigger"));

    const input = document.getElementById("rename-input") as HTMLInputElement | null;
    expect(input).not.toBeNull();
    expect(input?.value).toBe("Demo");

    await fireEvent.input(input!, { target: { value: "  Renamed  " } });
    await fireEvent.keyDown(input!, { key: "Enter" });

    await waitFor(() => {
      expect(getSessions()[0]?.title).toBe("Renamed");
    });
    expect(recordTabHistoryMock).toHaveBeenCalledWith(
      "claude",
      "Ubuntu",
      "/workspace/demo",
      "Renamed",
      "resume-1",
    );
    expect(document.getElementById("rename-input")).toBeNull();
  });

  it("opens and closes the session launcher from the tab bar trigger", async () => {
    render(App);

    expect(screen.queryByTestId("session-launcher-stub")).toBeNull();

    await fireEvent.click(screen.getByTestId("new-tab-trigger"));
    expect(await screen.findByTestId("session-launcher-stub")).not.toBeNull();

    await fireEvent.click(screen.getByTestId("session-launcher-cancel"));

    await waitFor(() => {
      expect(screen.queryByTestId("session-launcher-stub")).toBeNull();
    });
  });

  it("opens and closes the settings modal from the tab bar trigger", async () => {
    render(App);

    expect(screen.queryByTestId("settings-modal-stub")).toBeNull();

    await fireEvent.click(screen.getByTestId("settings-trigger"));

    await waitFor(() => {
      expect(settingsModalLoaderRuntime.ensureLoaded).toHaveBeenCalledTimes(1);
      expect(screen.getByTestId("settings-modal-stub")).toBeInTheDocument();
    });

    await fireEvent.click(screen.getByTestId("settings-modal-close"));

    await waitFor(() => {
      expect(screen.queryByTestId("settings-modal-stub")).toBeNull();
    });
  });

  it("wires preview overlay visibility and session actions through preview controllers", async () => {
    previewRuntimeMock.isBrowserPreview = true;
    render(App);

    expect(screen.queryByTestId("preview-control-panel-stub")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Preview Tools" })).toBeInTheDocument();

    await fireEvent.click(screen.getByRole("button", { name: "Preview Tools" }));
    await waitFor(() => {
      expect(screen.getByTestId("preview-control-panel-stub")).toBeInTheDocument();
    });

    await fireEvent.click(screen.getByTestId("preview-toggle-launcher"));
    expect(await screen.findByTestId("session-launcher-stub")).toBeInTheDocument();

    await waitFor(() => {
      expect(screen.getByTestId("preview-control-panel-stub")).toHaveAttribute("data-launcher-open", "true");
    });

    await fireEvent.click(screen.getByTestId("preview-toggle-settings"));
    await waitFor(() => {
      expect(settingsModalLoaderRuntime.ensureLoaded).toHaveBeenCalledTimes(1);
      expect(screen.getByTestId("settings-modal-stub")).toBeInTheDocument();
      expect(screen.getByTestId("preview-control-panel-stub")).toHaveAttribute("data-settings-open", "true");
    });

    await fireEvent.click(screen.getByTestId("preview-open-rename"));
    expect(document.getElementById("rename-input")).not.toBeNull();

    await fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Cancel" }));
    await waitFor(() => {
      expect(document.getElementById("rename-input")).toBeNull();
    });

    await fireEvent.click(screen.getByTestId("preview-open-close-dialog"));
    expect(await screen.findByTestId("close-tab-dialog")).toBeInTheDocument();

    await fireEvent.click(within(screen.getByTestId("close-tab-dialog")).getByRole("button", { name: "Cancel" }));
    await waitFor(() => {
      expect(screen.queryByTestId("close-tab-dialog")).toBeNull();
    });

    await fireEvent.click(screen.getByTestId("preview-reset-overlays"));
    await waitFor(() => {
      expect(screen.queryByTestId("session-launcher-stub")).toBeNull();
      expect(screen.queryByTestId("settings-modal-stub")).toBeNull();
      expect(document.getElementById("rename-input")).toBeNull();
      expect(screen.getByTestId("preview-control-panel-stub")).toHaveAttribute("data-launcher-open", "false");
      expect(screen.getByTestId("preview-control-panel-stub")).toHaveAttribute("data-settings-open", "false");
    });

    await fireEvent.click(screen.getByTestId("preview-toggle-visibility"));
    await waitFor(() => {
      expect(screen.queryByTestId("preview-control-panel-stub")).not.toBeInTheDocument();
    });
    expect(screen.getByRole("button", { name: "Preview Tools" })).toBeInTheDocument();

    await fireEvent.click(screen.getByRole("button", { name: "Preview Tools" }));
    await waitFor(() => {
      expect(screen.getByTestId("preview-control-panel-stub")).toBeInTheDocument();
    });
  });

  it("opens the window rename dialog from the tab bar trigger and confirms the renamed window name", async () => {
    render(App);

    await fireEvent.click(screen.getByTestId("rename-window-trigger"));

    const input = document.getElementById("rename-input") as HTMLInputElement | null;
    expect(input).not.toBeNull();
    expect(input?.value).toBe("main");

    await fireEvent.input(input!, { target: { value: "  workspace-2  " } });
    await fireEvent.keyDown(input!, { key: "Enter" });

    await waitFor(() => {
      expect(getCurrentWindowName()).toBe("workspace-2");
    });
    expect(document.getElementById("rename-input")).toBeNull();
  });

  it("routes move-to-window through the app-shell move orchestration", async () => {
    render(App);

    await fireEvent.click(screen.getByTestId("move-tab-window-trigger"));

    await waitFor(() => {
      expect(isWindowReady).toHaveBeenCalledWith("secondary");
      expect(moveSessionToWindow).toHaveBeenCalledWith("session-1", "secondary");
    });
  });

  it("routes move-to-new-window through the app-shell detach orchestration", async () => {
    render(App);

    await fireEvent.click(screen.getByTestId("move-tab-new-window-trigger"));

    await waitFor(() => {
      expect(measureWindowSizeForTerminal).toHaveBeenCalled();
      expect(openEmptyWindow).toHaveBeenCalledWith(112, 152, 900, 700);
      expect(isWindowReady).toHaveBeenCalledWith("secondary");
      expect(moveSessionToWindow).toHaveBeenCalledWith("session-1", "secondary");
    });
  });

  it("does not open a new window when geometry preparation fails", async () => {
    const measureError = new Error("measure failed");
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(measureWindowSizeForTerminal).mockRejectedValueOnce(measureError);

    render(App);
    await fireEvent.click(screen.getByTestId("move-tab-new-window-trigger"));

    await waitFor(() => {
      expect(consoleError).toHaveBeenCalledWith("Failed to detach tab", measureError);
    });
    expect(openEmptyWindow).not.toHaveBeenCalled();
    expect(moveSessionToWindow).not.toHaveBeenCalled();
  });

  it("shows dirty app close dialog from the window listener and confirms app close", async () => {
    render(App);

    getAppWindowListenerDeps().showDirtyAppDialog(3);

    await fireEvent.click(await screen.findByRole("button", { name: "Quit Anyway" }));

    await waitFor(() => {
      expect(windowCloseOrchestrationMock.performAppClose).toHaveBeenCalledTimes(1);
    });
    expect(screen.queryByRole("button", { name: "Quit Anyway" })).toBeNull();
  });

  it("shows the close-window dialog from the window listener and routes move-to-main", async () => {
    render(App);

    getAppWindowListenerDeps().showCloseWindowDialog();

    await fireEvent.click(await screen.findByRole("button", { name: "Move Tabs To Main" }));

    await waitFor(() => {
      expect(windowCloseOrchestrationMock.moveWindowSessionsToMainAndClose).toHaveBeenCalledTimes(1);
    });
    expect(screen.queryByRole("button", { name: "Move Tabs To Main" })).toBeNull();
  });

  it("shows dirty secondary-window confirmation when close-tabs reports dirty sessions", async () => {
    windowCloseOrchestrationMock.handleCloseWindowSessions.mockResolvedValueOnce({
      kind: "show-dirty-window-dialog",
    });
    render(App);

    getAppWindowListenerDeps().showCloseWindowDialog();
    await fireEvent.click(await screen.findByRole("button", { name: "Close Tabs" }));
    await fireEvent.click(await screen.findByRole("button", { name: "Close Anyway" }));

    await waitFor(() => {
      expect(windowCloseOrchestrationMock.confirmDirtyWindowClose).toHaveBeenCalledTimes(1);
    });
  });
});

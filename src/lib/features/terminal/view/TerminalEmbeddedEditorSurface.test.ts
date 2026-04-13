import { fireEvent, render, screen } from "@testing-library/svelte";
import type { ComponentProps } from "svelte";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { initializeI18n } from "../../../i18n";
import { initializeSettings } from "../../../stores/settings.svelte";
import { TEST_IDS } from "../../../testids";
import { DEFAULT_SETTINGS } from "../../../types";
import { createEditorQuickOpenState } from "../../editor/state/editor-quick-open-state.svelte";
import { createEditorRuntimeState } from "../../editor/state/editor-runtime-state.svelte";
import TerminalEmbeddedEditorSurface from "./TerminalEmbeddedEditorSurface.svelte";

type SurfaceProps = ComponentProps<typeof TerminalEmbeddedEditorSurface>;

const hostMock = vi.hoisted(() => {
  const instance = {
    syncTabs: vi.fn(),
    setActivePath: vi.fn(),
    setTheme: vi.fn(),
    setPresentation: vi.fn(),
    setNavigationWorkspaceRoot: vi.fn(),
    focus: vi.fn(),
    dispose: vi.fn(),
  };

  return {
    createMonacoEditorHost: vi.fn(() => instance),
    reset() {
      instance.syncTabs.mockReset();
      instance.setActivePath.mockReset();
      instance.setTheme.mockReset();
      instance.setPresentation.mockReset();
      instance.setNavigationWorkspaceRoot.mockReset();
      instance.focus.mockReset();
      instance.dispose.mockReset();
      this.createMonacoEditorHost.mockReset();
      this.createMonacoEditorHost.mockImplementation(() => instance);
    },
  };
});

vi.mock("../../../editor/monaco-host", () => ({
  createMonacoEditorHost: hostMock.createMonacoEditorHost,
}));

function createLabels() {
  return {
    title: "Internal Editor",
    emptyTitle: "No file open",
    emptyDescription: "Open a file to start editing.",
    saveLabel: "Save",
    openFileLabel: "Open File",
    switchToTerminalLabel: "Terminal",
    quickOpenTitle: "Open File",
    quickOpenDescription: "Search within the session root",
    quickOpenPlaceholder: "Search files",
    quickOpenIdleLabel: "Type to search files",
    quickOpenEmptyLabel: "No matching files",
    quickOpenLoadingLabel: "Searching files...",
    refreshLabel: "Refresh",
    closeLabel: "Dismiss",
    keyboardHintLabel: "Press Enter to open",
  };
}

function createSurfaceProps(): SurfaceProps {
  const runtimeState = createEditorRuntimeState();
  runtimeState.tabs = [
    {
      wslPath: "/workspace/src/App.svelte",
      content: "<script>let count = 0;</script>",
      languageId: "svelte",
      dirty: true,
      line: 12,
      column: 3,
      loading: false,
      saving: false,
      error: null,
    },
  ];
  runtimeState.activePath = "/workspace/src/App.svelte";
  runtimeState.statusText = "Unsaved changes";
  runtimeState.closeConfirmVisible = true;
  runtimeState.closeConfirmPath = "/workspace/src/App.svelte";

  const quickOpenState = createEditorQuickOpenState();
  quickOpenState.visible = true;
  quickOpenState.openKey = 1;
  quickOpenState.query = "app";
  quickOpenState.rootDir = "/workspace";
  quickOpenState.entries = [
    {
      wslPath: "/workspace/src/App.svelte",
      relativePath: "src/App.svelte",
      basename: "App.svelte",
      line: 12,
      column: 3,
    },
  ];
  quickOpenState.busy = false;

  return {
    viewMode: "editor",
    runtimeState,
    quickOpenState,
    rootDir: "/workspace",
    busy: false,
    closeConfirmTitle: "App.svelte",
    labels: createLabels(),
    onActivePathChange: vi.fn(),
    onCloseTab: vi.fn(),
    onContentChange: vi.fn(),
    onSaveRequest: vi.fn(),
    onOpenFile: vi.fn(),
    onSwitchToTerminal: vi.fn(),
    onListWorkspaceFiles: vi.fn(async () => []),
    onReadWorkspaceFile: vi.fn(async (wslPath: string) => ({
      wslPath,
      content: "",
      languageId: "plaintext",
    })),
    onOpenLocation: vi.fn(),
    onRefreshQuickOpen: vi.fn(),
    onSelectQuickOpenResult: vi.fn(),
    onCloseQuickOpen: vi.fn(),
    onCancelCloseConfirm: vi.fn(),
    onConfirmCloseConfirm: vi.fn(),
  };
}

describe("TerminalEmbeddedEditorSurface", () => {
  beforeEach(() => {
    hostMock.reset();
    initializeSettings(DEFAULT_SETTINGS);
    initializeI18n("ko", "ko-KR");
  });

  it("composes editor surface, quick open, and close confirm handlers", async () => {
    const props = createSurfaceProps();
    render(TerminalEmbeddedEditorSurface, props);

    expect(screen.getByTestId(TEST_IDS.internalEditorShell)).toBeInTheDocument();
    expect(screen.getByTestId(TEST_IDS.internalEditorQuickOpenModal)).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "저장되지 않은 변경 사항" })).toBeInTheDocument();

    await fireEvent.click(screen.getAllByRole("button", { name: "Open File" })[0]);
    expect(props.onOpenFile).toHaveBeenCalledTimes(1);

    const quickOpenInput = screen.getByTestId(TEST_IDS.internalEditorQuickOpenInput);
    await fireEvent.keyDown(quickOpenInput, { key: "Enter" });
    expect(props.onSelectQuickOpenResult).toHaveBeenCalledWith(props.quickOpenState.entries[0]);

    await fireEvent.click(screen.getAllByRole("button", { name: "Refresh" })[0]);
    expect(props.onRefreshQuickOpen).toHaveBeenCalledWith(true);

    await fireEvent.click(screen.getByRole("button", { name: "그대로 닫기" }));
    expect(props.onConfirmCloseConfirm).toHaveBeenCalledTimes(1);

    await fireEvent.click(screen.getByRole("button", { name: "취소" }));
    expect(props.onCancelCloseConfirm).toHaveBeenCalledTimes(1);
  });

  it("keeps quick open and close confirm active when the editor panel is hidden", async () => {
    const props = createSurfaceProps();
    props.viewMode = "terminal";
    render(TerminalEmbeddedEditorSurface, props);

    expect(screen.queryByTestId(TEST_IDS.internalEditorShell)).not.toBeInTheDocument();

    await fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(props.onCloseQuickOpen).toHaveBeenCalledTimes(1);

    await fireEvent.click(screen.getByRole("button", { name: "취소" }));
    expect(props.onCancelCloseConfirm).toHaveBeenCalledTimes(1);
  });
});

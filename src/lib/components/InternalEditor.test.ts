import type { ComponentProps } from "svelte";
import { fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import { beforeEach, describe, expect, it, vi } from "vitest";
import InternalEditor from "./InternalEditor.svelte";
import { TEST_IDS } from "../testids";
import type { InternalEditorTab } from "../editor/contracts";

const hostMock = vi.hoisted(() => {
  const instance = {
    syncTabs: vi.fn(),
    setActivePath: vi.fn(),
    setTheme: vi.fn(),
    focus: vi.fn(),
    dispose: vi.fn(),
  };

  return {
    createMonacoEditorHost: vi.fn(() => instance),
    instance,
    reset() {
      instance.syncTabs.mockReset();
      instance.setActivePath.mockReset();
      instance.setTheme.mockReset();
      instance.focus.mockReset();
      instance.dispose.mockReset();
      this.createMonacoEditorHost.mockReset();
      this.createMonacoEditorHost.mockImplementation(() => instance);
    },
  };
});

vi.mock("../editor/monaco-host", () => ({
  createMonacoEditorHost: hostMock.createMonacoEditorHost,
}));

function createTabs(): InternalEditorTab[] {
  return [
    {
      wslPath: "/home/user/work/project/src/App.svelte",
      content: "<script>let count = 0;</script>",
      languageId: "svelte",
      dirty: true,
      line: 12,
      column: 3,
    },
    {
      wslPath: "/home/user/work/project/src/routes.ts",
      content: "export const route = '/';",
      languageId: "typescript",
      dirty: false,
    },
  ];
}

type InternalEditorProps = ComponentProps<typeof InternalEditor>;

function createProps(overrides: Partial<InternalEditorProps> = {}) {
  return {
    tabs: createTabs(),
    activePath: "/home/user/work/project/src/App.svelte",
    busy: false,
    statusText: "Unsaved changes",
    emptyTitle: "No file open",
    emptyDescription: "Open a file to start editing.",
    saveLabel: "Save",
    openFileLabel: "Open File",
    switchToTerminalLabel: "Terminal",
    onActivePathChange: vi.fn(),
    onCloseTab: vi.fn(),
    onContentChange: vi.fn(),
    onSaveRequest: vi.fn(),
    onOpenFile: vi.fn(),
    onSwitchToTerminal: vi.fn(),
    ...overrides,
  };
}

describe("InternalEditor", () => {
  beforeEach(() => {
    hostMock.reset();
  });

  it("creates and syncs the Monaco host around the active tab state", async () => {
    const props = createProps();
    const view = render(InternalEditor, props);

    await waitFor(() => {
      expect(hostMock.createMonacoEditorHost).toHaveBeenCalledWith(
        expect.objectContaining({
          target: expect.any(HTMLDivElement),
          tabs: props.tabs,
          activePath: props.activePath,
          theme: expect.objectContaining({ id: "dracula" }),
          onChange: props.onContentChange,
          onSaveRequest: props.onSaveRequest,
        }),
      );
    });

    await waitFor(() => {
      expect(hostMock.instance.syncTabs).toHaveBeenLastCalledWith(props.tabs);
      expect(hostMock.instance.setActivePath).toHaveBeenLastCalledWith(props.activePath);
      expect(hostMock.instance.setTheme).toHaveBeenCalled();
      expect(hostMock.instance.focus).toHaveBeenCalled();
    });

    const nextTabs = createTabs().map((tab) =>
      tab.wslPath.endsWith("routes.ts") ? { ...tab, dirty: true } : tab,
    );

    await view.rerender({
      ...props,
      tabs: nextTabs,
      activePath: "/home/user/work/project/src/routes.ts",
    });

    await waitFor(() => {
      expect(hostMock.instance.syncTabs).toHaveBeenLastCalledWith(nextTabs);
      expect(hostMock.instance.setActivePath).toHaveBeenLastCalledWith(
        "/home/user/work/project/src/routes.ts",
      );
    });

    view.unmount();
    expect(hostMock.instance.dispose).toHaveBeenCalled();
  });

  it("routes toolbar and tab actions through callback props", async () => {
    const props = createProps();
    render(InternalEditor, props);

    expect(screen.getByTestId(TEST_IDS.internalEditorShell)).toBeInTheDocument();
    expect(screen.getByLabelText("dirty")).toBeInTheDocument();

    await fireEvent.click(screen.getByRole("button", { name: "routes.ts" }));
    expect(props.onActivePathChange).toHaveBeenCalledWith("/home/user/work/project/src/routes.ts");

    await fireEvent.click(screen.getByRole("button", { name: /Close routes.ts/i }));
    expect(props.onCloseTab).toHaveBeenCalledWith("/home/user/work/project/src/routes.ts");

    await fireEvent.click(screen.getAllByRole("button", { name: "Open File" })[0]);
    expect(props.onOpenFile).toHaveBeenCalled();

    await fireEvent.click(screen.getByRole("button", { name: "Terminal" }));
    expect(props.onSwitchToTerminal).toHaveBeenCalled();

    await fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(props.onSaveRequest).toHaveBeenCalledWith("/home/user/work/project/src/App.svelte");
  });

  it("enables save only when the active tab is dirty", async () => {
    const props = createProps({
      activePath: "/home/user/work/project/src/routes.ts",
    });
    const view = render(InternalEditor, props);

    const saveButton = screen.getByRole("button", { name: "Save" });
    expect(saveButton).toBeDisabled();

    await view.rerender({
      ...props,
      activePath: "/home/user/work/project/src/App.svelte",
    });

    expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();
  });

  it("shows the empty state without creating a Monaco host", async () => {
    const props = createProps({
      tabs: [],
      activePath: null,
      statusText: null,
    });

    render(InternalEditor, props);

    expect(screen.getAllByText("No file open")).toHaveLength(2);
    expect(screen.getAllByText("Open a file to start editing.").length).toBeGreaterThan(0);
    expect(hostMock.createMonacoEditorHost).not.toHaveBeenCalled();

    await fireEvent.click(screen.getAllByRole("button", { name: "Open File" })[0]);
    expect(props.onOpenFile).toHaveBeenCalled();
  });
});

import { fireEvent, render, screen, within } from "@testing-library/svelte";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { initializeI18n } from "../i18n";
import { DEFAULT_SETTINGS, type WorkspaceSnapshot } from "../types";
import { initializeSettings } from "../stores/settings.svelte";
import { getActiveSessionId, initializeSessionsFromWorkspace } from "../stores/sessions.svelte";
import TabBar from "./TabBar.svelte";
import { contextMenuItemTestId } from "../testids";

const EXAMPLE_DISTRO = "ExampleDistro";

const BASE_WORKSPACE: WorkspaceSnapshot = {
  windows: [
    {
      label: "main",
      name: "main",
      role: "main",
      activeSessionId: "session-a",
      tabs: [
        {
          sessionId: "session-a",
          agentId: "claude",
          distro: EXAMPLE_DISTRO,
          workDir: "/home/xenia/work/a",
          title: "Alpha",
          pinned: false,
          locked: false,
          ptyId: 1,
        },
        {
          sessionId: "session-b",
          agentId: "claude",
          distro: EXAMPLE_DISTRO,
          workDir: "/home/xenia/work/b",
          title: "Beta",
          pinned: false,
          locked: false,
          ptyId: 2,
        },
      ],
    },
  ],
};

describe("TabBar", () => {
  beforeEach(() => {
    initializeI18n("ko", "ko-KR");
    initializeSettings(DEFAULT_SETTINGS);
    initializeSessionsFromWorkspace(BASE_WORKSPACE, "main");
  });

  it("keeps the active tab unchanged when opening a context menu on another tab", async () => {
    render(TabBar, {
      onNewTab: vi.fn(),
      onCloseTab: vi.fn(),
      availableWindows: [{ label: "window-1", name: "window-1" }],
    });

    const betaTab = screen.getByText("Beta").closest(".tab");
    expect(betaTab).not.toBeNull();

    await fireEvent.contextMenu(betaTab!, { clientX: 160, clientY: 24 });

    const menu = screen.getByRole("menu");
    expect(menu).toBeInTheDocument();
    expect(getActiveSessionId()).toBe("session-a");
    expect(within(menu).getByRole("button", { name: /새 창으로 이동/i })).toBeInTheDocument();
  });

  it("routes close action from the context menu to the selected tab", async () => {
    const onCloseTab = vi.fn();

    render(TabBar, {
      onNewTab: vi.fn(),
      onCloseTab,
      availableWindows: [],
    });

    const betaTab = screen.getByText("Beta").closest(".tab");
    expect(betaTab).not.toBeNull();

    await fireEvent.contextMenu(betaTab!, { clientX: 160, clientY: 24 });

    const menu = screen.getByRole("menu");
    await fireEvent.click(within(menu).getByTestId(contextMenuItemTestId("close-tab")));

    expect(onCloseTab).toHaveBeenCalledWith("session-b");
  });
});

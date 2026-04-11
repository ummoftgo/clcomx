import { fireEvent, render, screen, waitFor, within } from "@testing-library/svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getActiveSessionId,
  getSessions,
} from "../../session/state/live-session-store.svelte";
import { initializeSessionsFromWorkspace } from "../../workspace/session-store.svelte";
import { initializeI18n } from "../../../i18n";
import { initializeSettings } from "../../../stores/settings.svelte";
import {
  contextMenuItemTestId,
  tabMenuButtonTestId,
  tabTestId,
} from "../../../testids";
import { DEFAULT_SETTINGS, type WorkspaceSnapshot } from "../../../types";
import TabBar from "./TabBar.svelte";
import TabBarHarness from "./test-fixtures/TabBarHarness.svelte";
import type { TabBarProps } from "../contracts/tab-bar";

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

const COMPLEX_WORKSPACE: WorkspaceSnapshot = {
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
        {
          sessionId: "session-c",
          agentId: "claude",
          distro: EXAMPLE_DISTRO,
          workDir: "/home/xenia/work/c",
          title: "Gamma",
          pinned: true,
          locked: true,
          ptyId: 3,
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

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  function renderTabBar(overrides: Partial<TabBarProps> = {}) {
    return render(TabBarHarness, {
      onNewTab: vi.fn(),
      onRequestSessionFocus: vi.fn(),
      onCloseTab: vi.fn(),
      availableWindows: [],
      ...overrides,
    });
  }

  function renderRawTabBar(overrides: Partial<TabBarProps> = {}) {
    return render(TabBar, {
      sessions: getSessions(),
      activeSessionId: getActiveSessionId(),
      onNewTab: vi.fn(),
      onActivateTab: vi.fn(),
      onReorderTab: vi.fn(),
      onRequestSessionFocus: vi.fn(),
      onCloseTab: vi.fn(),
      availableWindows: [],
      ...overrides,
    });
  }

  function mockTabRect(
    sessionId: string,
    rect: Pick<DOMRect, "bottom" | "left" | "right" | "top">,
  ) {
    const element = screen.getByTestId(tabTestId(sessionId));
    vi.spyOn(element, "getBoundingClientRect").mockReturnValue({
      ...rect,
      height: rect.bottom - rect.top,
      width: rect.right - rect.left,
      x: rect.left,
      y: rect.top,
      toJSON: () => ({}),
    } as DOMRect);
    return element;
  }

  function getRenderedTabOrder() {
    return Array.from(document.querySelectorAll<HTMLElement>(".tab[data-testid]")).map(
      (element) => element.dataset.testid,
    );
  }

  it("keeps the active tab unchanged when opening a context menu on another tab", async () => {
    renderTabBar({
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

    renderTabBar({
      onCloseTab,
    });

    const betaTab = screen.getByText("Beta").closest(".tab");
    expect(betaTab).not.toBeNull();

    await fireEvent.contextMenu(betaTab!, { clientX: 160, clientY: 24 });

    const menu = screen.getByRole("menu");
    await fireEvent.click(within(menu).getByTestId(contextMenuItemTestId("close-tab")));

    expect(onCloseTab).toHaveBeenCalledWith("session-b");
  });

  it("keeps the active tab unchanged when opening the menu from the tab menu button", async () => {
    renderTabBar({
      availableWindows: [{ label: "window-1", name: "window-1" }],
    });

    await fireEvent.click(screen.getByTestId(tabMenuButtonTestId("session-b")));

    const menu = screen.getByRole("menu");
    expect(menu).toBeInTheDocument();
    expect(getActiveSessionId()).toBe("session-a");
    expect(within(menu).getByRole("button", { name: /새 창으로 이동/i })).toBeInTheDocument();
  });

  it("renders disabled close and move actions for a locked pinned edge tab", async () => {
    initializeSessionsFromWorkspace(COMPLEX_WORKSPACE, "main");

    renderTabBar({
      availableWindows: [{ label: "window-1", name: "window-1" }],
    });

    await fireEvent.contextMenu(screen.getByText("Gamma").closest(".tab")!, {
      clientX: 180,
      clientY: 24,
    });

    const menu = screen.getByRole("menu");
    expect(within(menu).getByTestId(contextMenuItemTestId("close-tab"))).toBeDisabled();
    expect(within(menu).getByTestId(contextMenuItemTestId("move-left"))).toBeDisabled();
    expect(within(menu).getByTestId(contextMenuItemTestId("move-right"))).toBeDisabled();
  });

  it("activates an inactive tab on click", async () => {
    renderTabBar();

    const betaTab = screen.getByTestId(tabTestId("session-b"));
    await fireEvent.click(betaTab);

    expect(getActiveSessionId()).toBe("session-b");
    expect(betaTab).toHaveClass("active");
  });

  it("activates the pointed tab and requests terminal focus on pointer up", async () => {
    const onRequestSessionFocus = vi.fn();

    renderTabBar({
      onRequestSessionFocus,
    });

    const betaTab = screen.getByTestId(tabTestId("session-b"));

    await fireEvent.pointerDown(betaTab, {
      button: 0,
      pointerId: 1,
      clientX: 120,
      clientY: 20,
    });
    await fireEvent.pointerUp(betaTab, {
      pointerId: 1,
      clientX: 120,
      clientY: 20,
    });

    expect(getActiveSessionId()).toBe("session-b");
    expect(betaTab).toHaveClass("active");
    expect(onRequestSessionFocus).toHaveBeenCalledWith("session-b");
  });

  it("ignores pointercancel from a different pointer", async () => {
    const onRequestSessionFocus = vi.fn();

    renderTabBar({
      onRequestSessionFocus,
    });

    const betaTab = screen.getByTestId(tabTestId("session-b"));

    await fireEvent.pointerDown(betaTab, {
      button: 0,
      pointerId: 1,
      clientX: 120,
      clientY: 20,
    });
    await fireEvent.pointerCancel(betaTab, {
      pointerId: 2,
      clientX: 120,
      clientY: 20,
    });

    expect(onRequestSessionFocus).not.toHaveBeenCalled();
  });

  it("restores focus on pointercancel for the active pointer", async () => {
    const onRequestSessionFocus = vi.fn();

    renderTabBar({
      onRequestSessionFocus,
    });

    const betaTab = screen.getByTestId(tabTestId("session-b"));

    await fireEvent.pointerDown(betaTab, {
      button: 0,
      pointerId: 1,
      clientX: 120,
      clientY: 20,
    });
    await fireEvent.pointerCancel(betaTab, {
      pointerId: 1,
      clientX: 120,
      clientY: 20,
    });

    expect(onRequestSessionFocus).toHaveBeenCalledWith("session-a");
  });

  it("reorders within the same pin group and restores focus on drag finish", async () => {
    const onReorderTab = vi.fn();
    const onActivateTab = vi.fn();
    const onRequestSessionFocus = vi.fn();

    renderRawTabBar({
      onActivateTab,
      onReorderTab,
      onRequestSessionFocus,
    });

    const alphaTab = mockTabRect("session-a", {
      left: 0,
      right: 100,
      top: 0,
      bottom: 40,
    });
    const betaTab = mockTabRect("session-b", {
      left: 100,
      right: 200,
      top: 0,
      bottom: 40,
    });

    expect(alphaTab).toBeInTheDocument();

    await fireEvent.pointerDown(betaTab, {
      button: 0,
      pointerId: 1,
      clientX: 150,
      clientY: 20,
    });
    await fireEvent.pointerMove(betaTab, {
      pointerId: 1,
      clientX: 50,
      clientY: 20,
    });
    await fireEvent.pointerUp(betaTab, {
      pointerId: 1,
      clientX: 50,
      clientY: 20,
    });

    expect(onReorderTab).toHaveBeenCalledWith("session-b", 0);
    expect(onActivateTab).toHaveBeenCalledWith("session-b");
    expect(onRequestSessionFocus).toHaveBeenCalledWith("session-b");
  });

  it("re-renders the harness with the reordered session sequence after drag finish", async () => {
    const onRequestSessionFocus = vi.fn();

    renderTabBar({
      onRequestSessionFocus,
    });

    expect(getRenderedTabOrder()).toEqual([
      tabTestId("session-a"),
      tabTestId("session-b"),
    ]);

    mockTabRect("session-a", {
      left: 0,
      right: 100,
      top: 0,
      bottom: 40,
    });
    const betaTab = mockTabRect("session-b", {
      left: 100,
      right: 200,
      top: 0,
      bottom: 40,
    });

    await fireEvent.pointerDown(betaTab, {
      button: 0,
      pointerId: 1,
      clientX: 150,
      clientY: 20,
    });
    await fireEvent.pointerMove(betaTab, {
      pointerId: 1,
      clientX: 50,
      clientY: 20,
    });
    await fireEvent.pointerUp(betaTab, {
      pointerId: 1,
      clientX: 50,
      clientY: 20,
    });

    await waitFor(() => {
      expect(getRenderedTabOrder()).toEqual([
        tabTestId("session-b"),
        tabTestId("session-a"),
      ]);
    });

    expect(onRequestSessionFocus).toHaveBeenCalledWith("session-b");
  });

  it("does not reorder across a pinned boundary", async () => {
    const onReorderTab = vi.fn();
    initializeSessionsFromWorkspace(COMPLEX_WORKSPACE, "main");

    renderRawTabBar({
      onReorderTab,
    });

    const betaTab = mockTabRect("session-b", {
      left: 100,
      right: 200,
      top: 0,
      bottom: 40,
    });
    mockTabRect("session-c", {
      left: 200,
      right: 300,
      top: 0,
      bottom: 40,
    });

    await fireEvent.pointerDown(betaTab, {
      button: 0,
      pointerId: 1,
      clientX: 150,
      clientY: 20,
    });
    await fireEvent.pointerMove(betaTab, {
      pointerId: 1,
      clientX: 250,
      clientY: 20,
    });

    expect(onReorderTab).not.toHaveBeenCalled();
  });

  it("activates an inactive tab on Enter", async () => {
    renderTabBar();

    const betaTab = screen.getByTestId(tabTestId("session-b"));
    await fireEvent.keyDown(betaTab, { key: "Enter" });

    expect(getActiveSessionId()).toBe("session-b");
    expect(betaTab).toHaveClass("active");
  });

  it("requests terminal focus after move-left tab action", async () => {
    const onRequestSessionFocus = vi.fn();
    const onMoveTabLeft = vi.fn();

    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callback(16);
      return 1;
    });

    renderTabBar({
      onRequestSessionFocus,
      onMoveTabLeft,
      availableWindows: [{ label: "window-1", name: "window-1" }],
    });

    await fireEvent.contextMenu(screen.getByText("Beta").closest(".tab")!, {
      clientX: 160,
      clientY: 24,
    });

    const menu = screen.getByRole("menu");
    await fireEvent.click(within(menu).getByTestId(contextMenuItemTestId("move-left")));

    expect(onMoveTabLeft).toHaveBeenCalledWith("session-b");
    expect(onRequestSessionFocus).toHaveBeenCalledWith("session-b");
  });

  it("requests terminal focus after pin tab action", async () => {
    const onRequestSessionFocus = vi.fn();
    const onTogglePinTab = vi.fn();

    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callback(16);
      return 1;
    });

    renderTabBar({
      onRequestSessionFocus,
      onTogglePinTab,
      availableWindows: [{ label: "window-1", name: "window-1" }],
    });

    await fireEvent.contextMenu(screen.getByText("Beta").closest(".tab")!, {
      clientX: 160,
      clientY: 24,
    });

    const menu = screen.getByRole("menu");
    await fireEvent.click(within(menu).getByTestId(contextMenuItemTestId("pin-tab")));

    expect(onTogglePinTab).toHaveBeenCalledWith("session-b");
    expect(onRequestSessionFocus).toHaveBeenCalledWith("session-b");
  });
});

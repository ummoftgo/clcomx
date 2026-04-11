import { beforeEach, describe, expect, it, vi } from "vitest";
import { initializeI18n } from "../../../i18n";
import type { ContextMenuItem } from "../../../ui/context-menu";
import {
  buildSessionTabMenuItems,
  handleSessionTabMenuSelect,
} from "./tab-context-menu-controller";

const SESSIONS = [
  { id: "a", pinned: false, locked: false },
  { id: "b", pinned: false, locked: false },
  { id: "c", pinned: true, locked: false },
  { id: "d", pinned: true, locked: true },
];

function translate(key: string, options?: { default?: string; values?: Record<string, unknown> }) {
  if (key === "tabs.menu.moveToWindow") {
    return `Move to ${String(options?.values?.name ?? "")}`;
  }

  return options?.default ?? key;
}

function createItem(id: string, value?: string): Extract<ContextMenuItem, { kind: "item" }> {
  return {
    id,
    kind: "item",
    label: id,
    value,
  };
}

describe("tab-context-menu-controller", () => {
  beforeEach(() => {
    initializeI18n("ko", "ko-KR");
  });

  it("builds menu items with move guards and window targets", () => {
    const items = buildSessionTabMenuItems({
      sessions: SESSIONS,
      sessionId: "a",
      availableWindows: [
        { label: "secondary", name: "Window 2" },
      ],
      translate,
    });

    expect(items.find((item) => item.id === "move-left")).toMatchObject({
      kind: "item",
      disabled: true,
    });
    expect(items.find((item) => item.id === "move-right")).toMatchObject({
      kind: "item",
      disabled: false,
    });
    expect(items.find((item) => item.id === "move-window-header")).toMatchObject({
      kind: "header",
    });
    expect(items.find((item) => item.id === "move-window-secondary")).toMatchObject({
      kind: "item",
      value: "secondary",
      label: "Move to Window 2",
    });
  });

  it("derives pin and lock labels from the target session state", () => {
    const items = buildSessionTabMenuItems({
      sessions: SESSIONS,
      sessionId: "d",
      availableWindows: [],
      translate,
    });

    expect(items.find((item) => item.id === "unpin-tab")).toBeTruthy();
    expect(items.find((item) => item.id === "unlock-tab")).toBeTruthy();
    expect(items.find((item) => item.id === "close-tab")).toMatchObject({
      kind: "item",
      disabled: true,
      danger: true,
    });
  });

  it("routes menu selections to the provided action handlers", () => {
    const renameTab = vi.fn();
    const renameWindow = vi.fn();
    const togglePin = vi.fn();
    const toggleLock = vi.fn();
    const moveLeft = vi.fn();
    const moveRight = vi.fn();
    const moveToNewWindow = vi.fn();
    const moveToWindow = vi.fn();
    const closeTab = vi.fn();

    const invoke = (item: Extract<ContextMenuItem, { kind: "item" }>) =>
      handleSessionTabMenuSelect({
        sessionId: "b",
        item,
        renameTab,
        renameWindow,
        togglePin,
        toggleLock,
        moveLeft,
        moveRight,
        moveToNewWindow,
        moveToWindow,
        closeTab,
      });

    invoke(createItem("rename-tab"));
    invoke(createItem("rename-window"));
    invoke(createItem("pin-tab"));
    invoke(createItem("lock-tab"));
    invoke(createItem("move-left"));
    invoke(createItem("move-right"));
    invoke(createItem("move-new-window"));
    invoke(createItem("close-tab"));
    invoke(createItem("move-window-secondary", "secondary"));

    expect(renameTab).toHaveBeenCalledWith("b");
    expect(renameWindow).toHaveBeenCalledTimes(1);
    expect(togglePin).toHaveBeenCalledWith("b");
    expect(toggleLock).toHaveBeenCalledWith("b");
    expect(moveLeft).toHaveBeenCalledWith("b");
    expect(moveRight).toHaveBeenCalledWith("b");
    expect(moveToNewWindow).toHaveBeenCalledWith("b");
    expect(closeTab).toHaveBeenCalledWith("b");
    expect(moveToWindow).toHaveBeenCalledWith("b", "secondary");
  });
});

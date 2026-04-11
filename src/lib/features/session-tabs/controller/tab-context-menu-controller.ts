import type { ContextMenuItem } from "../../../ui/context-menu";
import { resolveAdjacentSessionMoveIndex } from "../../session/service/session-tab-behavior";
import type {
  SessionTabMenuSession,
  SessionTabWindowMenuItem,
} from "../contracts/tab-bar";

type TranslationOptions = {
  default?: string;
  values?: Record<string, string | number | boolean | Date | null | undefined>;
  locale?: string;
  format?: string;
};

interface BuildSessionTabMenuItemsOptions {
  sessions: SessionTabMenuSession[];
  sessionId: string;
  availableWindows: SessionTabWindowMenuItem[];
  translate: (key: string, options?: TranslationOptions) => string;
}

interface HandleSessionTabMenuSelectOptions {
  sessionId: string;
  item: Extract<ContextMenuItem, { kind: "item" }>;
  renameTab: (sessionId: string) => void;
  renameWindow: () => void;
  togglePin: (sessionId: string) => void;
  toggleLock: (sessionId: string) => void;
  moveLeft: (sessionId: string) => void;
  moveRight: (sessionId: string) => void;
  moveToNewWindow: (sessionId: string) => void;
  moveToWindow: (sessionId: string, targetLabel: string) => void;
  closeTab: (sessionId: string) => void;
}

function canMove(
  sessions: SessionTabMenuSession[],
  sessionId: string,
  direction: "left" | "right",
) {
  return resolveAdjacentSessionMoveIndex(sessions, sessionId, direction) !== null;
}

export function buildSessionTabMenuItems(
  options: BuildSessionTabMenuItemsOptions,
): ContextMenuItem[] {
  const { sessions, sessionId, availableWindows, translate } = options;
  const session = sessions.find((entry) => entry.id === sessionId);
  const items: ContextMenuItem[] = [
    {
      id: "rename-tab",
      kind: "item",
      label: translate("tabs.menu.renameTab", { default: "Rename Tab" }),
      value: sessionId,
    },
    {
      id: "rename-window",
      kind: "item",
      label: translate("tabs.menu.renameWindow", { default: "Rename This Window" }),
    },
    { id: "rename-separator", kind: "separator" },
    {
      id: session?.pinned ? "unpin-tab" : "pin-tab",
      kind: "item",
      label: translate(session?.pinned ? "tabs.menu.unpinTab" : "tabs.menu.pinTab", {
        default: session?.pinned ? "Unpin Tab" : "Pin Tab",
      }),
      value: sessionId,
    },
    {
      id: session?.locked ? "unlock-tab" : "lock-tab",
      kind: "item",
      label: translate(session?.locked ? "tabs.menu.unlockTab" : "tabs.menu.lockTab", {
        default: session?.locked ? "Unlock Tab Close" : "Lock Tab Close",
      }),
      value: sessionId,
    },
    { id: "organize-separator", kind: "separator" },
    {
      id: "move-left",
      kind: "item",
      label: translate("tabs.menu.moveLeft", { default: "Move left" }),
      disabled: !canMove(sessions, sessionId, "left"),
      value: sessionId,
    },
    {
      id: "move-right",
      kind: "item",
      label: translate("tabs.menu.moveRight", { default: "Move right" }),
      disabled: !canMove(sessions, sessionId, "right"),
      value: sessionId,
    },
    {
      id: "move-new-window",
      kind: "item",
      label: translate("tabs.menu.moveToNewWindow", { default: "Move to new window" }),
      value: sessionId,
    },
  ];

  if (availableWindows.length > 0) {
    items.push({
      id: "move-window-header",
      kind: "header",
      label: translate("tabs.menu.moveToWindowSection", { default: "Move to other window" }),
    });

    for (const windowItem of availableWindows) {
      items.push({
        id: `move-window-${windowItem.label}`,
        kind: "item",
        label: translate("tabs.menu.moveToWindow", {
          default: "Move to {name}",
          values: { name: windowItem.name },
        }),
        value: windowItem.label,
      });
    }
  }

  items.push({ id: "close-separator", kind: "separator" });
  items.push({
    id: "close-tab",
    kind: "item",
    label: translate("tabs.menu.closeTab", { default: "Close tab" }),
    disabled: Boolean(session?.locked),
    danger: true,
    value: sessionId,
  });

  return items;
}

export function handleSessionTabMenuSelect(
  options: HandleSessionTabMenuSelectOptions,
) {
  const { sessionId, item } = options;

  switch (item.id) {
    case "rename-tab":
      options.renameTab(sessionId);
      return;
    case "rename-window":
      options.renameWindow();
      return;
    case "pin-tab":
    case "unpin-tab":
      options.togglePin(sessionId);
      return;
    case "lock-tab":
    case "unlock-tab":
      options.toggleLock(sessionId);
      return;
    case "move-left":
      options.moveLeft(sessionId);
      return;
    case "move-right":
      options.moveRight(sessionId);
      return;
    case "move-new-window":
      options.moveToNewWindow(sessionId);
      return;
    case "close-tab":
      options.closeTab(sessionId);
      return;
    default:
      if (item.value) {
        options.moveToWindow(sessionId, item.value);
      }
  }
}

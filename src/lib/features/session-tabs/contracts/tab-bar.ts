import type { Session } from "../../../types";

export interface SessionTabWindowMenuItem {
  label: string;
  name: string;
}

export interface TabBarProps {
  onNewTab: () => void;
  onSettings?: () => void;
  onCloseTab?: (id: string) => void;
  onRenameTab?: (id: string) => void;
  onRenameWindow?: () => void;
  onTogglePinTab?: (id: string) => void;
  onToggleLockTab?: (id: string) => void;
  onMoveTabLeft?: (id: string) => void;
  onMoveTabRight?: (id: string) => void;
  onMoveTabToNewWindow?: (id: string) => void;
  onMoveTabToWindow?: (sessionId: string, targetLabel: string) => void;
  availableWindows?: SessionTabWindowMenuItem[];
}

export type SessionTabMenuSession = Pick<Session, "id" | "pinned" | "locked">;

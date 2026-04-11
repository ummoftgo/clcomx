import type { Session } from "../../../types";

export interface SessionTabWindowMenuItem {
  label: string;
  name: string;
}

export type SessionTabViewModel = Pick<
  Session,
  "agentId" | "id" | "locked" | "pinned" | "title"
>;

export interface TabBarProps {
  sessions: SessionTabViewModel[];
  activeSessionId: string | null;
  onNewTab: () => void;
  onActivateTab?: (id: string) => void;
  onReorderTab?: (id: string, toIndex: number) => void;
  onRequestTerminalFocus?: (id: string) => void;
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

import type { Component } from "svelte";
import type { AgentId } from "../../../agents";
import type { Session, TabHistoryEntry } from "../../../types";
import type { SessionShellAuxState } from "./session-shell";

export interface SessionViewportProps {
  sessions: Session[];
  activeSessionId: string | null;
  historyEntries: TabHistoryEntry[];
  TerminalComponent: Component | null;
  onOpenHistory: (entry: TabHistoryEntry) => void;
  onConfirmSession: (agentId: AgentId, distro: string, workDir: string) => void;
  onSessionPtyId: (sessionId: string, ptyId: number) => void | Promise<void>;
  onSessionAuxStateChange: (
    sessionId: string,
    state: SessionShellAuxState,
  ) => void | Promise<void>;
  onSessionExit: (ptyId: number) => void | Promise<void>;
  onSessionResumeFallback: (sessionId: string) => void | Promise<void>;
}

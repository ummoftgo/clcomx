import type { Component } from "svelte";
import type { AgentId } from "../../../agents";
import type { Session, SessionEditorState, TabHistoryEntry } from "../../../types";
import type { SessionShellAuxState } from "./session-shell";

export interface SessionViewportProps {
  sessions: Session[];
  activeSessionId: string | null;
  historyEntries: TabHistoryEntry[];
  SessionShellComponent: Component<any> | null;
  onOpenHistory: (entry: TabHistoryEntry) => void;
  onConfirmSession: (agentId: AgentId, distro: string, workDir: string) => void;
  onSessionEditorStateChange: (
    sessionId: string,
    state: SessionEditorState,
  ) => void | Promise<void>;
  onSessionPtyId: (sessionId: string, ptyId: number) => void | Promise<void>;
  onSessionAuxStateChange: (
    sessionId: string,
    state: SessionShellAuxState,
  ) => void | Promise<void>;
  onSessionExit: (ptyId: number) => void | Promise<void>;
  onSessionResumeFallback: (sessionId: string) => void | Promise<void>;
}

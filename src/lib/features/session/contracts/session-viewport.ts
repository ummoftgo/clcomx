import type { Component } from "svelte";
import type { AgentId } from "../../../agents";
import type { Session, SessionEditorState, TabHistoryEntry } from "../../../types";
import type { SessionRuntimeKind } from "../../agent-runtime/contracts/metadata";
import type {
  SessionFallbackToPtyRequest,
  SessionShellAuxState,
} from "./session-shell";

export interface SessionViewportProps {
  sessions: Session[];
  activeSessionId: string | null;
  historyEntries: TabHistoryEntry[];
  SessionLauncherComponent: Component<any>;
  SessionShellComponent: Component<any> | null;
  onOpenHistory: (entry: TabHistoryEntry) => void;
  onConfirmSession: (
    agentId: AgentId,
    distro: string,
    workDir: string,
    runtimeKind?: SessionRuntimeKind,
  ) => void;
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
  /** direct runtime 실패 시 legacy PTY 새 세션 전환(10 §4.6). */
  onSessionFallbackToPty?: (request: SessionFallbackToPtyRequest) => void | Promise<void>;
}

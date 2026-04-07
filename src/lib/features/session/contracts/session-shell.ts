import type {
  Session,
  SessionEditorSnapshot,
  SessionEditorState,
} from "../../../types";

export interface SessionShellAuxState {
  auxPtyId: number;
  auxVisible: boolean;
  auxHeightPercent: number | null;
}

export type SessionShellSession = Pick<
  Session,
  | "id"
  | "agentId"
  | "distro"
  | "workDir"
  | "ptyId"
  | "auxPtyId"
  | "auxVisible"
  | "auxHeightPercent"
  | "resumeToken"
  | "viewMode"
  | "editorRootDir"
  | "openEditorTabs"
  | "activeEditorPath"
>;

export interface SessionHostProps {
  sessionId: string;
  visible: boolean;
  agentId: string;
  distro: string;
  workDir: string;
  ptyId: number;
  storedAuxPtyId?: number;
  storedAuxVisible?: boolean;
  storedAuxHeightPercent?: number | null;
  resumeToken?: string | null;
  sessionSnapshot?: SessionEditorSnapshot | null;
  onEditorSessionStateChange?: (state: SessionEditorState) => void | Promise<void>;
  onPtyId?: (ptyId: number) => void | Promise<void>;
  onAuxStateChange?: (state: SessionShellAuxState) => void | Promise<void>;
  onExit?: (ptyId: number) => void | Promise<void>;
  onResumeFallback?: () => void | Promise<void>;
}

export interface SessionShellProps {
  session: SessionShellSession;
  visible: boolean;
  onSessionEditorStateChange?: (
    sessionId: string,
    state: SessionEditorState,
  ) => void | Promise<void>;
  onSessionPtyId?: (sessionId: string, ptyId: number) => void | Promise<void>;
  onSessionAuxStateChange?: (
    sessionId: string,
    state: SessionShellAuxState,
  ) => void | Promise<void>;
  onSessionExit?: (ptyId: number) => void | Promise<void>;
  onSessionResumeFallback?: (sessionId: string) => void | Promise<void>;
}

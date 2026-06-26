import type {
  Session,
  SessionEditorSnapshot,
  SessionEditorState,
} from "../../../types";
import type { SessionRuntimeKind } from "../../agent-runtime/contracts/metadata";

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
  | "runtimeKind"
>;

export interface SessionHostProps {
  sessionId: string;
  visible: boolean;
  agentId: string;
  distro: string;
  workDir: string;
  ptyId: number;
  /** 세션 host 종류(15 §7.2). direct host 분기·adapter 선택에 사용. 미지정은 pty 취급. */
  runtimeKind?: SessionRuntimeKind;
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

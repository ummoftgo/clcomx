import type {
  Session,
  SessionEditorSnapshot,
  SessionEditorState,
} from "../../../types";
import type {
  AgentRuntimeMetadata,
  SessionRuntimeKind,
} from "../../agent-runtime/contracts/metadata";
import type { AgentSessionStatus } from "../../agent-runtime/contracts/normalized";

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
  | "agentRuntime"
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
  /** direct runtime 재개·복원용 provider 메타. PTY host는 무시한다. */
  agentRuntime?: AgentRuntimeMetadata;
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
  /** direct runtime 시작/재개 후 provider id·capability 메타를 live session에 반영한다. */
  onAgentRuntimeMetadataChange?: (metadata: AgentRuntimeMetadata) => void | Promise<void>;
  /** direct runtime status를 live session에 반영해 탭 badge와 동기화한다(OQ-06). */
  onAgentRuntimeStatusChange?: (status: AgentSessionStatus) => void | Promise<void>;
  /** direct runtime provider title 갱신을 live session title에 반영한다. */
  onSessionTitleChange?: (title: string | null) => void | Promise<void>;
}

/** direct runtime 실패 후 legacy PTY 새 세션/legacy resume 전환 요청(10 §4.6). */
export interface SessionFallbackToPtyRequest {
  /** 실패한 direct 세션(닫기 대상). */
  sessionId: string;
  agentId: string;
  distro: string;
  workDir: string;
  /** 기존 PTY resume 토큰이 있으면 새 PTY 세션 생성에 넘긴다. */
  resumeToken?: string | null;
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
  /** direct runtime 시작/재개 후 provider id·capability 메타를 session별로 반영한다. */
  onSessionAgentRuntimeMetadataChange?: (
    sessionId: string,
    metadata: AgentRuntimeMetadata,
  ) => void | Promise<void>;
  /** direct runtime status를 session별 live UI 상태로 반영한다. */
  onSessionAgentRuntimeStatusChange?: (
    sessionId: string,
    status: AgentSessionStatus,
  ) => void | Promise<void>;
  /** direct runtime provider title 갱신을 session별 live title로 반영한다. */
  onSessionTitleChange?: (sessionId: string, title: string | null) => void | Promise<void>;
  /** direct runtime spawn/initialize 실패 시 legacy PTY 새 세션으로 전환(10 §4.6). */
  onSessionFallbackToPty?: (request: SessionFallbackToPtyRequest) => void | Promise<void>;
}

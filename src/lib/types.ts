import type { AgentId } from "./agents";
import type { ThemePack } from "./themes";
import type {
  AgentRuntimeMetadata,
  SessionRuntimeKind,
} from "./features/agent-runtime/contracts/metadata";

export type SupportedLocale = "en" | "ko";
export type LanguagePreference = "system" | SupportedLocale;
export type FileOpenMode = "default" | "picker";
export type FileOpenTarget = "internal" | "external";
export type SessionViewMode = "terminal" | "editor";
export type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends object
    ? T[K] extends Date | RegExp | Array<unknown> | Function
      ? T[K]
      : DeepPartial<T[K]>
    : T[K];
};

export interface EditorTabRef {
  wslPath: string;
  line?: number | null;
  column?: number | null;
}

export interface SessionCore {
  id: string;
  agentId: AgentId;
  resumeToken: string | null;
  title: string;
  pinned: boolean;
  locked: boolean;
  distro: string;
  workDir: string;
  /**
   * 세션 host 종류(15 §7.2). 미지정/`"pty"`는 기존 terminal host, `"direct-*"`는 direct agent runtime host.
   * SessionViewMode와는 별개 축이다(viewMode=surface 토글, runtimeKind=host 종류).
   */
  runtimeKind?: SessionRuntimeKind;
  /**
   * direct runtime 재개·복원용 메타(15 §7.2). transcript 전체는 저장하지 않는다.
   * 비밀 필드(providerSessionId/providerThreadId/providerResumeToken)는 저장 직전 scrub(10 §6).
   */
  agentRuntime?: AgentRuntimeMetadata;
}

export interface SessionShellRuntimeState {
  ptyId: number;
  auxPtyId: number;
  auxVisible: boolean;
  auxHeightPercent: number | null;
}

export interface SessionEditorSnapshot {
  viewMode: SessionViewMode;
  editorRootDir: string;
  openEditorTabs: EditorTabRef[];
  activeEditorPath: string | null;
}

export interface SessionEditorState extends SessionEditorSnapshot {
  dirtyPaths: string[];
}

export type SessionPersistedState =
  & SessionCore
  & SessionShellRuntimeState
  & SessionEditorSnapshot;

export type Session = SessionPersistedState & Pick<SessionEditorState, "dirtyPaths">;

export interface WindowPlacement {
  monitor: string | null;
  x: number;
  y: number;
  width: number;
  height: number;
  maximized: boolean;
}

export interface InterfaceSettings {
  theme: string;
  uiScale: number;
  uiFontFamily: string;
  uiFontFamilyFallback: string;
  windowDefaultCols: number;
  windowDefaultRows: number;
  fileOpenMode: FileOpenMode;
  fileOpenTarget: FileOpenTarget;
  defaultEditorId: string;
}

export interface TerminalSettings {
  fontFamily: string;
  fontFamilyFallback: string;
  fontSize: number;
  renderer: TerminalRendererPreference;
  claudeFooterGhostingMitigation: boolean;
  claudeCliFlags: ClaudeCliFlagsSettings;
  claudeTui: ClaudeTuiPreference;
  scrollback: number;
  draftMaxRows: number;
  auxTerminalShortcut: string;
  auxTerminalDefaultHeight: number;
}

export interface EditorSettings {
  fontFamily: string;
  fontFamilyFallback: string;
  fontSize: number;
}

export interface ClaudeCliFlagsSettings {
  enableAutoMode: boolean;
}

export type TerminalRendererPreference = "dom" | "webgl";

export type ClaudeTuiPreference = "auto" | "fullscreen" | "default";

export interface WorkspaceSettings {
  defaultAgentId: AgentId;
  defaultDistro: string;
  defaultStartPathsByDistro: Record<string, string>;
}

export interface HistorySettings {
  tabLimit: number;
}

export interface Settings {
  language: LanguagePreference;
  interface: InterfaceSettings;
  workspace: WorkspaceSettings;
  terminal: TerminalSettings;
  editor: EditorSettings;
  history: HistorySettings;
  mainWindow: WindowPlacement | null;
}

export interface TabHistoryEntry {
  agentId: AgentId;
  distro: string;
  workDir: string;
  title: string;
  resumeToken?: string | null;
  lastOpenedAt: string;
}

export interface WorkspaceTabSnapshot {
  sessionId: string;
  agentId: AgentId;
  distro: string;
  workDir: string;
  title: string;
  pinned: boolean;
  locked: boolean;
  resumeToken?: string | null;
  ptyId?: number | null;
  auxPtyId?: number | null;
  auxVisible?: boolean;
  auxHeightPercent?: number | null;
  viewMode?: SessionViewMode;
  editorRootDir?: string;
  openEditorTabs?: EditorTabRef[];
  activeEditorPath?: string | null;
  /** 세션 host 종류(15 §7.2). 부재 시 복원 정규화에서 "pty"로 취급. */
  runtimeKind?: SessionRuntimeKind;
  /** direct runtime 재개·복원용 메타(15 §7.2). transcript 전체는 저장하지 않는다. */
  agentRuntime?: AgentRuntimeMetadata;
}

export interface WorkspaceWindowSnapshot {
  label: string;
  name: string;
  role: "main" | "secondary";
  tabs: WorkspaceTabSnapshot[];
  activeSessionId: string | null;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  maximized?: boolean;
}

export interface WorkspaceSnapshot {
  windows: WorkspaceWindowSnapshot[];
}

export interface AppBootstrap {
  settings: DeepPartial<Settings> | null;
  tabHistory: TabHistoryEntry[];
  workspace: WorkspaceSnapshot | null;
  themePack: ThemePack | null;
  testMode: boolean;
  debugTerminalHooks: boolean;
  softFollowExperiment: boolean | null;
}

export const DEFAULT_SETTINGS: Settings = {
  language: "system",
  interface: {
    theme: "dracula",
    uiScale: 100,
    uiFontFamily: "Pretendard, Segoe UI, system-ui",
    uiFontFamilyFallback: "Malgun Gothic, Apple SD Gothic Neo, sans-serif",
    windowDefaultCols: 120,
    windowDefaultRows: 36,
    fileOpenMode: "picker",
    fileOpenTarget: "external",
    defaultEditorId: "",
  },
  workspace: {
    defaultAgentId: "claude",
    defaultDistro: "",
    defaultStartPathsByDistro: {},
  },
  terminal: {
    fontFamily: "JetBrains Mono, Cascadia Code, Consolas",
    fontFamilyFallback: "Malgun Gothic, NanumGothicCoding, monospace",
    fontSize: 14,
    renderer: "dom",
    claudeFooterGhostingMitigation: true,
    claudeCliFlags: {
      enableAutoMode: true,
    },
    claudeTui: "auto",
    scrollback: 10000,
    draftMaxRows: 5,
    auxTerminalShortcut: "Ctrl+`",
    auxTerminalDefaultHeight: 28,
  },
  editor: {
    fontFamily: "JetBrains Mono, Cascadia Code, Consolas",
    fontFamilyFallback: "Malgun Gothic, NanumGothicCoding, monospace",
    fontSize: 14,
  },
  history: {
    tabLimit: 10,
  },
  mainWindow: null,
};

import type { Terminal } from "@xterm/xterm";
import type { AgentId } from "./agents";

export type SupportedLocale = "en" | "ko";
export type LanguagePreference = "system" | SupportedLocale;
export type FileOpenMode = "default" | "picker";
export type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends object
    ? T[K] extends Date | RegExp | Array<unknown> | Function
      ? T[K]
      : DeepPartial<T[K]>
    : T[K];
};

export interface Session {
  id: string;
  ptyId: number;
  agentId: AgentId;
  resumeToken: string | null;
  title: string;
  pinned: boolean;
  locked: boolean;
  terminal: Terminal | null;
  element: HTMLDivElement | null;
  distro: string;
  workDir: string;
}

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
  defaultEditorId: string;
}

export interface TerminalSettings {
  fontFamily: string;
  fontFamilyFallback: string;
  fontSize: number;
  scrollback: number;
  draftMaxRows: number;
}

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
  testMode: boolean;
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
    scrollback: 10000,
    draftMaxRows: 5,
  },
  history: {
    tabLimit: 10,
  },
  mainWindow: null,
};

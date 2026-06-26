export type AgentId = string;

export interface AgentIconConfig {
  type: "builtin" | "file" | "url";
  light?: string;
  dark?: string;
  monochrome?: string;
  fallbackText: string;
  sourceUrl?: string;
  licenseNote?: string;
}

/**
 * direct agent runtime(stdio JSON-RPC) 지원 capability(FE §10-7, 10 §5).
 * 이 플래그가 있으면 launcher에서 해당 agent를 direct runtime으로 생성할 수 있다.
 * provider는 backend resolve/adapter 선택의 기준이 된다(codex|claude).
 */
export interface AgentDirectRuntimeCapability {
  provider: "codex" | "claude";
}

export interface AgentDefinition {
  id: AgentId;
  label: string;
  shortLabel: string;
  supportsResume: boolean;
  resumeTokenLabel: string;
  icon: AgentIconConfig;
  /**
   * direct runtime 지원 여부(미설정이면 기존 PTY 전용 agent).
   * 설정 시 launcher가 direct runtime 선택지를 노출한다(10 §5 — 자동 승격 아님, 명시 선택).
   */
  directRuntime?: AgentDirectRuntimeCapability;
  buildStartCommand(options?: AgentCommandOptions): string;
  buildResumeCommand(token: string, options?: AgentCommandOptions): string;
}

export interface AgentCommandOptions {
  extraArgs?: readonly string[];
  envVars?: Readonly<Record<string, string>>;
}

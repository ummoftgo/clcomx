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

export interface AgentDefinition {
  id: AgentId;
  label: string;
  shortLabel: string;
  supportsResume: boolean;
  resumeTokenLabel: string;
  icon: AgentIconConfig;
  buildStartCommand(): string;
  buildResumeCommand(token: string): string;
}

import type { AgentDefinition, AgentId } from "./types";
import { getBuiltinAgentIcon } from "./icons";

function escapeShellSingleQuoted(value: string) {
  return value.replace(/'/g, "'\\''");
}

function shellQuote(value: string) {
  return `'${escapeShellSingleQuoted(value)}'`;
}

function joinShellCommand(parts: readonly string[]) {
  return parts.map(shellQuote).join(" ");
}

const BUILTIN_AGENTS: AgentDefinition[] = [
  {
    id: "claude",
    label: "Claude Code",
    shortLabel: "Claude",
    supportsResume: true,
    resumeTokenLabel: "Session ID",
    icon: getBuiltinAgentIcon("claude"),
    buildStartCommand(options) {
      return joinShellCommand(["claude", ...(options?.extraArgs ?? [])]);
    },
    buildResumeCommand(token: string, options) {
      return joinShellCommand(["claude", "--resume", token, ...(options?.extraArgs ?? [])]);
    },
  },
  {
    id: "codex",
    label: "Codex",
    shortLabel: "Codex",
    supportsResume: true,
    resumeTokenLabel: "Session ID",
    icon: getBuiltinAgentIcon("codex"),
    buildStartCommand(options) {
      return joinShellCommand(["codex", ...(options?.extraArgs ?? [])]);
    },
    buildResumeCommand(token: string, options) {
      return joinShellCommand(["codex", "resume", token, ...(options?.extraArgs ?? [])]);
    },
  },
];

const AGENT_MAP = new Map(BUILTIN_AGENTS.map((agent) => [agent.id, agent]));

function titleCase(value: string) {
  return value
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((segment) => segment[0].toUpperCase() + segment.slice(1))
    .join(" ");
}

export function getBuiltinAgents() {
  return BUILTIN_AGENTS;
}

export function getAgentDefinition(agentId: AgentId): AgentDefinition {
  const builtin = AGENT_MAP.get(agentId);
  if (builtin) {
    return builtin;
  }

  const label = titleCase(agentId);
  return {
    id: agentId,
    label,
    shortLabel: label,
    supportsResume: false,
    resumeTokenLabel: "Session ID",
    icon: getBuiltinAgentIcon(agentId),
    buildStartCommand(options) {
      return joinShellCommand([agentId, ...(options?.extraArgs ?? [])]);
    },
    buildResumeCommand(token: string, options) {
      return joinShellCommand([agentId, "--resume", token, ...(options?.extraArgs ?? [])]);
    },
  };
}

export function getAgentLabel(agentId: AgentId) {
  return getAgentDefinition(agentId).label;
}

export function getAgentShortLabel(agentId: AgentId) {
  return getAgentDefinition(agentId).shortLabel;
}

export function summarizeResumeToken(token: string | null | undefined, maxLength = 20) {
  const normalized = token?.trim();
  if (!normalized) return null;
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength - 1)}…`;
}

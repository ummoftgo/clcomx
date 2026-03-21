import type { AgentDefinition, AgentId } from "./types";
import { getBuiltinAgentIcon } from "./icons";

const BUILTIN_AGENTS: AgentDefinition[] = [
  {
    id: "claude",
    label: "Claude Code",
    shortLabel: "Claude",
    supportsResume: true,
    resumeTokenLabel: "Session ID",
    icon: getBuiltinAgentIcon("claude"),
    buildStartCommand() {
      return "claude";
    },
    buildResumeCommand(token: string) {
      return `claude --resume '${token}'`;
    },
  },
  {
    id: "codex",
    label: "Codex",
    shortLabel: "Codex",
    supportsResume: true,
    resumeTokenLabel: "Session ID",
    icon: getBuiltinAgentIcon("codex"),
    buildStartCommand() {
      return "codex";
    },
    buildResumeCommand(token: string) {
      return `codex resume '${token}'`;
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
    buildStartCommand() {
      return agentId;
    },
    buildResumeCommand(token: string) {
      return `${agentId} --resume '${token}'`;
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

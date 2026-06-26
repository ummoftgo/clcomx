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

function assertValidEnvKey(key: string) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
    throw new Error(`Invalid environment variable name: ${key}`);
  }
}

function buildEnvPrefix(envVars?: Readonly<Record<string, string>>) {
  const entries = Object.entries(envVars ?? {});
  if (entries.length === 0) {
    return "";
  }
  return entries.map(([key, value]) => {
    assertValidEnvKey(key);
    return `${key}=${shellQuote(value)}`;
  }).join(" ") + " ";
}

const BUILTIN_AGENTS: AgentDefinition[] = [
  {
    id: "claude",
    label: "Claude Code",
    shortLabel: "Claude",
    supportsResume: true,
    resumeTokenLabel: "Session ID",
    icon: getBuiltinAgentIcon("claude"),
    directRuntime: { provider: "claude" },
    buildStartCommand(options) {
      return buildEnvPrefix(options?.envVars) + joinShellCommand(["claude", ...(options?.extraArgs ?? [])]);
    },
    buildResumeCommand(token: string, options) {
      return (
        buildEnvPrefix(options?.envVars) +
        joinShellCommand(["claude", "--resume", token, ...(options?.extraArgs ?? [])])
      );
    },
  },
  {
    id: "codex",
    label: "Codex",
    shortLabel: "Codex",
    supportsResume: true,
    resumeTokenLabel: "Session ID",
    icon: getBuiltinAgentIcon("codex"),
    directRuntime: { provider: "codex" },
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
      return buildEnvPrefix(options?.envVars) + joinShellCommand([agentId, ...(options?.extraArgs ?? [])]);
    },
    buildResumeCommand(token: string, options) {
      return (
        buildEnvPrefix(options?.envVars) +
        joinShellCommand([agentId, "--resume", token, ...(options?.extraArgs ?? [])])
      );
    },
  };
}

export function getAgentLabel(agentId: AgentId) {
  return getAgentDefinition(agentId).label;
}

export function getAgentShortLabel(agentId: AgentId) {
  return getAgentDefinition(agentId).shortLabel;
}

/**
 * agent가 direct runtime을 지원하는지 여부(FE §10-7).
 * launcher가 direct 토글 노출 여부를 결정할 때 사용한다.
 */
export function agentSupportsDirectRuntime(agentId: AgentId): boolean {
  return getAgentDefinition(agentId).directRuntime !== undefined;
}

/**
 * agentId + direct 선택 여부를 SessionRuntimeKind("pty"|"direct-codex"|"direct-claude")로 매핑한다(10 §5).
 * - useDirect=false이거나 agent가 direct 미지원이면 "pty"(기존 경로, 자동 승격 없음).
 * - direct 지원 + useDirect=true면 provider에 따라 "direct-codex"/"direct-claude".
 * 반환 타입을 좁은 문자열 union으로 두어 호출부가 그대로 buildSession.runtimeKind에 넘긴다.
 */
export function resolveRuntimeKind(
  agentId: AgentId,
  useDirect: boolean,
): "pty" | "direct-codex" | "direct-claude" {
  if (!useDirect) return "pty";
  const capability = getAgentDefinition(agentId).directRuntime;
  if (!capability) return "pty";
  return capability.provider === "codex" ? "direct-codex" : "direct-claude";
}

export function summarizeResumeToken(token: string | null | undefined, maxLength = 20) {
  const normalized = token?.trim();
  if (!normalized) return null;
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength - 1)}…`;
}

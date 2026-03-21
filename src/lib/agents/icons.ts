import type { AgentIconConfig, AgentId } from "./types";

const BUILTIN_AGENT_ICONS: Record<string, AgentIconConfig> = {
  claude: {
    type: "builtin",
    fallbackText: "Cl",
    sourceUrl: "https://claude.com/product/overview",
    licenseNote: "Anthropic product page reference. Replace with official asset files when available.",
  },
  codex: {
    type: "builtin",
    fallbackText: "Cx",
    sourceUrl: "https://openai.com/brand/",
    licenseNote: "OpenAI brand page reference. Replace with official asset files when available.",
  },
};

export function getBuiltinAgentIcon(agentId: AgentId): AgentIconConfig {
  return BUILTIN_AGENT_ICONS[agentId] ?? {
    type: "builtin",
    fallbackText: agentId.slice(0, 2).toUpperCase(),
  };
}


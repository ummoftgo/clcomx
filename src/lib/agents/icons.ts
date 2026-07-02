import type { AgentIconConfig, AgentId } from "./types";

const BUILTIN_AGENT_ICONS: Record<string, AgentIconConfig> = {
  claude: {
    type: "builtin",
    fallbackText: "Cl",
    sourceUrl: "https://claude.com/product/overview",
    licenseNote: "Product page reference only; CLCOMX bundles no Claude logo asset.",
  },
  codex: {
    type: "builtin",
    fallbackText: "Cx",
    sourceUrl: "https://openai.com/brand/",
    licenseNote: "Brand page reference only; CLCOMX bundles no Codex logo asset.",
  },
};

export function getBuiltinAgentIcon(agentId: AgentId): AgentIconConfig {
  return BUILTIN_AGENT_ICONS[agentId] ?? {
    type: "builtin",
    fallbackText: agentId.slice(0, 2).toUpperCase(),
  };
}

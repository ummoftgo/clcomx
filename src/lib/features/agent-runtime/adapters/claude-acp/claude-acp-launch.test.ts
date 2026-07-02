/**
 * Claude ACP launch params 테스트 — env는 non-secret만 전달한다(09 §5.3).
 */

import { describe, expect, it } from "vitest";
import { buildClaudeAcpLaunchParams } from "./claude-acp-launch";

describe("buildClaudeAcpLaunchParams", () => {
  const base = {
    distro: "Ubuntu",
    workDir: "/home/u/proj",
    adapterEntryPath: "/opt/node_modules/@agentclientprotocol/claude-agent-acp/dist/index.js",
  };

  it("keeps non-secret env values in AgentRuntimeStartParams.env", () => {
    const params = buildClaudeAcpLaunchParams({
      ...base,
      env: { CLAUDE_CONFIG_DIR: "/home/u/.claude", NODE_OPTIONS: "--max-old-space-size=4096" },
    });

    expect(params).toMatchObject({
      transportKind: "jsonrpc-stdio",
      provider: "claude",
      args: [base.adapterEntryPath, "--hide-claude-auth"],
      env: { CLAUDE_CONFIG_DIR: "/home/u/.claude", NODE_OPTIONS: "--max-old-space-size=4096" },
    });
  });

  it("rejects secret-shaped env keys and values before runtime start", () => {
    expect(() =>
      buildClaudeAcpLaunchParams({
        ...base,
        env: { ANTHROPIC_AUTH_TOKEN: "anth-secret" },
      }),
    ).toThrow("secret env key");

    expect(() =>
      buildClaudeAcpLaunchParams({
        ...base,
        env: { CLAUDE_CONFIG_DIR: "sk-ant-secret-value" },
      }),
    ).toThrow("secret-looking env value");
  });
});

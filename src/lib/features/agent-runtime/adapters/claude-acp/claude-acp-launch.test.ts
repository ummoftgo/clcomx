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

  it("omits --hide-claude-auth only when subscription auth is explicitly allowed", () => {
    // 기본(미지정)은 보수 정책 유지 — 플래그 포함.
    expect(buildClaudeAcpLaunchParams(base)).toMatchObject({
      args: [base.adapterEntryPath, "--hide-claude-auth"],
    });
    expect(buildClaudeAcpLaunchParams({ ...base, allowSubscriptionAuth: false })).toMatchObject({
      args: [base.adapterEntryPath, "--hide-claude-auth"],
    });

    // opt-in(true)일 때만 [entry] 단독 형태.
    expect(buildClaudeAcpLaunchParams({ ...base, allowSubscriptionAuth: true })).toMatchObject({
      args: [base.adapterEntryPath],
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

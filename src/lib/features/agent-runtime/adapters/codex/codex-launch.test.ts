/**
 * Codex launch params 테스트 — env는 non-secret만 전달한다(09 §5.3).
 */

import { describe, expect, it } from "vitest";
import { buildCodexStartParams } from "./codex-launch";

describe("buildCodexStartParams", () => {
  it("keeps non-secret env values in AgentRuntimeStartParams.env", () => {
    const params = buildCodexStartParams({
      distro: "Ubuntu",
      workDir: "/home/u/proj",
      extraEnv: { RUST_LOG: "info", CODEX_DISABLE_UPDATE_CHECK: "1" },
    });

    expect(params).toMatchObject({
      transportKind: "jsonrpc-stdio",
      provider: "codex",
      env: { RUST_LOG: "info", CODEX_DISABLE_UPDATE_CHECK: "1" },
    });
  });

  it("rejects secret-shaped env keys and values before runtime start", () => {
    expect(() =>
      buildCodexStartParams({
        distro: "Ubuntu",
        workDir: "/home/u/proj",
        extraEnv: { ANTHROPIC_API_KEY: "sk-ant-secret-value" },
      }),
    ).toThrow("secret env key");

    expect(() =>
      buildCodexStartParams({
        distro: "Ubuntu",
        workDir: "/home/u/proj",
        extraEnv: { RUST_LOG: "Bearer account-token-123" },
      }),
    ).toThrow("secret-looking env value");
  });
});

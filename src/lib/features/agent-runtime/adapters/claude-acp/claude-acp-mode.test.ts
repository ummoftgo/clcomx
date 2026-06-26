/**
 * Claude ACP — mode / set_config_option wire 생성 단위 테스트(11 §4, §8).
 */
import { describe, expect, it } from "vitest";
import { buildSetConfigOption, buildSetMode, CLAUDE_SESSION_MODES } from "./claude-acp-mode";

describe("buildSetMode / buildSetConfigOption (§8)", () => {
  it("6 modes 정의", () => {
    expect(CLAUDE_SESSION_MODES).toEqual(["auto", "default", "acceptEdits", "bypassPermissions", "dontAsk", "plan"]);
  });

  it("session/set_mode wire", () => {
    expect(buildSetMode(3, "s1", "plan")).toEqual({
      jsonrpc: "2.0",
      id: 3,
      method: "session/set_mode",
      params: { sessionId: "s1", modeId: "plan" },
    });
  });

  it("session/set_config_option wire", () => {
    expect(buildSetConfigOption(4, "s1", "model", "opus")).toEqual({
      jsonrpc: "2.0",
      id: 4,
      method: "session/set_config_option",
      params: { sessionId: "s1", configId: "model", value: "opus" },
    });
  });
});

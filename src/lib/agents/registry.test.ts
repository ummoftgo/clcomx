import { describe, expect, it } from "vitest";
import { getAgentDefinition } from "./registry";

describe("agent registry", () => {
  it("builds Claude start and resume commands with shared extra args", () => {
    const agent = getAgentDefinition("claude");
    const options = { extraArgs: ["--enable-auto-mode"] };

    expect(agent.buildStartCommand(options)).toBe("'claude' '--enable-auto-mode'");
    expect(agent.buildResumeCommand("session-123", options)).toBe(
      "'claude' '--resume' 'session-123' '--enable-auto-mode'",
    );
  });

  it("prefixes Claude commands with validated environment variables", () => {
    const agent = getAgentDefinition("claude");
    const options = { envVars: { CLAUDE_CODE_NO_FLICKER: "1" } };

    expect(agent.buildStartCommand(options)).toBe("CLAUDE_CODE_NO_FLICKER='1' 'claude'");
    expect(agent.buildResumeCommand("session-123", options)).toBe(
      "CLAUDE_CODE_NO_FLICKER='1' 'claude' '--resume' 'session-123'",
    );
  });

  it("rejects invalid environment variable names", () => {
    const agent = getAgentDefinition("claude");

    expect(() => agent.buildStartCommand({ envVars: { "BAD KEY": "1" } })).toThrow(
      "Invalid environment variable name",
    );
  });

  it("keeps Codex resume commands unchanged without extra args", () => {
    const agent = getAgentDefinition("codex");

    expect(agent.buildStartCommand()).toBe("'codex'");
    expect(agent.buildResumeCommand("session-123")).toBe("'codex' 'resume' 'session-123'");
  });
});

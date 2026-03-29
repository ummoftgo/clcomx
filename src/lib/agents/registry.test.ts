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

  it("keeps Codex resume commands unchanged without extra args", () => {
    const agent = getAgentDefinition("codex");

    expect(agent.buildStartCommand()).toBe("'codex'");
    expect(agent.buildResumeCommand("session-123")).toBe("'codex' 'resume' 'session-123'");
  });
});

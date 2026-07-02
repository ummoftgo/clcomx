import { describe, expect, it } from "vitest";
import {
  agentSupportsDirectRuntime,
  getAgentDefinition,
  resolveRuntimeKind,
} from "./registry";

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

  it("keeps built-in icon metadata free of official product logo assets", () => {
    for (const agentId of ["claude", "codex"]) {
      const icon = getAgentDefinition(agentId).icon;

      expect(icon.light).toBeUndefined();
      expect(icon.dark).toBeUndefined();
      expect(icon.monochrome).toBeUndefined();
      expect(icon.licenseNote ?? "").not.toMatch(/official .*asset/i);
    }
  });
});

describe("agent direct runtime capability", () => {
  it("marks codex and claude as direct-runtime capable with provider", () => {
    expect(getAgentDefinition("codex").directRuntime).toEqual({ provider: "codex" });
    expect(getAgentDefinition("claude").directRuntime).toEqual({ provider: "claude" });
    expect(agentSupportsDirectRuntime("codex")).toBe(true);
    expect(agentSupportsDirectRuntime("claude")).toBe(true);
  });

  it("treats unknown/PTY-only agents as direct-unsupported (default pty)", () => {
    // 미등록 agent는 default factory가 directRuntime 미설정으로 반환한다.
    expect(getAgentDefinition("some-custom-agent").directRuntime).toBeUndefined();
    expect(agentSupportsDirectRuntime("some-custom-agent")).toBe(false);
  });

  it("resolves runtimeKind from agent + direct toggle", () => {
    expect(resolveRuntimeKind("codex", true)).toBe("direct-codex");
    expect(resolveRuntimeKind("claude", true)).toBe("direct-claude");
    // 토글 off면 항상 pty(자동 승격 없음, 10 §5).
    expect(resolveRuntimeKind("codex", false)).toBe("pty");
    expect(resolveRuntimeKind("claude", false)).toBe("pty");
    // direct 미지원 agent는 토글이 켜져도 pty로 폴백.
    expect(resolveRuntimeKind("some-custom-agent", true)).toBe("pty");
  });
});

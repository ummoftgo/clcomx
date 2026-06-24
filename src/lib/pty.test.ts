import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  invokeMock: vi.fn(async () => 123),
}));

vi.mock("./tauri/core", () => ({
  invoke: mocks.invokeMock,
}));

import { resolvePtyHomeDir, spawnPty } from "./pty";
import { initializeSettings } from "./stores/settings.svelte";

describe("spawnPty", () => {
  function lastSpawnCommand() {
    const call = mocks.invokeMock.mock.calls[mocks.invokeMock.mock.calls.length - 1] as unknown as [unknown, {
      command: string;
      args: string[];
    }];
    const payload = call[1];
    return String(payload.args[payload.args.length - 1] ?? "");
  }

  it("emits a one-shot HOME metadata marker before launching the shell", async () => {
    await spawnPty(120, 40, "codex", "Ubuntu-24.04", "/home/tester/workspace", null);

    expect(mocks.invokeMock).toHaveBeenCalledTimes(1);
    const call = mocks.invokeMock.mock.calls[0] as unknown as [unknown, {
      command: string;
      args: string[];
    }];
    const payload = call[1];
    expect(payload.command).toBe("wsl.exe");
    expect(payload.args).toContain("-c");
    const command = String(payload.args[payload.args.length - 1] ?? "");
    expect(command).toContain("CLCOMX_HOME");
    expect(command).toContain("printf '\\033]633;CLCOMX_HOME;%s\\007'");
    expect(command).toContain("cd '/home/tester/workspace'");
  });

  it("maps Claude TUI settings to launch environment variables", async () => {
    initializeSettings({
      terminal: {
        claudeCliFlags: {
          enableAutoMode: false,
        },
        claudeTui: "auto",
      },
    });
    await spawnPty(120, 40, "claude", "Ubuntu-24.04", "/home/tester/workspace", null);
    expect(lastSpawnCommand()).toContain("cd '/home/tester/workspace' && 'claude'");
    expect(lastSpawnCommand()).not.toContain("CLAUDE_CODE_NO_FLICKER");

    initializeSettings({
      terminal: {
        claudeCliFlags: {
          enableAutoMode: false,
        },
        claudeTui: "fullscreen",
      },
    });
    await spawnPty(120, 40, "claude", "Ubuntu-24.04", "/home/tester/workspace", null);
    expect(lastSpawnCommand()).toContain("CLAUDE_CODE_NO_FLICKER='1' 'claude'");

    initializeSettings({
      terminal: {
        claudeCliFlags: {
          enableAutoMode: false,
        },
        claudeTui: "default",
      },
    });
    await spawnPty(120, 40, "claude", "Ubuntu-24.04", "/home/tester/workspace", null);
    expect(lastSpawnCommand()).toContain("CLAUDE_CODE_NO_FLICKER='0' 'claude'");
  });
});


describe("resolvePtyHomeDir", () => {
  it("prefers the current shell homeDir and falls back to snapshot homeDir when empty", () => {
    expect(resolvePtyHomeDir("  /home/live  ", "/home/snapshot")).toBe("/home/live");
    expect(resolvePtyHomeDir("", " /home/snapshot ")).toBe("/home/snapshot");
    expect(resolvePtyHomeDir(null, null)).toBeNull();
  });
});

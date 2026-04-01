import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  invokeMock: vi.fn(async () => 123),
}));

vi.mock("./tauri/core", () => ({
  invoke: mocks.invokeMock,
}));

import { resolvePtyHomeDir, spawnPty } from "./pty";

describe("spawnPty", () => {
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
});


describe("resolvePtyHomeDir", () => {
  it("prefers the current shell homeDir and falls back to snapshot homeDir when empty", () => {
    expect(resolvePtyHomeDir("  /home/live  ", "/home/snapshot")).toBe("/home/live");
    expect(resolvePtyHomeDir("", " /home/snapshot ")).toBe("/home/snapshot");
    expect(resolvePtyHomeDir(null, null)).toBeNull();
  });
});

import { describe, expect, it } from "vitest";
import { invokeMock, resetTauriMocks } from "../test/mocks/tauri";
import { recordTabHistoryEntry } from "./tab-history";

describe("recordTabHistoryEntry", () => {
  it("scrubs resume tokens while preserving direct runtime history kind", async () => {
    resetTauriMocks();

    await recordTabHistoryEntry(
      "codex",
      "Ubuntu-24.04",
      "/home/user/work/project",
      "Direct session",
      "provider-resume-secret",
      "direct-codex",
    );

    expect(invokeMock).toHaveBeenCalledWith("record_tab_history", {
      agentId: "codex",
      distro: "Ubuntu-24.04",
      workDir: "/home/user/work/project",
      title: "Direct session",
      resumeToken: null,
      runtimeKind: "direct-codex",
    });
  });

  it("does not persist pty runtimeKind markers", async () => {
    resetTauriMocks();

    await recordTabHistoryEntry(
      "claude",
      "Ubuntu-24.04",
      "/home/user/work/project",
      "PTY session",
      "legacy-resume-secret",
      "pty",
    );

    expect(invokeMock).toHaveBeenCalledWith("record_tab_history", {
      agentId: "claude",
      distro: "Ubuntu-24.04",
      workDir: "/home/user/work/project",
      title: "PTY session",
      resumeToken: null,
      runtimeKind: undefined,
    });
  });
});

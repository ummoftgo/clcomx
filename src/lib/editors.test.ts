import { describe, expect, it } from "vitest";
import {
  readSessionFile,
  resolveTerminalPath,
  searchSessionFiles,
  writeSessionFile,
} from "./editors";
import { invokeMock, resetTauriMocks } from "../test/mocks/tauri";

describe("resolveTerminalPath session-aware contract", () => {
  it("forwards sessionId and homeDirHint when provided", async () => {
    resetTauriMocks();

    await resolveTerminalPath(
      "~/.claude/skills/code-quality-review/SKILL.md",
      "Ubuntu-24.04",
      "/home/user/work/project",
      "session-123",
      "/home/user",
    );

    expect(invokeMock).toHaveBeenCalledWith(
      "resolve_terminal_path",
      expect.objectContaining({
        raw: "~/.claude/skills/code-quality-review/SKILL.md",
        distro: "Ubuntu-24.04",
        workDir: "/home/user/work/project",
        sessionId: "session-123",
        homeDirHint: "/home/user",
      }),
    );
  });
});

describe("editor file command wrappers", () => {
  it("forwards quick open search arguments", async () => {
    resetTauriMocks();

    await searchSessionFiles("session-123", "/home/user/work/project", "app", 25);

    expect(invokeMock).toHaveBeenCalledWith("search_session_files", {
      sessionId: "session-123",
      rootDir: "/home/user/work/project",
      query: "app",
      limit: 25,
    });
  });

  it("forwards read arguments", async () => {
    resetTauriMocks();

    await readSessionFile("session-123", "/home/user/work/project/src/App.svelte");

    expect(invokeMock).toHaveBeenCalledWith("read_session_file", {
      sessionId: "session-123",
      wslPath: "/home/user/work/project/src/App.svelte",
    });
  });

  it("forwards write arguments", async () => {
    resetTauriMocks();
    invokeMock.mockResolvedValueOnce({
      wslPath: "/home/user/work/project/src/App.svelte",
      sizeBytes: 10,
      mtimeMs: 1235,
    });

    await writeSessionFile(
      "session-123",
      "/home/user/work/project/src/App.svelte",
      "<script />",
      1234,
    );

    expect(invokeMock).toHaveBeenCalledWith("write_session_file", {
      sessionId: "session-123",
      wslPath: "/home/user/work/project/src/App.svelte",
      content: "<script />",
      expectedMtimeMs: 1234,
    });
  });
});

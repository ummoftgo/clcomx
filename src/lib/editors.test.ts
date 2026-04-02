import { describe, expect, it } from "vitest";
import { resolveTerminalPath } from "./editors";
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

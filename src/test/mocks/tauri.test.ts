import { describe, expect, it } from "vitest";
import { invokeMock, resetTauriMocks } from "./tauri";

describe("tauri invoke mock resolve_terminal_path", () => {
  it("returns candidates for bare filenames", async () => {
    resetTauriMocks();
    const result = await invokeMock("resolve_terminal_path", {
      raw: "index.ts",
      sessionId: "session-a",
    });

    expect(result).toMatchObject({
      kind: "candidates",
      raw: "index.ts",
    });
    expect((result as { candidates: unknown[] }).candidates).toHaveLength(2);
  });

  it("resolves home-relative paths using the supplied homeDirHint", async () => {
    resetTauriMocks();
    const result = await invokeMock("resolve_terminal_path", {
      raw: "~/.claude/skills/code-quality-review/SKILL.md",
      sessionId: "session-b",
      homeDirHint: "/home/tester",
    });

    expect(result).toMatchObject({
      kind: "resolved",
      path: {
        raw: "~/.claude/skills/code-quality-review/SKILL.md",
        wslPath: "/home/tester/.claude/skills/code-quality-review/SKILL.md",
      },
    });
  });
});

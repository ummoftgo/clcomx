import { describe, expect, it } from "vitest";
import { previewInvoke } from "./runtime";

describe("previewInvoke resolve_terminal_path", () => {
  it("returns candidates for bare filenames", async () => {
    const result = await previewInvoke<{
      kind: "candidates" | "resolved";
      candidates?: unknown[];
    }>("resolve_terminal_path", { raw: "index.ts", sessionId: "preview-a" });

    expect(result.kind).toBe("candidates");
    expect(result.candidates).toHaveLength(2);
  });

  it("returns a resolved path for normal terminal tokens", async () => {
    const result = await previewInvoke<{
      kind: "candidates" | "resolved";
      path?: { wslPath: string };
    }>("resolve_terminal_path", {
      raw: "src/App.svelte:12:3",
      sessionId: "preview-b",
    });

    expect(result.kind).toBe("resolved");
    expect(result.path?.wslPath).toContain("/src/App.svelte");
  });

  it("resolves home-relative paths using the supplied homeDirHint", async () => {
    const result = await previewInvoke<{
      kind: "candidates" | "resolved";
      path?: { wslPath: string; copyText: string };
    }>("resolve_terminal_path", {
      raw: "~/.claude/skills/code-quality-review/SKILL.md",
      sessionId: "preview-c",
      homeDirHint: "/home/user",
    });

    expect(result.kind).toBe("resolved");
    expect(result.path?.wslPath).toBe("/home/user/.claude/skills/code-quality-review/SKILL.md");
    expect(result.path?.copyText).toBe("/home/user/.claude/skills/code-quality-review/SKILL.md");
  });
});

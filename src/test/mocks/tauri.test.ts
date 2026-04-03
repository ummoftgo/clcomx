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

describe("tauri invoke mock editor commands", () => {
  it("returns basename-ranked search results rooted to the requested directory", async () => {
    resetTauriMocks();
    const result = await invokeMock("search_session_files", {
      sessionId: "session-editor",
      rootDir: "/home/tester/workspace",
      query: "editor",
      limit: 10,
    });

    expect(result).toMatchObject({
      rootDir: "/home/tester/workspace",
    });
    expect((result as { results: Array<{ basename: string }> }).results).toMatchObject([
      { basename: "EditorQuickOpenModal.svelte" },
      { basename: "InternalEditor.svelte" },
    ]);
  });

  it("returns no mock editor results for an empty query", async () => {
    resetTauriMocks();
    const result = await invokeMock("search_session_files", {
      sessionId: "session-editor",
      rootDir: "/home/tester/workspace",
      query: "",
      limit: 10,
    });

    expect(result).toMatchObject({
      rootDir: "/home/tester/workspace",
      results: [],
    });
  });

  it("returns no quick-open results for an empty query", async () => {
    resetTauriMocks();
    const result = await invokeMock("search_session_files", {
      sessionId: "session-editor",
      rootDir: "/home/tester/workspace",
      query: "",
      limit: 10,
    });

    expect(result).toMatchObject({
      rootDir: "/home/tester/workspace",
      results: [],
    });
  });

  it("reads and writes mock editor files", async () => {
    resetTauriMocks();
    const before = await invokeMock("read_session_file", {
      sessionId: "session-editor",
      wslPath: "/home/tester/workspace/src/App.svelte",
    });

    expect(before).toMatchObject({
      languageId: "svelte",
      wslPath: "/home/tester/workspace/src/App.svelte",
    });

    const written = await invokeMock("write_session_file", {
      sessionId: "session-editor",
      wslPath: "/home/tester/workspace/src/App.svelte",
      content: "<!-- saved -->\n",
      expectedMtimeMs: (before as { mtimeMs: number }).mtimeMs,
    });

    expect((written as { mtimeMs: number }).mtimeMs).toBeGreaterThan(
      (before as { mtimeMs: number }).mtimeMs,
    );

    const after = await invokeMock("read_session_file", {
      sessionId: "session-editor",
      wslPath: "/home/tester/workspace/src/App.svelte",
    });

    expect((after as { content: string }).content).toContain("saved");
  });

  it("rejects stale mock file writes", async () => {
    resetTauriMocks();
    const before = await invokeMock("read_session_file", {
      sessionId: "session-editor",
      wslPath: "/home/user/work/project/src/App.svelte",
    });

    await expect(
      invokeMock("write_session_file", {
        sessionId: "session-editor",
        wslPath: "/home/user/work/project/src/App.svelte",
        content: "<!-- stale -->\n",
        expectedMtimeMs: (before as { mtimeMs: number }).mtimeMs - 1,
      }),
    ).rejects.toThrow("FileModifiedOnDisk");
  });
});

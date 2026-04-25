import { describe, expect, it } from "vitest";
import {
  applyPreviewPreset,
  getActivePreviewPresetId,
  getAvailablePreviewPresets,
  previewInvoke,
} from "./runtime";

describe("preview presets", () => {
  it("keeps preset selection and representative bootstrap shapes behind the runtime facade", async () => {
    expect(getAvailablePreviewPresets().map((preset) => preset.id)).toEqual([
      "workspace",
      "dense",
      "empty",
      "editor",
    ]);

    applyPreviewPreset("dense");
    expect(getActivePreviewPresetId()).toBe("dense");
    let bootstrap = await previewInvoke<{
      settings: { history: { tabLimit: number } };
      workspace: { windows: Array<{ tabs: unknown[] }> };
    }>("bootstrap_app");
    expect(bootstrap.settings.history.tabLimit).toBe(12);
    expect(bootstrap.workspace.windows[0]?.tabs.length).toBeGreaterThan(1);

    applyPreviewPreset("empty");
    expect(getActivePreviewPresetId()).toBe("empty");
    bootstrap = await previewInvoke<typeof bootstrap>("bootstrap_app");
    expect(bootstrap.workspace.windows[0]?.tabs).toEqual([]);

    applyPreviewPreset("editor");
    expect(getActivePreviewPresetId()).toBe("editor");
    const editorBootstrap = await previewInvoke<{
      settings: { interface: { fileOpenTarget?: string } };
      workspace: {
        windows: Array<{
          activeSessionId: string | null;
          tabs: Array<{ sessionId: string; viewMode?: string }>;
        }>;
      };
    }>("bootstrap_app");
    const mainWindow = editorBootstrap.workspace.windows[0];
    const activeTab = mainWindow.tabs.find((tab) => tab.sessionId === mainWindow.activeSessionId);
    expect(editorBootstrap.settings.interface.fileOpenTarget).toBe("internal");
    expect(activeTab?.viewMode).toBe("editor");
  });
});

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

describe("previewInvoke editor commands", () => {
  it("includes an editor-focused preset", () => {
    expect(getAvailablePreviewPresets().map((preset) => preset.id)).toContain("editor");
  });

  it("returns editor-first workspace data for the editor preset", async () => {
    const presetBootstrap = applyPreviewPreset("editor");

    const bootstrap = await previewInvoke<{
      settings: {
        interface: {
          fileOpenTarget?: string;
        };
      };
      workspace: {
        windows: Array<{
          activeSessionId: string | null;
          tabs: Array<{
            sessionId: string;
            viewMode?: string;
            activeEditorPath?: string | null;
            openEditorTabs?: Array<{ wslPath: string }>;
          }>;
        }>;
      };
    }>("bootstrap_app");

    const mainWindow = bootstrap.workspace.windows[0];
    const activeTab = mainWindow.tabs.find((tab) => tab.sessionId === mainWindow.activeSessionId);

    expect(presetBootstrap.settings?.interface?.fileOpenTarget).toBe("internal");
    expect(bootstrap.settings.interface.fileOpenTarget).toBe("internal");
    expect(activeTab?.viewMode).toBe("editor");
    expect(activeTab?.activeEditorPath).toContain("/src/App.svelte");
    expect(activeTab?.openEditorTabs).toHaveLength(2);
  });

  it("searches preview editor files with basename-ranked results", async () => {
    applyPreviewPreset("editor");

    const result = await previewInvoke<{
      rootDir: string;
      results: Array<{ basename: string; relativePath: string }>;
    }>("search_session_files", {
      sessionId: "preview-editor",
      rootDir: "/home/user/work/project",
      query: "editor",
      limit: 10,
    });

    expect(result.rootDir).toBe("/home/user/work/project");
    expect(result.results[0]).toMatchObject({
      basename: "EditorQuickOpenModal.svelte",
      relativePath: "src/lib/components/EditorQuickOpenModal.svelte",
    });
    expect(result.results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          basename: "InternalEditor.svelte",
          relativePath: "src/lib/components/InternalEditor.svelte",
        }),
      ]),
    );
  });

  it("keeps prefix matches ahead of substring matches in preview editor search", async () => {
    applyPreviewPreset("editor");

    const result = await previewInvoke<{
      results: Array<{ basename: string; relativePath: string }>;
    }>("search_session_files", {
      sessionId: "preview-editor",
      rootDir: "/home/user/work/project",
      query: "editor",
      limit: 10,
    });

    expect(result.results[0]).toMatchObject({
      basename: "EditorQuickOpenModal.svelte",
      relativePath: "src/lib/components/EditorQuickOpenModal.svelte",
    });
    expect(result.results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          basename: "InternalEditor.svelte",
          relativePath: "src/lib/components/InternalEditor.svelte",
        }),
      ]),
    );
  });

  it("returns no preview editor results for an empty query", async () => {
    applyPreviewPreset("editor");

    const result = await previewInvoke<{
      rootDir: string;
      results: Array<{ basename: string }>;
    }>("search_session_files", {
      sessionId: "preview-editor",
      rootDir: "/home/user/work/project",
      query: "",
      limit: 10,
    });

    expect(result.rootDir).toBe("/home/user/work/project");
    expect(result.results).toEqual([]);
  });

  it("returns no results for empty quick-open queries", async () => {
    applyPreviewPreset("editor");

    const result = await previewInvoke<{
      rootDir: string;
      results: Array<{ basename: string }>;
    }>("search_session_files", {
      sessionId: "preview-editor",
      rootDir: "/home/user/work/project",
      query: "",
      limit: 10,
    });

    expect(result.rootDir).toBe("/home/user/work/project");
    expect(result.results).toEqual([]);
  });

  it("returns cached list_session_files results until forceRefresh", async () => {
    applyPreviewPreset("editor");

    const first = await previewInvoke<{
      rootDir: string;
      results: Array<{ wslPath: string; relativePath: string; basename: string }>;
      lastUpdatedMs: number;
    }>("list_session_files", {
      sessionId: "preview-editor",
      rootDir: "/home/user/work/project",
    });

    const second = await previewInvoke<{
      rootDir: string;
      results: Array<{ wslPath: string; relativePath: string; basename: string }>;
      lastUpdatedMs: number;
    }>("list_session_files", {
      sessionId: "preview-editor",
      rootDir: "/home/user/work/project",
    });

    expect(first.rootDir).toBe("/home/user/work/project");
    expect(first.results.length).toBeGreaterThan(0);
    expect(second.lastUpdatedMs).toBe(first.lastUpdatedMs);
    expect(second.results).toEqual(first.results);

    const refreshed = await previewInvoke<{
      rootDir: string;
      results: Array<{ wslPath: string; relativePath: string; basename: string }>;
      lastUpdatedMs: number;
    }>("list_session_files", {
      sessionId: "preview-editor",
      rootDir: "/home/user/work/project",
      forceRefresh: true,
    });

    expect(refreshed.lastUpdatedMs).toBeGreaterThan(first.lastUpdatedMs);
    expect(refreshed.results).toEqual(first.results);
  });

  it("reads and writes preview editor files", async () => {
    applyPreviewPreset("editor");

    const before = await previewInvoke<{
      content: string;
      mtimeMs: number;
      languageId: string;
    }>("read_session_file", {
      sessionId: "preview-editor",
      wslPath: "/home/user/work/project/src/App.svelte",
    });

    expect(before.languageId).toBe("svelte");
    expect(before.content).toContain("CLCOMX");

    const written = await previewInvoke<{ mtimeMs: number; sizeBytes: number }>("write_session_file", {
      sessionId: "preview-editor",
      wslPath: "/home/user/work/project/src/App.svelte",
      content: `${before.content}\n<!-- changed -->\n`,
      expectedMtimeMs: before.mtimeMs,
    });

    expect(written.mtimeMs).toBeGreaterThan(before.mtimeMs);
    expect(written.sizeBytes).toBeGreaterThan(before.content.length);

    const after = await previewInvoke<{ content: string }>("read_session_file", {
      sessionId: "preview-editor",
      wslPath: "/home/user/work/project/src/App.svelte",
    });

    expect(after.content).toContain("changed");
  });

  it("rejects preview writes when the file mtime is stale", async () => {
    applyPreviewPreset("editor");

    const before = await previewInvoke<{
      mtimeMs: number;
    }>("read_session_file", {
      sessionId: "preview-editor",
      wslPath: "/home/user/work/project/src/App.svelte",
    });

    await expect(
      previewInvoke("write_session_file", {
        sessionId: "preview-editor",
        wslPath: "/home/user/work/project/src/App.svelte",
        content: "<!-- stale -->\n",
        expectedMtimeMs: before.mtimeMs - 1,
      }),
    ).rejects.toThrow("FileModifiedOnDisk");
  });

  it("refreshes cached list_session_files metadata after write", async () => {
    applyPreviewPreset("editor");

    const beforeList = await previewInvoke<{
      rootDir: string;
      results: Array<{ wslPath: string }>;
      lastUpdatedMs: number;
    }>("list_session_files", {
      sessionId: "preview-editor",
      rootDir: "/home/user/work/project",
    });

    const beforeFile = await previewInvoke<{
      content: string;
      mtimeMs: number;
    }>("read_session_file", {
      sessionId: "preview-editor",
      wslPath: "/home/user/work/project/src/App.svelte",
    });

    await previewInvoke("write_session_file", {
      sessionId: "preview-editor",
      wslPath: "/home/user/work/project/src/App.svelte",
      content: `${beforeFile.content}\n<!-- list cache update -->\n`,
      expectedMtimeMs: beforeFile.mtimeMs,
    });

    const afterList = await previewInvoke<{
      rootDir: string;
      results: Array<{ wslPath: string }>;
      lastUpdatedMs: number;
    }>("list_session_files", {
      sessionId: "preview-editor",
      rootDir: "/home/user/work/project",
    });

    expect(afterList.lastUpdatedMs).toBeGreaterThan(beforeList.lastUpdatedMs);
    expect(afterList.results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          wslPath: "/home/user/work/project/src/App.svelte",
        }),
      ]),
    );
  });
});

describe("previewInvoke history commands", () => {
  it("records history at the front, dedupes by session identity, and applies the current limit", async () => {
    applyPreviewPreset("workspace");
    await previewInvoke("trim_tab_history", { limit: 2.8 });

    const first = await previewInvoke<Array<{
      agentId: string;
      distro: string;
      workDir: string;
      title: string;
      resumeToken?: string | null;
    }>>("record_tab_history", {
      agentId: "claude",
      distro: "Ubuntu-24.04",
      workDir: "/home/user/work/project",
      title: "Updated title",
      resumeToken: "resume-preview-1",
    });

    expect(first).toHaveLength(2);
    expect(first[0]).toMatchObject({
      agentId: "claude",
      distro: "Ubuntu-24.04",
      workDir: "/home/user/work/project",
      title: "Updated title",
      resumeToken: "resume-preview-1",
    });
    expect(first.some((entry) => entry.title === "claudemx")).toBe(false);

    const second = await previewInvoke<typeof first>("record_tab_history", {
      agentId: "codex",
      distro: "Ubuntu-24.04",
      workDir: "/home/user/work/project",
      title: "Second entry",
      resumeToken: null,
    });

    expect(second).toHaveLength(2);
    expect(second[0]).toMatchObject({
      agentId: "codex",
      title: "Second entry",
      resumeToken: null,
    });
    expect(second[1]).toMatchObject({
      agentId: "claude",
      title: "Updated title",
    });
  });

  it("removes only exact history entry matches", async () => {
    applyPreviewPreset("workspace");

    const before = await previewInvoke<{
      tabHistory: Array<{
        agentId: string;
        distro: string;
        workDir: string;
        title: string;
        resumeToken?: string | null;
        lastOpenedAt: string;
      }>;
    }>("bootstrap_app").then((bootstrap) => bootstrap.tabHistory);
    const target = before[0];

    const unchanged = await previewInvoke<typeof before>("remove_tab_history_entry", {
      entry: {
        ...target,
        lastOpenedAt: "2099-01-01T00:00:00.000Z",
      },
    });

    expect(unchanged).toHaveLength(before.length);
    expect(unchanged).toEqual(before);

    const after = await previewInvoke<typeof before>("remove_tab_history_entry", {
      entry: target,
    });

    expect(after).toHaveLength(before.length - 1);
    expect(after).not.toContainEqual(target);
  });

  it("trims history and stores a normalized limit in preview settings", async () => {
    applyPreviewPreset("workspace");

    const trimmedToOne = await previewInvoke<Array<unknown>>("trim_tab_history", { limit: 0 });
    expect(trimmedToOne).toHaveLength(1);

    let bootstrap = await previewInvoke<{
      settings: { history: { tabLimit: number } };
      tabHistory: unknown[];
    }>("bootstrap_app");
    expect(bootstrap.settings.history.tabLimit).toBe(1);
    expect(bootstrap.tabHistory).toHaveLength(1);

    await previewInvoke("trim_tab_history", { limit: 2.8 });
    bootstrap = await previewInvoke<typeof bootstrap>("bootstrap_app");
    expect(bootstrap.settings.history.tabLimit).toBe(2);
  });

  it("returns cloned history arrays from history commands", async () => {
    applyPreviewPreset("workspace");

    const result = await previewInvoke<Array<{
      title: string;
    }>>("record_tab_history", {
      agentId: "claude",
      distro: "Ubuntu-24.04",
      workDir: "/home/user/work/project",
      title: "Mutable return",
      resumeToken: "resume-mutable",
    });
    result[0].title = "Mutated outside";

    const bootstrap = await previewInvoke<{
      tabHistory: Array<{ title: string }>;
    }>("bootstrap_app");

    expect(bootstrap.tabHistory[0]?.title).toBe("Mutable return");
  });
});

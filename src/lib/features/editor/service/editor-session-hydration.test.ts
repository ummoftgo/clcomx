import { describe, expect, it, vi } from "vitest";
import {
  buildEditorHydrationPlaceholderTabs,
  loadHydratedEditorTabs,
  resolveHydratedActivePath,
  splitHydratedEditorTabs,
} from "./editor-session-hydration";

describe("editor-session-hydration", () => {
  it("builds loading placeholders from session refs", () => {
    expect(
      buildEditorHydrationPlaceholderTabs([
        { wslPath: "/workspace/a.ts", line: 2, column: 4 },
      ]),
    ).toEqual([
      {
        wslPath: "/workspace/a.ts",
        content: "",
        languageId: "plaintext",
        dirty: false,
        line: 2,
        column: 4,
        loading: true,
        saving: false,
        error: null,
      },
    ]);
  });

  it("loads session files and shapes failures as non-throwing tabs", async () => {
    const readSessionFile = vi.fn<
      (sessionId: string, wslPath: string) => Promise<{
        wslPath: string;
        content: string;
        languageId: string;
        sizeBytes: number;
        mtimeMs: number;
      }>
    >();
    readSessionFile.mockImplementation(async (_sessionId, wslPath) => {
      if (wslPath.endsWith("missing.ts")) {
        throw new Error("missing");
      }

      return {
        wslPath,
        content: "console.log('ok')",
        languageId: "typescript",
        sizeBytes: 17,
        mtimeMs: 42,
      };
    });

    const loadedTabs = await loadHydratedEditorTabs(
      { readSessionFile },
      "session-1",
      [
        { wslPath: "/workspace/a.ts" },
        { wslPath: "/workspace/missing.ts", line: 3, column: 7 },
      ],
    );

    expect(loadedTabs).toEqual([
      {
        wslPath: "/workspace/a.ts",
        content: "console.log('ok')",
        languageId: "typescript",
        dirty: false,
        line: null,
        column: null,
        loading: false,
        saving: false,
        error: null,
        mtimeMs: 42,
      },
      {
        wslPath: "/workspace/missing.ts",
        content: "",
        languageId: "plaintext",
        dirty: false,
        line: 3,
        column: 7,
        loading: false,
        saving: false,
        error: "missing",
        mtimeMs: 0,
      },
    ]);
  });

  it("splits hydrated tabs into runtime tabs and saved/mtime caches", () => {
    const result = splitHydratedEditorTabs([
      {
        wslPath: "/workspace/a.ts",
        content: "alpha",
        languageId: "typescript",
        dirty: false,
        line: null,
        column: null,
        loading: false,
        saving: false,
        error: null,
        mtimeMs: 12,
      },
      {
        wslPath: "/workspace/b.ts",
        content: "",
        languageId: "plaintext",
        dirty: false,
        line: null,
        column: null,
        loading: false,
        saving: false,
        error: "missing",
        mtimeMs: 0,
      },
    ]);

    expect(result.tabs).toEqual([
      {
        wslPath: "/workspace/a.ts",
        content: "alpha",
        languageId: "typescript",
        dirty: false,
        line: null,
        column: null,
        loading: false,
        saving: false,
        error: null,
      },
      {
        wslPath: "/workspace/b.ts",
        content: "",
        languageId: "plaintext",
        dirty: false,
        line: null,
        column: null,
        loading: false,
        saving: false,
        error: "missing",
      },
    ]);
    expect(result.savedContentByPath).toEqual({
      "/workspace/a.ts": "alpha",
    });
    expect(result.mtimeByPath).toEqual({
      "/workspace/a.ts": 12,
    });
  });

  it("falls back to the first tab when the persisted active path is gone", () => {
    expect(
      resolveHydratedActivePath("/workspace/missing.ts", [
        { wslPath: "/workspace/a.ts" },
        { wslPath: "/workspace/b.ts" },
      ]),
    ).toBe("/workspace/a.ts");

    expect(resolveHydratedActivePath("/workspace/b.ts", [{ wslPath: "/workspace/b.ts" }])).toBe(
      "/workspace/b.ts",
    );
  });
});

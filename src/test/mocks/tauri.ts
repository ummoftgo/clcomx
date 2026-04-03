import { vi } from "vitest";

const MOCK_WORKSPACE_ROOTS = [
  "/home/tester/workspace",
  "/home/user/work/project",
] as const;

const MOCK_EDITOR_FILE_SEEDS = [
  {
    relativePath: "src/App.svelte",
    languageId: "svelte",
    content: `<script lang="ts">
  let name = "Mock";
</script>
`,
    mtimeMs: 1_710_000_000_000,
  },
  {
    relativePath: "src/lib/components/InternalEditor.svelte",
    languageId: "svelte",
    content: `<section class="editor-shell">Internal Editor</section>\n`,
    mtimeMs: 1_710_000_010_000,
  },
  {
    relativePath: "src/lib/components/EditorQuickOpenModal.svelte",
    languageId: "svelte",
    content: `<div class="quick-open-modal">\n  <input placeholder="Search files" />\n</div>\n`,
    mtimeMs: 1_710_000_015_000,
  },
  {
    relativePath: "docs/notes.md",
    languageId: "markdown",
    content: `# Notes\n\n- quick open\n`,
    mtimeMs: 1_710_000_020_000,
  },
] as const;

type MockSearchRank = [number, number, number, number, string];

function normalizeMockHomeDir(homeDir: unknown) {
  if (typeof homeDir !== "string") {
    return "/home/tester";
  }

  const trimmed = homeDir.trim();
  return trimmed || "/home/tester";
}

function buildMockWindowsPath(wslPath: string) {
  return `\\\\wsl.localhost\\clcomx-test${wslPath.replace(/\//g, "\\")}`;
}

const MOCK_EDITOR_FILES = new Map<
  string,
  {
    languageId: string;
    content: string;
    mtimeMs: number;
  }
>();
const MOCK_SESSION_FILE_LIST_CACHE = new Map<
  string,
  {
    results: Array<{ wslPath: string; relativePath: string; basename: string }>;
    lastUpdatedMs: number;
  }
>();
let mockFileListClock = 1_710_001_000_000;

function getMockBasename(path: string) {
  return path.replace(/\/+$/, "").split("/").pop() || path;
}

function getMockRelativePath(rootDir: string, wslPath: string) {
  if (wslPath === rootDir) return getMockBasename(wslPath);
  return wslPath.startsWith(`${rootDir}/`) ? wslPath.slice(rootDir.length + 1) : wslPath;
}

function getMockSearchRank(
  query: string,
  result: { basename: string; relativePath: string },
): MockSearchRank | null {
  const normalizedQuery = query.trim().toLowerCase();
  const basename = result.basename.toLowerCase();
  const relativePath = result.relativePath.toLowerCase();

  const bucket = !normalizedQuery
    ? 4
    : basename === normalizedQuery
      ? 0
      : basename.startsWith(normalizedQuery)
        ? 1
        : basename.includes(normalizedQuery)
          ? 2
          : relativePath.includes(normalizedQuery)
            ? 3
            : null;

  if (bucket === null) {
    return null;
  }

  return [
    bucket,
    result.relativePath.split("/").length - 1,
    result.relativePath.length,
    result.basename.length,
    relativePath,
  ];
}

function compareMockSearchRank(left: MockSearchRank, right: MockSearchRank) {
  for (let index = 0; index < left.length; index += 1) {
    const leftValue = left[index];
    const rightValue = right[index];
    const delta =
      typeof leftValue === "string" && typeof rightValue === "string"
        ? leftValue.localeCompare(rightValue)
        : (leftValue as number) - (rightValue as number);

    if (delta !== 0) {
      return delta;
    }
  }

  return 0;
}

function createSearchResults(rootDir: string, query: string) {
  if (!query.trim()) {
    return [];
  }

  return [...MOCK_EDITOR_FILES.keys()]
    .filter((wslPath) => wslPath === rootDir || wslPath.startsWith(`${rootDir}/`))
    .map((wslPath) => ({
      wslPath,
      relativePath: getMockRelativePath(rootDir, wslPath),
      basename: getMockBasename(wslPath),
    }))
    .flatMap((result) => {
      const rank = getMockSearchRank(query, result);
      return rank ? [{ result, rank }] : [];
    })
    .sort((left, right) => compareMockSearchRank(left.rank, right.rank))
    .map(({ result }) => result);
}

function createSessionFileList(rootDir: string) {
  return [...MOCK_EDITOR_FILES.keys()]
    .filter((wslPath) => wslPath === rootDir || wslPath.startsWith(`${rootDir}/`))
    .map((wslPath) => ({
      wslPath,
      relativePath: getMockRelativePath(rootDir, wslPath),
      basename: getMockBasename(wslPath),
    }))
    .sort((left, right) => {
      const byDepth = left.relativePath.split("/").length - right.relativePath.split("/").length;
      if (byDepth !== 0) return byDepth;
      return left.relativePath.localeCompare(right.relativePath);
    });
}

function buildOrReuseSessionFileList(
  rootDir: string,
  forceRefresh: boolean,
) {
  const cacheKey = rootDir.trim() || "/home/tester/workspace";
  if (!forceRefresh) {
    const cached = MOCK_SESSION_FILE_LIST_CACHE.get(cacheKey);
    if (cached) {
      return {
        rootDir: cacheKey,
        results: cached.results,
        lastUpdatedMs: cached.lastUpdatedMs,
      };
    }
  }

  const results = createSessionFileList(cacheKey);
  mockFileListClock += 100;
  const entry = {
    results,
    lastUpdatedMs: mockFileListClock,
  };
  MOCK_SESSION_FILE_LIST_CACHE.set(cacheKey, entry);
  return {
    rootDir: cacheKey,
    results,
    lastUpdatedMs: entry.lastUpdatedMs,
  };
}

function touchSessionFileListCacheForPath(wslPath: string) {
  for (const [rootDir] of MOCK_SESSION_FILE_LIST_CACHE.entries()) {
    if (!(wslPath === rootDir || wslPath.startsWith(`${rootDir}/`))) {
      continue;
    }

    const results = createSessionFileList(rootDir);
    mockFileListClock += 1;
    MOCK_SESSION_FILE_LIST_CACHE.set(rootDir, {
      results,
      lastUpdatedMs: mockFileListClock,
    });
    // Keep existing cached object semantics simple: update first matching roots only.
  }
}

function resetMockEditorFiles() {
  MOCK_EDITOR_FILES.clear();
  MOCK_SESSION_FILE_LIST_CACHE.clear();
  mockFileListClock = 1_710_001_000_000;

  for (const rootDir of MOCK_WORKSPACE_ROOTS) {
    for (const seed of MOCK_EDITOR_FILE_SEEDS) {
      MOCK_EDITOR_FILES.set(`${rootDir}/${seed.relativePath}`, {
        languageId: seed.languageId,
        content: seed.content,
        mtimeMs: seed.mtimeMs,
      });
    }
  }
}

function createDefaultInvokeImplementation() {
  return async (command: string, args?: Record<string, unknown>) => {
    switch (command) {
      case "list_monospace_fonts":
        return ["Pretendard", "Malgun Gothic", "JetBrains Mono"];
      case "list_available_editors":
        return [
          { id: "vscode", label: "VS Code" },
          { id: "cursor", label: "Cursor" },
          { id: "phpstorm", label: "PhpStorm" },
        ];
      case "resolve_terminal_path": {
        const raw = String(args?.raw ?? "src/App.svelte:12:3");
        const homeDir = normalizeMockHomeDir(args?.homeDirHint ?? args?.homeDir);

        if (raw === "~" || raw.startsWith("~/")) {
          const wslPath = raw === "~" ? homeDir : `${homeDir}${raw.slice(1)}`;
          return {
            kind: "resolved",
            path: {
              raw,
              wslPath,
              copyText: wslPath,
              windowsPath: buildMockWindowsPath(wslPath),
              line: null,
              column: null,
              isDirectory: raw === "~" || raw.endsWith("/"),
            },
          };
        }

        if (raw === "index.ts") {
          return {
            kind: "candidates",
            raw: "index.ts",
            candidates: [
              {
                raw: "index.ts",
                wslPath: `${homeDir}/workspace/src/front/index.ts`,
                copyText: `${homeDir}/workspace/src/front/index.ts:12:3`,
                windowsPath: buildMockWindowsPath(`${homeDir}/workspace/src/front/index.ts`),
                line: 12,
                column: 3,
                isDirectory: false,
              },
              {
                raw: "index.ts",
                wslPath: `${homeDir}/workspace/src/shared/index.ts`,
                copyText: `${homeDir}/workspace/src/shared/index.ts:8:1`,
                windowsPath: buildMockWindowsPath(`${homeDir}/workspace/src/shared/index.ts`),
                line: 8,
                column: 1,
                isDirectory: false,
              },
            ],
          };
        }

        return {
          kind: "resolved",
          path: {
            raw,
            wslPath: `${homeDir}/workspace/src/App.svelte`,
            copyText: `${homeDir}/workspace/src/App.svelte:12:3`,
            windowsPath: buildMockWindowsPath(`${homeDir}/workspace/src/App.svelte`),
            line: 12,
            column: 3,
            isDirectory: false,
          },
        };
      }
      case "search_session_files": {
        const rootDir = String(args?.rootDir ?? "/home/tester/workspace").trim() || "/home/tester/workspace";
        const query = String(args?.query ?? "");
        return {
          rootDir,
          results: createSearchResults(rootDir, query).slice(0, Number(args?.limit ?? 50)),
        };
      }
      case "list_session_files": {
        const rootDir =
          String(args?.rootDir ?? "/home/tester/workspace").trim() || "/home/tester/workspace";
        const forceRefresh = Boolean(args?.forceRefresh);
        const limit = Math.max(1, Number(args?.limit ?? 200) || 200);
        const result = buildOrReuseSessionFileList(rootDir, forceRefresh);
        return {
          rootDir: result.rootDir,
          results: result.results.slice(0, limit),
          lastUpdatedMs: result.lastUpdatedMs,
        };
      }
      case "read_session_file": {
        const wslPath = String(args?.wslPath ?? "");
        const file = MOCK_EDITOR_FILES.get(wslPath);
        if (!file) {
          throw new Error(`Mock file not found: ${wslPath}`);
        }

        return {
          wslPath,
          content: file.content,
          languageId: file.languageId,
          sizeBytes: new TextEncoder().encode(file.content).length,
          mtimeMs: file.mtimeMs,
        };
      }
      case "write_session_file": {
        const wslPath = String(args?.wslPath ?? "");
        const content = String(args?.content ?? "");
        const expectedMtimeMs = Number(args?.expectedMtimeMs);
        const file = MOCK_EDITOR_FILES.get(wslPath);
        if (!file) {
          throw new Error(`Mock file not found: ${wslPath}`);
        }

        if (!Number.isFinite(expectedMtimeMs) || expectedMtimeMs !== file.mtimeMs) {
          throw new Error("FileModifiedOnDisk");
        }

        const nextFile = {
          ...file,
          content,
          mtimeMs: file.mtimeMs + 1_000,
        };
        MOCK_EDITOR_FILES.set(wslPath, nextFile);
        touchSessionFileListCacheForPath(wslPath);
        return {
          wslPath,
          sizeBytes: new TextEncoder().encode(content).length,
          mtimeMs: nextFile.mtimeMs,
        };
      }
      case "open_in_editor":
        return undefined;
      case "get_image_cache_stats":
        return { path: "/tmp/image", files: 0, bytes: 0 };
      case "open_image_cache_folder":
        return "/tmp/image";
      case "clear_image_cache":
        return 0;
      case "save_settings":
      case "save_workspace":
        return undefined;
      default:
        return undefined;
    }
  };
}

export const invokeMock = vi.fn(createDefaultInvokeImplementation());

export function resetTauriMocks() {
  resetMockEditorFiles();
  invokeMock.mockReset();
  invokeMock.mockImplementation(createDefaultInvokeImplementation());
}

resetMockEditorFiles();

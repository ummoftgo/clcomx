import type {
  EditorSearchResult,
  ReadSessionFileResult,
  WriteSessionFileResult,
} from "../editors";

export interface PreviewEditorFile {
  wslPath: string;
  content: string;
  languageId: string;
  mtimeMs: number;
}

export interface PreviewCachedFileList {
  results: EditorSearchResult[];
  lastUpdatedMs: number;
}

export interface PreviewEditorFileState {
  editorFiles: Map<string, PreviewEditorFile>;
  fileListCache: Map<string, PreviewCachedFileList>;
  fileListClock: number;
}

interface PreviewEditorFileSeed {
  wslPath: string;
  content: string;
  languageId: string;
}

type PreviewSearchRank = [number, number, number, number, string];

function createPreviewEditorFileSeed(projectPath: string): PreviewEditorFileSeed[] {
  return [
    {
      wslPath: `${projectPath}/src/App.svelte`,
      languageId: "svelte",
      content: `<script lang="ts">
  let name = "CLCOMX";
</script>

<main class="app-shell">
  <h1>{name}</h1>
</main>
`,
    },
    {
      wslPath: `${projectPath}/src/lib/components/InternalEditor.svelte`,
      languageId: "svelte",
      content: `<script lang="ts">
  export let title = "Internal Editor";
</script>

<section class="editor-shell">{title}</section>
`,
    },
    {
      wslPath: `${projectPath}/src/lib/components/EditorQuickOpenModal.svelte`,
      languageId: "svelte",
      content: `<div class="quick-open-modal">
  <input placeholder="Search files" />
</div>
`,
    },
    {
      wslPath: `${projectPath}/src/lib/editor/model-store.ts`,
      languageId: "typescript",
      content: `export function openModel(path: string) {
  return \`model:\${path}\`;
}
`,
    },
    {
      wslPath: `${projectPath}/src/lib/editor/monaco-theme.ts`,
      languageId: "typescript",
      content: `export const editorTheme = {
  base: "vs-dark",
};
`,
    },
    {
      wslPath: `${projectPath}/docs/architecture/2026-04-02-internal-monaco-editor-design.md`,
      languageId: "markdown",
      content: `# Internal Monaco Editor

- Quick Open
- Session-local tabs
- Preview coverage
`,
    },
    {
      wslPath: `${projectPath}/.claude/settings.json`,
      languageId: "json",
      content: `{
  "theme": "tokyo-night",
  "internalEditor": true
}
`,
    },
  ];
}

export function createPreviewEditorFiles(projectPath: string) {
  const files = new Map<string, PreviewEditorFile>();
  const now = Date.now();

  for (const [index, seed] of createPreviewEditorFileSeed(projectPath).entries()) {
    files.set(seed.wslPath, {
      ...seed,
      mtimeMs: now - index * 10_000,
    });
  }

  return files;
}

function getPreviewPathBasename(path: string) {
  const normalized = path.replace(/\/+$/, "");
  return normalized.split("/").pop() || normalized;
}

function toPreviewRelativePath(rootDir: string, path: string) {
  if (path === rootDir) return getPreviewPathBasename(path);
  return path.startsWith(`${rootDir}/`) ? path.slice(rootDir.length + 1) : path;
}

function getPreviewSearchRank(query: string, result: EditorSearchResult): PreviewSearchRank | null {
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

function comparePreviewSearchRank(left: PreviewSearchRank, right: PreviewSearchRank) {
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

export function searchPreviewEditorFiles(
  state: PreviewEditorFileState,
  defaultRootDir: string,
  args?: Record<string, unknown>,
) {
  const rootDir = String(args?.rootDir ?? defaultRootDir).trim() || defaultRootDir;
  const query = String(args?.query ?? "").trim();
  const limit = Math.max(1, Math.min(100, Number(args?.limit ?? 50) || 50));
  const list = listPreviewEditorFiles(state, defaultRootDir, {
    rootDir,
    forceRefresh: false,
    limit: 10_000,
  });

  if (!query) {
    return {
      rootDir: list.rootDir,
      results: [],
    };
  }

  const results = list.results
    .flatMap((entry) => {
      const rank = getPreviewSearchRank(query, entry);
      return rank ? [{ file: entry, rank }] : [];
    })
    .sort((left, right) => comparePreviewSearchRank(left.rank, right.rank))
    .map(({ file }) => file)
    .slice(0, limit);

  return {
    rootDir: list.rootDir,
    results,
  };
}

export function listPreviewEditorFiles(
  state: PreviewEditorFileState,
  defaultRootDir: string,
  args?: Record<string, unknown>,
) {
  const rootDir = String(args?.rootDir ?? defaultRootDir).trim() || defaultRootDir;
  const forceRefresh = Boolean(args?.forceRefresh);
  const limit = Math.max(1, Number(args?.limit ?? 200) || 200);

  if (!forceRefresh) {
    const cached = state.fileListCache.get(rootDir);
    if (cached) {
      return {
        rootDir,
        results: cached.results.slice(0, limit),
        lastUpdatedMs: cached.lastUpdatedMs,
      };
    }
  }

  const results = [...state.editorFiles.values()]
    .filter((file) => file.wslPath.startsWith(`${rootDir}/`) || file.wslPath === rootDir)
    .map<EditorSearchResult>((file) => {
      const relativePath = toPreviewRelativePath(rootDir, file.wslPath);
      return {
        wslPath: file.wslPath,
        relativePath,
        basename: getPreviewPathBasename(file.wslPath),
      };
    })
    .sort((left, right) => {
      const byDepth = left.relativePath.split("/").length - right.relativePath.split("/").length;
      if (byDepth !== 0) {
        return byDepth;
      }
      return left.relativePath.localeCompare(right.relativePath);
    });

  state.fileListClock += 100;
  const entry: PreviewCachedFileList = {
    results,
    lastUpdatedMs: state.fileListClock,
  };
  state.fileListCache.set(rootDir, entry);
  return {
    rootDir,
    results: entry.results.slice(0, limit),
    lastUpdatedMs: entry.lastUpdatedMs,
  };
}

function touchPreviewFileListCacheForPath(
  state: PreviewEditorFileState,
  defaultRootDir: string,
  wslPath: string,
) {
  for (const [rootDir] of state.fileListCache.entries()) {
    if (!(wslPath === rootDir || wslPath.startsWith(`${rootDir}/`))) {
      continue;
    }

    void listPreviewEditorFiles(state, defaultRootDir, {
      rootDir,
      forceRefresh: true,
      limit: 10_000,
    });
  }
}

function inferPreviewLanguageId(wslPath: string) {
  if (wslPath.endsWith(".svelte")) return "svelte";
  if (wslPath.endsWith(".ts")) return "typescript";
  if (wslPath.endsWith(".js")) return "javascript";
  if (wslPath.endsWith(".json")) return "json";
  if (wslPath.endsWith(".md")) return "markdown";
  return "plaintext";
}

export function readPreviewEditorFile(
  state: PreviewEditorFileState,
  args?: Record<string, unknown>,
): ReadSessionFileResult {
  const wslPath = String(args?.wslPath ?? "");
  const file = state.editorFiles.get(wslPath);

  if (!file) {
    throw new Error(`Preview file not found: ${wslPath}`);
  }

  return {
    wslPath: file.wslPath,
    content: file.content,
    languageId: file.languageId || inferPreviewLanguageId(file.wslPath),
    sizeBytes: new TextEncoder().encode(file.content).length,
    mtimeMs: file.mtimeMs,
  };
}

export function writePreviewEditorFile(
  state: PreviewEditorFileState,
  defaultRootDir: string,
  args?: Record<string, unknown>,
): WriteSessionFileResult {
  const wslPath = String(args?.wslPath ?? "");
  const content = String(args?.content ?? "");
  const expectedMtimeMs = Number(args?.expectedMtimeMs);
  const file = state.editorFiles.get(wslPath);

  if (!file) {
    throw new Error(`Preview file not found: ${wslPath}`);
  }

  if (!Number.isFinite(expectedMtimeMs) || expectedMtimeMs !== file.mtimeMs) {
    throw new Error("FileModifiedOnDisk");
  }

  const nextFile: PreviewEditorFile = {
    ...file,
    content,
    mtimeMs: Math.max(Date.now(), file.mtimeMs + 1),
  };
  state.editorFiles.set(wslPath, nextFile);
  touchPreviewFileListCacheForPath(state, defaultRootDir, wslPath);

  return {
    wslPath,
    sizeBytes: new TextEncoder().encode(content).length,
    mtimeMs: nextFile.mtimeMs,
  };
}

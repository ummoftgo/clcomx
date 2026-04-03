import defaultThemePack from "../themes/default-theme-pack.json";
import { DEFAULT_SETTINGS, type AppBootstrap, type Settings, type TabHistoryEntry } from "../types";
import type { ThemePack } from "../themes";
import type { WorkspaceTabSnapshot, WorkspaceWindowSnapshot } from "../types";
import type {
  EditorSearchResult,
  ReadSessionFileResult,
  WriteSessionFileResult,
} from "../editors";

export type PreviewUnlistenFn = () => void;
export type PreviewPresetId = "workspace" | "dense" | "empty" | "editor";

export interface PreviewPresetOption {
  id: PreviewPresetId;
  label: string;
  description: string;
}

export interface PreviewEvent<T> {
  payload: T;
}

export interface PreviewWindowCloseEvent {
  preventDefault(): void;
}

export interface PreviewWindowHandle {
  label: string;
  setTitle(title: string): Promise<void>;
  outerPosition(): Promise<{ x: number; y: number }>;
  innerSize(): Promise<{ width: number; height: number }>;
  isMaximized(): Promise<boolean>;
  close(): Promise<void>;
  onCloseRequested(
    callback: (event: PreviewWindowCloseEvent) => void | Promise<void>,
  ): Promise<PreviewUnlistenFn>;
  onMoved(callback: () => void | Promise<void>): Promise<PreviewUnlistenFn>;
  onResized(callback: () => void | Promise<void>): Promise<PreviewUnlistenFn>;
}

declare global {
  interface Window {
    __CLCOMX_BROWSER_PREVIEW__?: boolean;
  }
}

interface PreviewState {
  presetId: PreviewPresetId;
  bootstrap: AppBootstrap;
  readyWindows: Set<string>;
  editorFiles: Map<string, PreviewEditorFile>;
  fileListCache: Map<string, PreviewCachedFileList>;
  fileListClock: number;
}

interface PreviewEditorFile {
  wslPath: string;
  content: string;
  languageId: string;
  mtimeMs: number;
}

interface PreviewCachedFileList {
  results: EditorSearchResult[];
  lastUpdatedMs: number;
}

type PreviewSearchRank = [number, number, number, number, string];

const DEFAULT_PREVIEW_PRESET_ID: PreviewPresetId = "workspace";
const PREVIEW_USER_HOME = "/home/user";
const PREVIEW_WORK_ROOT = `${PREVIEW_USER_HOME}/work`;
const PREVIEW_PROJECT_PATH = `${PREVIEW_WORK_ROOT}/project`;
const PREVIEW_PROJECT_FILE = `${PREVIEW_PROJECT_PATH}/src/App.svelte`;
const PREVIEW_PRESET_OPTIONS: readonly PreviewPresetOption[] = [
  {
    id: "workspace",
    label: "Workspace",
    description: "평소 작업 중인 탭 배치와 보조 터미널이 열린 상태를 봅니다.",
  },
  {
    id: "dense",
    label: "Dense Tabs",
    description: "탭이 많고 창 메뉴가 복잡한 상태에서 간격과 밀도를 확인합니다.",
  },
  {
    id: "empty",
    label: "Empty Start",
    description: "세션이 없는 시작 화면과 히스토리 목록 흐름을 봅니다.",
  },
  {
    id: "editor",
    label: "Editor Focus",
    description: "내부 에디터 탭과 빠른 열기 흐름을 중심으로 UI를 확인합니다.",
  },
];

const PREVIEW_DISTRO_TREE: Record<string, string[]> = {
  "/home": [PREVIEW_USER_HOME],
  [PREVIEW_USER_HOME]: [PREVIEW_WORK_ROOT],
  [PREVIEW_WORK_ROOT]: [PREVIEW_PROJECT_PATH],
  [PREVIEW_PROJECT_PATH]: [
    `${PREVIEW_PROJECT_PATH}/src`,
    `${PREVIEW_PROJECT_PATH}/src-tauri`,
    `${PREVIEW_PROJECT_PATH}/docs`,
  ],
};

const PREVIEW_EDITOR_FILE_SEED = [
  {
    wslPath: `${PREVIEW_PROJECT_PATH}/src/App.svelte`,
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
    wslPath: `${PREVIEW_PROJECT_PATH}/src/lib/components/InternalEditor.svelte`,
    languageId: "svelte",
    content: `<script lang="ts">
  export let title = "Internal Editor";
</script>

<section class="editor-shell">{title}</section>
`,
  },
  {
    wslPath: `${PREVIEW_PROJECT_PATH}/src/lib/components/EditorQuickOpenModal.svelte`,
    languageId: "svelte",
    content: `<div class="quick-open-modal">
  <input placeholder="Search files" />
</div>
`,
  },
  {
    wslPath: `${PREVIEW_PROJECT_PATH}/src/lib/editor/model-store.ts`,
    languageId: "typescript",
    content: `export function openModel(path: string) {
  return \`model:\${path}\`;
}
`,
  },
  {
    wslPath: `${PREVIEW_PROJECT_PATH}/src/lib/editor/monaco-theme.ts`,
    languageId: "typescript",
    content: `export const editorTheme = {
  base: "vs-dark",
};
`,
  },
  {
    wslPath: `${PREVIEW_PROJECT_PATH}/docs/architecture/2026-04-02-internal-monaco-editor-design.md`,
    languageId: "markdown",
    content: `# Internal Monaco Editor

- Quick Open
- Session-local tabs
- Preview coverage
`,
  },
  {
    wslPath: `${PREVIEW_PROJECT_PATH}/.claude/settings.json`,
    languageId: "json",
    content: `{
  "theme": "tokyo-night",
  "internalEditor": true
}
`,
  },
];

function normalizePreviewHomeDir(homeDir: unknown) {
  if (typeof homeDir !== "string") {
    return PREVIEW_USER_HOME;
  }

  const trimmed = homeDir.trim();
  return trimmed || PREVIEW_USER_HOME;
}

function toPreviewWindowsPath(wslPath: string) {
  return `\\\\wsl.localhost\\Ubuntu-24.04${wslPath.replace(/\//g, "\\")}`;
}

const previewWindow: PreviewWindowHandle = {
  label: "main",
  async setTitle(title) {
    document.title = title;
  },
  async outerPosition() {
    return { x: 80, y: 80 };
  },
  async innerSize() {
    return {
      width: window.innerWidth,
      height: window.innerHeight,
    };
  },
  async isMaximized() {
    return false;
  },
  async close() {},
  async onCloseRequested() {
    return () => {};
  },
  async onMoved() {
    return () => {};
  },
  async onResized() {
    return () => {};
  },
};

const previewListeners = new Map<string, Set<(event: PreviewEvent<unknown>) => void>>();
let previewState = createPreviewState();

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function createHistoryEntry(
  agentId: TabHistoryEntry["agentId"],
  distro: string,
  workDir: string,
  title: string,
  resumeToken: string | null,
  lastOpenedAt: string,
): TabHistoryEntry {
  return {
    agentId,
    distro,
    workDir,
    title,
    resumeToken,
    lastOpenedAt,
  };
}

function createPreviewTab(
  sessionId: string,
  agentId: WorkspaceTabSnapshot["agentId"],
  distro: string,
  workDir: string,
  title: string,
  overrides: Partial<WorkspaceTabSnapshot> = {},
): WorkspaceTabSnapshot {
  return {
    sessionId,
    agentId,
    distro,
    workDir,
    title,
    pinned: false,
    locked: false,
    resumeToken: null,
    ptyId: null,
    auxPtyId: null,
    auxVisible: false,
    auxHeightPercent: null,
    viewMode: "terminal",
    editorRootDir: workDir,
    openEditorTabs: [],
    activeEditorPath: null,
    ...overrides,
  };
}

function createPreviewWindowSnapshot(
  label: string,
  name: string,
  role: WorkspaceWindowSnapshot["role"],
  tabs: WorkspaceTabSnapshot[],
  activeSessionId: string | null,
  geometry: Pick<WorkspaceWindowSnapshot, "x" | "y" | "width" | "height" | "maximized">,
): WorkspaceWindowSnapshot {
  return {
    label,
    name,
    role,
    tabs,
    activeSessionId,
    ...geometry,
  };
}

function createPreviewSettings(presetId: PreviewPresetId): Settings {
  const settings = clone(DEFAULT_SETTINGS);
  settings.interface.theme = "tokyo-night";
  settings.interface.uiScale = 102;
  settings.interface.fileOpenTarget = presetId === "editor" ? "internal" : "external";
  settings.workspace.defaultDistro = "Ubuntu-24.04";
  settings.workspace.defaultStartPathsByDistro = {
    "Ubuntu-24.04": PREVIEW_PROJECT_PATH,
  };
  settings.history.tabLimit = presetId === "dense" ? 12 : 10;
  if (presetId === "dense") {
    settings.interface.uiScale = 98;
  }
  return settings;
}

function createWorkspaceHistory(): TabHistoryEntry[] {
  return [
    createHistoryEntry(
      "claude",
      "Ubuntu-24.04",
      PREVIEW_PROJECT_PATH,
      "claudemx",
      "resume-preview-1",
      "2026-03-30T12:00:00.000Z",
    ),
    createHistoryEntry(
      "codex",
      "Ubuntu-24.04",
      PREVIEW_PROJECT_PATH,
      "design-lab",
      null,
      "2026-03-30T09:30:00.000Z",
    ),
    createHistoryEntry(
      "claude",
      "Debian",
      PREVIEW_PROJECT_PATH,
      "agent-playground",
      "resume-preview-2",
      "2026-03-29T23:10:00.000Z",
    ),
  ];
}

function createDenseHistory(): TabHistoryEntry[] {
  return [
    createHistoryEntry(
      "claude",
      "Ubuntu-24.04",
      PREVIEW_PROJECT_PATH,
      "client-portal",
      "resume-preview-client",
      "2026-03-30T12:42:00.000Z",
    ),
    createHistoryEntry(
      "codex",
      "Ubuntu-24.04",
      PREVIEW_PROJECT_PATH,
      "claudemx",
      null,
      "2026-03-30T12:18:00.000Z",
    ),
    createHistoryEntry(
      "claude",
      "Ubuntu-24.04",
      PREVIEW_PROJECT_PATH,
      "design-lab",
      "resume-preview-design",
      "2026-03-30T11:40:00.000Z",
    ),
    createHistoryEntry(
      "codex",
      "Debian",
      PREVIEW_PROJECT_PATH,
      "release-prep",
      null,
      "2026-03-30T09:55:00.000Z",
    ),
    createHistoryEntry(
      "claude",
      "Ubuntu-24.04",
      PREVIEW_PROJECT_PATH,
      "docs",
      null,
      "2026-03-29T21:11:00.000Z",
    ),
    createHistoryEntry(
      "claude",
      "Arch",
      PREVIEW_PROJECT_PATH,
      "proto-shell",
      null,
      "2026-03-29T18:45:00.000Z",
    ),
  ];
}

function createEmptyHistory(): TabHistoryEntry[] {
  return [
    ...createWorkspaceHistory(),
    createHistoryEntry(
      "claude",
      "Ubuntu-24.04",
      PREVIEW_PROJECT_PATH,
      "notes",
      null,
      "2026-03-29T18:25:00.000Z",
    ),
    createHistoryEntry(
      "codex",
      "Ubuntu-24.04",
      PREVIEW_PROJECT_PATH,
      "theme-lab",
      null,
      "2026-03-28T16:40:00.000Z",
    ),
    createHistoryEntry(
      "claude",
      "Debian",
      PREVIEW_PROJECT_PATH,
      "ux-sandbox",
      "resume-preview-ux",
      "2026-03-28T08:15:00.000Z",
    ),
  ];
}

function createWorkspaceWindows(): WorkspaceWindowSnapshot[] {
  return [
    createPreviewWindowSnapshot(
      "main",
      "main",
      "main",
      [
        createPreviewTab(
          "preview-session-claude",
          "claude",
          "Ubuntu-24.04",
          PREVIEW_PROJECT_PATH,
          "claudemx",
          {
            pinned: true,
            resumeToken: "resume-preview-1",
            auxVisible: true,
            auxHeightPercent: 30,
          },
        ),
        createPreviewTab(
          "preview-session-codex",
          "codex",
          "Ubuntu-24.04",
          PREVIEW_PROJECT_PATH,
          "design-lab",
        ),
        createPreviewTab(
          "preview-session-ops",
          "claude",
          "Debian",
          PREVIEW_PROJECT_PATH,
          "agent-playground",
          {
            locked: true,
            resumeToken: "resume-preview-2",
          },
        ),
      ],
      "preview-session-claude",
      {
        x: 80,
        y: 80,
        width: 1320,
        height: 860,
        maximized: false,
      },
    ),
    createPreviewWindowSnapshot(
      "preview-docs",
      "Docs",
      "secondary",
      [
        createPreviewTab(
          "preview-session-docs",
          "claude",
          "Ubuntu-24.04",
          PREVIEW_PROJECT_PATH,
          "notes",
        ),
      ],
      "preview-session-docs",
      {
        x: 1420,
        y: 96,
        width: 980,
        height: 760,
        maximized: false,
      },
    ),
  ];
}

function createDenseWindows(): WorkspaceWindowSnapshot[] {
  return [
    createPreviewWindowSnapshot(
      "main",
      "Release Prep",
      "main",
      [
        createPreviewTab(
          "preview-session-inbox",
          "claude",
          "Ubuntu-24.04",
          PREVIEW_PROJECT_PATH,
          "claudemx",
          {
            pinned: true,
            resumeToken: "resume-preview-1",
          },
        ),
        createPreviewTab(
          "preview-session-client",
          "claude",
          "Ubuntu-24.04",
          PREVIEW_PROJECT_PATH,
          "client-portal-redesign",
          {
            pinned: true,
            auxVisible: true,
            auxHeightPercent: 32,
          },
        ),
        createPreviewTab(
          "preview-session-design",
          "codex",
          "Ubuntu-24.04",
          PREVIEW_PROJECT_PATH,
          "design-lab",
        ),
        createPreviewTab(
          "preview-session-theme",
          "claude",
          "Ubuntu-24.04",
          PREVIEW_PROJECT_PATH,
          "theme-lab-long-iteration",
          {
            locked: true,
            resumeToken: "resume-preview-theme",
          },
        ),
        createPreviewTab(
          "preview-session-release",
          "codex",
          "Debian",
          PREVIEW_PROJECT_PATH,
          "release-prep",
        ),
        createPreviewTab(
          "preview-session-docs",
          "claude",
          "Ubuntu-24.04",
          PREVIEW_PROJECT_PATH,
          "docs-polish",
        ),
      ],
      "preview-session-client",
      {
        x: 72,
        y: 72,
        width: 1380,
        height: 880,
        maximized: false,
      },
    ),
    createPreviewWindowSnapshot(
      "preview-review",
      "Review",
      "secondary",
      [
        createPreviewTab(
          "preview-session-review",
          "claude",
          "Ubuntu-24.04",
          PREVIEW_PROJECT_PATH,
          "review-queue",
        ),
        createPreviewTab(
          "preview-session-specs",
          "codex",
          "Ubuntu-24.04",
          PREVIEW_PROJECT_PATH,
          "specs",
        ),
      ],
      "preview-session-review",
      {
        x: 1460,
        y: 96,
        width: 1040,
        height: 760,
        maximized: false,
      },
    ),
    createPreviewWindowSnapshot(
      "preview-docs",
      "Docs",
      "secondary",
      [
        createPreviewTab(
          "preview-session-notes",
          "claude",
          "Ubuntu-24.04",
          PREVIEW_PROJECT_PATH,
          "notes",
        ),
      ],
      "preview-session-notes",
      {
        x: 1540,
        y: 140,
        width: 920,
        height: 620,
        maximized: false,
      },
    ),
  ];
}

function createEmptyWindows(): WorkspaceWindowSnapshot[] {
  return [
    createPreviewWindowSnapshot(
      "main",
      "main",
      "main",
      [],
      null,
      {
        x: 80,
        y: 80,
        width: 1320,
        height: 860,
        maximized: false,
      },
    ),
  ];
}

function createEditorWindows(): WorkspaceWindowSnapshot[] {
  return [
    createPreviewWindowSnapshot(
      "main",
      "Editor Focus",
      "main",
      [
        createPreviewTab(
          "preview-session-editor",
          "claude",
          "Ubuntu-24.04",
          PREVIEW_PROJECT_PATH,
          "claudemx",
          {
            pinned: true,
            viewMode: "editor",
            editorRootDir: PREVIEW_PROJECT_PATH,
            openEditorTabs: [
              {
                wslPath: `${PREVIEW_PROJECT_PATH}/src/App.svelte`,
                line: 4,
                column: 3,
              },
              {
                wslPath: `${PREVIEW_PROJECT_PATH}/src/lib/components/InternalEditor.svelte`,
              },
            ],
            activeEditorPath: `${PREVIEW_PROJECT_PATH}/src/App.svelte`,
          },
        ),
        createPreviewTab(
          "preview-session-terminal",
          "codex",
          "Ubuntu-24.04",
          PREVIEW_PROJECT_PATH,
          "design-lab",
        ),
      ],
      "preview-session-editor",
      {
        x: 80,
        y: 80,
        width: 1380,
        height: 860,
        maximized: false,
      },
    ),
  ];
}

function createPreviewHistory(presetId: PreviewPresetId): TabHistoryEntry[] {
  switch (presetId) {
    case "dense":
      return createDenseHistory();
    case "empty":
      return createEmptyHistory();
    default:
      return createWorkspaceHistory();
  }
}

function createPreviewWindows(presetId: PreviewPresetId): WorkspaceWindowSnapshot[] {
  switch (presetId) {
    case "editor":
      return createEditorWindows();
    case "dense":
      return createDenseWindows();
    case "empty":
      return createEmptyWindows();
    default:
      return createWorkspaceWindows();
  }
}

function createPreviewBootstrap(presetId: PreviewPresetId): AppBootstrap {
  return {
    settings: createPreviewSettings(presetId),
    tabHistory: createPreviewHistory(presetId),
    workspace: {
      windows: createPreviewWindows(presetId),
    },
    themePack: defaultThemePack as ThemePack,
    testMode: false,
    debugTerminalHooks: false,
    softFollowExperiment: null,
  };
}

function createPreviewEditorFiles() {
  const files = new Map<string, PreviewEditorFile>();
  const now = Date.now();

  for (const [index, seed] of PREVIEW_EDITOR_FILE_SEED.entries()) {
    files.set(seed.wslPath, {
      ...seed,
      mtimeMs: now - index * 10_000,
    });
  }

  return files;
}

function normalizePreviewPresetId(value: unknown): PreviewPresetId {
  return PREVIEW_PRESET_OPTIONS.some((option) => option.id === value)
    ? (value as PreviewPresetId)
    : DEFAULT_PREVIEW_PRESET_ID;
}

function getPreviewUrlParam(name: string): string | null {
  if (typeof window === "undefined") return null;
  return new URL(window.location.href).searchParams.get(name);
}

function setPreviewUrlParam(name: string, value: string | null) {
  if (typeof window === "undefined") return;
  const url = new URL(window.location.href);
  if (value && value.length > 0) {
    url.searchParams.set(name, value);
  } else {
    url.searchParams.delete(name);
  }
  window.history.replaceState(window.history.state, "", url);
}

function createPreviewState(presetId: PreviewPresetId = DEFAULT_PREVIEW_PRESET_ID): PreviewState {
  return {
    presetId,
    bootstrap: createPreviewBootstrap(presetId),
    readyWindows: new Set(["main"]),
    editorFiles: createPreviewEditorFiles(),
    fileListCache: new Map(),
    fileListClock: Date.now(),
  };
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

function searchPreviewEditorFiles(args?: Record<string, unknown>) {
  const rootDir = String(args?.rootDir ?? PREVIEW_PROJECT_PATH).trim() || PREVIEW_PROJECT_PATH;
  const query = String(args?.query ?? "").trim();
  const limit = Math.max(1, Math.min(100, Number(args?.limit ?? 50) || 50));
  const list = listPreviewEditorFiles({
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

function listPreviewEditorFiles(args?: Record<string, unknown>) {
  const rootDir = String(args?.rootDir ?? PREVIEW_PROJECT_PATH).trim() || PREVIEW_PROJECT_PATH;
  const forceRefresh = Boolean(args?.forceRefresh);
  const limit = Math.max(1, Number(args?.limit ?? 200) || 200);

  if (!forceRefresh) {
    const cached = previewState.fileListCache.get(rootDir);
    if (cached) {
      return {
        rootDir,
        results: cached.results.slice(0, limit),
        lastUpdatedMs: cached.lastUpdatedMs,
      };
    }
  }

  const results = [...previewState.editorFiles.values()]
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

  previewState.fileListClock += 100;
  const entry: PreviewCachedFileList = {
    results,
    lastUpdatedMs: previewState.fileListClock,
  };
  previewState.fileListCache.set(rootDir, entry);
  return {
    rootDir,
    results: entry.results.slice(0, limit),
    lastUpdatedMs: entry.lastUpdatedMs,
  };
}

function touchPreviewFileListCacheForPath(wslPath: string) {
  for (const [rootDir] of previewState.fileListCache.entries()) {
    if (!(wslPath === rootDir || wslPath.startsWith(`${rootDir}/`))) {
      continue;
    }

    void listPreviewEditorFiles({
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

function readPreviewEditorFile(args?: Record<string, unknown>): ReadSessionFileResult {
  const wslPath = String(args?.wslPath ?? "");
  const file = previewState.editorFiles.get(wslPath);

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

function writePreviewEditorFile(args?: Record<string, unknown>): WriteSessionFileResult {
  const wslPath = String(args?.wslPath ?? "");
  const content = String(args?.content ?? "");
  const expectedMtimeMs = Number(args?.expectedMtimeMs);
  const file = previewState.editorFiles.get(wslPath);

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
  previewState.editorFiles.set(wslPath, nextFile);
  touchPreviewFileListCacheForPath(wslPath);

  return {
    wslPath,
    sizeBytes: new TextEncoder().encode(content).length,
    mtimeMs: nextFile.mtimeMs,
  };
}

function sameHistoryEntry(left: TabHistoryEntry, right: TabHistoryEntry) {
  return (
    left.agentId === right.agentId &&
    left.distro === right.distro &&
    left.workDir === right.workDir &&
    left.title === right.title &&
    (left.resumeToken ?? null) === (right.resumeToken ?? null) &&
    left.lastOpenedAt === right.lastOpenedAt
  );
}

function normalizeHistoryLimit(value: unknown) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return previewState.bootstrap.settings?.history?.tabLimit ?? DEFAULT_SETTINGS.history.tabLimit;
  }
  return Math.max(1, Math.trunc(value));
}

function applyHistoryLimit(entries: TabHistoryEntry[]) {
  const limit = normalizeHistoryLimit(previewState.bootstrap.settings?.history?.tabLimit);
  return entries.slice(0, limit);
}

function recordPreviewHistoryEntry(args?: Record<string, unknown>) {
  const entry: TabHistoryEntry = {
    agentId: (args?.agentId as TabHistoryEntry["agentId"]) ?? "claude",
    distro: String(args?.distro ?? "Ubuntu-24.04"),
    workDir: String(args?.workDir ?? PREVIEW_PROJECT_PATH),
    title: String(args?.title ?? "workspace"),
    resumeToken: (args?.resumeToken as string | null | undefined) ?? null,
    lastOpenedAt: new Date().toISOString(),
  };

  const deduped = previewState.bootstrap.tabHistory.filter((existing) => {
    return !(
      existing.agentId === entry.agentId &&
      existing.distro === entry.distro &&
      existing.workDir === entry.workDir &&
      (existing.resumeToken ?? null) === (entry.resumeToken ?? null)
    );
  });

  previewState.bootstrap.tabHistory = applyHistoryLimit([entry, ...deduped]);
  return clone(previewState.bootstrap.tabHistory);
}

function removePreviewHistoryEntry(args?: Record<string, unknown>) {
  const candidate = (args?.entry ?? null) as TabHistoryEntry | null;
  if (!candidate) {
    return clone(previewState.bootstrap.tabHistory);
  }

  previewState.bootstrap.tabHistory = previewState.bootstrap.tabHistory.filter(
    (entry) => !sameHistoryEntry(entry, candidate),
  );
  return clone(previewState.bootstrap.tabHistory);
}

function trimPreviewHistory(args?: Record<string, unknown>) {
  const limit = normalizeHistoryLimit(args?.limit);
  previewState.bootstrap.settings = {
    ...previewState.bootstrap.settings,
    history: {
      ...DEFAULT_SETTINGS.history,
      ...(previewState.bootstrap.settings?.history ?? {}),
      tabLimit: limit,
    },
  };
  previewState.bootstrap.tabHistory = previewState.bootstrap.tabHistory.slice(0, limit);
  return clone(previewState.bootstrap.tabHistory);
}

function listPreviewDirectories(path: string) {
  const normalized = path.trim() || "/home";
  const directChildren = PREVIEW_DISTRO_TREE[normalized];
  const nextPaths =
    directChildren ??
    [1, 2, 3].map((index) => `${normalized.replace(/\/$/, "")}/sample-${index}`);

  return nextPaths.map((entryPath) => ({
    name: entryPath.split("/").pop() || entryPath,
    path: entryPath,
  }));
}

export function installBrowserPreviewRuntime() {
  window.__CLCOMX_BROWSER_PREVIEW__ = true;
  previewState = createPreviewState(normalizePreviewPresetId(getPreviewUrlParam("preset")));
  previewListeners.clear();
}

export function isBrowserPreview() {
  return typeof window !== "undefined" && window.__CLCOMX_BROWSER_PREVIEW__ === true;
}

export function getAvailablePreviewPresets() {
  return PREVIEW_PRESET_OPTIONS;
}

export function getActivePreviewPresetId(): PreviewPresetId {
  return previewState.presetId;
}

export function applyPreviewPreset(presetId: PreviewPresetId): AppBootstrap {
  const nextPresetId = normalizePreviewPresetId(presetId);
  previewState = createPreviewState(nextPresetId);
  setPreviewUrlParam(
    "preset",
    nextPresetId === DEFAULT_PREVIEW_PRESET_ID ? null : nextPresetId,
  );
  return clone(previewState.bootstrap);
}

export async function previewInvoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  switch (command) {
    case "bootstrap_app":
      return clone(previewState.bootstrap) as T;
    case "save_settings":
      if (args?.settings) {
        previewState.bootstrap.settings = clone(args.settings as AppBootstrap["settings"]);
      }
      return undefined as T;
    case "save_workspace":
      if (args?.workspace) {
        previewState.bootstrap.workspace = clone(args.workspace as AppBootstrap["workspace"]);
      }
      return undefined as T;
    case "record_tab_history":
      return recordPreviewHistoryEntry(args) as T;
    case "remove_tab_history_entry":
      return removePreviewHistoryEntry(args) as T;
    case "trim_tab_history":
      return trimPreviewHistory(args) as T;
    case "list_wsl_distros":
      return ["Ubuntu-24.04", "Debian", "Arch"] as T;
    case "list_wsl_directories":
      return listPreviewDirectories(String(args?.path ?? "/home")) as T;
    case "list_available_editors":
      return [
        { id: "vscode", label: "VS Code" },
        { id: "cursor", label: "Cursor" },
        { id: "windsurf", label: "Windsurf" },
      ] as T;
    case "list_monospace_fonts":
      return ["JetBrains Mono", "Cascadia Code", "IBM Plex Mono", "Fira Code"] as T;
    case "search_session_files":
      return searchPreviewEditorFiles(args) as T;
    case "list_session_files":
      return listPreviewEditorFiles(args) as T;
    case "read_session_file":
      return readPreviewEditorFile(args) as T;
    case "write_session_file":
      return writePreviewEditorFile(args) as T;
    case "resolve_terminal_path": {
      const raw = String(args?.raw ?? "");
      const homeDir = normalizePreviewHomeDir(args?.homeDirHint ?? args?.homeDir);

      if (raw === "~" || raw.startsWith("~/")) {
        const wslPath = raw === "~" ? homeDir : `${homeDir}${raw.slice(1)}`;
        return {
          kind: "resolved",
          path: {
            raw,
            wslPath,
            copyText: wslPath,
            windowsPath: toPreviewWindowsPath(wslPath),
            line: null,
            column: null,
            isDirectory: raw === "~" || raw.endsWith("/"),
          },
        } as T;
      }

      if (raw === "index.ts") {
        return {
          kind: "candidates",
          raw: "index.ts",
          candidates: [
            {
              raw: "index.ts",
              wslPath: `${PREVIEW_PROJECT_PATH}/src/front/index.ts`,
              copyText: `${PREVIEW_PROJECT_PATH}/src/front/index.ts:12:3`,
              windowsPath:
                "\\\\wsl.localhost\\Ubuntu-24.04\\home\\user\\work\\project\\src\\front\\index.ts",
              line: 12,
              column: 3,
              isDirectory: false,
            },
            {
              raw: "index.ts",
              wslPath: `${PREVIEW_PROJECT_PATH}/src/shared/index.ts`,
              copyText: `${PREVIEW_PROJECT_PATH}/src/shared/index.ts:8:1`,
              windowsPath:
                "\\\\wsl.localhost\\Ubuntu-24.04\\home\\user\\work\\project\\src\\shared\\index.ts",
              line: 8,
              column: 1,
              isDirectory: false,
            },
          ],
        } as T;
      }

      return {
        kind: "resolved",
        path: {
          raw,
          wslPath: PREVIEW_PROJECT_FILE,
          copyText: `${PREVIEW_PROJECT_FILE}:12:3`,
          windowsPath:
            "\\\\wsl.localhost\\Ubuntu-24.04\\home\\user\\work\\project\\src\\App.svelte",
          line: 12,
          column: 3,
          isDirectory: false,
        },
      } as T;
    }
    case "open_in_editor":
    case "set_session_pty":
    case "set_session_aux_terminal_state":
    case "set_session_resume_token":
    case "clear_session_pty":
    case "close_session":
    case "close_session_by_pty":
    case "update_window_geometry":
    case "move_window_sessions_to_main":
    case "close_window_sessions":
    case "remove_window":
    case "close_app":
    case "save_clipboard_image":
    case "open_image_cache_folder":
    case "clear_image_cache":
    case "notify_window_ready":
      return undefined as T;
    case "window_ready":
      previewState.readyWindows.add(String(args?.label ?? "main"));
      return undefined as T;
    case "is_window_ready":
      return previewState.readyWindows.has(String(args?.label ?? "main")) as T;
    case "get_image_cache_stats":
      return { path: "/tmp/clcomx-preview-image-cache", files: 0, bytes: 0 } as T;
    case "open_external_url":
      if (typeof args?.url === "string") {
        window.open(args.url, "_blank", "noopener,noreferrer");
      }
      return undefined as T;
    case "load_custom_css":
      return "" as T;
    default:
      return undefined as T;
  }
}

export async function previewListen<T>(
  event: string,
  callback: (event: PreviewEvent<T>) => void,
): Promise<PreviewUnlistenFn> {
  const listeners = previewListeners.get(event) ?? new Set<(event: PreviewEvent<unknown>) => void>();
  listeners.add(callback as (event: PreviewEvent<unknown>) => void);
  previewListeners.set(event, listeners);
  return () => {
    listeners.delete(callback as (event: PreviewEvent<unknown>) => void);
    if (listeners.size === 0) {
      previewListeners.delete(event);
    }
  };
}

export async function previewEmitTo<T>(_: string, event: string, payload?: T): Promise<void> {
  const listeners = previewListeners.get(event);
  if (!listeners) return;
  for (const listener of listeners) {
    listener({ payload });
  }
}

export function previewGetCurrentWindow(): PreviewWindowHandle {
  return previewWindow;
}

export async function previewCurrentMonitor() {
  return { name: "Browser Preview" };
}

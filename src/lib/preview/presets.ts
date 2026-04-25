import defaultThemePack from "../themes/default-theme-pack.json";
import type { ThemePack } from "../themes";
import {
  DEFAULT_SETTINGS,
  type AppBootstrap,
  type Settings,
  type TabHistoryEntry,
  type WorkspaceTabSnapshot,
  type WorkspaceWindowSnapshot,
} from "../types";

export type PreviewPresetId = "workspace" | "dense" | "empty" | "editor";

export interface PreviewPresetOption {
  id: PreviewPresetId;
  label: string;
  description: string;
}

export const DEFAULT_PREVIEW_PRESET_ID: PreviewPresetId = "workspace";
export const PREVIEW_USER_HOME = "/home/user";
export const PREVIEW_WORK_ROOT = `${PREVIEW_USER_HOME}/work`;
export const PREVIEW_PROJECT_PATH = `${PREVIEW_WORK_ROOT}/project`;
export const PREVIEW_PROJECT_FILE = `${PREVIEW_PROJECT_PATH}/src/App.svelte`;

export const PREVIEW_PRESET_OPTIONS: readonly PreviewPresetOption[] = [
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

export function createPreviewBootstrap(presetId: PreviewPresetId): AppBootstrap {
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

export function normalizePreviewPresetId(value: unknown): PreviewPresetId {
  return PREVIEW_PRESET_OPTIONS.some((option) => option.id === value)
    ? (value as PreviewPresetId)
    : DEFAULT_PREVIEW_PRESET_ID;
}

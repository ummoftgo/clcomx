import type { AppBootstrap } from "../types";
import {
  createPreviewEditorFiles,
  listPreviewEditorFiles,
  readPreviewEditorFile,
  searchPreviewEditorFiles,
  writePreviewEditorFile,
  type PreviewCachedFileList,
  type PreviewEditorFile,
} from "./editor-files";
import {
  recordPreviewHistoryEntry,
  removePreviewHistoryEntry,
  trimPreviewHistory,
} from "./history";
import {
  DEFAULT_PREVIEW_PRESET_ID,
  PREVIEW_PRESET_OPTIONS,
  PREVIEW_PROJECT_FILE,
  PREVIEW_PROJECT_PATH,
  PREVIEW_USER_HOME,
  PREVIEW_WORK_ROOT,
  createPreviewBootstrap,
  normalizePreviewPresetId,
  type PreviewPresetId,
} from "./presets";

export type { PreviewPresetId, PreviewPresetOption } from "./presets";

export type PreviewUnlistenFn = () => void;

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
    editorFiles: createPreviewEditorFiles(PREVIEW_PROJECT_PATH),
    fileListCache: new Map(),
    fileListClock: Date.now(),
  };
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
      return recordPreviewHistoryEntry(previewState.bootstrap, PREVIEW_PROJECT_PATH, args) as T;
    case "remove_tab_history_entry":
      return removePreviewHistoryEntry(previewState.bootstrap, args) as T;
    case "trim_tab_history":
      return trimPreviewHistory(previewState.bootstrap, args) as T;
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
      return searchPreviewEditorFiles(previewState, PREVIEW_PROJECT_PATH, args) as T;
    case "list_session_files":
      return listPreviewEditorFiles(previewState, PREVIEW_PROJECT_PATH, args) as T;
    case "read_session_file":
      return readPreviewEditorFile(previewState, args) as T;
    case "write_session_file":
      return writePreviewEditorFile(previewState, PREVIEW_PROJECT_PATH, args) as T;
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

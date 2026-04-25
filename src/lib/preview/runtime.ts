import type { AppBootstrap } from "../types";
import { invokePreviewBridgeCommand } from "./bridge";
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
  PREVIEW_PROJECT_PATH,
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
    case "search_session_files":
      return searchPreviewEditorFiles(previewState, PREVIEW_PROJECT_PATH, args) as T;
    case "list_session_files":
      return listPreviewEditorFiles(previewState, PREVIEW_PROJECT_PATH, args) as T;
    case "read_session_file":
      return readPreviewEditorFile(previewState, args) as T;
    case "write_session_file":
      return writePreviewEditorFile(previewState, PREVIEW_PROJECT_PATH, args) as T;
    case "window_ready":
      previewState.readyWindows.add(String(args?.label ?? "main"));
      return undefined as T;
    case "is_window_ready":
      return previewState.readyWindows.has(String(args?.label ?? "main")) as T;
    default: {
      const bridgeResult = invokePreviewBridgeCommand<T>(command, args);
      return bridgeResult.handled ? (bridgeResult.value as T) : (undefined as T);
    }
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

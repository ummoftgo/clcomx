import {
  PREVIEW_PROJECT_FILE,
  PREVIEW_PROJECT_PATH,
  PREVIEW_USER_HOME,
  PREVIEW_WORK_ROOT,
} from "./presets";

export interface PreviewBridgeCommandResult<T> {
  handled: boolean;
  value?: T;
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

const PREVIEW_NOOP_COMMANDS = new Set([
  "open_in_editor",
  "set_session_pty",
  "set_session_aux_terminal_state",
  "set_session_resume_token",
  "clear_session_pty",
  "close_session",
  "close_session_by_pty",
  "update_window_geometry",
  "move_window_sessions_to_main",
  "close_window_sessions",
  "remove_window",
  "close_app",
  "save_clipboard_image",
  "open_image_cache_folder",
  "clear_image_cache",
  "notify_window_ready",
]);

function handled<T>(value: T): PreviewBridgeCommandResult<T> {
  return { handled: true, value };
}

function unhandled<T>(): PreviewBridgeCommandResult<T> {
  return { handled: false };
}

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

function resolvePreviewTerminalPath(args?: Record<string, unknown>) {
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
    };
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
    };
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
  };
}

export function invokePreviewBridgeCommand<T>(
  command: string,
  args?: Record<string, unknown>,
): PreviewBridgeCommandResult<T> {
  switch (command) {
    case "list_wsl_distros":
      return handled(["Ubuntu-24.04", "Debian", "Arch"] as T);
    case "list_wsl_directories":
      return handled(listPreviewDirectories(String(args?.path ?? "/home")) as T);
    case "list_available_editors":
      return handled([
        { id: "vscode", label: "VS Code" },
        { id: "cursor", label: "Cursor" },
        { id: "windsurf", label: "Windsurf" },
      ] as T);
    case "list_monospace_fonts":
      return handled(["JetBrains Mono", "Cascadia Code", "IBM Plex Mono", "Fira Code"] as T);
    case "resolve_terminal_path":
      return handled(resolvePreviewTerminalPath(args) as T);
    case "get_image_cache_stats":
      return handled({ path: "/tmp/clcomx-preview-image-cache", files: 0, bytes: 0 } as T);
    case "open_external_url":
      if (typeof args?.url === "string") {
        window.open(args.url, "_blank", "noopener,noreferrer");
      }
      return handled(undefined as T);
    case "load_custom_css":
      return handled("" as T);
    default:
      return PREVIEW_NOOP_COMMANDS.has(command) ? handled(undefined as T) : unhandled<T>();
  }
}

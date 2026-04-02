import { invoke } from "./tauri/core";

export interface DetectedEditor {
  id: string;
  label: string;
}

export interface ResolvedTerminalPath {
  raw: string;
  wslPath: string;
  copyText: string;
  windowsPath: string;
  line: number | null;
  column: number | null;
  isDirectory: boolean;
}

export type TerminalPathResolution =
  | {
      kind: "resolved";
      path: ResolvedTerminalPath;
    }
  | {
      kind: "candidates";
      raw: string;
      candidates: ResolvedTerminalPath[];
    };

export async function listAvailableEditors(): Promise<DetectedEditor[]> {
  return invoke("list_available_editors");
}

export async function resolveTerminalPath(
  raw: string,
  distro: string,
  workDir: string,
  sessionId?: string | null,
  homeDirHint?: string | null,
): Promise<TerminalPathResolution> {
  const args: Record<string, unknown> = { raw, distro, workDir };
  if (sessionId !== undefined && sessionId !== null && sessionId.trim() !== "") {
    args.sessionId = sessionId.trim();
  }

  if (homeDirHint !== undefined && homeDirHint !== null && homeDirHint.trim() !== "") {
    args.homeDirHint = homeDirHint.trim();
  }

  return invoke("resolve_terminal_path", args);
}

export async function openInEditor(
  editorId: string,
  path: ResolvedTerminalPath,
): Promise<void> {
  await invoke("open_in_editor", {
    editorId,
    windowsPath: path.windowsPath,
    line: path.line,
    column: path.column,
    isDirectory: path.isDirectory,
  });
}

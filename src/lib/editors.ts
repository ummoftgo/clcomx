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

export async function listAvailableEditors(): Promise<DetectedEditor[]> {
  return invoke("list_available_editors");
}

export async function resolveTerminalPath(
  raw: string,
  distro: string,
  workDir: string,
): Promise<ResolvedTerminalPath> {
  return invoke("resolve_terminal_path", { raw, distro, workDir });
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

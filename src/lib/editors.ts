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

export interface SearchSessionFilesResult {
  rootDir: string;
  results: EditorSearchResult[];
}

export interface ListSessionFilesResult {
  rootDir: string;
  results: EditorSearchResult[];
  lastUpdatedMs: number;
}

export interface EditorSearchResult {
  wslPath: string;
  relativePath: string;
  basename: string;
  line?: number | null;
  column?: number | null;
}

export interface ReadSessionFileResult {
  wslPath: string;
  content: string;
  languageId: string;
  sizeBytes: number;
  mtimeMs: number;
}

export interface WriteSessionFileResult {
  wslPath: string;
  sizeBytes: number;
  mtimeMs: number;
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

export async function searchSessionFiles(
  sessionId: string,
  rootDir: string,
  query: string,
  limit = 50,
): Promise<SearchSessionFilesResult> {
  return invoke("search_session_files", {
    sessionId,
    rootDir,
    query,
    limit,
  });
}

export async function listSessionFiles(
  sessionId: string,
  rootDir: string,
  forceRefresh = false,
): Promise<ListSessionFilesResult> {
  return invoke("list_session_files", {
    sessionId,
    rootDir,
    forceRefresh,
  });
}

export async function readSessionFile(
  sessionId: string,
  wslPath: string,
): Promise<ReadSessionFileResult> {
  return invoke("read_session_file", {
    sessionId,
    wslPath,
  });
}

export async function writeSessionFile(
  sessionId: string,
  wslPath: string,
  content: string,
  expectedMtimeMs: number,
): Promise<WriteSessionFileResult> {
  return invoke("write_session_file", {
    sessionId,
    wslPath,
    content,
    expectedMtimeMs,
  });
}

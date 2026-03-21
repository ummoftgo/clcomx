import { invoke } from "@tauri-apps/api/core";
import type { WorkspaceSnapshot } from "./types";

export interface PtyResumeCaptureResult {
  resumeToken: string | null;
}

export async function saveWorkspaceSnapshot(
  workspace: WorkspaceSnapshot,
): Promise<void> {
  await invoke("save_workspace", { workspace });
}

export async function setSessionPty(
  sessionId: string,
  ptyId: number,
): Promise<void> {
  await invoke("set_session_pty", { sessionId, ptyId });
}

export async function setSessionResumeToken(
  sessionId: string,
  resumeToken: string | null,
): Promise<void> {
  await invoke("set_session_resume_token", { sessionId, resumeToken });
}

export async function clearSessionPty(
  sessionId: string,
): Promise<void> {
  await invoke("clear_session_pty", { sessionId });
}

export async function closePtyAndCaptureResume(
  ptyId: number,
  agentId: string,
): Promise<PtyResumeCaptureResult> {
  return invoke("pty_close_and_capture_resume", { id: ptyId, agentId });
}

export async function detachSessionToNewWindow(
  sessionId: string,
  x: number,
  y: number,
  width: number,
  height: number,
): Promise<void> {
  await invoke("detach_session_to_new_window", {
    sessionId,
    x,
    y,
    width,
    height,
  });
}

export async function openEmptyWindow(
  x: number,
  y: number,
  width: number,
  height: number,
): Promise<string> {
  return invoke("open_empty_window", {
    x,
    y,
    width,
    height,
  });
}

export async function moveSessionToWindow(
  sessionId: string,
  targetLabel: string,
): Promise<void> {
  await invoke("move_session_to_window", { sessionId, targetLabel });
}

export async function closeSession(sessionId: string): Promise<void> {
  await invoke("close_session", { sessionId });
}

export async function closeSessionByPtyId(ptyId: number): Promise<void> {
  await invoke("close_session_by_pty", { ptyId });
}

export async function updateWindowGeometry(
  label: string,
  x: number,
  y: number,
  width: number,
  height: number,
  maximized: boolean,
): Promise<void> {
  await invoke("update_window_geometry", {
    label,
    x,
    y,
    width,
    height,
    maximized,
  });
}

export async function moveWindowSessionsToMain(label: string): Promise<void> {
  await invoke("move_window_sessions_to_main", { label });
}

export async function closeWindowSessions(label: string): Promise<void> {
  await invoke("close_window_sessions", { label });
}

export async function removeWindow(label: string): Promise<void> {
  await invoke("remove_window", { label });
}

export async function closeApp(): Promise<void> {
  await invoke("close_app");
}

export async function notifyWindowReady(label: string): Promise<void> {
  await invoke("window_ready", { label });
}

export async function isWindowReady(label: string): Promise<boolean> {
  return invoke("is_window_ready", { label });
}

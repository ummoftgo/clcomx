import { invoke } from "@tauri-apps/api/core";

export type TmuxSplitDirection = "horizontal" | "vertical";

export interface TmuxPaneSnapshot {
  paneId: string;
  active: boolean;
  dead: boolean;
  left: number;
  top: number;
  width: number;
  height: number;
  cursorX: number;
  cursorY: number;
  currentPath: string;
  currentCommand: string;
  historyText: string;
  screenText: string;
}

export interface TmuxSessionSnapshot {
  sessionName: string;
  activePaneId: string;
  width: number;
  height: number;
  panes: TmuxPaneSnapshot[];
}

export interface TmuxStateEvent {
  sessionId: string;
  snapshot: TmuxSessionSnapshot;
}

export interface TmuxOutputEvent {
  sessionId: string;
  paneId: string;
  data: string;
}

export interface TmuxErrorEvent {
  sessionId: string;
  message: string;
}

export async function createTmuxSession(
  distro: string,
  workDir: string,
  startCommand: string,
  sessionSeed: string,
  cols: number,
  rows: number,
  historyLines: number,
): Promise<TmuxSessionSnapshot> {
  return invoke("tmux_create_session", {
    distro,
    workDir,
    startCommand,
    sessionSeed,
    cols,
    rows,
    historyLines,
  });
}

export async function subscribeTmuxSession(
  sessionId: string,
  subscriberId: string,
  distro: string,
  workDir: string,
  startCommand: string,
  sessionName: string | null,
  cols: number,
  rows: number,
  historyLines: number,
): Promise<TmuxSessionSnapshot> {
  return invoke("tmux_subscribe_session", {
    sessionId,
    subscriberId,
    distro,
    workDir,
    startCommand,
    sessionName,
    cols,
    rows,
    historyLines,
  });
}

export async function unsubscribeTmuxSession(
  sessionId: string,
  subscriberId: string,
): Promise<void> {
  await invoke("tmux_unsubscribe_session", {
    sessionId,
    subscriberId,
  });
}

export async function getTmuxSessionSnapshot(
  distro: string,
  sessionName: string,
  historyLines: number,
): Promise<TmuxSessionSnapshot | null> {
  return invoke("tmux_get_session_snapshot", { distro, sessionName, historyLines });
}

export async function sendTmuxInput(
  sessionId: string,
  distro: string,
  paneId: string,
  data: string,
): Promise<void> {
  await invoke("tmux_send_input", { sessionId, distro, paneId, data });
}

export async function splitTmuxPane(
  sessionId: string,
  distro: string,
  targetPaneId: string,
  direction: TmuxSplitDirection,
  workDir: string,
): Promise<void> {
  await invoke("tmux_split_pane", { sessionId, distro, targetPaneId, direction, workDir });
}

export async function selectTmuxPane(
  sessionId: string,
  distro: string,
  paneId: string,
): Promise<void> {
  await invoke("tmux_select_pane", { sessionId, distro, paneId });
}

export async function selectTmuxPaneDirection(
  sessionId: string,
  distro: string,
  paneId: string,
  direction: "left" | "right" | "up" | "down",
): Promise<void> {
  await invoke("tmux_select_pane_direction", { sessionId, distro, paneId, direction });
}

export async function killTmuxPane(
  sessionId: string,
  distro: string,
  paneId: string,
): Promise<void> {
  await invoke("tmux_kill_pane", { sessionId, distro, paneId });
}

export async function killTmuxSession(
  distro: string,
  sessionName: string,
): Promise<void> {
  await invoke("tmux_kill_session", { distro, sessionName });
}

export async function resizeTmuxSession(
  sessionId: string,
  distro: string,
  sessionName: string,
  cols: number,
  rows: number,
): Promise<void> {
  await invoke("tmux_resize_session", { sessionId, distro, sessionName, cols, rows });
}

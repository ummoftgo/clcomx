import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { Session } from "../types";
import type { TmuxSessionSnapshot, TmuxStateEvent } from "../tmux";

let tmuxSessionSnapshots = $state<Record<string, TmuxSessionSnapshot>>({});
let runtimeReady = false;
let runtimeUnlisten: UnlistenFn | null = null;

function isNewerSnapshot(
  current: TmuxSessionSnapshot | null | undefined,
  next: TmuxSessionSnapshot,
) {
  if (!current) return true;
  if ((next.revision ?? 0) !== (current.revision ?? 0)) {
    return (next.revision ?? 0) > (current.revision ?? 0);
  }
  return (next.capturedAt ?? 0) >= (current.capturedAt ?? 0);
}

export function getTmuxSessionSnapshot(sessionId: string) {
  return tmuxSessionSnapshots[sessionId] ?? null;
}

export function getTmuxSessionSnapshots() {
  return tmuxSessionSnapshots;
}

export function applyTmuxSessionSnapshot(sessionId: string, snapshot: TmuxSessionSnapshot) {
  const current = tmuxSessionSnapshots[sessionId] ?? null;
  if (!isNewerSnapshot(current, snapshot)) {
    return current;
  }
  tmuxSessionSnapshots[sessionId] = snapshot;
  return snapshot;
}

export function clearTmuxSessionSnapshot(sessionId: string) {
  if (!(sessionId in tmuxSessionSnapshots)) return;
  delete tmuxSessionSnapshots[sessionId];
}

export function syncTmuxSnapshotSessions(sessions: Session[]) {
  const activeTmuxSessionIds = new Set(
    sessions.filter((session) => session.runtimeMode === "tmux").map((session) => session.id),
  );

  for (const sessionId of Object.keys(tmuxSessionSnapshots)) {
    if (activeTmuxSessionIds.has(sessionId)) continue;
    delete tmuxSessionSnapshots[sessionId];
  }
}

export async function initializeTmuxSnapshotRuntime() {
  if (runtimeReady) return;

  runtimeUnlisten = await listen<TmuxStateEvent>("clcomx:tmux/state", (event) => {
    applyTmuxSessionSnapshot(event.payload.sessionId, event.payload.snapshot);
  });

  runtimeReady = true;
}

export async function disposeTmuxSnapshotRuntime() {
  if (runtimeUnlisten) {
    runtimeUnlisten();
    runtimeUnlisten = null;
  }
  runtimeReady = false;
}

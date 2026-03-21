import type { WorkspaceSnapshot, WorkspaceWindowSnapshot } from "../types";

let workspaceSnapshot = $state<WorkspaceSnapshot | null>(null);
let currentWindowLabel = $state("main");

export function initializeWorkspaceSnapshot(
  workspace: WorkspaceSnapshot | null,
  windowLabel = "main",
) {
  workspaceSnapshot = workspace;
  currentWindowLabel = windowLabel;
}

export function syncWorkspaceSnapshot(workspace: WorkspaceSnapshot | null) {
  workspaceSnapshot = workspace;
}

export function getWorkspaceSnapshot() {
  return workspaceSnapshot;
}

export function getCurrentWindowLabel() {
  return currentWindowLabel;
}

export function getOtherWindows(): WorkspaceWindowSnapshot[] {
  return (workspaceSnapshot?.windows ?? []).filter((window) => window.label !== currentWindowLabel);
}

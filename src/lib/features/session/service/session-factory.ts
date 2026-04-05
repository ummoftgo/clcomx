import type { AgentId } from "../../../agents";
import { createRuntimeId } from "../../../ids";
import type { Session, TabHistoryEntry } from "../../../types";

export interface SessionLaunchRequest {
  agentId: AgentId;
  distro: string;
  workDir: string;
  title: string;
  resumeToken: string | null;
}

export function createSessionLaunchRequest(input: {
  agentId: AgentId;
  distro: string;
  workDir: string;
  title?: string | null;
  resumeToken?: string | null;
}): SessionLaunchRequest {
  const workDir = input.workDir;
  return {
    agentId: input.agentId,
    distro: input.distro,
    workDir,
    title: input.title ?? (workDir.split("/").pop() || workDir),
    resumeToken: input.resumeToken ?? null,
  };
}

export function createSessionLaunchRequestFromHistoryEntry(
  entry: TabHistoryEntry,
): SessionLaunchRequest {
  return createSessionLaunchRequest({
    agentId: entry.agentId ?? "claude",
    distro: entry.distro,
    workDir: entry.workDir,
    title: entry.title,
    resumeToken: entry.resumeToken ?? null,
  });
}

export function buildSession(request: SessionLaunchRequest): Session {
  return {
    id: createRuntimeId("session-"),
    ptyId: -1,
    auxPtyId: -1,
    auxVisible: false,
    auxHeightPercent: null,
    agentId: request.agentId,
    resumeToken: request.resumeToken,
    title: request.title,
    pinned: false,
    locked: false,
    terminal: null,
    element: null,
    distro: request.distro,
    workDir: request.workDir,
    viewMode: "terminal",
    editorRootDir: request.workDir,
    openEditorTabs: [],
    activeEditorPath: null,
    dirtyPaths: [],
  };
}

import type { AgentId } from "../../../agents";
import { createRuntimeId } from "../../../ids";
import type {
  Session,
  SessionCore,
  SessionEditorState,
  SessionShellRuntimeState,
  TabHistoryEntry,
} from "../../../types";

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

function buildSessionCore(request: SessionLaunchRequest): SessionCore {
  return {
    id: createRuntimeId("session-"),
    agentId: request.agentId,
    resumeToken: request.resumeToken,
    title: request.title,
    pinned: false,
    locked: false,
    distro: request.distro,
    workDir: request.workDir,
  };
}

function buildSessionShellRuntimeState(): SessionShellRuntimeState {
  return {
    ptyId: -1,
    auxPtyId: -1,
    auxVisible: false,
    auxHeightPercent: null,
  };
}

function buildSessionEditorState(rootDir: string): SessionEditorState {
  return {
    viewMode: "terminal",
    editorRootDir: rootDir,
    openEditorTabs: [],
    activeEditorPath: null,
    dirtyPaths: [],
  };
}

export function buildSession(request: SessionLaunchRequest): Session {
  return {
    ...buildSessionCore(request),
    ...buildSessionShellRuntimeState(),
    ...buildSessionEditorState(request.workDir),
  };
}

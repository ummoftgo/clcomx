import type { AgentId } from "../../../agents";
import { createRuntimeId } from "../../../ids";
import type {
  Session,
  SessionCore,
  SessionEditorState,
  SessionShellRuntimeState,
  TabHistoryEntry,
} from "../../../types";
import type { SessionRuntimeKind } from "../../agent-runtime/contracts/metadata";

export interface SessionLaunchRequest {
  agentId: AgentId;
  distro: string;
  workDir: string;
  title: string;
  resumeToken: string | null;
  /**
   * 세션 host 종류(15 §7.2). 미지정 시 기존 terminal host(pty)로 동작한다.
   * direct runtime 지원 launcher capability가 붙기 전까지는 호출부가 명시할 때만 채워진다.
   */
  runtimeKind?: SessionRuntimeKind;
}

export function createSessionLaunchRequest(input: {
  agentId: AgentId;
  distro: string;
  workDir: string;
  title?: string | null;
  resumeToken?: string | null;
  /** direct runtime 선택 시 host 종류(10 §5). 미지정 시 기존 PTY 경로. */
  runtimeKind?: SessionRuntimeKind;
}): SessionLaunchRequest {
  const workDir = input.workDir;
  return {
    agentId: input.agentId,
    distro: input.distro,
    workDir,
    title: input.title ?? (workDir.split("/").pop() || workDir),
    resumeToken: input.resumeToken ?? null,
    runtimeKind: input.runtimeKind,
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
    runtimeKind: entry.runtimeKind,
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
    runtimeKind: request.runtimeKind,
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

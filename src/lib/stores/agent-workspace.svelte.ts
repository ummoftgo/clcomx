import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { getAgentShortLabel } from "../agents";
import {
  appendActivityEvent,
  buildActivitySeed,
  buildNodeLabel,
  deriveTmuxNodeStatus,
  detectRuntimeAgentId,
  makeNodeSummary,
  summarizeActivityText,
} from "../agent-workspace";
import type { PtyOutputChunk } from "../pty";
import type { Session, ActivityEvent, AgentNode, AgentNodeStatus } from "../types";
import type { TmuxErrorEvent, TmuxOutputEvent, TmuxPaneSnapshot, TmuxSessionSnapshot } from "../tmux";

export interface AgentWorkspaceSessionState {
  sessionId: string;
  runtimeMode: Session["runtimeMode"];
  agentId: string;
  sessionTitle: string;
  rootNodeId: string;
  selectedNodeId: string;
  rootPaneId: string | null;
  nodes: AgentNode[];
  activityByNodeId: Record<string, ActivityEvent[]>;
}

let agentWorkspaceSessions = $state<Record<string, AgentWorkspaceSessionState>>({});
const ptyToSessionId = new Map<number, string>();
const seededPtyIds = new Set<number>();
const seededSurfaceRefs = new Set<string>();
let runtimeListeners: UnlistenFn[] = [];
let runtimeReady = false;

function nowIso() {
  return new Date().toISOString();
}

function getRootNodeId(sessionId: string) {
  return `${sessionId}::root`;
}

function getPaneNodeId(sessionId: string, paneId: string) {
  return `${sessionId}::pane::${paneId}`;
}

function getWorkspaceSession(sessionId: string) {
  return agentWorkspaceSessions[sessionId] ?? null;
}

function ensureWorkspaceSession(session: Session) {
  const existing = getWorkspaceSession(session.id);
  const rootNodeId = getRootNodeId(session.id);
  if (existing) {
    existing.runtimeMode = session.runtimeMode;
    existing.agentId = session.agentId;
    existing.sessionTitle = session.title;
    const rootNode = existing.nodes.find((node) => node.id === rootNodeId);
    if (rootNode) {
      rootNode.label = getAgentShortLabel(session.agentId);
      rootNode.agentId = session.agentId;
      rootNode.summary = summarizeRootSummary(session);
      rootNode.currentCommand = session.agentId;
      rootNode.currentPath = session.workDir;
      rootNode.status = deriveRootStatus(session);
      rootNode.lastActiveAt = nowIso();
    }
    return existing;
  }

  const createdAt = nowIso();
  const rootNode: AgentNode = {
    id: rootNodeId,
    sessionId: session.id,
    parentId: null,
    agentId: session.agentId,
    label: getAgentShortLabel(session.agentId),
    status: deriveRootStatus(session),
    surfaceRef: { kind: "session-root", id: session.id },
    summary: summarizeRootSummary(session),
    currentCommand: session.agentId,
    currentPath: session.workDir,
    startedAt: createdAt,
    lastActiveAt: createdAt,
  };

  const state: AgentWorkspaceSessionState = {
    sessionId: session.id,
    runtimeMode: session.runtimeMode,
    agentId: session.agentId,
    sessionTitle: session.title,
    rootNodeId,
    selectedNodeId: rootNodeId,
    rootPaneId: null,
    nodes: [rootNode],
    activityByNodeId: { [rootNodeId]: [] },
  };
  agentWorkspaceSessions[session.id] = state;
  return state;
}

function summarizeRootSummary(session: Session) {
  const segments = session.workDir.split("/").filter(Boolean);
  const pathLeaf = segments[segments.length - 1] ?? session.workDir;
  return `${getAgentShortLabel(session.agentId)} · ${pathLeaf}`;
}

function deriveRootStatus(session: Session): AgentNodeStatus {
  if (session.runtimeMode === "tmux") {
    return session.tmuxSessionName ? "running" : "idle";
  }
  return session.ptyId >= 0 ? "running" : "idle";
}

function findNode(state: AgentWorkspaceSessionState, nodeId: string) {
  return state.nodes.find((node) => node.id === nodeId) ?? null;
}

function ensureActivityBucket(state: AgentWorkspaceSessionState, nodeId: string) {
  if (!state.activityByNodeId[nodeId]) {
    state.activityByNodeId[nodeId] = [];
  }
  return state.activityByNodeId[nodeId];
}

function ensurePaneNode(
  state: AgentWorkspaceSessionState,
  sessionAgentId: string,
  pane: TmuxPaneSnapshot,
) {
  if (!state.rootPaneId) {
    state.rootPaneId = pane.paneId;
    const rootNode = findNode(state, state.rootNodeId);
    if (rootNode) {
      rootNode.surfaceRef = { kind: "tmux-pane", id: pane.paneId };
    }
  }

  if (pane.paneId === state.rootPaneId) {
    const rootNode = findNode(state, state.rootNodeId);
    if (!rootNode) {
      return state.rootNodeId;
    }
    rootNode.status = deriveTmuxNodeStatus(pane.active, pane.dead);
    rootNode.currentCommand = pane.currentCommand;
    rootNode.currentPath = pane.currentPath;
    rootNode.summary = makeNodeSummary(
      pane.currentCommand,
      pane.currentPath,
      getAgentShortLabel(sessionAgentId),
    );
    rootNode.lastActiveAt = nowIso();
    return rootNode.id;
  }

  const nodeId = getPaneNodeId(state.sessionId, pane.paneId);
  const agentId = detectRuntimeAgentId(pane.currentCommand, sessionAgentId);
  let node = findNode(state, nodeId);
  if (!node) {
    const createdAt = nowIso();
    node = {
      id: nodeId,
      sessionId: state.sessionId,
      parentId: state.rootNodeId,
      agentId,
      label: buildNodeLabel(agentId),
      status: deriveTmuxNodeStatus(pane.active, pane.dead),
      surfaceRef: { kind: "tmux-pane", id: pane.paneId },
      summary: makeNodeSummary(pane.currentCommand, pane.currentPath, buildNodeLabel(agentId)),
      currentCommand: pane.currentCommand,
      currentPath: pane.currentPath,
      startedAt: createdAt,
      lastActiveAt: createdAt,
    };
    state.nodes.push(node);
  } else {
    node.agentId = agentId;
    node.label = buildNodeLabel(agentId);
    node.status = deriveTmuxNodeStatus(pane.active, pane.dead);
    node.summary = makeNodeSummary(pane.currentCommand, pane.currentPath, node.label);
    node.currentCommand = pane.currentCommand;
    node.currentPath = pane.currentPath;
    node.lastActiveAt = nowIso();
  }

  ensureActivityBucket(state, nodeId);
  return nodeId;
}

function appendNodeActivity(
  state: AgentWorkspaceSessionState,
  nodeId: string,
  kind: ActivityEvent["kind"],
  text: string,
  timestamp = Date.now(),
) {
  const node = findNode(state, nodeId);
  if (!node) return;

  const bucket = ensureActivityBucket(state, nodeId);
  appendActivityEvent(bucket, state.sessionId, nodeId, kind, text, timestamp);
  node.lastActiveAt = new Date(timestamp).toISOString();
  node.summary = summarizeActivityText(text, node.summary);
  if (node.status === "idle") {
    node.status = "running";
  }
}

function ensureFallbackPaneNode(state: AgentWorkspaceSessionState, paneId: string) {
  const nodeId = getPaneNodeId(state.sessionId, paneId);
  let node = findNode(state, nodeId);
  if (!node) {
    const createdAt = nowIso();
    node = {
      id: nodeId,
      sessionId: state.sessionId,
      parentId: state.rootNodeId,
      agentId: state.agentId,
      label: buildNodeLabel(state.agentId),
      status: "running",
      surfaceRef: { kind: "tmux-pane", id: paneId },
      summary: "Waiting for runtime metadata",
      currentCommand: "",
      currentPath: "",
      startedAt: createdAt,
      lastActiveAt: createdAt,
    };
    state.nodes.push(node);
  }
  ensureActivityBucket(state, nodeId);
  return nodeId;
}

function markPlainSessionExited(sessionId: string) {
  const state = getWorkspaceSession(sessionId);
  if (!state) return;
  const rootNode = findNode(state, state.rootNodeId);
  if (!rootNode) return;
  rootNode.status = "done";
  rootNode.lastActiveAt = nowIso();
}

function seedPlainSessionTranscript(sessionId: string, ptyId: number, data: string) {
  const state = getWorkspaceSession(sessionId);
  if (!state || !data) return;
  if (seededPtyIds.has(ptyId)) return;
  seededPtyIds.add(ptyId);
  appendNodeActivity(state, state.rootNodeId, "snapshot", data, Date.now());
}

function ingestTmuxSnapshot(sessionId: string, snapshot: TmuxSessionSnapshot) {
  const state = getWorkspaceSession(sessionId);
  if (!state) return;

  if (!state.rootPaneId) {
    state.rootPaneId = snapshot.activePaneId || (snapshot.panes[0]?.paneId ?? null);
  }

  const presentNodeIds = new Set<string>([state.rootNodeId]);
  for (const pane of snapshot.panes) {
    const nodeId = ensurePaneNode(state, state.agentId, pane);
    presentNodeIds.add(nodeId);
    const seedKey = `${sessionId}:${pane.paneId}`;
    if (!seededSurfaceRefs.has(seedKey)) {
      const seedText = buildActivitySeed(pane.historyText, pane.screenText);
      if (seedText) {
        appendNodeActivity(state, nodeId, "snapshot", seedText, Date.now());
      }
      seededSurfaceRefs.add(seedKey);
    }
  }

  for (const node of state.nodes) {
    if (node.parentId && !presentNodeIds.has(node.id) && node.status !== "done") {
      node.status = "done";
      node.lastActiveAt = nowIso();
    }
  }

  if (state.selectedNodeId !== state.rootNodeId && !findNode(state, state.selectedNodeId)) {
    state.selectedNodeId = state.rootNodeId;
  }
}

function handleTmuxOutput(sessionId: string, paneId: string, data: string) {
  const state = getWorkspaceSession(sessionId);
  if (!state) return;
  const nodeId =
    state.rootPaneId && paneId === state.rootPaneId
      ? state.rootNodeId
      : ensureFallbackPaneNode(state, paneId);
  appendNodeActivity(state, nodeId, "output", data, Date.now());
}

function handleTmuxError(sessionId: string, message: string) {
  const state = getWorkspaceSession(sessionId);
  if (!state) return;
  const rootNode = findNode(state, state.rootNodeId);
  if (!rootNode) return;
  rootNode.status = "error";
  rootNode.summary = summarizeActivityText(message, rootNode.summary);
  appendNodeActivity(state, state.rootNodeId, "status", message, Date.now());
}

export function getAgentWorkspaceSession(sessionId: string) {
  return agentWorkspaceSessions[sessionId] ?? null;
}

export function getAgentWorkspaceSessions() {
  return agentWorkspaceSessions;
}

export function getSelectedActivityEvents(sessionId: string) {
  const state = getWorkspaceSession(sessionId);
  if (!state) return [];
  return state.activityByNodeId[state.selectedNodeId] ?? [];
}

export function getSelectedAgentNode(sessionId: string) {
  const state = getWorkspaceSession(sessionId);
  if (!state) return null;
  return findNode(state, state.selectedNodeId);
}

export function sessionHasChildAgents(sessionId: string) {
  const state = getWorkspaceSession(sessionId);
  if (!state) return false;
  return state.nodes.some((node) => node.parentId === state.rootNodeId);
}

export function selectAgentWorkspaceNode(sessionId: string, nodeId: string) {
  const state = getWorkspaceSession(sessionId);
  if (!state) return;
  if (!findNode(state, nodeId)) return;
  state.selectedNodeId = nodeId;
}

export function getSelectedAgentWorkspacePaneId(sessionId: string) {
  const state = getWorkspaceSession(sessionId);
  if (!state) return null;
  const selectedNode = findNode(state, state.selectedNodeId);
  if (!selectedNode) return state.rootPaneId;
  if (selectedNode.surfaceRef.kind === "tmux-pane") {
    return selectedNode.surfaceRef.id;
  }
  return state.rootPaneId;
}

export function syncAgentWorkspaceSessions(sessions: Session[]) {
  const activeSessionIds = new Set<string>();
  ptyToSessionId.clear();

  for (const session of sessions) {
    activeSessionIds.add(session.id);
    const state = ensureWorkspaceSession(session);
    const rootNode = findNode(state, state.rootNodeId);
    if (rootNode && session.runtimeMode === "plain" && session.ptyId >= 0) {
      rootNode.surfaceRef = { kind: "session-root", id: session.id };
    }
    if (session.runtimeMode === "plain" && session.ptyId >= 0) {
      ptyToSessionId.set(session.ptyId, session.id);
    }
  }

  for (const sessionId of Object.keys(agentWorkspaceSessions)) {
    if (activeSessionIds.has(sessionId)) continue;
    delete agentWorkspaceSessions[sessionId];
  }
}

export function syncAgentSessions(sessions: Session[]) {
  syncAgentWorkspaceSessions(sessions);
}

export function appendPlainAgentOutputByPtyId(ptyId: number, data: string) {
  const sessionId = ptyToSessionId.get(ptyId);
  if (!sessionId) return;
  const state = getWorkspaceSession(sessionId);
  if (!state) return;
  appendNodeActivity(state, state.rootNodeId, "output", data, Date.now());
}

export function hydratePlainAgentTranscript(sessionId: string, ptyId: number, data: string) {
  seedPlainSessionTranscript(sessionId, ptyId, data);
}

export function applyTmuxAgentSnapshot(sessionId: string, snapshot: TmuxSessionSnapshot) {
  ingestTmuxSnapshot(sessionId, snapshot);
}

export function appendTmuxAgentOutput(sessionId: string, paneId: string, data: string) {
  handleTmuxOutput(sessionId, paneId, data);
}

export async function initializeAgentWorkspaceRuntime() {
  if (runtimeReady) return;

  runtimeListeners = await Promise.all([
    listen<PtyOutputChunk>("pty-output", (event) => {
      const sessionId = ptyToSessionId.get(event.payload.id);
      if (!sessionId) return;
      const state = getWorkspaceSession(sessionId);
      if (!state) return;
      appendNodeActivity(state, state.rootNodeId, "output", event.payload.data, Date.now());
    }),
    listen<number>("pty-exit", (event) => {
      const sessionId = ptyToSessionId.get(event.payload);
      if (!sessionId) return;
      markPlainSessionExited(sessionId);
      ptyToSessionId.delete(event.payload);
    }),
    listen<TmuxOutputEvent>("clcomx:tmux/output", (event) => {
      handleTmuxOutput(event.payload.sessionId, event.payload.paneId, event.payload.data);
    }),
    listen<TmuxErrorEvent>("clcomx:tmux/error", (event) => {
      handleTmuxError(event.payload.sessionId, event.payload.message);
    }),
  ]);

  runtimeReady = true;
}

export async function destroyAgentWorkspaceRuntime() {
  const listeners = runtimeListeners;
  runtimeListeners = [];
  runtimeReady = false;
  await Promise.all(listeners.map(async (unlisten) => {
    await unlisten();
  }));
}

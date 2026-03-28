import { getAgentShortLabel, type AgentId } from "./agents";
import type { ActivityEvent, AgentNodeStatus } from "./types";

const ANSI_CSI_REGEX = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;
const ANSI_OSC_REGEX = /\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g;
const OTHER_CONTROL_REGEX = /[\u0000-\u0008\u000b-\u001f\u007f]/g;
const OUTPUT_MERGE_WINDOW_MS = 900;
const MAX_ACTIVITY_EVENTS = 120;

export function normalizeActivityText(value: string) {
  if (!value) return "";

  let normalized = value.replace(/\r\n/g, "\n");
  normalized = normalized.replace(ANSI_OSC_REGEX, "");
  normalized = normalized.replace(ANSI_CSI_REGEX, "");
  normalized = applyBackspaceControls(normalized);
  normalized = normalized.replace(/\r/g, "");
  normalized = normalized.replace(OTHER_CONTROL_REGEX, "");
  return normalized;
}

export function summarizeActivityText(value: string, fallback: string) {
  const normalized = normalizeActivityText(value);
  const lines = normalized
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  return lines[lines.length - 1] ?? fallback;
}

export function buildActivitySeed(historyText: string, screenText: string) {
  const history = normalizeActivityText(historyText).trimEnd();
  const screen = normalizeActivityText(screenText).trimEnd();
  if (history && screen) {
    if (history.endsWith(screen)) {
      return history;
    }
    return `${history}\n${screen}`.trim();
  }
  return history || screen;
}

export function detectRuntimeAgentId(command: string, fallbackAgentId: AgentId): AgentId {
  const normalized = command.trim().toLowerCase();
  if (!normalized) return fallbackAgentId;
  if (normalized.includes("claude")) return "claude";
  if (normalized.includes("codex")) return "codex";
  return fallbackAgentId;
}

export function buildNodeLabel(agentId: AgentId) {
  return getAgentShortLabel(agentId);
}

export function deriveTmuxNodeStatus(active: boolean, dead: boolean): AgentNodeStatus {
  if (dead) return "done";
  if (active) return "running";
  return "idle";
}

export function makeNodeSummary(command: string, currentPath: string, fallback: string) {
  const commandLabel = command.trim() || fallback;
  const pathSegments = currentPath.trim().split("/").filter(Boolean);
  const leaf = pathSegments[pathSegments.length - 1] ?? currentPath.trim();
  if (!leaf) return commandLabel;
  return `${commandLabel} · ${leaf}`;
}

export function appendActivityEvent(
  events: ActivityEvent[],
  sessionId: string,
  agentNodeId: string,
  kind: ActivityEvent["kind"],
  text: string,
  timestamp = Date.now(),
) {
  const normalized = normalizeActivityText(text);
  if (!normalized.trim()) {
    return events;
  }

  const timestampIso = new Date(timestamp).toISOString();
  const tail = events[events.length - 1];
  if (
    tail &&
    tail.kind === kind &&
    tail.agentNodeId === agentNodeId &&
    timestamp - Date.parse(tail.timestamp) <= OUTPUT_MERGE_WINDOW_MS
  ) {
    tail.text += normalized;
    tail.timestamp = timestampIso;
  } else {
    events.push({
      id: crypto.randomUUID(),
      sessionId,
      agentNodeId,
      kind,
      text: normalized,
      timestamp: timestampIso,
    });
  }

  if (events.length > MAX_ACTIVITY_EVENTS) {
    events.splice(0, events.length - MAX_ACTIVITY_EVENTS);
  }

  return events;
}

function applyBackspaceControls(value: string) {
  let result = "";
  for (const char of value) {
    if (char === "\b") {
      result = result.slice(0, -1);
      continue;
    }
    result += char;
  }
  return result;
}

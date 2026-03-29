import type { TabHistoryEntry } from "../types";
import type { AgentId } from "../agents";
import {
  recordTabHistoryEntry,
  removeTabHistoryEntry as removeTabHistoryEntryCommand,
  trimTabHistoryEntries,
} from "../tab-history";

let tabHistory = $state<TabHistoryEntry[]>([]);

export function getTabHistory() {
  return tabHistory;
}

export function initializeTabHistory(entries: TabHistoryEntry[]) {
  tabHistory.splice(0, tabHistory.length, ...entries);
}

export async function recordTabHistory(
  agentId: AgentId,
  distro: string,
  workDir: string,
  title: string,
  resumeToken?: string | null,
) {
  try {
    const entries = await recordTabHistoryEntry(agentId, distro, workDir, title, resumeToken);
    tabHistory.splice(0, tabHistory.length, ...entries);
  } catch (error) {
    console.error("Failed to record tab history", error);
  }
}

export async function applyTabHistoryLimit(limit: number) {
  try {
    const entries = await trimTabHistoryEntries(limit);
    tabHistory.splice(0, tabHistory.length, ...entries);
  } catch (error) {
    console.error("Failed to trim tab history", error);
  }
}

export async function removeTabHistoryEntry(entry: TabHistoryEntry) {
  try {
    const entries = await removeTabHistoryEntryCommand(entry);
    tabHistory.splice(0, tabHistory.length, ...entries);
  } catch (error) {
    console.error("Failed to remove tab history entry", error);
    throw error;
  }
}

import { invoke } from "@tauri-apps/api/core";
import type { TabHistoryEntry } from "./types";
import type { AgentId } from "./agents";

export async function recordTabHistoryEntry(
  agentId: AgentId,
  distro: string,
  workDir: string,
  title: string,
  resumeToken?: string | null,
): Promise<TabHistoryEntry[]> {
  return invoke<TabHistoryEntry[]>("record_tab_history", {
    agentId,
    distro,
    workDir,
    title,
    resumeToken,
  });
}

export async function trimTabHistoryEntries(limit: number): Promise<TabHistoryEntry[]> {
  return invoke<TabHistoryEntry[]>("trim_tab_history", { limit });
}

export async function removeTabHistoryEntry(entry: TabHistoryEntry): Promise<TabHistoryEntry[]> {
  return invoke<TabHistoryEntry[]>("remove_tab_history_entry", { entry });
}

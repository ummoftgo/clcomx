import { invoke } from "./tauri/core";
import type { TabHistoryEntry } from "./types";
import type { AgentId } from "./agents";
import type { SessionRuntimeKind } from "./features/agent-runtime/contracts/metadata";

/** history에는 direct host 표식만 저장하고 PTY/기타 값은 legacy 형식으로 둔다. */
function historyRuntimeKind(runtimeKind?: SessionRuntimeKind) {
  return runtimeKind?.startsWith("direct-") ? runtimeKind : undefined;
}

export async function recordTabHistoryEntry(
  agentId: AgentId,
  distro: string,
  workDir: string,
  title: string,
  _resumeToken?: string | null,
  runtimeKind?: SessionRuntimeKind,
): Promise<TabHistoryEntry[]> {
  return invoke<TabHistoryEntry[]>("record_tab_history", {
    agentId,
    distro,
    workDir,
    title,
    resumeToken: null,
    runtimeKind: historyRuntimeKind(runtimeKind),
  });
}

export async function trimTabHistoryEntries(limit: number): Promise<TabHistoryEntry[]> {
  return invoke<TabHistoryEntry[]>("trim_tab_history", { limit });
}

export async function removeTabHistoryEntry(entry: TabHistoryEntry): Promise<TabHistoryEntry[]> {
  return invoke<TabHistoryEntry[]>("remove_tab_history_entry", { entry });
}

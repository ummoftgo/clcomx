import type { AgentId } from "../../../agents";
import type { TabHistoryEntry } from "../../../types";

export interface SessionLauncherProps {
  visible: boolean;
  embedded?: boolean;
  historyEntries: TabHistoryEntry[];
  onOpenHistory: (entry: TabHistoryEntry) => void;
  onConfirm: (agentId: AgentId, distro: string, workDir: string) => void;
  onCancel?: () => void;
}

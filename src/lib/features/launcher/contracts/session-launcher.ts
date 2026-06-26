import type { AgentId } from "../../../agents";
import type { TabHistoryEntry } from "../../../types";
import type { SessionRuntimeKind } from "../../agent-runtime/contracts/metadata";

export interface SessionLauncherProps {
  visible: boolean;
  embedded?: boolean;
  historyEntries: TabHistoryEntry[];
  onOpenHistory: (entry: TabHistoryEntry) => void;
  /**
   * 세션 생성 확정. runtimeKind는 direct 선택 시에만 "direct-*"이고, 그 외(미지정/PTY)는 생략한다(10 §5).
   * 기존 호출부 호환을 위해 마지막 인자는 optional이다.
   */
  onConfirm: (
    agentId: AgentId,
    distro: string,
    workDir: string,
    runtimeKind?: SessionRuntimeKind,
  ) => void;
  onCancel?: () => void;
}

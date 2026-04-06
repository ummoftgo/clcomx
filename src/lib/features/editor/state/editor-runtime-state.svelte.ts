import type { InternalEditorTab } from "../../../editor/contracts";

export interface EditorRuntimeState {
  tabs: InternalEditorTab[];
  activePath: string | null;
  savedContentByPath: Record<string, string>;
  mtimeByPath: Record<string, number>;
  statusText: string | null;
  closeConfirmVisible: boolean;
  closeConfirmPath: string | null;
}

class EditorRuntimeStateImpl implements EditorRuntimeState {
  tabs = $state<InternalEditorTab[]>([]);
  activePath = $state<string | null>(null);
  savedContentByPath = $state<Record<string, string>>({});
  mtimeByPath = $state<Record<string, number>>({});
  statusText = $state<string | null>(null);
  closeConfirmVisible = $state(false);
  closeConfirmPath = $state<string | null>(null);
}

export function createEditorRuntimeState(): EditorRuntimeState {
  return new EditorRuntimeStateImpl();
}

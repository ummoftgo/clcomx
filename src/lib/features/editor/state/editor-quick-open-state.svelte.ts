import type { EditorSearchResult } from "../../../editors";

export interface EditorQuickOpenState {
  visible: boolean;
  query: string;
  rootDir: string;
  entries: EditorSearchResult[];
  lastUpdatedMs: number;
  busy: boolean;
  openKey: number;
  requestToken: number;
  prewarmHandle: ReturnType<typeof setTimeout> | number | null;
  prewarmToken: number;
  prewarmRequestedRootDir: string;
  prewarmInFlightRootDir: string;
  monacoPrewarmHandle: ReturnType<typeof setTimeout> | number | null;
  monacoPrewarmToken: number;
  monacoPrewarming: boolean;
  monacoPrewarmed: boolean;
}

class EditorQuickOpenStateImpl implements EditorQuickOpenState {
  visible = $state(false);
  query = $state("");
  rootDir = $state("");
  entries = $state<EditorSearchResult[]>([]);
  lastUpdatedMs = $state(0);
  busy = $state(false);
  openKey = $state(0);
  requestToken = 0;
  prewarmHandle: ReturnType<typeof setTimeout> | number | null = null;
  prewarmToken = 0;
  prewarmRequestedRootDir = $state("");
  prewarmInFlightRootDir = $state("");
  monacoPrewarmHandle: ReturnType<typeof setTimeout> | number | null = null;
  monacoPrewarmToken = 0;
  monacoPrewarming = $state(false);
  monacoPrewarmed = $state(false);
}

export function createEditorQuickOpenState(): EditorQuickOpenState {
  return new EditorQuickOpenStateImpl();
}

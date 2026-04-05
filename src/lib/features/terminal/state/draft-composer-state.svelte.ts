export interface DraftComposerState {
  draftPanelEl: HTMLDivElement | null;
  draftEl: HTMLTextAreaElement | null;
  draftValue: string;
  draftOpen: boolean;
  draftHeightPx: number | null;
  draftNaturalHeightPx: number | null;
}

class DraftComposerStateImpl implements DraftComposerState {
  draftPanelEl = $state<HTMLDivElement | null>(null);
  draftEl = $state<HTMLTextAreaElement | null>(null);
  draftValue = $state("");
  draftOpen = $state(false);
  draftHeightPx = $state<number | null>(null);
  draftNaturalHeightPx = $state<number | null>(null);
}

export function createDraftComposerState(): DraftComposerState {
  return new DraftComposerStateImpl();
}

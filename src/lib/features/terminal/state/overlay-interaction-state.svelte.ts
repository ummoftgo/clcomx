import type { PendingClipboardImage } from "../../../clipboard";
import type { ResolvedTerminalPath } from "../../../editors";

export type LinkMenuTarget =
  | { kind: "url"; url: string }
  | { kind: "file"; path: ResolvedTerminalPath }
  | { kind: "file-candidates"; raw: string; candidates: ResolvedTerminalPath[] };

export interface OverlayInteractionState {
  pendingClipboardImage: PendingClipboardImage | null;
  linkMenuVisible: boolean;
  linkMenuX: number;
  linkMenuY: number;
  linkMenuTarget: LinkMenuTarget | null;
  linkHovering: boolean;
  suppressSelectionUntilMouseUp: boolean;
  clipboardBusy: boolean;
  clipboardError: string | null;
  clipboardNotice: string | null;
  editorPickerVisible: boolean;
  editorPickerPath: ResolvedTerminalPath | null;
  noticeTimer: ReturnType<typeof setTimeout> | null;
}

class OverlayInteractionStateImpl implements OverlayInteractionState {
  pendingClipboardImage = $state<PendingClipboardImage | null>(null);
  linkMenuVisible = $state(false);
  linkMenuX = $state(0);
  linkMenuY = $state(0);
  linkMenuTarget = $state<LinkMenuTarget | null>(null);
  linkHovering = $state(false);
  suppressSelectionUntilMouseUp = false;
  clipboardBusy = $state(false);
  clipboardError = $state<string | null>(null);
  clipboardNotice = $state<string | null>(null);
  editorPickerVisible = $state(false);
  editorPickerPath = $state<ResolvedTerminalPath | null>(null);
  noticeTimer: ReturnType<typeof setTimeout> | null = null;
}

export function createOverlayInteractionState(): OverlayInteractionState {
  return new OverlayInteractionStateImpl();
}

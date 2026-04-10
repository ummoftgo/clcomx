import type {
  PendingClipboardImage,
  SavedClipboardImage,
} from "../../../clipboard";
import type { OverlayInteractionState } from "../state/overlay-interaction-state.svelte";

type TranslateFn = (key: string, options?: Record<string, unknown>) => string;

interface OverlayClipboardImageDeps {
  getDistro: () => string;
  getVisible: () => boolean;
  getDraftOpen: () => boolean;
  focusDraft: () => void;
  focusOutput: () => void;
  routeInsertedText: (text: string) => void;
  setNotice: (message: string) => void;
  t: TranslateFn;
  createPendingClipboardImage: (blob: Blob) => PendingClipboardImage;
  revokePendingClipboardImage: (image: PendingClipboardImage | null) => void;
  readImageFromClipboard: () => Promise<Blob | null>;
  getImageFromPasteEvent: (event: ClipboardEvent) => Blob | null;
  saveClipboardImage: (
    image: PendingClipboardImage,
    distro: string,
  ) => Promise<SavedClipboardImage>;
  formatPathForAgentInput: (path: string) => string;
}

export function createOverlayClipboardImageController(
  state: OverlayInteractionState,
  deps: OverlayClipboardImageDeps,
) {
  const restoreFocus = () => {
    if (deps.getDraftOpen()) {
      deps.focusDraft();
    } else {
      deps.focusOutput();
    }
  };

  const resetClipboardImage = (restore = false) => {
    const current = state.pendingClipboardImage;
    state.pendingClipboardImage = null;
    state.clipboardError = null;
    deps.revokePendingClipboardImage(current);

    if (restore) {
      restoreFocus();
    }
  };

  const openClipboardPreview = (blob: Blob) => {
    const nextImage = deps.createPendingClipboardImage(blob);
    deps.revokePendingClipboardImage(state.pendingClipboardImage);
    state.pendingClipboardImage = nextImage;
    state.clipboardError = null;
  };

  const handlePasteImageFromClipboard = async () => {
    try {
      const imageBlob = await deps.readImageFromClipboard();
      if (!imageBlob) {
        deps.setNotice(deps.t("terminal.assist.clipboardNoImage"));
        restoreFocus();
        return;
      }

      openClipboardPreview(imageBlob);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      deps.setNotice(message);
      restoreFocus();
    }
  };

  const confirmClipboardImage = async () => {
    if (!state.pendingClipboardImage) return;

    state.clipboardBusy = true;
    state.clipboardError = null;

    try {
      const savedImage = await deps.saveClipboardImage(state.pendingClipboardImage, deps.getDistro());
      const text = deps.formatPathForAgentInput(savedImage.wslPath);
      deps.routeInsertedText(text);
      resetClipboardImage(true);
    } catch (error) {
      state.clipboardError = error instanceof Error ? error.message : String(error);
    } finally {
      state.clipboardBusy = false;
    }
  };

  const handleDraftPaste = (event: ClipboardEvent) => {
    const imageBlob = deps.getImageFromPasteEvent(event);
    if (!imageBlob) {
      return;
    }

    event.preventDefault();
    openClipboardPreview(imageBlob);
  };

  const handleTerminalPaste = (event: ClipboardEvent) => {
    if (!deps.getVisible()) return;

    const imageBlob = deps.getImageFromPasteEvent(event);
    if (!imageBlob) {
      return;
    }

    event.preventDefault();
    openClipboardPreview(imageBlob);
  };

  const dispose = () => {
    deps.revokePendingClipboardImage(state.pendingClipboardImage);
    state.pendingClipboardImage = null;
    state.clipboardBusy = false;
    state.clipboardError = null;
  };

  return {
    openClipboardPreview,
    resetClipboardImage,
    handlePasteImageFromClipboard,
    confirmClipboardImage,
    handleDraftPaste,
    handleTerminalPaste,
    dispose,
  };
}

import type { Terminal } from "@xterm/xterm";
import type { DraftComposerState } from "../state/draft-composer-state.svelte";

type TickFn = () => Promise<void>;

interface DraftComposerDeps {
  getVisible: () => boolean;
  getUiScale: () => number;
  getTerminalFontSize: () => number;
  getShellHeight: () => number;
  getAssistPanelHeight: () => number;
  focusOutput: () => void;
  getAuxVisible: () => boolean;
  hideAuxTerminal: (options?: { restoreFocus?: boolean }) => void;
  getTerminal: () => Terminal | null;
  getLivePtyId: () => number;
  writeLivePty: (text: string) => Promise<void>;
  tick: TickFn;
}

export function createDraftComposerController(
  state: DraftComposerState,
  deps: DraftComposerDeps,
) {
  let resizingDraft = false;
  let draftResizePointerId: number | null = null;
  let draftResizeStartY = 0;
  let draftResizeStartHeightPx = 0;

  function syncDraftHeight() {
    if (!state.draftEl) return;
    state.draftEl.style.height = "";
    state.draftEl.style.overflowY = "auto";
  }

  function focusDraft(moveCaretToEnd = false) {
    if (!deps.getVisible() || !state.draftOpen) return;

    deps.tick().then(() => {
      state.draftEl?.focus();
      if (moveCaretToEnd && state.draftEl) {
        const length = state.draftEl.value.length;
        state.draftEl.setSelectionRange(length, length);
      }
    });
  }

  function getDraftMinHeightPx() {
    return (
      state.draftNaturalHeightPx ??
      Math.max(128 * deps.getUiScale(), deps.getTerminalFontSize() * 5.5)
    );
  }

  function measureDraftNaturalHeight() {
    if (!state.draftPanelEl) {
      return null;
    }

    const rectHeight = Math.round(state.draftPanelEl.getBoundingClientRect().height);
    const scrollHeight = Math.round(state.draftPanelEl.scrollHeight);
    const measuredHeight = Math.max(rectHeight, scrollHeight);
    return measuredHeight > 0 ? measuredHeight : null;
  }

  function rememberDraftNaturalHeight() {
    if (state.draftHeightPx !== null) {
      return;
    }

    const measuredHeight = measureDraftNaturalHeight();
    if (measuredHeight !== null) {
      state.draftNaturalHeightPx = measuredHeight;
    }
  }

  function clampDraftHeightPx(value: number) {
    const minHeight = getDraftMinHeightPx();
    const maxHeight = Math.max(minHeight, deps.getShellHeight() - deps.getAssistPanelHeight() - 12);
    return Math.min(maxHeight, Math.max(minHeight, Math.round(value)));
  }

  function closeDraft(options?: { restoreFocus?: boolean }) {
    state.draftOpen = false;

    if (options?.restoreFocus ?? true) {
      deps.tick().then(deps.focusOutput);
    }
  }

  function openDraft(options?: { preserveFocus?: boolean }) {
    if (deps.getAuxVisible()) {
      deps.hideAuxTerminal({ restoreFocus: false });
    }

    if (state.draftHeightPx !== null) {
      state.draftHeightPx = clampDraftHeightPx(state.draftHeightPx);
    }

    state.draftOpen = true;

    deps.tick().then(() => {
      syncDraftHeight();
      rememberDraftNaturalHeight();
      if (!(options?.preserveFocus ?? false)) {
        focusDraft(true);
      }
    });
  }

  function stopDraftResize() {
    resizingDraft = false;
    draftResizePointerId = null;
    window.removeEventListener("pointermove", handleDraftResizeMove, true);
    window.removeEventListener("pointerup", stopDraftResize, true);
    window.removeEventListener("pointercancel", stopDraftResize, true);
    document.body.style.removeProperty("cursor");
    document.body.style.removeProperty("user-select");
  }

  function handleDraftResizeMove(event: PointerEvent) {
    if (!resizingDraft || draftResizePointerId !== event.pointerId) {
      return;
    }

    event.preventDefault();
    const delta = draftResizeStartY - event.clientY;
    state.draftHeightPx = clampDraftHeightPx(draftResizeStartHeightPx + delta);
  }

  function handleDraftResizeStart(event: PointerEvent) {
    if (event.button !== 0 || !state.draftOpen || !state.draftPanelEl) {
      return;
    }

    event.preventDefault();
    resizingDraft = true;
    draftResizePointerId = event.pointerId;
    draftResizeStartY = event.clientY;
    const measuredNaturalHeight = measureDraftNaturalHeight();
    if (state.draftNaturalHeightPx === null && measuredNaturalHeight !== null) {
      state.draftNaturalHeightPx = measuredNaturalHeight;
    }

    draftResizeStartHeightPx =
      state.draftHeightPx ?? measuredNaturalHeight ?? getDraftMinHeightPx();
    state.draftHeightPx = draftResizeStartHeightPx;
    document.body.style.cursor = "ns-resize";
    document.body.style.userSelect = "none";
    window.addEventListener("pointermove", handleDraftResizeMove, true);
    window.addEventListener("pointerup", stopDraftResize, true);
    window.addEventListener("pointercancel", stopDraftResize, true);
  }

  function insertIntoDraft(text: string, moveCaretToEnd = false) {
    if (!state.draftEl) {
      state.draftValue += text;
      return;
    }

    const start = state.draftEl.selectionStart ?? state.draftValue.length;
    const end = state.draftEl.selectionEnd ?? state.draftValue.length;
    state.draftValue = `${state.draftValue.slice(0, start)}${text}${state.draftValue.slice(end)}`;

    deps.tick().then(() => {
      syncDraftHeight();
      const nextPosition = moveCaretToEnd ? state.draftValue.length : start + text.length;
      state.draftEl?.setSelectionRange(nextPosition, nextPosition);
    });
  }

  function pasteIntoTerminal(text: string) {
    const terminal = deps.getTerminal();
    if (!terminal || deps.getLivePtyId() < 0) {
      if (!state.draftOpen) {
        openDraft({ preserveFocus: true });
      }
      insertIntoDraft(text, true);
      deps.tick().then(() => {
        syncDraftHeight();
        focusDraft(true);
      });
      return;
    }

    terminal.paste(text);
    deps.focusOutput();
  }

  function routeInsertedText(text: string) {
    if (state.draftOpen || state.draftValue.length > 0) {
      if (!state.draftOpen) {
        openDraft({ preserveFocus: true });
      }
      insertIntoDraft(text, true);
      deps.tick().then(() => {
        syncDraftHeight();
        focusDraft(true);
      });
      return;
    }

    pasteIntoTerminal(text);
  }

  function splitDraftLines(text: string) {
    return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  }

  async function insertDraftIntoTerminal(submit: boolean) {
    const text = state.draftValue;
    if (!text || deps.getLivePtyId() < 0) {
      return;
    }

    state.draftValue = "";
    syncDraftHeight();
    const lines = splitDraftLines(text);

    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index] ?? "";
      if (line.length > 0) {
        await deps.writeLivePty(line);
      }

      if (index < lines.length - 1) {
        await deps.writeLivePty("\n");
      }
    }

    if (submit) {
      await deps.writeLivePty("\r");
      closeDraft({ restoreFocus: false });
      deps.tick().then(deps.focusOutput);
      return;
    }

    focusDraft();
  }

  function handleDraftKeydown(event: KeyboardEvent) {
    if (event.key === "Enter" && event.ctrlKey && !event.altKey && !event.metaKey) {
      event.preventDefault();
      void insertDraftIntoTerminal(true);
    }
  }

  function handleDraftInput(event: Event) {
    state.draftValue = (event.target as HTMLTextAreaElement).value;
    syncDraftHeight();
  }

  function toggleDraft() {
    if (state.draftOpen) {
      closeDraft();
      return;
    }

    openDraft();
  }

  return {
    syncDraftHeight,
    focusDraft,
    closeDraft,
    openDraft,
    stopDraftResize,
    handleDraftResizeStart,
    routeInsertedText,
    insertDraftIntoTerminal,
    handleDraftKeydown,
    handleDraftInput,
    toggleDraft,
  };
}

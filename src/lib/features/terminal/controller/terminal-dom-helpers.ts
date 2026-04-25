import type { Terminal } from "@xterm/xterm";
import { TEST_IDS } from "../../../testids";

export interface StableTerminalLayoutDeps {
  tick: () => Promise<void>;
  getFontsReady?: () => Promise<unknown> | undefined;
  requestAnimationFrame: (callback: FrameRequestCallback) => number;
}

function waitForAnimationFrame(requestAnimationFrame: StableTerminalLayoutDeps["requestAnimationFrame"]) {
  return new Promise<void>((resolve) => {
    requestAnimationFrame(() => resolve());
  });
}

export async function waitForStableTerminalLayout({
  tick,
  getFontsReady,
  requestAnimationFrame,
}: StableTerminalLayoutDeps) {
  await tick();
  const fontsReady = getFontsReady?.();
  if (fontsReady) {
    await fontsReady.catch(() => {});
  }
  await waitForAnimationFrame(requestAnimationFrame);
  await waitForAnimationFrame(requestAnimationFrame);
}

export function writeTerminalData(term: Terminal, data: string) {
  return new Promise<void>((resolve) => {
    if (!data) {
      resolve();
      return;
    }

    term.write(data, () => resolve());
  });
}

export function focusTerminalSurface(term: Terminal | null, container: HTMLElement | null) {
  if (!term || !container) {
    return;
  }

  term.focus();

  const helperTextarea = container.querySelector(
    ".xterm-helper-textarea",
  ) as HTMLTextAreaElement | null;
  helperTextarea?.focus({ preventScroll: true });
}

export function isEditableTarget(target: EventTarget | null) {
  if (!(target instanceof Element)) {
    return false;
  }

  return Boolean(target.closest("input, textarea, select, [contenteditable='true']"));
}

export function isInsideInternalEditor(target: EventTarget | null) {
  if (!(target instanceof Element)) {
    return false;
  }

  return Boolean(
    target.closest(`[data-testid="${TEST_IDS.internalEditorShell}"]`) ||
      target.closest(`[data-testid="${TEST_IDS.internalEditorQuickOpenModal}"]`),
  );
}

export function shouldInterceptTerminalCtrlC(event: KeyboardEvent) {
  return (
    event.type === "keydown" &&
    event.key.toLowerCase() === "c" &&
    event.ctrlKey &&
    !event.shiftKey &&
    !event.altKey &&
    !event.metaKey
  );
}

import { matchesShortcut } from "../../../hotkeys";
import { isEditableTarget, isInsideInternalEditor } from "./terminal-dom-helpers";

export interface AuxShortcutRouteParams {
  event: KeyboardEvent;
  visible: boolean;
  shortcut: string;
  shellElement: HTMLElement;
  hasBlockingOverlay: boolean;
}

export interface EditorShortcutRouteParams {
  event: KeyboardEvent;
  visible: boolean;
  shellElement: HTMLElement;
  shortcut?: string;
}

function getTargetNode(event: KeyboardEvent) {
  return event.target instanceof Node ? event.target : null;
}

export function shouldHandleAuxShortcut({
  event,
  visible,
  shortcut,
  shellElement,
  hasBlockingOverlay,
}: AuxShortcutRouteParams) {
  if (!visible || !matchesShortcut(event, shortcut)) {
    return false;
  }

  const targetNode = getTargetNode(event);
  const insideTerminalShell = targetNode !== null && shellElement.contains(targetNode);

  if (hasBlockingOverlay && targetNode !== null && !insideTerminalShell) {
    return false;
  }

  if (isEditableTarget(event.target) && targetNode !== null && !insideTerminalShell) {
    return false;
  }

  return true;
}

export function shouldHandleEditorShortcut({
  event,
  visible,
  shellElement,
  shortcut = "Ctrl+P",
}: EditorShortcutRouteParams) {
  if (!visible || !matchesShortcut(event, shortcut)) {
    return false;
  }

  const targetNode = getTargetNode(event);
  const insideTerminalShell = targetNode !== null && shellElement.contains(targetNode);
  const insideEditorSurface = isInsideInternalEditor(targetNode);

  if (targetNode !== null && !insideTerminalShell && !insideEditorSurface) {
    return false;
  }

  if (isEditableTarget(event.target) && !insideTerminalShell && !insideEditorSurface) {
    return false;
  }

  return true;
}

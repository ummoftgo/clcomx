import { describe, expect, it } from "vitest";
import { TEST_IDS } from "../../../testids";
import {
  shouldHandleAuxShortcut,
  shouldHandleEditorShortcut,
} from "./terminal-shortcut-routing";

function keyboardEvent(key: string, target: EventTarget | null, options: KeyboardEventInit = {}) {
  const event = new KeyboardEvent("keydown", {
    key,
    bubbles: true,
    ...options,
  });
  Object.defineProperty(event, "target", {
    configurable: true,
    value: target,
  });
  return event;
}

function ctrlKeyEvent(key: string, target: EventTarget | null) {
  return keyboardEvent(key, target, { ctrlKey: true });
}

describe("terminal-shortcut-routing", () => {
  it("routes aux shortcuts only when the app is visible and the configured shortcut matches", () => {
    const shell = document.createElement("section");
    const target = document.createElement("button");
    shell.append(target);

    expect(
      shouldHandleAuxShortcut({
        event: ctrlKeyEvent("`", target),
        visible: false,
        shortcut: "Ctrl+`",
        shellElement: shell,
        hasBlockingOverlay: false,
      }),
    ).toBe(false);
    expect(
      shouldHandleAuxShortcut({
        event: ctrlKeyEvent("p", target),
        visible: true,
        shortcut: "Ctrl+`",
        shellElement: shell,
        hasBlockingOverlay: false,
      }),
    ).toBe(false);
    expect(
      shouldHandleAuxShortcut({
        event: ctrlKeyEvent("`", target),
        visible: true,
        shortcut: "Ctrl+`",
        shellElement: shell,
        hasBlockingOverlay: false,
      }),
    ).toBe(true);
  });

  it("ignores aux shortcuts from external overlay and editable targets", () => {
    const shell = document.createElement("section");
    const externalButton = document.createElement("button");
    const externalInput = document.createElement("input");
    const shellInput = document.createElement("input");
    shell.append(shellInput);

    expect(
      shouldHandleAuxShortcut({
        event: ctrlKeyEvent("`", externalButton),
        visible: true,
        shortcut: "Ctrl+`",
        shellElement: shell,
        hasBlockingOverlay: true,
      }),
    ).toBe(false);
    expect(
      shouldHandleAuxShortcut({
        event: ctrlKeyEvent("`", externalInput),
        visible: true,
        shortcut: "Ctrl+`",
        shellElement: shell,
        hasBlockingOverlay: false,
      }),
    ).toBe(false);
    expect(
      shouldHandleAuxShortcut({
        event: ctrlKeyEvent("`", shellInput),
        visible: true,
        shortcut: "Ctrl+`",
        shellElement: shell,
        hasBlockingOverlay: true,
      }),
    ).toBe(true);
  });

  it("preserves aux shortcut behavior for non-node targets", () => {
    expect(
      shouldHandleAuxShortcut({
        event: ctrlKeyEvent("`", window),
        visible: true,
        shortcut: "Ctrl+`",
        shellElement: document.createElement("section"),
        hasBlockingOverlay: true,
      }),
    ).toBe(true);
  });

  it("routes editor shortcuts only from terminal or internal editor surfaces", () => {
    const shell = document.createElement("section");
    const terminalButton = document.createElement("button");
    shell.append(terminalButton);
    const externalButton = document.createElement("button");

    const editorShell = document.createElement("section");
    editorShell.dataset.testid = TEST_IDS.internalEditorShell;
    const editorChild = document.createElement("button");
    editorShell.append(editorChild);

    const quickOpen = document.createElement("section");
    quickOpen.dataset.testid = TEST_IDS.internalEditorQuickOpenModal;
    const quickOpenInput = document.createElement("input");
    quickOpen.append(quickOpenInput);

    expect(
      shouldHandleEditorShortcut({
        event: ctrlKeyEvent("p", terminalButton),
        visible: true,
        shellElement: shell,
      }),
    ).toBe(true);
    expect(
      shouldHandleEditorShortcut({
        event: ctrlKeyEvent("p", editorChild),
        visible: true,
        shellElement: shell,
      }),
    ).toBe(true);
    expect(
      shouldHandleEditorShortcut({
        event: ctrlKeyEvent("p", quickOpenInput),
        visible: true,
        shellElement: shell,
      }),
    ).toBe(true);
    expect(
      shouldHandleEditorShortcut({
        event: ctrlKeyEvent("p", externalButton),
        visible: true,
        shellElement: shell,
      }),
    ).toBe(false);
  });

  it("ignores editor shortcuts when hidden or the shortcut does not match", () => {
    const shell = document.createElement("section");
    const target = document.createElement("button");
    shell.append(target);

    expect(
      shouldHandleEditorShortcut({
        event: ctrlKeyEvent("p", target),
        visible: false,
        shellElement: shell,
      }),
    ).toBe(false);
    expect(
      shouldHandleEditorShortcut({
        event: ctrlKeyEvent("o", target),
        visible: true,
        shellElement: shell,
      }),
    ).toBe(false);
  });

  it("preserves editor shortcut behavior for non-node targets", () => {
    expect(
      shouldHandleEditorShortcut({
        event: ctrlKeyEvent("p", window),
        visible: true,
        shellElement: document.createElement("section"),
      }),
    ).toBe(true);
  });
});

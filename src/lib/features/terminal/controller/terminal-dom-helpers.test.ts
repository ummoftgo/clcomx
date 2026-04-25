import { describe, expect, it, vi } from "vitest";
import type { Terminal } from "@xterm/xterm";
import { TEST_IDS } from "../../../testids";
import {
  focusTerminalSurface,
  isEditableTarget,
  isInsideInternalEditor,
  shouldInterceptTerminalCtrlC,
  waitForStableTerminalLayout,
  writeTerminalData,
} from "./terminal-dom-helpers";

function createTerminal() {
  return {
    focus: vi.fn(),
    write: vi.fn((_data: string, callback: () => void) => callback()),
  } as unknown as Terminal & {
    focus: ReturnType<typeof vi.fn>;
    write: ReturnType<typeof vi.fn>;
  };
}

describe("terminal-dom-helpers", () => {
  it("waits for tick, fonts, and two animation frames before layout work continues", async () => {
    const calls: string[] = [];
    const tick = vi.fn(async () => {
      calls.push("tick");
    });
    let rejectFonts!: (error: Error) => void;
    const fontsReady = new Promise<unknown>((_, reject) => {
      rejectFonts = reject;
    });
    const getFontsReady = vi.fn(() => {
      calls.push("fonts");
      return fontsReady;
    });
    const frames: FrameRequestCallback[] = [];
    const requestAnimationFrame = vi.fn((callback: FrameRequestCallback) => {
      calls.push("raf");
      frames.push(callback);
      return frames.length;
    });

    const pending = waitForStableTerminalLayout({
      tick,
      getFontsReady,
      requestAnimationFrame,
    });

    await Promise.resolve();
    rejectFonts(new Error("font loading failed"));
    for (let index = 0; index < 5 && requestAnimationFrame.mock.calls.length === 0; index += 1) {
      await Promise.resolve();
    }
    expect(tick).toHaveBeenCalledTimes(1);
    expect(getFontsReady).toHaveBeenCalledTimes(1);
    expect(requestAnimationFrame).toHaveBeenCalledTimes(1);
    expect(calls).toEqual(["tick", "fonts", "raf"]);

    frames.shift()?.(0);
    for (let index = 0; index < 5 && requestAnimationFrame.mock.calls.length === 1; index += 1) {
      await Promise.resolve();
    }
    expect(requestAnimationFrame).toHaveBeenCalledTimes(2);

    frames.shift()?.(16);
    await expect(pending).resolves.toBeUndefined();
  });

  it("resolves terminal writes through the xterm write callback", async () => {
    const term = createTerminal();

    await writeTerminalData(term, "hello");

    expect(term.write).toHaveBeenCalledWith("hello", expect.any(Function));
  });

  it("skips empty terminal writes", async () => {
    const term = createTerminal();

    await writeTerminalData(term, "");

    expect(term.write).not.toHaveBeenCalled();
  });

  it("focuses the terminal and xterm helper textarea without scrolling", () => {
    const term = createTerminal();
    const container = document.createElement("div");
    const helperTextarea = document.createElement("textarea");
    helperTextarea.className = "xterm-helper-textarea";
    helperTextarea.focus = vi.fn();
    container.append(helperTextarea);

    focusTerminalSurface(term, container);

    expect(term.focus).toHaveBeenCalledTimes(1);
    expect(helperTextarea.focus).toHaveBeenCalledWith({ preventScroll: true });
  });

  it("identifies editable keyboard targets", () => {
    const input = document.createElement("input");
    const editable = document.createElement("div");
    editable.setAttribute("contenteditable", "true");
    const plain = document.createElement("div");

    expect(isEditableTarget(input)).toBe(true);
    expect(isEditableTarget(editable)).toBe(true);
    expect(isEditableTarget(plain)).toBe(false);
    expect(isEditableTarget(null)).toBe(false);
  });

  it("identifies internal editor and quick-open surfaces", () => {
    const editorShell = document.createElement("section");
    editorShell.dataset.testid = TEST_IDS.internalEditorShell;
    const editorChild = document.createElement("button");
    editorShell.append(editorChild);

    const quickOpen = document.createElement("section");
    quickOpen.dataset.testid = TEST_IDS.internalEditorQuickOpenModal;
    const quickOpenChild = document.createElement("input");
    quickOpen.append(quickOpenChild);

    expect(isInsideInternalEditor(editorChild)).toBe(true);
    expect(isInsideInternalEditor(quickOpenChild)).toBe(true);
    expect(isInsideInternalEditor(document.createElement("div"))).toBe(false);
    expect(isInsideInternalEditor(null)).toBe(false);
  });

  it("only intercepts plain Ctrl+C keydown events", () => {
    expect(shouldInterceptTerminalCtrlC(new KeyboardEvent("keydown", { key: "c", ctrlKey: true }))).toBe(true);
    expect(shouldInterceptTerminalCtrlC(new KeyboardEvent("keydown", { key: "C", ctrlKey: true }))).toBe(true);
    expect(shouldInterceptTerminalCtrlC(new KeyboardEvent("keyup", { key: "c", ctrlKey: true }))).toBe(false);
    expect(
      shouldInterceptTerminalCtrlC(
        new KeyboardEvent("keydown", { key: "c", ctrlKey: true, shiftKey: true }),
      ),
    ).toBe(false);
    expect(
      shouldInterceptTerminalCtrlC(
        new KeyboardEvent("keydown", { key: "c", ctrlKey: true, altKey: true }),
      ),
    ).toBe(false);
    expect(
      shouldInterceptTerminalCtrlC(
        new KeyboardEvent("keydown", { key: "c", ctrlKey: true, metaKey: true }),
      ),
    ).toBe(false);
    expect(shouldInterceptTerminalCtrlC(new KeyboardEvent("keydown", { key: "v", ctrlKey: true }))).toBe(false);
  });
});

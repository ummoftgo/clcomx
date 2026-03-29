import { describe, expect, it } from "vitest";
import { eventToShortcut, matchesShortcut, normalizeShortcut } from "./hotkeys";

describe("hotkey helpers", () => {
  it("normalizes modifier order and backtick labels", () => {
    expect(normalizeShortcut("shift + ctrl + grave")).toBe("Ctrl+Shift+`");
  });

  it("falls back when no primary key is provided", () => {
    expect(normalizeShortcut("Ctrl+Shift")).toBe("Ctrl+`");
  });

  it("converts keyboard events into normalized shortcuts", () => {
    const event = new KeyboardEvent("keydown", {
      key: "`",
      ctrlKey: true,
      shiftKey: true,
      bubbles: true,
    });

    expect(eventToShortcut(event)).toBe("Ctrl+Shift+`");
  });

  it("does not treat plain space as the default shortcut", () => {
    const event = new KeyboardEvent("keydown", {
      key: " ",
      code: "Space",
      bubbles: true,
    });

    expect(eventToShortcut(event)).toBe("Space");
    expect(matchesShortcut(event, "Ctrl+`")).toBe(false);
  });

  it("matches normalized shortcuts against keyboard events", () => {
    const event = new KeyboardEvent("keydown", {
      key: "Backquote",
      code: "Backquote",
      ctrlKey: true,
      bubbles: true,
    });

    expect(matchesShortcut(event, "control+grave")).toBe(true);
    expect(matchesShortcut(event, "Alt+`")).toBe(false);
  });

  it("treats plus as a dedicated primary key instead of falling back", () => {
    const event = new KeyboardEvent("keydown", {
      key: "+",
      code: "Equal",
      shiftKey: true,
      bubbles: true,
    });

    expect(eventToShortcut(event)).toBe("Shift+Plus");
    expect(matchesShortcut(event, "Ctrl+`")).toBe(false);
    expect(normalizeShortcut("Ctrl+Plus")).toBe("Ctrl+Plus");
  });
});

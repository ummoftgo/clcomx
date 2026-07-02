import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, type Settings } from "../types";
import { UI_CSS_VARS } from "./tokens";
import { getUiPreferenceTokenStyle } from "./theme-bridge";

describe("theme-bridge UI preference tokens", () => {
  it("drives the agent/runtime mono token from terminal font settings", () => {
    const settings: Settings = {
      ...DEFAULT_SETTINGS,
      interface: {
        ...DEFAULT_SETTINGS.interface,
        uiFontFamily: "Pretendard",
      },
      terminal: {
        ...DEFAULT_SETTINGS.terminal,
        fontFamily: "IBM Plex Mono, Fira Code",
        fontFamilyFallback: "D2Coding, monospace",
      },
    };

    const style = getUiPreferenceTokenStyle(settings);

    expect(UI_CSS_VARS.fontMonoStack).toBe("--ui-font-mono-stack");
    expect(style[UI_CSS_VARS.fontMonoStack]).toContain('"IBM Plex Mono"');
    expect(style[UI_CSS_VARS.fontMonoStack]).toContain('"Fira Code"');
    expect(style[UI_CSS_VARS.fontMonoStack]).toContain("D2Coding");
    expect(style[UI_CSS_VARS.fontMonoStack]).not.toContain("Pretendard");
  });
});

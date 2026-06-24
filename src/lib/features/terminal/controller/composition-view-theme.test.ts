import { describe, expect, it } from "vitest";
import {
  applyTerminalCompositionViewTheme,
  getCompositionViewThemeVars,
  toOpaqueColor,
} from "./composition-view-theme";

describe("composition-view-theme", () => {
  it("keeps opaque hex colors as-is", () => {
    expect(toOpaqueColor("#abc", "fallback")).toBe("#abc");
    expect(toOpaqueColor("#aabbcc", "fallback")).toBe("#aabbcc");
  });

  it("strips the alpha channel from colors", () => {
    expect(toOpaqueColor("#aabbcc80", "fallback")).toBe("#aabbcc");
    expect(toOpaqueColor("rgba(170, 187, 204, 0.18)", "fallback")).toBe("rgb(170, 187, 204)");
    expect(toOpaqueColor("rgb(1, 2, 3)", "fallback")).toBe("rgb(1, 2, 3)");
  });

  it("uses fallback colors for invalid or missing input", () => {
    expect(toOpaqueColor(undefined, "fallback")).toBe("fallback");
    expect(toOpaqueColor("not-a-color", "fallback")).toBe("fallback");
  });

  it("keeps selection background ahead of cursor for composition emphasis (opaque)", () => {
    expect(
      getCompositionViewThemeVars({
        foreground: "#eeeeee",
        selectionBackground: "#123456",
        cursor: "#abcdef",
      }),
    ).toEqual({
      foreground: "#eeeeee",
      background: "#123456",
    });
  });

  it("falls back to cursor and default theme values", () => {
    expect(
      getCompositionViewThemeVars({
        cursor: "#abcdef",
      }),
    ).toEqual({
      foreground: "#f8fafc",
      background: "#abcdef",
    });

    expect(getCompositionViewThemeVars(null)).toEqual({
      foreground: "#f8fafc",
      background: "#64748b",
    });
  });

  it("produces a fully opaque composition background (no alpha)", () => {
    for (const theme of [
      { selectionBackground: "#44475a" },
      { cursor: "#f8f8f2" },
      { background: "#101820" },
      null,
    ]) {
      const { background } = getCompositionViewThemeVars(theme);
      expect(background).not.toMatch(/rgba\(/i);
      expect(background).not.toMatch(/^#[\da-f]{8}$/i);
    }
  });

  it("applies composition CSS variables to the terminal shell element", () => {
    const element = document.createElement("div");

    applyTerminalCompositionViewTheme(element, {
      foreground: "#fdfdfd",
      selectionBackground: "#010203",
    });

    expect(element.style.getPropertyValue("--ime-composition-fg")).toBe("#fdfdfd");
    expect(element.style.getPropertyValue("--ime-composition-bg")).toBe("#010203");
  });
});

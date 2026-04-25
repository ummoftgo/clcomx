import { describe, expect, it } from "vitest";
import {
  applyTerminalCompositionViewTheme,
  getCompositionViewThemeVars,
  hexToRgba,
} from "./composition-view-theme";

describe("composition-view-theme", () => {
  it("converts short and long hex colors to rgba", () => {
    expect(hexToRgba("#abc", 0.18, "fallback")).toBe("rgba(170, 187, 204, 0.18)");
    expect(hexToRgba("#aabbcc", 0.18, "fallback")).toBe("rgba(170, 187, 204, 0.18)");
  });

  it("uses fallback colors for invalid or missing hex input", () => {
    expect(hexToRgba(undefined, 0.18, "fallback")).toBe("fallback");
    expect(hexToRgba("not-a-color", 0.18, "fallback")).toBe("fallback");
  });

  it("keeps selection background ahead of cursor for composition emphasis", () => {
    expect(
      getCompositionViewThemeVars({
        foreground: "#eeeeee",
        selectionBackground: "#123456",
        cursor: "#abcdef",
      }),
    ).toEqual({
      foreground: "#eeeeee",
      background: "rgba(18, 52, 86, 0.18)",
    });
  });

  it("falls back to cursor and default theme values", () => {
    expect(
      getCompositionViewThemeVars({
        cursor: "#abcdef",
      }),
    ).toEqual({
      foreground: "#f8fafc",
      background: "rgba(171, 205, 239, 0.18)",
    });

    expect(getCompositionViewThemeVars(null)).toEqual({
      foreground: "#f8fafc",
      background: "rgba(100, 116, 139, 0.18)",
    });
  });

  it("applies composition CSS variables to the terminal shell element", () => {
    const element = document.createElement("div");

    applyTerminalCompositionViewTheme(element, {
      foreground: "#fdfdfd",
      selectionBackground: "#010203",
    });

    expect(element.style.getPropertyValue("--ime-composition-fg")).toBe("#fdfdfd");
    expect(element.style.getPropertyValue("--ime-composition-bg")).toBe("rgba(1, 2, 3, 0.18)");
  });
});

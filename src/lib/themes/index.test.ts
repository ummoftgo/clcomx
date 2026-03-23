import { beforeEach, describe, expect, it } from "vitest";
import {
  DARK_THEMES,
  LIGHT_THEMES,
  getThemeById,
  initializeThemes,
  normalizeThemePack,
  resolveThemePack,
  type ThemePack,
} from "./index";

describe("theme registry", () => {
  beforeEach(() => {
    initializeThemes(null);
  });

  it("normalizes invalid theme entries away", () => {
    const pack = normalizeThemePack({
      themes: [
        { id: "valid-dark", name: "Valid Dark", dark: true, theme: { background: "#111111" } },
        { id: "", name: "Missing Id", dark: true, theme: {} },
        { id: "missing-name", dark: false, theme: {} },
      ],
    });

    expect(pack.themes).toHaveLength(1);
    expect(pack.themes[0]?.id).toBe("valid-dark");
  });

  it("resolves extends with partial theme overrides", () => {
    const pack: ThemePack = {
      themes: [
        {
          id: "base",
          name: "Base",
          dark: true,
          theme: {
            background: "#111111",
            foreground: "#eeeeee",
            blue: "#123456",
          },
        },
        {
          id: "base-soft",
          name: "Base Soft",
          dark: true,
          extends: "base",
          theme: {
            background: "#222222",
          },
        },
      ],
    };

    const resolved = resolveThemePack(pack);
    const extended = resolved.find((theme) => theme.id === "base-soft");

    expect(extended?.theme.background).toBe("#222222");
    expect(extended?.theme.foreground).toBe("#eeeeee");
    expect(extended?.theme.blue).toBe("#123456");
  });

  it("lets later duplicate ids override earlier themes", () => {
    initializeThemes({
      themes: [
        {
          id: "dracula",
          name: "Dracula Override",
          dark: true,
          extends: "dracula",
          theme: {
            background: "#101820",
          },
        },
      ],
    });

    expect(getThemeById("dracula")?.name).toBe("Dracula Override");
    expect(getThemeById("dracula")?.theme.background).toBe("#101820");
  });

  it("keeps dark and light theme buckets populated after runtime merge", () => {
    initializeThemes({
      themes: [
        {
          id: "custom-light",
          name: "Custom Light",
          dark: false,
          theme: {
            background: "#fafafa",
            foreground: "#222222",
          },
        },
      ],
    });

    expect(DARK_THEMES.length).toBeGreaterThan(0);
    expect(LIGHT_THEMES.some((theme) => theme.id === "custom-light")).toBe(true);
  });
});

import { describe, expect, it } from "vitest";
import type { ThemeDef } from "../themes";
import {
  buildMonacoStandaloneThemeData,
  buildMonacoThemeName,
} from "./monaco-theme";

function createThemeDef(overrides: Partial<ThemeDef> = {}): ThemeDef {
  return {
    id: "dracula",
    name: "Dracula",
    dark: true,
    theme: {
      background: "#282a36",
      foreground: "#f8f8f2",
      cursor: "#f8f8f2",
      selectionBackground: "#44475a",
      black: "#21222c",
      red: "#ff5555",
      green: "#50fa7b",
      yellow: "#f1fa8c",
      blue: "#bd93f9",
      magenta: "#ff79c6",
      cyan: "#8be9fd",
      brightBlack: "#6272a4",
    },
    ...overrides,
  };
}

describe("monaco-theme adapter", () => {
  it("builds deterministic monaco theme names", () => {
    expect(buildMonacoThemeName("dracula")).toBe("clcomx-dracula");
  });

  it("builds fallback monaco theme data from xterm palette", () => {
    const data = buildMonacoStandaloneThemeData(createThemeDef());

    expect(data.base).toBe("vs-dark");
    expect(data.colors["editor.background"]).toBe("#282a36");
    expect(data.colors["editor.foreground"]).toBe("#f8f8f2");
    expect(data.rules.some((rule) => rule.token === "keyword")).toBe(true);
  });

  it("applies explicit monaco overrides on top of fallback", () => {
    const data = buildMonacoStandaloneThemeData(
      createThemeDef({
        monaco: {
          source: "builtin-vscode",
          base: "vs-dark",
          inherit: true,
          colors: {
            "editor.background": "#101010",
          },
          rules: [{ token: "keyword", foreground: "#abcdef", fontStyle: "bold" }],
        },
      }),
    );

    expect(data.colors["editor.background"]).toBe("#101010");
    expect(data.rules.some((rule) => rule.token === "keyword" && rule.fontStyle === "bold")).toBe(
      true,
    );
  });

  it("accepts token rule colors with and without a leading hash", () => {
    const data = buildMonacoStandaloneThemeData(
      createThemeDef({
        monaco: {
          colors: {},
          rules: [
            { token: "keyword", foreground: "ABCDEF" },
            { token: "string", foreground: "#123456", background: "654321" },
          ],
        },
      }),
    );

    expect(data.rules).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ token: "keyword", foreground: "ABCDEF" }),
        expect.objectContaining({
          token: "string",
          foreground: "123456",
          background: "654321",
        }),
      ]),
    );
  });
});

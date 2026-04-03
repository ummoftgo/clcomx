import type * as monaco from "monaco-editor";
import type { ITheme } from "@xterm/xterm";
import type { ThemeDef, MonacoThemeTokenRuleDef } from "../themes";

const DEFAULT_DARK_BACKGROUND = "#1e1e2e";
const DEFAULT_DARK_FOREGROUND = "#cdd6f4";

function normalizeColor(value: string | undefined, fallback: string) {
  if (!value) return fallback;
  const trimmed = value.trim();
  if (/^#[0-9a-f]{6}$/i.test(trimmed)) return trimmed;
  if (/^#[0-9a-f]{3}$/i.test(trimmed)) {
    const [, short = "000"] = /^#([0-9a-f]{3})$/i.exec(trimmed) ?? [];
    return `#${short
      .split("")
      .map((part) => `${part}${part}`)
      .join("")}`;
  }
  return fallback;
}

function normalizeHexNoHash(value: string | undefined) {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (/^[0-9a-f]{6}$/i.test(trimmed)) {
    return trimmed.toUpperCase();
  }
  if (/^[0-9a-f]{3}$/i.test(trimmed)) {
    return trimmed
      .toUpperCase()
      .split("")
      .map((part) => `${part}${part}`)
      .join("");
  }

  const normalized = normalizeColor(trimmed, "");
  return normalized ? normalized.slice(1).toUpperCase() : undefined;
}

function toMonacoBase(theme: ThemeDef): "vs" | "vs-dark" {
  return theme.dark ? "vs-dark" : "vs";
}

function buildFallbackColors(theme: ITheme): Record<string, string> {
  const background = normalizeColor(theme.background, DEFAULT_DARK_BACKGROUND);
  const foreground = normalizeColor(theme.foreground, DEFAULT_DARK_FOREGROUND);
  const selection = normalizeColor(theme.selectionBackground, "#3B4261");
  const cursor = normalizeColor(theme.cursor, foreground);

  return {
    "editor.background": background,
    "editor.foreground": foreground,
    "editorCursor.foreground": cursor,
    "editor.selectionBackground": selection,
    "editor.lineHighlightBackground": normalizeColor(
      theme.brightBlack,
      "#2A2E44",
    ),
    "editorLineNumber.foreground": normalizeColor(theme.brightBlack, "#6C7086"),
    "editorLineNumber.activeForeground": foreground,
    "editorWhitespace.foreground": normalizeColor(theme.black, "#585B70"),
    "editorIndentGuide.background1": normalizeColor(theme.black, "#585B70"),
  };
}

function buildFallbackRules(theme: ITheme): monaco.editor.ITokenThemeRule[] {
  return [
    {
      token: "comment",
      foreground: normalizeHexNoHash(theme.brightBlack) ?? "6C7086",
      fontStyle: "italic",
    },
    {
      token: "keyword",
      foreground: normalizeHexNoHash(theme.blue) ?? "89B4FA",
    },
    {
      token: "string",
      foreground: normalizeHexNoHash(theme.green) ?? "A6E3A1",
    },
    {
      token: "number",
      foreground: normalizeHexNoHash(theme.yellow) ?? "F9E2AF",
    },
    {
      token: "regexp",
      foreground: normalizeHexNoHash(theme.cyan) ?? "94E2D5",
    },
    {
      token: "type",
      foreground: normalizeHexNoHash(theme.magenta) ?? "F5C2E7",
    },
    {
      token: "delimiter",
      foreground: normalizeHexNoHash(theme.foreground) ?? "CDD6F4",
    },
  ];
}

function toTokenRule(
  rule: MonacoThemeTokenRuleDef,
): monaco.editor.ITokenThemeRule | null {
  const token = rule.token.trim();
  if (!token) {
    return null;
  }

  const foreground = normalizeHexNoHash(rule.foreground);
  const background = normalizeHexNoHash(rule.background);

  return {
    token,
    ...(foreground ? { foreground } : {}),
    ...(background ? { background } : {}),
    ...(rule.fontStyle ? { fontStyle: rule.fontStyle } : {}),
  };
}

export function buildMonacoThemeName(themeId: string) {
  return `clcomx-${themeId}`;
}

export function buildMonacoStandaloneThemeData(
  theme: ThemeDef,
): monaco.editor.IStandaloneThemeData {
  const fallbackColors = buildFallbackColors(theme.theme);
  const fallbackRules = buildFallbackRules(theme.theme);
  const customRules = (theme.monaco?.rules ?? [])
    .map((rule) => toTokenRule(rule))
    .filter((rule): rule is monaco.editor.ITokenThemeRule => Boolean(rule));

  return {
    base: theme.monaco?.base ?? toMonacoBase(theme),
    inherit: theme.monaco?.inherit ?? true,
    colors: {
      ...fallbackColors,
      ...(theme.monaco?.colors ?? {}),
    },
    rules: [...fallbackRules, ...customRules],
  };
}

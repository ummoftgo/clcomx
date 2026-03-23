import type { ITheme } from "@xterm/xterm";
import defaultThemePackJson from "./default-theme-pack.json";

type ThemeThemePatch = Partial<Record<keyof ITheme, string>> & Record<string, string>;

export interface ThemeSourceDef {
  id: string;
  name: string;
  dark: boolean;
  extends?: string;
  theme: ThemeThemePatch;
}

export interface ThemePack {
  themes: ThemeSourceDef[];
}

export interface ThemeDef {
  id: string;
  name: string;
  dark: boolean;
  theme: ITheme;
}

const DEFAULT_THEME_ID = "dracula";
const BUILTIN_THEME_PACK = normalizeThemePack(defaultThemePackJson);

let themeIndex = new Map<string, ThemeDef>();
export let DARK_THEMES: ThemeDef[] = [];
export let LIGHT_THEMES: ThemeDef[] = [];
export let ALL_THEMES: ThemeDef[] = [];

function normalizeThemePatch(value: unknown): ThemeThemePatch {
  if (!value || typeof value !== "object") {
    return {};
  }

  const patch: ThemeThemePatch = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (typeof entry === "string" && entry.trim()) {
      patch[key] = entry.trim();
    }
  }
  return patch;
}

function normalizeThemeEntry(value: unknown): ThemeSourceDef | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const entry = value as Record<string, unknown>;
  const id = typeof entry.id === "string" ? entry.id.trim() : "";
  const name = typeof entry.name === "string" ? entry.name.trim() : "";

  if (!id || !name || typeof entry.dark !== "boolean") {
    return null;
  }

  const extendsId =
    typeof entry.extends === "string" && entry.extends.trim() ? entry.extends.trim() : undefined;
  const theme = normalizeThemePatch(entry.theme);

  return {
    id,
    name,
    dark: entry.dark,
    ...(extendsId ? { extends: extendsId } : {}),
    theme,
  };
}

export function normalizeThemePack(value: unknown): ThemePack {
  if (!value || typeof value !== "object") {
    return { themes: [] };
  }

  const rawThemes = Array.isArray((value as { themes?: unknown }).themes)
    ? ((value as { themes: unknown[] }).themes ?? [])
    : [];

  return {
    themes: rawThemes
      .map((entry) => normalizeThemeEntry(entry))
      .filter((entry): entry is ThemeSourceDef => Boolean(entry)),
  };
}

export function resolveThemePack(pack: ThemePack): ThemeDef[] {
  const resolved = new Map<string, ThemeDef>();
  const orderedIds: string[] = [];

  for (const sourceTheme of pack.themes) {
    const baseTheme =
      sourceTheme.extends && resolved.has(sourceTheme.extends)
        ? resolved.get(sourceTheme.extends)!.theme
        : sourceTheme.extends === sourceTheme.id && resolved.has(sourceTheme.id)
          ? resolved.get(sourceTheme.id)!.theme
          : undefined;

    const nextTheme: ThemeDef = {
      id: sourceTheme.id,
      name: sourceTheme.name,
      dark: sourceTheme.dark,
      theme: {
        ...(baseTheme ?? {}),
        ...sourceTheme.theme,
      } as ITheme,
    };

    if (!resolved.has(sourceTheme.id)) {
      orderedIds.push(sourceTheme.id);
    }

    resolved.set(sourceTheme.id, nextTheme);
  }

  return orderedIds.map((id) => resolved.get(id)!).filter(Boolean);
}

function applyResolvedThemes(themes: ThemeDef[]) {
  ALL_THEMES = themes;
  DARK_THEMES = themes.filter((theme) => theme.dark);
  LIGHT_THEMES = themes.filter((theme) => !theme.dark);
  themeIndex = new Map(themes.map((theme) => [theme.id, theme]));
}

function resolveMergedThemePack(runtimePack?: ThemePack | null): ThemeDef[] {
  const runtimeThemes = normalizeThemePack(runtimePack).themes;
  const mergedPack: ThemePack = {
    themes: [...BUILTIN_THEME_PACK.themes, ...runtimeThemes],
  };

  const resolvedThemes = resolveThemePack(mergedPack);
  return resolvedThemes.length > 0 ? resolvedThemes : resolveThemePack(BUILTIN_THEME_PACK);
}

export function initializeThemes(runtimePack?: ThemePack | null) {
  applyResolvedThemes(resolveMergedThemePack(runtimePack));
}

export function getThemeById(id: string): ThemeDef | undefined {
  return themeIndex.get(id) ?? themeIndex.get(DEFAULT_THEME_ID);
}

initializeThemes(null);

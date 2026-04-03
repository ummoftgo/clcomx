import type { ITheme } from "@xterm/xterm";
import defaultThemePackJson from "./default-theme-pack.json";

type ThemeThemePatch = Partial<Record<keyof ITheme, string>> & Record<string, string>;

export interface MonacoThemeTokenRuleDef {
  token: string;
  foreground?: string;
  background?: string;
  fontStyle?: string;
}

export interface MonacoThemeDef {
  source?: string;
  base?: "vs" | "vs-dark" | "hc-black";
  inherit?: boolean;
  colors: Record<string, string>;
  rules: MonacoThemeTokenRuleDef[];
}

export interface ThemeSourceDef {
  id: string;
  name: string;
  dark: boolean;
  extends?: string;
  theme: ThemeThemePatch;
  monaco?: MonacoThemeDef;
}

export interface ThemePack {
  formatVersion?: number;
  themes: ThemeSourceDef[];
}

export interface ThemeDef {
  id: string;
  name: string;
  dark: boolean;
  theme: ITheme;
  monaco?: MonacoThemeDef;
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

function normalizeMonacoTokenRule(value: unknown): MonacoThemeTokenRuleDef | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const entry = value as Record<string, unknown>;
  const token = typeof entry.token === "string" ? entry.token.trim() : "";
  if (!token) {
    return null;
  }

  const foreground =
    typeof entry.foreground === "string" && entry.foreground.trim()
      ? entry.foreground.trim()
      : undefined;
  const background =
    typeof entry.background === "string" && entry.background.trim()
      ? entry.background.trim()
      : undefined;
  const fontStyle =
    typeof entry.fontStyle === "string" && entry.fontStyle.trim()
      ? entry.fontStyle.trim()
      : undefined;

  return {
    token,
    ...(foreground ? { foreground } : {}),
    ...(background ? { background } : {}),
    ...(fontStyle ? { fontStyle } : {}),
  };
}

function normalizeMonacoTheme(value: unknown): MonacoThemeDef | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }

  const entry = value as Record<string, unknown>;
  const source =
    typeof entry.source === "string" && entry.source.trim() ? entry.source.trim() : undefined;
  const base =
    entry.base === "vs" || entry.base === "vs-dark" || entry.base === "hc-black"
      ? entry.base
      : undefined;
  const inherit = typeof entry.inherit === "boolean" ? entry.inherit : undefined;
  const colors = normalizeThemePatch(entry.colors);
  const rules = Array.isArray(entry.rules)
    ? entry.rules
        .map((rule) => normalizeMonacoTokenRule(rule))
        .filter((rule): rule is MonacoThemeTokenRuleDef => Boolean(rule))
    : [];

  if (
    !source &&
    !base &&
    inherit === undefined &&
    Object.keys(colors).length === 0 &&
    rules.length === 0
  ) {
    return undefined;
  }

  return {
    ...(source ? { source } : {}),
    ...(base ? { base } : {}),
    ...(inherit !== undefined ? { inherit } : {}),
    colors,
    rules,
  };
}

function mergeMonacoTheme(
  baseMonaco: MonacoThemeDef | undefined,
  overrideMonaco: MonacoThemeDef | undefined,
): MonacoThemeDef | undefined {
  if (!baseMonaco && !overrideMonaco) {
    return undefined;
  }

  return {
    source: overrideMonaco?.source ?? baseMonaco?.source,
    base: overrideMonaco?.base ?? baseMonaco?.base,
    inherit: overrideMonaco?.inherit ?? baseMonaco?.inherit,
    colors: {
      ...(baseMonaco?.colors ?? {}),
      ...(overrideMonaco?.colors ?? {}),
    },
    rules: [...(baseMonaco?.rules ?? []), ...(overrideMonaco?.rules ?? [])],
  };
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
  const monaco = normalizeMonacoTheme(entry.monaco);

  return {
    id,
    name,
    dark: entry.dark,
    ...(extendsId ? { extends: extendsId } : {}),
    theme,
    ...(monaco ? { monaco } : {}),
  };
}

export function normalizeThemePack(value: unknown): ThemePack {
  if (!value || typeof value !== "object") {
    return { themes: [] };
  }

  const rawThemes = Array.isArray((value as { themes?: unknown }).themes)
    ? ((value as { themes: unknown[] }).themes ?? [])
    : [];
  const formatVersion =
    typeof (value as { formatVersion?: unknown }).formatVersion === "number"
      ? ((value as { formatVersion: number }).formatVersion ?? undefined)
      : undefined;

  return {
    ...(formatVersion ? { formatVersion } : {}),
    themes: rawThemes
      .map((entry) => normalizeThemeEntry(entry))
      .filter((entry): entry is ThemeSourceDef => Boolean(entry)),
  };
}

export function resolveThemePack(pack: ThemePack): ThemeDef[] {
  const resolved = new Map<string, ThemeDef>();
  const orderedIds: string[] = [];

  for (const sourceTheme of pack.themes) {
    const baseDef =
      sourceTheme.extends && resolved.has(sourceTheme.extends)
        ? resolved.get(sourceTheme.extends)!
        : sourceTheme.extends === sourceTheme.id && resolved.has(sourceTheme.id)
          ? resolved.get(sourceTheme.id)!
          : undefined;
    const nextMonaco = mergeMonacoTheme(baseDef?.monaco, sourceTheme.monaco);

    const nextTheme: ThemeDef = {
      id: sourceTheme.id,
      name: sourceTheme.name,
      dark: sourceTheme.dark,
      theme: {
        ...(baseDef?.theme ?? {}),
        ...sourceTheme.theme,
      } as ITheme,
      ...(nextMonaco ? { monaco: nextMonaco } : {}),
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
    formatVersion: runtimePack?.formatVersion,
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

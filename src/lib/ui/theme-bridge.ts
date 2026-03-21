import type { ITheme } from "@xterm/xterm";
import { UI_CSS_VARS } from "./tokens";
import type { Settings } from "../types";
import { buildFontStack, serializeFontFamilyList } from "../font-family";

export interface UiThemePalette {
  appBg: string;
  surface: string;
  elevated: string;
  overlay: string;
  textPrimary: string;
  textSecondary: string;
  textMuted: string;
  borderSubtle: string;
  borderStrong: string;
  accent: string;
  accentSoft: string;
  accentText: string;
  danger: string;
  dangerSoft: string;
  success: string;
  warning: string;
  focusRing: string;
  shadowRgb: string;
}

type Rgb = { r: number; g: number; b: number };

function clampChannel(value: number) {
  return Math.max(0, Math.min(255, Math.round(value)));
}

function normalizeHex(value: string | undefined, fallback: string) {
  if (!value) return fallback;
  const trimmed = value.trim();
  if (/^#([\da-f]{3}|[\da-f]{6})$/i.test(trimmed)) return trimmed;
  return fallback;
}

function hexToRgb(value: string): Rgb {
  const normalized = normalizeHex(value, "#000000");
  const short = /^#([\da-f]{3})$/i.exec(normalized);
  if (short) {
    const [r, g, b] = short[1].split("").map((part) => Number.parseInt(part + part, 16));
    return { r, g, b };
  }

  const long = /^#([\da-f]{6})$/i.exec(normalized);
  if (!long) return { r: 0, g: 0, b: 0 };

  const hex = long[1];
  return {
    r: Number.parseInt(hex.slice(0, 2), 16),
    g: Number.parseInt(hex.slice(2, 4), 16),
    b: Number.parseInt(hex.slice(4, 6), 16),
  };
}

function rgbToHex({ r, g, b }: Rgb) {
  return `#${[r, g, b].map((channel) => channel.toString(16).padStart(2, "0")).join("")}`;
}

function mixHex(left: string, right: string, weight: number) {
  const a = hexToRgb(left);
  const b = hexToRgb(right);
  const ratio = Math.max(0, Math.min(1, weight));

  return rgbToHex({
    r: clampChannel(a.r + (b.r - a.r) * ratio),
    g: clampChannel(a.g + (b.g - a.g) * ratio),
    b: clampChannel(a.b + (b.b - a.b) * ratio),
  });
}

function luminance(value: string) {
  const { r, g, b } = hexToRgb(value);
  const toLinear = (channel: number) => {
    const normalized = channel / 255;
    return normalized <= 0.03928
      ? normalized / 12.92
      : ((normalized + 0.055) / 1.055) ** 2.4;
  };

  return 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b);
}

function rgba(value: string, alpha: number) {
  const { r, g, b } = hexToRgb(value);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function withAlpha(value: string, alpha: number) {
  return rgba(value, alpha);
}

function pickReadableText(background: string) {
  return luminance(background) > 0.5 ? "#0f172a" : "#f8fafc";
}

export function createUiThemePalette(theme: ITheme | null | undefined): UiThemePalette {
  const background = normalizeHex(theme?.background, "#1e1e2e");
  const foreground = normalizeHex(theme?.foreground, pickReadableText(background));
  const selection = normalizeHex(theme?.selectionBackground, mixHex(background, foreground, 0.18));
  const cursor = normalizeHex(theme?.cursor, selection);
  const dark = luminance(background) < 0.45;

  const surface = dark ? mixHex(background, "#ffffff", 0.04) : mixHex(background, "#000000", 0.04);
  const elevated = dark ? mixHex(background, "#ffffff", 0.08) : mixHex(background, "#000000", 0.08);
  const borderSubtle = dark ? mixHex(background, "#ffffff", 0.13) : mixHex(background, "#000000", 0.13);
  const borderStrong = dark ? mixHex(background, "#ffffff", 0.22) : mixHex(background, "#000000", 0.22);
  const muted = dark ? mixHex(foreground, background, 0.42) : mixHex(foreground, background, 0.56);
  const accent = cursor;
  const accentSoft = withAlpha(accent, dark ? 0.18 : 0.14);
  const accentText = pickReadableText(accent);
  const shadowRgb = dark ? "15, 23, 42" : "15, 23, 42";
  const danger = normalizeHex(theme?.red, dark ? "#fb7185" : "#dc2626");
  const success = normalizeHex(theme?.green, dark ? "#34d399" : "#16a34a");
  const warning = normalizeHex(theme?.yellow, dark ? "#fbbf24" : "#d97706");

  return {
    appBg: background,
    surface,
    elevated,
    overlay: dark ? "rgba(2, 6, 23, 0.58)" : "rgba(15, 23, 42, 0.42)",
    textPrimary: foreground,
    textSecondary: mixHex(foreground, background, 0.18),
    textMuted: muted,
    borderSubtle,
    borderStrong,
    accent,
    accentSoft,
    accentText,
    danger,
    dangerSoft: withAlpha(danger, dark ? 0.16 : 0.12),
    success,
    warning,
    focusRing: accentSoft,
    shadowRgb,
  };
}

export function applyUiThemeVariables(root: HTMLElement, theme: ITheme | null | undefined) {
  const palette = createUiThemePalette(theme);
  root.style.setProperty(UI_CSS_VARS.appBg, palette.appBg);
  root.style.setProperty(UI_CSS_VARS.surface, palette.surface);
  root.style.setProperty(UI_CSS_VARS.elevated, palette.elevated);
  root.style.setProperty(UI_CSS_VARS.overlay, palette.overlay);
  root.style.setProperty(UI_CSS_VARS.textPrimary, palette.textPrimary);
  root.style.setProperty(UI_CSS_VARS.textSecondary, palette.textSecondary);
  root.style.setProperty(UI_CSS_VARS.textMuted, palette.textMuted);
  root.style.setProperty(UI_CSS_VARS.borderSubtle, palette.borderSubtle);
  root.style.setProperty(UI_CSS_VARS.borderStrong, palette.borderStrong);
  root.style.setProperty(UI_CSS_VARS.accent, palette.accent);
  root.style.setProperty(UI_CSS_VARS.accentSoft, palette.accentSoft);
  root.style.setProperty(UI_CSS_VARS.accentText, palette.accentText);
  root.style.setProperty(UI_CSS_VARS.danger, palette.danger);
  root.style.setProperty(UI_CSS_VARS.dangerSoft, palette.dangerSoft);
  root.style.setProperty(UI_CSS_VARS.success, palette.success);
  root.style.setProperty(UI_CSS_VARS.warning, palette.warning);
  root.style.setProperty(UI_CSS_VARS.focusRing, palette.focusRing);
  root.style.setProperty(UI_CSS_VARS.shadowRgb, palette.shadowRgb);
}

function scaled(px: number, scale: number) {
  return `${Math.round(px * scale * 100) / 100}px`;
}

export function applyUiPreferenceVariables(root: HTMLElement, settings: Settings) {
  const scale = Math.max(0.8, Math.min(2, settings.interface.uiScale / 100));
  const fontFamily = serializeFontFamilyList(
    settings.interface.uiFontFamily,
    "\"Pretendard\", \"Segoe UI\", system-ui",
  );
  const fontFallback = serializeFontFamilyList(
    settings.interface.uiFontFamilyFallback,
    "\"Malgun Gothic\", \"Apple SD Gothic Neo\", sans-serif",
  );

  root.style.setProperty(UI_CSS_VARS.scale, String(scale));
  root.style.setProperty(UI_CSS_VARS.fontFamily, fontFamily);
  root.style.setProperty(UI_CSS_VARS.fontFallback, fontFallback);
  root.style.setProperty(
    UI_CSS_VARS.fontStack,
    buildFontStack(fontFamily, fontFallback, "system-ui", "-apple-system", "sans-serif"),
  );

  root.style.setProperty(UI_CSS_VARS.fontSizeXs, scaled(11, scale));
  root.style.setProperty(UI_CSS_VARS.fontSizeSm, scaled(12, scale));
  root.style.setProperty(UI_CSS_VARS.fontSizeBase, scaled(14, scale));
  root.style.setProperty(UI_CSS_VARS.fontSizeMd, scaled(15, scale));
  root.style.setProperty(UI_CSS_VARS.fontSizeLg, scaled(18, scale));
  root.style.setProperty(UI_CSS_VARS.fontSizeXl, scaled(22, scale));
  root.style.setProperty(UI_CSS_VARS.space1, scaled(4, scale));
  root.style.setProperty(UI_CSS_VARS.space2, scaled(8, scale));
  root.style.setProperty(UI_CSS_VARS.space3, scaled(12, scale));
  root.style.setProperty(UI_CSS_VARS.space4, scaled(16, scale));
  root.style.setProperty(UI_CSS_VARS.space5, scaled(20, scale));
  root.style.setProperty(UI_CSS_VARS.space6, scaled(24, scale));
  root.style.setProperty(UI_CSS_VARS.radiusSm, scaled(8, scale));
  root.style.setProperty(UI_CSS_VARS.radiusMd, scaled(12, scale));
  root.style.setProperty(UI_CSS_VARS.radiusLg, scaled(16, scale));
  root.style.setProperty(UI_CSS_VARS.radiusXl, scaled(22, scale));
}

export function getThemeTokenStyle(theme: ITheme | null | undefined) {
  const palette = createUiThemePalette(theme);
  return {
    "--ui-bg-app": palette.appBg,
    "--ui-bg-surface": palette.surface,
    "--ui-bg-elevated": palette.elevated,
    "--ui-bg-overlay": palette.overlay,
    "--ui-text-primary": palette.textPrimary,
    "--ui-text-secondary": palette.textSecondary,
    "--ui-text-muted": palette.textMuted,
    "--ui-border-subtle": palette.borderSubtle,
    "--ui-border-strong": palette.borderStrong,
    "--ui-accent": palette.accent,
    "--ui-accent-soft": palette.accentSoft,
    "--ui-accent-text": palette.accentText,
    "--ui-danger": palette.danger,
    "--ui-danger-soft": palette.dangerSoft,
    "--ui-success": palette.success,
    "--ui-warning": palette.warning,
    "--ui-focus-ring": palette.focusRing,
    "--ui-shadow-rgb": palette.shadowRgb,
  };
}

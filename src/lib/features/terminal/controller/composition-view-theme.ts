import type { ITheme } from "@xterm/xterm";

const DEFAULT_COMPOSITION_FOREGROUND = "#f8fafc";
const DEFAULT_COMPOSITION_EMPHASIS = "#64748b";
const DEFAULT_COMPOSITION_BACKGROUND = "rgba(15, 23, 42, 0.18)";

export function hexToRgba(color: string | undefined, alpha: number, fallback: string) {
  if (!color) return fallback;

  const normalized = color.trim();
  const shortHex = /^#([\da-f]{3})$/i.exec(normalized);
  if (shortHex) {
    const [r, g, b] = shortHex[1].split("").map((value) => Number.parseInt(value + value, 16));
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }

  const longHex = /^#([\da-f]{6})$/i.exec(normalized);
  if (longHex) {
    const hex = longHex[1];
    const r = Number.parseInt(hex.slice(0, 2), 16);
    const g = Number.parseInt(hex.slice(2, 4), 16);
    const b = Number.parseInt(hex.slice(4, 6), 16);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }

  return fallback;
}

export function getCompositionViewThemeVars(theme: ITheme | null | undefined) {
  const foreground = theme?.foreground ?? DEFAULT_COMPOSITION_FOREGROUND;
  const emphasis = theme?.selectionBackground ?? theme?.cursor ?? DEFAULT_COMPOSITION_EMPHASIS;
  const background = hexToRgba(emphasis, 0.18, DEFAULT_COMPOSITION_BACKGROUND);

  return {
    foreground,
    background,
  };
}

export function applyTerminalCompositionViewTheme(
  element: HTMLElement | null | undefined,
  theme: ITheme | null | undefined,
) {
  if (!element) return;

  const { foreground, background } = getCompositionViewThemeVars(theme);
  element.style.setProperty("--ime-composition-fg", foreground);
  element.style.setProperty("--ime-composition-bg", background);
}

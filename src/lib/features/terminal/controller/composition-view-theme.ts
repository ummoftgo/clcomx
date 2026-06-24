import type { ITheme } from "@xterm/xterm";

const DEFAULT_COMPOSITION_FOREGROUND = "#f8fafc";
const DEFAULT_COMPOSITION_EMPHASIS = "#64748b";
// Must stay fully opaque: the composition box has to mask the block cursor and any
// glyph rendered underneath it during IME composition. A translucent background lets
// the cursor bleed through and produces the "overlapping characters" artifact.
const DEFAULT_COMPOSITION_BACKGROUND = "#0f172a";

/**
 * Returns the given color forced to full opacity, or `fallback` when it cannot be parsed.
 * Accepts 3/6/8-digit hex and rgb()/rgba(); any alpha channel is dropped so the
 * composition view always covers what is drawn beneath it.
 */
export function toOpaqueColor(color: string | undefined, fallback: string) {
  if (!color) return fallback;

  const normalized = color.trim();

  // 3 or 6 digit hex is already opaque.
  if (/^#([\da-f]{3}|[\da-f]{6})$/i.test(normalized)) {
    return normalized;
  }

  // 8 digit hex carries an alpha byte — strip it.
  const hex8 = /^#([\da-f]{6})[\da-f]{2}$/i.exec(normalized);
  if (hex8) {
    return `#${hex8[1]}`;
  }

  // rgb()/rgba() — keep the channels, force opacity by emitting rgb().
  const rgb = /^rgba?\(([^)]+)\)$/i.exec(normalized);
  if (rgb) {
    const parts = rgb[1].split(",").map((value) => value.trim());
    if (parts.length >= 3) {
      return `rgb(${parts[0]}, ${parts[1]}, ${parts[2]})`;
    }
  }

  return fallback;
}

export function getCompositionViewThemeVars(theme: ITheme | null | undefined) {
  const foreground = theme?.foreground ?? DEFAULT_COMPOSITION_FOREGROUND;
  const emphasis = theme?.selectionBackground ?? theme?.cursor ?? DEFAULT_COMPOSITION_EMPHASIS;
  const background = toOpaqueColor(emphasis, toOpaqueColor(theme?.background, DEFAULT_COMPOSITION_BACKGROUND));

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

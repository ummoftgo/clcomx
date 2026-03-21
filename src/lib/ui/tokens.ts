export const UI_SPACING = {
  0: "0px",
  1: "4px",
  2: "8px",
  3: "12px",
  4: "16px",
  5: "20px",
  6: "24px",
  8: "32px",
  10: "40px",
  12: "48px",
  16: "64px",
} as const;

export const UI_RADIUS = {
  xs: "6px",
  sm: "8px",
  md: "12px",
  lg: "16px",
  xl: "22px",
  pill: "999px",
} as const;

export const UI_SHADOW = {
  subtle: "0 8px 24px rgba(15, 23, 42, 0.18)",
  overlay: "0 18px 54px rgba(15, 23, 42, 0.32)",
  inset: "inset 0 1px 0 rgba(255, 255, 255, 0.04)",
} as const;

export const UI_MOTION = {
  fast: "120ms",
  base: "180ms",
  slow: "260ms",
  easing: "cubic-bezier(0.2, 0.8, 0.2, 1)",
} as const;

export const UI_TYPE_SCALE = {
  xs: "11px",
  sm: "12px",
  base: "14px",
  md: "15px",
  lg: "18px",
  xl: "22px",
} as const;

export const UI_CSS_VARS = {
  appBg: "--ui-bg-app",
  surface: "--ui-bg-surface",
  elevated: "--ui-bg-elevated",
  overlay: "--ui-bg-overlay",
  scale: "--ui-scale",
  fontFamily: "--ui-font-family",
  fontFallback: "--ui-font-fallback",
  fontStack: "--ui-font-stack",
  fontSizeXs: "--ui-font-size-xs",
  fontSizeSm: "--ui-font-size-sm",
  fontSizeBase: "--ui-font-size-base",
  fontSizeMd: "--ui-font-size-md",
  fontSizeLg: "--ui-font-size-lg",
  fontSizeXl: "--ui-font-size-xl",
  space1: "--ui-space-1",
  space2: "--ui-space-2",
  space3: "--ui-space-3",
  space4: "--ui-space-4",
  space5: "--ui-space-5",
  space6: "--ui-space-6",
  radiusSm: "--ui-radius-sm",
  radiusMd: "--ui-radius-md",
  radiusLg: "--ui-radius-lg",
  radiusXl: "--ui-radius-xl",
  textPrimary: "--ui-text-primary",
  textSecondary: "--ui-text-secondary",
  textMuted: "--ui-text-muted",
  borderSubtle: "--ui-border-subtle",
  borderStrong: "--ui-border-strong",
  accent: "--ui-accent",
  accentSoft: "--ui-accent-soft",
  accentText: "--ui-accent-text",
  danger: "--ui-danger",
  dangerSoft: "--ui-danger-soft",
  success: "--ui-success",
  warning: "--ui-warning",
  focusRing: "--ui-focus-ring",
  shadowRgb: "--ui-shadow-rgb",
} as const;

export type UiCssVarName = (typeof UI_CSS_VARS)[keyof typeof UI_CSS_VARS];

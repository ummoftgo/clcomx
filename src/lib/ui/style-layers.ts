import type { ITheme } from "@xterm/xterm";
import type { Settings } from "../types";
import { getThemeTokenStyle, getUiPreferenceTokenStyle } from "./theme-bridge";

const RUNTIME_STYLE_LAYER_ID = "clcomx-runtime-theme";
const CUSTOM_CSS_LAYER_ID = "clcomx-custom-css";

function getAppChromeTokenStyle(theme: ITheme | null | undefined): Record<string, string> {
  return {
    "--app-bg": theme?.background ?? "#1e1e2e",
    "--tab-text": theme?.foreground ?? "#cdd6f4",
    "--tab-bg": theme?.background ?? "#1e1e2e",
    "--tab-active-bg": theme?.selectionBackground ?? "#313244",
    "--tab-border": theme?.selectionBackground ?? "#45475a",
  };
}

function serializeStyleRule(selector: string, declarations: Record<string, string>) {
  const lines = Object.entries(declarations)
    .filter(([, value]) => typeof value === "string" && value.length > 0)
    .map(([key, value]) => `  ${key}: ${value};`);

  return `${selector} {\n${lines.join("\n")}\n}\n`;
}

function ensureStyleLayer(
  documentRef: Document,
  id: string,
  cssText: string,
  beforeLayerId?: string,
) {
  let styleEl = documentRef.getElementById(id) as HTMLStyleElement | null;
  if (!styleEl) {
    styleEl = documentRef.createElement("style");
    styleEl.id = id;

    const head = documentRef.head ?? documentRef.documentElement;
    const beforeNode = beforeLayerId ? documentRef.getElementById(beforeLayerId) : null;
    if (beforeNode?.parentNode === head) {
      head.insertBefore(styleEl, beforeNode);
    } else {
      head.append(styleEl);
    }
  }

  styleEl.textContent = cssText;
}

export function buildRuntimeStyleCss(
  settings: Settings,
  theme: ITheme | null | undefined,
) {
  return serializeStyleRule(":root", {
    ...getAppChromeTokenStyle(theme),
    ...getThemeTokenStyle(theme),
    ...getUiPreferenceTokenStyle(settings),
  });
}

export function applyRuntimeStyleLayer(
  documentRef: Document,
  settings: Settings,
  theme: ITheme | null | undefined,
) {
  ensureStyleLayer(
    documentRef,
    RUNTIME_STYLE_LAYER_ID,
    buildRuntimeStyleCss(settings, theme),
    CUSTOM_CSS_LAYER_ID,
  );
}

export function applyCustomCssLayer(documentRef: Document, cssText?: string | null) {
  const nextCss = cssText?.trim() ?? "";
  const existing = documentRef.getElementById(CUSTOM_CSS_LAYER_ID) as HTMLStyleElement | null;

  if (!nextCss) {
    existing?.remove();
    return;
  }

  ensureStyleLayer(documentRef, CUSTOM_CSS_LAYER_ID, `${nextCss}\n`);
}

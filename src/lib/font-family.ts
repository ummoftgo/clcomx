const GENERIC_FONT_FAMILIES = new Set([
  "serif",
  "sans-serif",
  "monospace",
  "cursive",
  "fantasy",
  "system-ui",
  "ui-serif",
  "ui-sans-serif",
  "ui-monospace",
  "ui-rounded",
  "emoji",
  "math",
  "fangsong",
]);

export function serializeFontFamilyToken(token: string) {
  const trimmed = token.trim();
  if (!trimmed) return "";
  if (
    (trimmed.startsWith("\"") && trimmed.endsWith("\"")) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed;
  }

  if (GENERIC_FONT_FAMILIES.has(trimmed.toLowerCase())) {
    return trimmed;
  }

  if (/^[A-Za-z0-9_-]+$/.test(trimmed)) {
    return trimmed;
  }

  return `"${trimmed.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

export function serializeFontFamilyList(value: string, fallback: string) {
  const parts = value
    .split(",")
    .map((part) => serializeFontFamilyToken(part))
    .filter(Boolean);

  if (parts.length > 0) {
    return parts.join(", ");
  }

  return fallback;
}

export function buildFontStack(...parts: string[]) {
  return parts
    .map((part) => part.trim())
    .filter(Boolean)
    .join(", ");
}

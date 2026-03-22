const MODIFIER_ORDER = ["Ctrl", "Alt", "Shift", "Meta"] as const;

type ModifierLabel = typeof MODIFIER_ORDER[number];

function normalizeModifierKey(modifier: string): ModifierLabel | null {
  const lowered = modifier.trim().toLowerCase();
  switch (lowered) {
    case "ctrl":
    case "control":
      return "Ctrl";
    case "alt":
    case "option":
      return "Alt";
    case "shift":
      return "Shift";
    case "meta":
    case "cmd":
    case "command":
    case "super":
      return "Meta";
    default:
      return null;
  }
}

function normalizeKeyLabel(key: string) {
  if (key === " ") {
    return "Space";
  }

  const trimmed = key.trim();
  if (!trimmed) return "";

  switch (trimmed.toLowerCase()) {
    case "backquote":
    case "backtick":
    case "grave":
    case "graveaccent":
      return "`";
    case "esc":
      return "Escape";
    case "space":
    case "spacebar":
      return "Space";
    default:
      if (trimmed.length === 1) {
        return trimmed.toUpperCase();
      }
      return trimmed[0].toUpperCase() + trimmed.slice(1);
  }
}

export function normalizeShortcut(value: string, fallback = "Ctrl+`") {
  const parts = value
    .split("+")
    .map((part) => part.trim())
    .filter(Boolean);

  if (parts.length === 0) {
    return fallback;
  }

  const modifierSet = new Set<ModifierLabel>();
  let primaryKey = "";

  for (const part of parts) {
    const normalizedModifier = normalizeModifierKey(part);
    if (normalizedModifier) {
      modifierSet.add(normalizedModifier);
      continue;
    }

    if (!primaryKey) {
      primaryKey = normalizeKeyLabel(part);
    }
  }

  if (!primaryKey) {
    return fallback;
  }

  const modifiers = MODIFIER_ORDER.filter((modifier) => modifierSet.has(modifier));
  return [...modifiers, primaryKey].join("+");
}

export function eventToShortcut(event: KeyboardEvent) {
  const modifiers: ModifierLabel[] = [];
  if (event.ctrlKey) modifiers.push("Ctrl");
  if (event.altKey) modifiers.push("Alt");
  if (event.shiftKey) modifiers.push("Shift");
  if (event.metaKey) modifiers.push("Meta");

  let key = event.key;
  if (!key || key === "Dead") {
    key = event.code;
  }

  if (key === " ") {
    key = "Space";
  }

  if (["Control", "Shift", "Alt", "Meta"].includes(key)) {
    return null;
  }

  return normalizeShortcut([...modifiers, key].join("+"));
}

export function matchesShortcut(event: KeyboardEvent, shortcut: string) {
  const normalizedEvent = eventToShortcut(event);
  if (!normalizedEvent) {
    return false;
  }
  return normalizedEvent === normalizeShortcut(shortcut);
}

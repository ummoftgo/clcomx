import { get } from "svelte/store";
import { _, addMessages, getLocaleFromNavigator, init, locale } from "svelte-i18n";
import type { LanguagePreference, SupportedLocale } from "../types";
import en from "./locales/en";
import ko from "./locales/ko";

const SUPPORTED_LOCALES: SupportedLocale[] = ["en", "ko"];
const DEFAULT_LOCALE: SupportedLocale = "en";

let initialized = false;

function normalizeLocale(value?: string | null): SupportedLocale {
  if (!value) return DEFAULT_LOCALE;
  const normalized = value.toLowerCase();
  if (normalized.startsWith("ko")) return "ko";
  if (normalized.startsWith("en")) return "en";
  return DEFAULT_LOCALE;
}

export function resolveLocale(preference?: LanguagePreference | null, systemLocale?: string | null): SupportedLocale {
  if (preference && preference !== "system") {
    return normalizeLocale(preference);
  }

  return normalizeLocale(systemLocale ?? getLocaleFromNavigator());
}

export function initializeI18n(preference: LanguagePreference = "system", systemLocale?: string | null) {
  if (!initialized) {
    addMessages("en", en);
    addMessages("ko", ko);
    init({
      fallbackLocale: DEFAULT_LOCALE,
      initialLocale: resolveLocale(preference, systemLocale),
    });
    initialized = true;
  }

  locale.set(resolveLocale(preference, systemLocale));
}

export function setLanguagePreference(preference: LanguagePreference, systemLocale?: string | null) {
  locale.set(resolveLocale(preference, systemLocale));
}

export function translate(
  key: string,
  options?: Record<string, unknown>,
) {
  return get(_)(key, options);
}

export { _, locale };
export const t = _;
export { SUPPORTED_LOCALES, DEFAULT_LOCALE };

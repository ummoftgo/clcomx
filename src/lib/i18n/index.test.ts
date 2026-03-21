import { describe, expect, it } from "vitest";
import { DEFAULT_LOCALE, resolveLocale } from "./index";

describe("i18n locale resolution", () => {
  it("prefers explicit language selection over system locale", () => {
    expect(resolveLocale("ko", "en-US")).toBe("ko");
    expect(resolveLocale("en", "ko-KR")).toBe("en");
  });

  it("uses the system locale when preference is system", () => {
    expect(resolveLocale("system", "ko-KR")).toBe("ko");
    expect(resolveLocale("system", "en-US")).toBe("en");
  });

  it("falls back to english for unsupported locales", () => {
    expect(resolveLocale("system", "ja-JP")).toBe(DEFAULT_LOCALE);
    expect(resolveLocale("system", null)).toBe(DEFAULT_LOCALE);
  });
});

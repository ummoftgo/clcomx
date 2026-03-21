import { describe, expect, it } from "vitest";
import { buildFontStack, serializeFontFamilyList, serializeFontFamilyToken } from "./font-family";

describe("font family helpers", () => {
  it("keeps generic font keywords unquoted", () => {
    expect(serializeFontFamilyToken("sans-serif")).toBe("sans-serif");
  });

  it("quotes font names with whitespace or unicode safely", () => {
    expect(serializeFontFamilyToken("Malgun Gothic")).toBe("\"Malgun Gothic\"");
    expect(serializeFontFamilyToken("맑은 고딕")).toBe("\"맑은 고딕\"");
  });

  it("serializes comma separated lists and trims empty entries", () => {
    expect(serializeFontFamilyList("Pretendard, , Malgun Gothic", "sans-serif")).toBe(
      "Pretendard, \"Malgun Gothic\"",
    );
  });

  it("falls back when no explicit font family is provided", () => {
    expect(serializeFontFamilyList("", "sans-serif")).toBe("sans-serif");
  });

  it("builds a combined font stack without empty items", () => {
    expect(buildFontStack("\"Pretendard\"", "", "sans-serif")).toBe("\"Pretendard\", sans-serif");
  });
});

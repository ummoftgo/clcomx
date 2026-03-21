import { describe, expect, it } from "vitest";
import { formatImageSize, formatPathForAgentInput } from "./clipboard";

describe("clipboard helpers", () => {
  it("quotes Claude input paths when whitespace is present", () => {
    expect(formatPathForAgentInput("/tmp/my image.png")).toBe("\"/tmp/my image.png\" ");
  });

  it("escapes embedded double quotes for Claude input paths", () => {
    expect(formatPathForAgentInput('/tmp/with"quote".png')).toBe("\"/tmp/with\\\"quote\\\".png\" ");
  });

  it("keeps simple paths unquoted", () => {
    expect(formatPathForAgentInput("/tmp/image.png")).toBe("/tmp/image.png ");
  });

  it("formats bytes into human readable image sizes", () => {
    expect(formatImageSize(999)).toBe("999 B");
    expect(formatImageSize(2_048)).toBe("2 KB");
    expect(formatImageSize(1_572_864)).toBe("1.5 MB");
  });
});

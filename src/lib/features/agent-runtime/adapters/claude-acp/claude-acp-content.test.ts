/**
 * Claude ACP — content block 매핑 단위 테스트(11 §4, §7).
 * image base64↔data URI, diff patch 생성(oldText=null→신규), resource, toolKind, prompt 변환.
 */
import { describe, expect, it } from "vitest";
import {
  buildUnifiedDiff,
  mapContentBlock,
  mapToolCallContent,
  mapToolKind,
  toAcpPromptContent,
} from "./claude-acp-content";

describe("mapContentBlock (ACP → AgentContent)", () => {
  it("text → {type:text}", () => {
    expect(mapContentBlock({ type: "text", text: "hi" })).toEqual({ type: "text", text: "hi" });
  });

  it("image base64 → data URI(OQ-12)", () => {
    const c = mapContentBlock({ type: "image", data: "QUJD", mimeType: "image/png" });
    expect(c).toEqual({ type: "image", uri: "data:image/png;base64,QUJD", mimeType: "image/png" });
  });

  it("image with uri → uri 우선", () => {
    const c = mapContentBlock({ type: "image", data: "QUJD", mimeType: "image/png", uri: "file:///a.png" });
    expect((c as { uri: string }).uri).toBe("file:///a.png");
  });

  it("audio → json raw 보존(crash 없음, TODO(13))", () => {
    const c = mapContentBlock({ type: "audio", data: "AAA", mimeType: "audio/wav" });
    expect(c.type).toBe("json");
    expect((c as { value: { type: string } }).value.type).toBe("audio");
  });

  it("resource_link → resource", () => {
    const c = mapContentBlock({ type: "resource_link", name: "doc", uri: "file:///a.md", mimeType: "text/markdown" });
    expect(c).toEqual({ type: "resource", uri: "file:///a.md", mimeType: "text/markdown" });
  });

  it("embedded resource(text) → resource{text}", () => {
    const c = mapContentBlock({ type: "resource", resource: { uri: "file:///a.txt", mimeType: "text/plain", text: "body" } });
    expect(c).toEqual({ type: "resource", uri: "file:///a.txt", mimeType: "text/plain", text: "body" });
  });
});

describe("mapToolCallContent / diff (ref-acp §13.5)", () => {
  it("content → 내부 ContentBlock 매핑", () => {
    const c = mapToolCallContent({ type: "content", content: { type: "text", text: "out" } });
    expect(c).toEqual({ type: "text", text: "out" });
  });

  it("diff → {type:diff, path, patch}", () => {
    const c = mapToolCallContent({ type: "diff", path: "a.ts", oldText: "x\n", newText: "y\n" });
    expect(c.type).toBe("diff");
    expect((c as { path: string }).path).toBe("a.ts");
    expect((c as { patch: string }).patch).toContain("--- a/a.ts");
    expect((c as { patch: string }).patch).toContain("-x");
    expect((c as { patch: string }).patch).toContain("+y");
  });

  it("diff oldText=null → 신규 파일(/dev/null)", () => {
    const patch = buildUnifiedDiff("new.ts", null, "hello\n");
    expect(patch).toContain("--- /dev/null");
    expect(patch).toContain("+++ b/new.ts");
    expect(patch).toContain("+hello");
  });

  it("terminal → {type:terminal, output:''}(1차 미조회)", () => {
    const c = mapToolCallContent({ type: "terminal", terminalId: "t1" });
    expect(c).toEqual({ type: "terminal", output: "" });
  });
});

describe("mapToolKind", () => {
  it("9종 그대로, switch_mode→other, undefined→other", () => {
    expect(mapToolKind("read")).toBe("read");
    expect(mapToolKind("execute")).toBe("execute");
    expect(mapToolKind("switch_mode")).toBe("other");
    expect(mapToolKind(undefined)).toBe("other");
  });
});

describe("toAcpPromptContent (composer → ACP)", () => {
  it("text → {type:text}", () => {
    expect(toAcpPromptContent([{ type: "text", text: "hi" }])).toEqual([{ type: "text", text: "hi" }]);
  });

  it("image data URI → {type:image, data, mimeType}", () => {
    const out = toAcpPromptContent([{ type: "image", uri: "data:image/png;base64,QUJD", mimeType: "image/png" }]);
    expect(out).toEqual([{ type: "image", data: "QUJD", mimeType: "image/png" }]);
  });

  it("resource{text} → embedded resource", () => {
    const out = toAcpPromptContent([{ type: "resource", uri: "file:///a.txt", text: "x" }]);
    expect(out[0]).toMatchObject({ type: "resource", resource: { uri: "file:///a.txt", text: "x" } });
  });
});

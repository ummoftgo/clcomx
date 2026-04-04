import { describe, expect, it } from "vitest";
import {
  basenameFromPath,
  directoryFromPath,
  fromMonacoFileUriString,
  toMonacoFileUriString,
} from "./path";

describe("editor path helpers", () => {
  it("extracts basename and directory labels from WSL paths", () => {
    expect(basenameFromPath("/home/user/work/project/src/App.svelte")).toBe("App.svelte");
    expect(directoryFromPath("/home/user/work/project/src/App.svelte")).toBe(
      "/home/user/work/project/src",
    );
  });

  it("builds file:// URIs for Monaco models", () => {
    expect(toMonacoFileUriString("/home/user/work/project/src/App.svelte")).toBe(
      "file:///home/user/work/project/src/App.svelte",
    );
    expect(toMonacoFileUriString("/home/user/work/project/My File.svelte")).toBe(
      "file:///home/user/work/project/My%20File.svelte",
    );
  });

  it("parses file:// URIs back into WSL paths", () => {
    expect(fromMonacoFileUriString("file:///home/user/work/project/src/App.svelte")).toBe(
      "/home/user/work/project/src/App.svelte",
    );
    expect(fromMonacoFileUriString("file:///home/user/work/project/My%20File.svelte")).toBe(
      "/home/user/work/project/My File.svelte",
    );
    expect(fromMonacoFileUriString("https://example.com")).toBeNull();
  });
});

import { describe, expect, it } from "vitest";
import { extractTerminalFileLinkCandidates } from "./file-links";

describe("extractTerminalFileLinkCandidates", () => {
  it("finds absolute, relative, and dotted filenames", () => {
    const line =
      "See /home/tester/work/clcomx/src/App.svelte:12:4 and ../README.md:8 plus Cargo.toml";
    const matches = extractTerminalFileLinkCandidates(line).map((entry) => entry.text);

    expect(matches).toEqual([
      "/home/tester/work/clcomx/src/App.svelte:12:4",
      "../README.md:8",
      "Cargo.toml",
    ]);
  });

  it("trims surrounding punctuation", () => {
    const line = "(src/lib/file.ts:10) '.gitignore' [./package.json]";
    const matches = extractTerminalFileLinkCandidates(line).map((entry) => entry.text);

    expect(matches).toEqual(["src/lib/file.ts:10", ".gitignore", "./package.json"]);
  });

  it("ignores urls and non-path slashes", () => {
    const line = "Visit https://example.com and ignore 2026/03/22 but keep src/routes/index.ts";
    const matches = extractTerminalFileLinkCandidates(line).map((entry) => entry.text);

    expect(matches).toEqual(["src/routes/index.ts"]);
  });

  it("ignores slash paths that end in directories or API-like routes", () => {
    const line =
      "Ignore /api/v1/users and src/lib but keep src/lib/file-links.ts and /home/tester/.gitconfig";
    const matches = extractTerminalFileLinkCandidates(line).map((entry) => entry.text);

    expect(matches).toEqual(["src/lib/file-links.ts", "/home/tester/.gitconfig"]);
  });

  it("extracts nested file paths from wrapper tokens", () => {
    const line = "Update(/home/xenia/work/skills/README.md) and Render(src/App.svelte:12:3)";
    const matches = extractTerminalFileLinkCandidates(line).map((entry) => entry.text);

    expect(matches).toEqual([
      "/home/xenia/work/skills/README.md",
      "src/App.svelte:12:3",
    ]);
  });
});

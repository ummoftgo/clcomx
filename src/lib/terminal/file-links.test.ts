import { describe, expect, it, vi } from "vitest";
import { createTerminalFileLinks, extractTerminalFileLinkCandidates } from "./file-links";


function createFakeTerminal(
  lines: Array<{ text: string; isWrapped?: boolean }>,
  cols: number,
) {
  return {
    cols,
    buffer: {
      active: {
        getLine(index: number) {
          const line = lines[index];
          if (!line) {
            return undefined;
          }

          return {
            isWrapped: line.isWrapped ?? false,
            translateToString(trimRight: boolean) {
              return trimRight ? line.text.trimEnd() : line.text.padEnd(cols, " ");
            },
            getCell(column: number) {
              if (column >= cols) {
                return undefined;
              }

              const char = line.text[column] ?? "";
              return {
                getWidth: () => 1,
                getChars: () => char,
              };
            },
          };
        },
      },
    },
  };
}

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

  it("extracts quoted paths with spaces", () => {
    const line = 'Open "C:/Program Files/Claude Code/app/main.ts" when ready';
    const matches = extractTerminalFileLinkCandidates(line);

    expect(matches).toEqual([
      {
        text: "C:/Program Files/Claude Code/app/main.ts",
        startIndex: 6,
        endIndex: 46,
      },
    ]);
  });

  it("trims surrounding punctuation", () => {
    const line = "(src/lib/file.ts:10) '.gitignore' [./package.json]";
    const matches = extractTerminalFileLinkCandidates(line).map((entry) => entry.text);

    expect(matches).toEqual(["src/lib/file.ts:10", ".gitignore", "./package.json"]);
  });

  it("keeps path:line:column candidates intact", () => {
    const line = "Use src/routes/index.ts:12:4 and src/lib/file-links.ts:88";
    const matches = extractTerminalFileLinkCandidates(line).map((entry) => entry.text);

    expect(matches).toEqual(["src/routes/index.ts:12:4", "src/lib/file-links.ts:88"]);
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

  it("parses traceback-style file references", () => {
    const line = '  File "src/front/index.ts", line 42, in render';
    const matches = extractTerminalFileLinkCandidates(line);

    expect(matches).toEqual([
      {
        text: "src/front/index.ts:42",
        startIndex: 8,
        endIndex: 36,
      },
    ]);
  });

  it("trims Korean natural language suffixes from path tokens", () => {
    const line = "src/front/index.ts에 있습니다.";
    const matches = extractTerminalFileLinkCandidates(line).map((entry) => entry.text);

    expect(matches).toEqual(["src/front/index.ts"]);
  });

  it("detects home-relative paths that start with tilde slash", () => {
    const line = "Open ~/work/project/src/main.ts:18 and ~/.config/ghostty/config";
    const matches = extractTerminalFileLinkCandidates(line).map((entry) => entry.text);

    expect(matches).toEqual(["~/work/project/src/main.ts:18", "~/.config/ghostty/config"]);
  });

  it("detects the exact claude skill path example", () => {
    const line = "~/.claude/skills/code-quality-review/SKILL.md";
    const matches = extractTerminalFileLinkCandidates(line).map((entry) => entry.text);

    expect(matches).toEqual(["~/.claude/skills/code-quality-review/SKILL.md"]);
  });

  it("keeps extensionless home-relative command paths intact", () => {
    const line = "Try ~/bin/claude and ~/.local/share/nvim/lazy-lock.json";
    const matches = extractTerminalFileLinkCandidates(line).map((entry) => entry.text);

    expect(matches).toEqual(["~/bin/claude", "~/.local/share/nvim/lazy-lock.json"]);
  });

  it("creates links for wrapped home-relative paths on continuation lines", () => {
    const term = createFakeTerminal(
      [
        { text: "~/.claude/skill", isWrapped: false },
        { text: "s/code-quality-", isWrapped: true },
        { text: "review/SKILL.md", isWrapped: true },
      ],
      15,
    );

    const links = createTerminalFileLinks(term as never, 2, vi.fn());
    expect(links).toHaveLength(1);
    expect(links?.[0]?.text).toBe("~/.claude/skills/code-quality-review/SKILL.md");
    expect(links?.[0]?.range).toEqual({
      start: { x: 1, y: 1 },
      end: { x: 16, y: 3 },
    });
  });

  it("detects bare tilde and home directories with trailing slash", () => {
    const line = "Run cd ~ or inspect ~/work/project/ before retrying";
    const matches = extractTerminalFileLinkCandidates(line).map((entry) => entry.text);

    expect(matches).toEqual(["~", "~/work/project/"]);
  });
});

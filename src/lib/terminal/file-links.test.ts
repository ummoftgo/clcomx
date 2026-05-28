import { describe, expect, it, vi } from "vitest";
import {
  createTerminalFileLinks,
  createTerminalLinks,
  createTerminalUrlLinks,
  extractTerminalFileLinkCandidates,
} from "./file-links";

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

function trimmedRange(
  text: string,
  lineNumber: number,
  startIndex = text.search(/\S/),
) {
  return {
    start: { x: startIndex + 1, y: lineNumber },
    end: { x: text.trimEnd().length, y: lineNumber },
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
      end: { x: 15, y: 3 },
    });
  });

  it("joins indented wrapped continuation fragments inside relative paths", () => {
    const firstLine = "  - .agent-works/20260328-215127-implement-tmux-s";
    const term = createFakeTerminal(
      [
        { text: firstLine, isWrapped: false },
        { text: "  ubagent-standby.md", isWrapped: true },
      ],
      firstLine.length,
    );

    const links = createTerminalFileLinks(term as never, 2, vi.fn());
    expect(links).toHaveLength(1);
    expect(links?.[0]?.text).toBe(
      ".agent-works/20260328-215127-implement-tmux-subagent-standby.md",
    );
    expect(links?.[0]?.range).toEqual({
      start: { x: 5, y: 1 },
      end: { x: 20, y: 2 },
    });
  });

  it("returns the complete relative path link for every wrapped buffer line", () => {
    const expectedPath = ".agent-works/20260328-215127-implement-tmux-subagent-standby.md";
    const term = createFakeTerminal(
      [
        { text: "  - .agent-works", isWrapped: false },
        { text: "  /20260328-2151", isWrapped: true },
        { text: "  27-implement-t", isWrapped: true },
        { text: "  mux-subagent-s", isWrapped: true },
        { text: "  tandby.md", isWrapped: true },
      ],
      17,
    );

    for (const lineNumber of [1, 2, 3, 4, 5]) {
      const links = createTerminalFileLinks(term as never, lineNumber, vi.fn());
      expect(links, `line ${lineNumber}`).toHaveLength(1);
      expect(links?.[0]?.text, `line ${lineNumber}`).toBe(expectedPath);
      expect(links?.[0]?.range, `line ${lineNumber}`).toEqual({
        start: { x: 5, y: 1 },
        end: { x: 11, y: 5 },
      });
    }
  });

  it("returns complete relative path links for hard-broken output lines", () => {
    const firstPath = ".agent-works/20260328-215127-implement-tmux-subagent-standby.md";
    const secondPath = ".agent-works/20260329-review-agents-skills-config.md";
    const lines = [
      { text: "> 작업 기록     " },
      { text: "  (.agent-works)" },
      { text: "  - .agent-works" },
      { text: "  /20260328-2151" },
      { text: "  27-implement-t" },
      { text: "  mux-subagent-s" },
      { text: "  tandby.md     " },
      { text: "  - .agent-works" },
      { text: "  /20260329-revi" },
      { text: "  ew-agents-skil" },
      { text: "  ls-config.md  " },
    ];
    const term = createFakeTerminal(lines, 24);
    const expected = new Map([
      [3, firstPath],
      [4, firstPath],
      [5, firstPath],
      [6, firstPath],
      [7, firstPath],
      [8, secondPath],
      [9, secondPath],
      [10, secondPath],
      [11, secondPath],
    ]);

    for (const [lineNumber, expectedPath] of expected) {
      const links = createTerminalFileLinks(term as never, lineNumber, vi.fn());
      const startIndex =
        lineNumber === 3 || lineNumber === 8
          ? lines[lineNumber - 1]?.text.indexOf(".agent-works") ?? -1
          : lines[lineNumber - 1]?.text.search(/\S/) ?? -1;

      expect(links, `line ${lineNumber}`).toHaveLength(1);
      expect(links?.[0]?.text, `line ${lineNumber}`).toBe(expectedPath);
      expect(links?.[0]?.range, `line ${lineNumber}`).toEqual(
        trimmedRange(lines[lineNumber - 1]?.text ?? "", lineNumber, startIndex),
      );
    }
  });

  it("preserves spaces in quoted file paths split by terminal wrapping", () => {
    const term = createFakeTerminal(
      [
        { text: 'Open "C:/Program ', isWrapped: false },
        { text: "Files/Claude Code", isWrapped: true },
        { text: '/app/main.ts"', isWrapped: true },
      ],
      17,
    );

    const links = createTerminalFileLinks(term as never, 1, vi.fn());
    expect(links).toHaveLength(1);
    expect(links?.[0]?.text).toBe("C:/Program Files/Claude Code/app/main.ts");
    expect(links?.[0]?.range).toEqual({
      start: { x: 7, y: 1 },
      end: { x: 12, y: 3 },
    });
  });

  it("creates URL links split by terminal wrapping", () => {
    const term = createFakeTerminal(
      [
        { text: "Visit https://exampl", isWrapped: false },
        { text: "e.com/docs/page", isWrapped: true },
      ],
      20,
    );

    const links = createTerminalUrlLinks(term as never, 2, vi.fn());
    expect(links).toHaveLength(1);
    expect(links?.[0]?.text).toBe("https://example.com/docs/page");
    expect(links?.[0]?.range).toEqual({
      start: { x: 7, y: 1 },
      end: { x: 15, y: 2 },
    });
  });

  it("joins indented wrapped continuation fragments inside URLs", () => {
    const firstLine = "Visit https://exampl";
    const term = createFakeTerminal(
      [
        { text: firstLine, isWrapped: false },
        { text: "  e.com/docs/page", isWrapped: true },
      ],
      firstLine.length,
    );

    const links = createTerminalUrlLinks(term as never, 2, vi.fn());
    expect(links).toHaveLength(1);
    expect(links?.[0]?.text).toBe("https://example.com/docs/page");
    expect(links?.[0]?.range).toEqual({
      start: { x: 7, y: 1 },
      end: { x: 17, y: 2 },
    });
  });

  it("returns the complete URL link for every wrapped buffer line", () => {
    const term = createFakeTerminal(
      [
        { text: "* https://claude", isWrapped: false },
        { text: "  .ai", isWrapped: true },
      ],
      16,
    );

    for (const lineNumber of [1, 2]) {
      const links = createTerminalUrlLinks(term as never, lineNumber, vi.fn());
      expect(links, `line ${lineNumber}`).toHaveLength(1);
      expect(links?.[0]?.text, `line ${lineNumber}`).toBe("https://claude.ai");
      expect(links?.[0]?.range, `line ${lineNumber}`).toEqual({
        start: { x: 3, y: 1 },
        end: { x: 5, y: 2 },
      });
    }
  });

  it("returns complete URL links for hard-broken output lines", () => {
    const lines = [{ text: "● https://claude" }, { text: "  .ai" }];
    const term = createFakeTerminal(lines, 18);

    for (const lineNumber of [1, 2]) {
      const links = createTerminalUrlLinks(term as never, lineNumber, vi.fn());
      const startIndex =
        lineNumber === 1
          ? lines[lineNumber - 1]?.text.indexOf("https://") ?? -1
          : lines[lineNumber - 1]?.text.search(/\S/) ?? -1;

      expect(links, `line ${lineNumber}`).toHaveLength(1);
      expect(links?.[0]?.text, `line ${lineNumber}`).toBe("https://claude.ai");
      expect(links?.[0]?.range, `line ${lineNumber}`).toEqual(
        trimmedRange(lines[lineNumber - 1]?.text ?? "", lineNumber, startIndex),
      );
    }
  });

  it("does not append prose after a complete hard-line URL", () => {
    const term = createFakeTerminal(
      [{ text: "See https://example.com/docs" }, { text: "  Next step" }],
      32,
    );

    const firstLineLinks = createTerminalUrlLinks(term as never, 1, vi.fn());
    const secondLineLinks = createTerminalUrlLinks(term as never, 2, vi.fn());

    expect(firstLineLinks).toHaveLength(1);
    expect(firstLineLinks?.[0]?.text).toBe("https://example.com/docs");
    expect(secondLineLinks).toBeUndefined();
  });

  it("does not append a single word after a complete hard-line URL", () => {
    const term = createFakeTerminal(
      [{ text: "See https://example.com/docs" }, { text: "  Next" }],
      32,
    );

    const firstLineLinks = createTerminalUrlLinks(term as never, 1, vi.fn());
    const secondLineLinks = createTerminalUrlLinks(term as never, 2, vi.fn());

    expect(firstLineLinks).toHaveLength(1);
    expect(firstLineLinks?.[0]?.text).toBe("https://example.com/docs");
    expect(secondLineLinks).toBeUndefined();
  });

  it("does not append prose after a complete hard-line file path", () => {
    const term = createFakeTerminal(
      [{ text: "Open src/App.svelte:12" }, { text: "  4 failures" }],
      28,
    );

    const firstLineLinks = createTerminalFileLinks(term as never, 1, vi.fn());
    const secondLineLinks = createTerminalFileLinks(term as never, 2, vi.fn());

    expect(firstLineLinks).toHaveLength(1);
    expect(firstLineLinks?.[0]?.text).toBe("src/App.svelte:12");
    expect(secondLineLinks).toBeUndefined();
  });

  it("does not append a single number after a complete hard-line file path", () => {
    const term = createFakeTerminal(
      [{ text: "Open src/App.svelte:12" }, { text: "  4" }],
      28,
    );

    const firstLineLinks = createTerminalFileLinks(term as never, 1, vi.fn());
    const secondLineLinks = createTerminalFileLinks(term as never, 2, vi.fn());

    expect(firstLineLinks).toHaveLength(1);
    expect(firstLineLinks?.[0]?.text).toBe("src/App.svelte:12");
    expect(secondLineLinks).toBeUndefined();
  });

  it("joins hard-broken URLs split inside the scheme separator", () => {
    const lines = [{ text: "Visit https:/" }, { text: "  /example.com/docs" }];
    const term = createFakeTerminal(lines, 22);

    for (const lineNumber of [1, 2]) {
      const links = createTerminalUrlLinks(term as never, lineNumber, vi.fn());
      const startIndex =
        lineNumber === 1
          ? lines[lineNumber - 1]?.text.indexOf("https:/") ?? -1
          : lines[lineNumber - 1]?.text.search(/\S/) ?? -1;

      expect(links, `line ${lineNumber}`).toHaveLength(1);
      expect(links?.[0]?.text, `line ${lineNumber}`).toBe("https://example.com/docs");
      expect(links?.[0]?.range, `line ${lineNumber}`).toEqual(
        trimmedRange(lines[lineNumber - 1]?.text ?? "", lineNumber, startIndex),
      );
    }
  });

  it("joins hard-broken home paths split after the tilde", () => {
    const lines = [{ text: "Open ~" }, { text: "  /work/project/file.ts" }];
    const term = createFakeTerminal(lines, 24);

    for (const lineNumber of [1, 2]) {
      const links = createTerminalFileLinks(term as never, lineNumber, vi.fn());
      const startIndex =
        lineNumber === 1
          ? lines[lineNumber - 1]?.text.indexOf("~") ?? -1
          : lines[lineNumber - 1]?.text.search(/\S/) ?? -1;

      expect(links, `line ${lineNumber}`).toHaveLength(1);
      expect(links?.[0]?.text, `line ${lineNumber}`).toBe("~/work/project/file.ts");
      expect(links?.[0]?.range, `line ${lineNumber}`).toEqual(
        trimmedRange(lines[lineNumber - 1]?.text ?? "", lineNumber, startIndex),
      );
    }
  });

  it("prefers complete hard-broken URLs over partial file-like fragments", () => {
    const term = createFakeTerminal([{ text: "● https://claude" }, { text: "  .ai" }], 18);
    const onFileActivate = vi.fn();
    const onUrlActivate = vi.fn();

    const links = createTerminalLinks(term as never, 2, {
      onFileActivate,
      onUrlActivate,
    });

    expect(links).toHaveLength(1);
    expect(links?.[0]?.text).toBe("https://claude.ai");

    links?.[0]?.activate(new MouseEvent("click"), links[0].text);
    expect(onUrlActivate).toHaveBeenCalledWith(expect.any(MouseEvent), "https://claude.ai");
    expect(onFileActivate).not.toHaveBeenCalled();
  });

  it("detects bare tilde and home directories with trailing slash", () => {
    const line = "Run cd ~ or inspect ~/work/project/ before retrying";
    const matches = extractTerminalFileLinkCandidates(line).map((entry) => entry.text);

    expect(matches).toEqual(["~", "~/work/project/"]);
  });
});

import type { ILink, Terminal } from "@xterm/xterm";

export interface TerminalFileLinkCandidate {
  text: string;
  startIndex: number;
  endIndex: number;
}

const RAW_TOKEN_REGEX = /\S+/g;
const LEADING_TRIM_CHARS = new Set(["\"", "'", "`", "(", "[", "{", "<"]);
const TRAILING_TRIM_CHARS = new Set(["\"", "'", "`", ")", "]", "}", ">", ",", ".", "!", "?", ";"]);
const KNOWN_FILENAMES = new Set([
  "cargo.toml",
  "cargo.lock",
  "package.json",
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "tsconfig.json",
  "vite.config.ts",
  "vite.config.js",
  "svelte.config.js",
  "dockerfile",
  "makefile",
  "readme",
  "readme.md",
  "license",
  "license.md",
]);
const KNOWN_EXTENSIONS = new Set([
  "c",
  "cc",
  "cpp",
  "cs",
  "css",
  "cxx",
  "env",
  "go",
  "h",
  "hpp",
  "html",
  "ini",
  "java",
  "js",
  "json",
  "jsonc",
  "jsx",
  "kt",
  "kts",
  "less",
  "lock",
  "lua",
  "m",
  "md",
  "mm",
  "php",
  "ps1",
  "py",
  "rb",
  "rs",
  "sass",
  "scss",
  "sh",
  "sql",
  "svelte",
  "swift",
  "toml",
  "ts",
  "tsx",
  "txt",
  "xml",
  "yaml",
  "yml",
  "zsh",
]);

function trimTokenBounds(source: string, startIndex: number, endIndex: number) {
  let start = startIndex;
  let end = endIndex;

  while (start < end && LEADING_TRIM_CHARS.has(source[start] ?? "")) {
    start += 1;
  }

  while (end > start && TRAILING_TRIM_CHARS.has(source[end - 1] ?? "")) {
    end -= 1;
  }

  return { start, end };
}

function stripLineAndColumn(value: string) {
  const match = /^(.*?):(\d+)(?::(\d+))?$/.exec(value);
  return match ? match[1] ?? value : value;
}

function findNestedPathStart(value: string) {
  for (let index = 1; index < value.length; index += 1) {
    const previous = value[index - 1];
    const canStartAfterDelimiter =
      previous !== undefined && LEADING_TRIM_CHARS.has(previous);

    if (!canStartAfterDelimiter) {
      continue;
    }

    return index;
  }

  return -1;
}

function basenameLooksLikeDevelopmentFile(basename: string) {
  if (!basename || basename === "." || basename === "..") {
    return false;
  }

  const normalizedBasename = basename.toLowerCase();
  if (KNOWN_FILENAMES.has(normalizedBasename)) {
    return true;
  }

  if (/^\.[A-Za-z0-9._-]+$/.test(basename)) {
    return true;
  }

  if (!basename.includes(".")) {
    return false;
  }

  const extension = normalizedBasename.split(".").pop() ?? "";
  return KNOWN_EXTENSIONS.has(extension);
}

function looksLikePathCandidate(value: string) {
  const normalized = stripLineAndColumn(value);
  const normalizedLower = normalized.toLowerCase();
  const basename = normalizedLower.split("/").filter(Boolean).pop() ?? normalizedLower;

  if (!normalized || normalized === "/" || normalized === "." || normalized === "..") {
    return false;
  }

  if (normalized.includes("://")) {
    return false;
  }

  if (/^\d+(?:[/-]\d+)+$/.test(normalized)) {
    return false;
  }

  if (!/[A-Za-z_.-]/.test(normalized)) {
    return false;
  }

  if (normalized.startsWith("~/")) {
    const homeBasename = normalizedLower.slice(2).split("/").filter(Boolean).pop() ?? "";
    return basenameLooksLikeDevelopmentFile(homeBasename);
  }

  if (normalized.startsWith("/")) {
    return normalized.length > 1 && basenameLooksLikeDevelopmentFile(basename);
  }

  if (normalized.startsWith("./") || normalized.startsWith("../")) {
    return basenameLooksLikeDevelopmentFile(basename);
  }

  if (normalized.includes("/")) {
    return basenameLooksLikeDevelopmentFile(basename);
  }

  return basenameLooksLikeDevelopmentFile(normalized);
}

export function extractTerminalFileLinkCandidates(text: string): TerminalFileLinkCandidate[] {
  const candidates: TerminalFileLinkCandidate[] = [];

  for (const match of text.matchAll(RAW_TOKEN_REGEX)) {
    const raw = match[0];
    const matchIndex = match.index;

    if (!raw || matchIndex === undefined) {
      continue;
    }

    const { start, end } = trimTokenBounds(text, matchIndex, matchIndex + raw.length);
    if (start >= end) {
      continue;
    }

    const rawCandidate = text.slice(start, end);
    const nestedStart = findNestedPathStart(rawCandidate);
    let candidate = rawCandidate;
    let candidateStart = start;

    if (nestedStart > 0) {
      const nestedCandidate = rawCandidate.slice(nestedStart);
      if (looksLikePathCandidate(nestedCandidate)) {
        candidate = nestedCandidate;
        candidateStart = start + nestedStart;
      }
    }

    if (!looksLikePathCandidate(candidate)) {
      continue;
    }

    candidates.push({
      text: candidate,
      startIndex: candidateStart,
      endIndex: candidateStart + candidate.length,
    });
  }

  return candidates;
}

function buildTerminalLineSnapshot(term: Terminal, bufferLineNumber: number) {
  const line = term.buffer.active.getLine(bufferLineNumber - 1);
  if (!line) {
    return null;
  }

  let text = "";
  const columnMap: number[] = [];
  const spanMap: number[] = [];

  for (let column = 0; column < term.cols; column += 1) {
    const cell = line.getCell(column);

    if (!cell) {
      text += " ";
      columnMap.push(column);
      spanMap.push(1);
      continue;
    }

    const width = cell.getWidth();
    if (width === 0) {
      continue;
    }

    const chars = cell.getChars() || " ";
    text += chars;

    for (let index = 0; index < chars.length; index += 1) {
      columnMap.push(column);
      spanMap.push(width);
    }
  }

  return { text, columnMap, spanMap };
}

export function createTerminalFileLinks(
  term: Terminal,
  bufferLineNumber: number,
  onActivate: (event: MouseEvent, text: string) => void,
  onHover?: (event: MouseEvent, text: string) => void,
  onLeave?: (event: MouseEvent, text: string) => void,
): ILink[] | undefined {
  const snapshot = buildTerminalLineSnapshot(term, bufferLineNumber);
  if (!snapshot) {
    return undefined;
  }

  const matches = extractTerminalFileLinkCandidates(snapshot.text);
  if (matches.length === 0) {
    return undefined;
  }

  return matches.map((match) => {
    const startColumn = snapshot.columnMap[match.startIndex];
    const endColumn = snapshot.columnMap[match.endIndex - 1];
    const endSpan = snapshot.spanMap[match.endIndex - 1] ?? 1;

    return {
      text: match.text,
      range: {
        start: {
          x: (startColumn ?? match.startIndex) + 1,
          y: bufferLineNumber,
        },
        end: {
          x: (endColumn ?? match.endIndex - 1) + endSpan + 1,
          y: bufferLineNumber,
        },
      },
      decorations: {
        pointerCursor: true,
        underline: true,
      },
      activate: (event, text) => onActivate(event, text),
      hover: onHover,
      leave: onLeave,
    } satisfies ILink;
  });
}

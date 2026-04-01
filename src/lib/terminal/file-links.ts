import type { ILink, Terminal } from "@xterm/xterm";

export interface TerminalFileLinkCandidate {
  text: string;
  startIndex: number;
  endIndex: number;
}

interface InternalTerminalFileLinkCandidate extends TerminalFileLinkCandidate {
  priority: number;
}

interface ParsedPathCandidate {
  text: string;
  startOffset: number;
  endOffset: number;
}

interface PathCandidateOptions {
  allowBareFilename: boolean;
  allowWhitespace: boolean;
}

interface TrailingLineInfo {
  path: string;
  line: string;
  column?: string;
}

const TOKEN_REGEX = /\S+/g;
const QUOTED_SEGMENT_REGEX = /(["'`])([^"'`]+)\1/g;
const BRACKETED_SEGMENT_REGEX = /[\(\[\{<]([^)\]}>]+)[\)\]\}>]/g;
const PYTHON_TRACEBACK_REGEX = /\bFile\s+(["'`])([^"'`]+)\1,\s+line\s+(\d+)(?:,\s+column\s+(\d+))?/g;
const LEADING_TRIM_CHARS = new Set(["\"", "'", "`", "(", "[", "{", "<"]);
const TRAILING_TRIM_CHARS = new Set(["\"", "'", "`", ")", "]", "}", ">", ",", ".", "!", "?", ";"]);
const KOREAN_TRAILING_SUFFIXES = [
  "까지",
  "부터",
  "처럼",
  "같이",
  "에게",
  "한테",
  "에서",
  "으로",
  "로",
  "에",
  "를",
  "을",
  "은",
  "는",
  "이",
  "가",
  "와",
  "과",
  "도",
  "만",
  "의",
  "께",
  "조차",
  "마저",
  "뿐",
  "입니다만",
  "있습니다만",
  "합니다만",
  "입니다",
  "있습니다",
  "합니다",
  "해요",
  "예요",
  "이에요",
  "네요",
] as const;
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

function splitPathBasename(value: string) {
  return value.split(/[\\/]/).filter(Boolean).pop() ?? value;
}

function hasPathSignal(value: string) {
  return (
    value.includes("/") ||
    value.includes("\\") ||
    /^[A-Za-z]:[\\/]/.test(value) ||
    value === "~" ||
    value.startsWith("./") ||
    value.startsWith("../") ||
    value.startsWith("~/")
  );
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

function parseTrailingLineInfo(value: string): TrailingLineInfo | null {
  const colonMatch = /^(.*?):(\d+)(?::(\d+))?$/.exec(value);
  if (colonMatch) {
    return {
      path: colonMatch[1] ?? value,
      line: colonMatch[2] ?? "",
      column: colonMatch[3],
    };
  }

  const parenMatch = /^(.*?)\((\d+)(?:,\s*(\d+))?\)$/.exec(value);
  if (parenMatch) {
    return {
      path: parenMatch[1] ?? value,
      line: parenMatch[2] ?? "",
      column: parenMatch[3],
    };
  }

  const bracketMatch = /^(.*?)\[(\d+)(?:,\s*(\d+))?\]$/.exec(value);
  if (bracketMatch) {
    return {
      path: bracketMatch[1] ?? value,
      line: bracketMatch[2] ?? "",
      column: bracketMatch[3],
    };
  }

  return null;
}

function trimTrailingNaturalLanguageSuffix(value: string, allowWhitespace: boolean) {
  let current = value;

  while (current.length > 0) {
    const punctuationTrimmed = current.replace(/["'`)\]}>,.!?;:]+$/u, "");
    if (punctuationTrimmed !== current) {
      current = punctuationTrimmed;
      continue;
    }

    const suffix = KOREAN_TRAILING_SUFFIXES.find((entry) => current.endsWith(entry));
    if (!suffix) {
      break;
    }

    const candidate = current.slice(0, -suffix.length);
    if (!candidate) {
      break;
    }

    if (!allowWhitespace && /\s/.test(candidate)) {
      break;
    }

    current = candidate;
  }

  return current;
}

function isLikelyPathBase(value: string, options: PathCandidateOptions) {
  if (!value || value === "." || value === "..") {
    return false;
  }

  if (value.includes("://")) {
    return false;
  }

  if (/^\d+(?:[/-]\d+)+$/.test(value)) {
    return false;
  }

  if (!options.allowWhitespace && /\s/.test(value)) {
    return false;
  }

  const basename = splitPathBasename(value);

  if (hasPathSignal(value)) {
    if (basenameLooksLikeDevelopmentFile(basename)) {
      return true;
    }

    const normalizedPath = value.replaceAll("\\", "/");
    if (normalizedPath === "~") {
      return true;
    }

    if (normalizedPath.startsWith("~/")) {
      return normalizedPath.length > 2;
    }

    return false;
  }

  if (!options.allowBareFilename) {
    return false;
  }

  return !value.includes("/") && !value.includes("\\") && basenameLooksLikeDevelopmentFile(value);
}

function normalizePathCandidate(raw: string, options: PathCandidateOptions): ParsedPathCandidate | null {
  let startOffset = 0;
  let endOffset = raw.length;
  let current = raw;

  while (current.length > 0 && LEADING_TRIM_CHARS.has(current[0] ?? "")) {
    current = current.slice(1);
    startOffset += 1;
  }

  while (current.length > 0 && TRAILING_TRIM_CHARS.has(current[current.length - 1] ?? "")) {
    current = current.slice(0, -1);
    endOffset -= 1;
  }

  for (let iteration = 0; iteration < 8; iteration += 1) {
    const lineInfo = parseTrailingLineInfo(current);
    if (lineInfo) {
      const basePath = lineInfo.path;
      const baseHasAllowedWhitespace = options.allowWhitespace || !/\s/.test(basePath);

      if (
        basePath &&
        basePath !== "." &&
        basePath !== ".." &&
        !basePath.includes("://") &&
        baseHasAllowedWhitespace &&
        isLikelyPathBase(basePath, {
          allowBareFilename: false,
          allowWhitespace: options.allowWhitespace,
        })
      ) {
        return {
          text: `${basePath}:${lineInfo.line}${lineInfo.column ? `:${lineInfo.column}` : ""}`,
          startOffset,
          endOffset,
        };
      }
    }

    const trimmed = trimTrailingNaturalLanguageSuffix(current, options.allowWhitespace);
    if (trimmed === current) {
      break;
    }

    endOffset -= current.length - trimmed.length;
    current = trimmed;
  }

  if (!isLikelyPathBase(current, options)) {
    return null;
  }

  return {
    text: current,
    startOffset,
    endOffset,
  };
}

function buildCandidate(
  text: string,
  startIndex: number,
  priority: number,
  options: PathCandidateOptions,
) {
  const normalized = normalizePathCandidate(text, options);
  if (!normalized) {
    return null;
  }

  return {
    text: normalized.text,
    startIndex: startIndex + normalized.startOffset,
    endIndex: startIndex + normalized.endOffset,
    priority,
  } satisfies InternalTerminalFileLinkCandidate;
}

function detectTokenCandidates(text: string) {
  const candidates: InternalTerminalFileLinkCandidate[] = [];

  for (const match of text.matchAll(TOKEN_REGEX)) {
    const raw = match[0];
    const matchIndex = match.index;

    if (!raw || matchIndex === undefined) {
      continue;
    }

    const { start, end } = trimTokenBounds(text, matchIndex, matchIndex + raw.length);
    if (start >= end) {
      continue;
    }

    const token = text.slice(start, end);
    const strongCandidate = buildCandidate(token, start, 2, {
      allowBareFilename: false,
      allowWhitespace: false,
    });
    if (strongCandidate) {
      candidates.push(strongCandidate);
      continue;
    }

    const bareCandidate = buildCandidate(token, start, 4, {
      allowBareFilename: true,
      allowWhitespace: false,
    });
    if (bareCandidate) {
      candidates.push(bareCandidate);
    }
  }

  return candidates;
}

function detectQuotedAndBracketedCandidates(text: string) {
  const candidates: InternalTerminalFileLinkCandidate[] = [];

  for (const match of text.matchAll(QUOTED_SEGMENT_REGEX)) {
    const raw = match[2];
    const matchIndex = match.index;

    if (!raw || matchIndex === undefined) {
      continue;
    }

    const start = matchIndex + 1;
    const candidate = buildCandidate(raw, start, 1, {
      allowBareFilename: true,
      allowWhitespace: true,
    });
    if (candidate) {
      candidates.push(candidate);
    }
  }

  for (const match of text.matchAll(BRACKETED_SEGMENT_REGEX)) {
    const raw = match[1];
    const matchIndex = match.index;

    if (!raw || matchIndex === undefined) {
      continue;
    }

    const start = matchIndex + 1;
    const candidate = buildCandidate(raw, start, 1, {
      allowBareFilename: false,
      allowWhitespace: true,
    });
    if (candidate) {
      candidates.push(candidate);
    }
  }

  return candidates;
}

function detectTracebackCandidates(text: string) {
  const candidates: InternalTerminalFileLinkCandidate[] = [];

  for (const match of text.matchAll(PYTHON_TRACEBACK_REGEX)) {
    const rawPath = match[2];
    const line = match[3];
    const column = match[4];
    const matchIndex = match.index;

    if (!rawPath || !line || matchIndex === undefined) {
      continue;
    }

    const pathStart = matchIndex + match[0].indexOf(rawPath);
    const normalized = buildCandidate(rawPath, pathStart, 0, {
      allowBareFilename: false,
      allowWhitespace: true,
    });
    if (!normalized) {
      continue;
    }

    candidates.push({
      text: `${normalized.text}:${line}${column ? `:${column}` : ""}`,
      startIndex: pathStart,
      endIndex: matchIndex + match[0].length,
      priority: 0,
    });
  }

  return candidates;
}

function dedupeCandidates(candidates: InternalTerminalFileLinkCandidate[]) {
  const sorted = candidates
    .slice()
    .sort((left, right) => {
      const priorityDelta = left.priority - right.priority;
      if (priorityDelta !== 0) {
        return priorityDelta;
      }

      const startDelta = left.startIndex - right.startIndex;
      if (startDelta !== 0) {
        return startDelta;
      }

      const lengthDelta = right.endIndex - right.startIndex - (left.endIndex - left.startIndex);
      if (lengthDelta !== 0) {
        return lengthDelta;
      }

      return left.text.localeCompare(right.text);
    });

  const accepted: InternalTerminalFileLinkCandidate[] = [];

  for (const candidate of sorted) {
    const overlaps = accepted.some(
      (existing) =>
        candidate.startIndex < existing.endIndex && candidate.endIndex > existing.startIndex,
    );

    if (overlaps) {
      continue;
    }

    accepted.push(candidate);
  }

  return accepted.sort((left, right) => {
    const startDelta = left.startIndex - right.startIndex;
    if (startDelta !== 0) {
      return startDelta;
    }

    const endDelta = left.endIndex - right.endIndex;
    if (endDelta !== 0) {
      return endDelta;
    }

    return left.priority - right.priority;
  });
}

export function extractTerminalFileLinkCandidates(text: string): TerminalFileLinkCandidate[] {
  const candidates = dedupeCandidates([
    ...detectTokenCandidates(text),
    ...detectQuotedAndBracketedCandidates(text),
    ...detectTracebackCandidates(text),
  ]);

  return candidates.map(({ priority: _priority, ...candidate }) => candidate);
}

interface TerminalLineSnapshot {
  text: string;
  columnMap: number[];
  lineMap: number[];
  spanMap: number[];
}

function getWrappedLineWindow(term: Terminal, bufferLineIndex: number) {
  const buffer = term.buffer.active;
  const anchor = buffer.getLine(bufferLineIndex);
  if (!anchor) {
    return null;
  }

  let start = bufferLineIndex;
  while (start > 0) {
    const line = buffer.getLine(start);
    if (!line?.isWrapped) {
      break;
    }
    start -= 1;
  }

  let end = bufferLineIndex;
  while (true) {
    const next = buffer.getLine(end + 1);
    if (!next?.isWrapped) {
      break;
    }
    end += 1;
  }

  return { start, end };
}

function buildTerminalLineSnapshot(term: Terminal, bufferLineNumber: number): TerminalLineSnapshot | null {
  const window = getWrappedLineWindow(term, bufferLineNumber - 1);
  if (!window) {
    return null;
  }

  let text = "";
  const columnMap: number[] = [];
  const lineMap: number[] = [];
  const spanMap: number[] = [];

  for (let bufferLineIndex = window.start; bufferLineIndex <= window.end; bufferLineIndex += 1) {
    const line = term.buffer.active.getLine(bufferLineIndex);
    if (!line) {
      continue;
    }

    let remainingChars = line.translateToString(true).length;
    if (remainingChars === 0) {
      continue;
    }

    for (let column = 0; column < term.cols && remainingChars > 0; column += 1) {
      const cell = line.getCell(column);
      if (!cell) {
        break;
      }

      const width = cell.getWidth();
      if (width === 0) {
        continue;
      }

      const chars = cell.getChars();
      const emittedChars = chars.length > 0 ? chars : " ";
      const emittedLength = chars.length || 1;
      const visibleChars = emittedChars.slice(0, remainingChars);

      text += visibleChars;

      for (let index = 0; index < visibleChars.length; index += 1) {
        columnMap.push(column);
        lineMap.push(bufferLineIndex + 1);
        spanMap.push(width);
      }

      remainingChars -= emittedLength;
    }
  }

  return { text, columnMap, lineMap, spanMap };
}

function matchTouchesBufferLine(
  snapshot: TerminalLineSnapshot,
  match: TerminalFileLinkCandidate,
  bufferLineNumber: number,
) {
  const startLine = snapshot.lineMap[match.startIndex];
  const endLine = snapshot.lineMap[match.endIndex - 1];
  if (startLine === undefined || endLine === undefined) {
    return false;
  }

  return bufferLineNumber >= startLine && bufferLineNumber <= endLine;
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

  const matches = extractTerminalFileLinkCandidates(snapshot.text).filter((match) =>
    matchTouchesBufferLine(snapshot, match, bufferLineNumber),
  );
  if (matches.length === 0) {
    return undefined;
  }

  return matches.map((match) => {
    const startColumn = snapshot.columnMap[match.startIndex];
    const startLine = snapshot.lineMap[match.startIndex];
    const endColumn = snapshot.columnMap[match.endIndex - 1];
    const endLine = snapshot.lineMap[match.endIndex - 1];
    const endSpan = snapshot.spanMap[match.endIndex - 1] ?? 1;

    return {
      text: match.text,
      range: {
        start: {
          x: (startColumn ?? match.startIndex) + 1,
          y: startLine ?? bufferLineNumber,
        },
        end: {
          x: (endColumn ?? match.endIndex - 1) + endSpan + 1,
          y: endLine ?? bufferLineNumber,
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

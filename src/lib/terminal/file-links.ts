import type { ILink, Terminal } from "@xterm/xterm";

export interface TerminalFileLinkCandidate {
  text: string;
  startIndex: number;
  endIndex: number;
}

interface TerminalLinkHandlers {
  onFileActivate: (event: MouseEvent, text: string) => void;
  onUrlActivate: (event: MouseEvent, text: string) => void;
  onHover?: (event: MouseEvent, text: string) => void;
  onLeave?: (event: MouseEvent, text: string) => void;
  urlRegex?: RegExp;
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
export const TERMINAL_WEB_LINK_REGEX =
  /(?:https?|ftp):[/]{2}[^\s"'!*(){}|\\^<>`]*[^\s"':,.!?{}|\\^~\[\]`()<>]/i;
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
const HARD_WRAP_MAX_CONTINUATION_LINES = 8;
const HARD_WRAP_MAX_CHARS = 768;
const HARD_WRAP_URL_START_REGEX = /\b(?:https?|ftp):\/{1,2}[^\s"'!*(){}|\\^<>`]*/gi;
const HARD_WRAP_PATH_START_REGEXES = [
  /(^|[\s("'`\[{<])(~)(?=\s*$|[\s"'`)\]}>])/g,
  /(^|[\s("'`\[{<])((?:~|\.\.?)[\\/][^\s"'`()<>{}|]*)/g,
  /(^|[\s("'`\[{<])(\.[A-Za-z0-9._-]+(?:[\\/][^\s"'`()<>{}|]*)?)/g,
  /(^|[\s("'`\[{<])([A-Za-z]:[\\/][^\s"'`()<>{}|]*)/g,
  /(^|[\s("'`\[{<])([A-Za-z0-9._-]+[\\/][^\s"'`()<>{}|]*)/g,
  /(^|[\s("'`\[{<])([\\/][^\s"'`()<>{}|]*)/g,
];
const HARD_WRAP_NEW_ITEM_REGEX = /^(?:[-*+]|\d+[.)])\s+/;
const HARD_WRAP_CONTINUATION_START_REGEX = /^[A-Za-z0-9._~\/\\?#&=%:+@-]/;

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

function regexWithGlobalFlag(regex: RegExp) {
  const flags = regex.flags.includes("g") ? regex.flags : `${regex.flags}g`;
  return new RegExp(regex.source, flags);
}

function isValidTerminalUrl(value: string) {
  try {
    const url = new URL(value);
    const parsedBase =
      url.password && url.username
        ? `${url.protocol}//${url.username}:${url.password}@${url.host}`
        : url.username
          ? `${url.protocol}//${url.username}@${url.host}`
          : `${url.protocol}//${url.host}`;
    return value.toLocaleLowerCase().startsWith(parsedBase.toLocaleLowerCase());
  } catch {
    return false;
  }
}

export function extractTerminalUrlLinkCandidates(
  text: string,
  urlRegex: RegExp = TERMINAL_WEB_LINK_REGEX,
): TerminalFileLinkCandidate[] {
  const regex = regexWithGlobalFlag(urlRegex);
  const candidates: TerminalFileLinkCandidate[] = [];

  for (let match = regex.exec(text); match; match = regex.exec(text)) {
    const value = match[0];
    const matchIndex = match.index;
    if (!value || matchIndex === undefined || !isValidTerminalUrl(value)) {
      continue;
    }

    candidates.push({
      text: value,
      startIndex: matchIndex,
      endIndex: matchIndex + value.length,
    });
  }

  return candidates;
}

interface TerminalLineSnapshot {
  text: string;
  columnMap: number[];
  lineMap: number[];
  spanMap: number[];
}

type HardWrapKind = "file" | "url";

interface HardWrapStart {
  kind: HardWrapKind;
  fragment: TerminalLineSnapshot;
}

interface HardWrapResolvedMatch {
  snapshot: TerminalLineSnapshot;
  match: TerminalFileLinkCandidate;
}

interface TerminalLineSnapshotOptions {
  stripWrappedLineLeadingWhitespace?: boolean;
  trimBeforeWrappedLine?: boolean;
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

function buildTerminalLineSnapshot(
  term: Terminal,
  bufferLineNumber: number,
  options: TerminalLineSnapshotOptions = {},
): TerminalLineSnapshot | null {
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

    const nextLine = term.buffer.active.getLine(bufferLineIndex + 1);
    const trimRight = Boolean(options.trimBeforeWrappedLine) || !nextLine?.isWrapped;
    let remainingChars = line.translateToString(trimRight).length;
    if (remainingChars === 0) {
      continue;
    }

    let skippingWrappedIndent =
      Boolean(options.stripWrappedLineLeadingWhitespace) && line.isWrapped && text.length > 0;

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

      if (skippingWrappedIndent && /^\s+$/.test(visibleChars)) {
        remainingChars -= emittedLength;
        continue;
      }

      skippingWrappedIndent = false;

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

function buildHardWrapPhysicalLineSnapshot(
  term: Terminal,
  bufferLineIndex: number,
): TerminalLineSnapshot | null {
  const line = term.buffer.active.getLine(bufferLineIndex);
  if (!line || line.isWrapped) {
    return null;
  }

  let text = "";
  const columnMap: number[] = [];
  const lineMap: number[] = [];
  const spanMap: number[] = [];
  let remainingChars = line.translateToString(true).length;

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

  return { text, columnMap, lineMap, spanMap };
}

function sliceTerminalLineSnapshot(
  snapshot: TerminalLineSnapshot,
  startIndex: number,
  endIndex: number,
): TerminalLineSnapshot | null {
  const start = Math.max(0, Math.min(startIndex, snapshot.text.length));
  const end = Math.max(start, Math.min(endIndex, snapshot.text.length));
  if (start >= end) {
    return null;
  }

  return {
    text: snapshot.text.slice(start, end),
    columnMap: snapshot.columnMap.slice(start, end),
    lineMap: snapshot.lineMap.slice(start, end),
    spanMap: snapshot.spanMap.slice(start, end),
  };
}

function trimTerminalLineSnapshot(
  snapshot: TerminalLineSnapshot,
  startIndex = 0,
  endIndex = snapshot.text.length,
) {
  let start = Math.max(0, startIndex);
  let end = Math.min(snapshot.text.length, endIndex);

  while (start < end && /\s/.test(snapshot.text[start] ?? "")) {
    start += 1;
  }

  while (end > start && /\s/.test(snapshot.text[end - 1] ?? "")) {
    end -= 1;
  }

  return sliceTerminalLineSnapshot(snapshot, start, end);
}

function joinTerminalLineSnapshots(fragments: TerminalLineSnapshot[]): TerminalLineSnapshot {
  return {
    text: fragments.map((fragment) => fragment.text).join(""),
    columnMap: fragments.flatMap((fragment) => fragment.columnMap),
    lineMap: fragments.flatMap((fragment) => fragment.lineMap),
    spanMap: fragments.flatMap((fragment) => fragment.spanMap),
  };
}

function findHardWrapTokenEnd(text: string, startIndex: number) {
  let end = startIndex;
  while (end < text.length && !/\s/.test(text[end] ?? "")) {
    end += 1;
  }

  return end;
}

function createHardWrapStart(
  snapshot: TerminalLineSnapshot,
  kind: HardWrapKind,
  startIndex: number,
): HardWrapStart | null {
  const fragment = sliceTerminalLineSnapshot(
    snapshot,
    startIndex,
    findHardWrapTokenEnd(snapshot.text, startIndex),
  );
  if (!fragment || !fragment.text) {
    return null;
  }

  return { kind, fragment };
}

function findHardWrapStarts(
  term: Terminal,
  bufferLineIndex: number,
  kind: HardWrapKind,
): HardWrapStart[] {
  const snapshot = buildHardWrapPhysicalLineSnapshot(term, bufferLineIndex);
  if (!snapshot || !snapshot.text.trim()) {
    return [];
  }

  const starts: HardWrapStart[] = [];
  const seen = new Set<string>();
  const addStart = (startIndex: number) => {
    const start = createHardWrapStart(snapshot, kind, startIndex);
    if (!start) {
      return;
    }

    const key = `${start.fragment.lineMap[0]}:${start.fragment.columnMap[0]}:${start.fragment.text}`;
    if (seen.has(key)) {
      return;
    }

    seen.add(key);
    starts.push(start);
  };

  if (kind === "url") {
    for (const match of snapshot.text.matchAll(HARD_WRAP_URL_START_REGEX)) {
      if (match.index !== undefined) {
        addStart(match.index);
      }
    }
    return starts;
  }

  for (const regex of HARD_WRAP_PATH_START_REGEXES) {
    for (const match of snapshot.text.matchAll(regex)) {
      const prefix = match[1] ?? "";
      const rawPath = match[2] ?? "";
      const matchIndex = match.index;
      if (!rawPath || matchIndex === undefined || rawPath.includes("://")) {
        continue;
      }

      addStart(matchIndex + prefix.length);
    }
  }

  return starts;
}

function getHardWrapContinuationFragment(
  term: Terminal,
  bufferLineIndex: number,
): TerminalLineSnapshot | null {
  const snapshot = buildHardWrapPhysicalLineSnapshot(term, bufferLineIndex);
  if (!snapshot) {
    return null;
  }

  const trimmedText = snapshot.text.trim();
  if (
    !trimmedText
    || /\s/.test(trimmedText)
    || HARD_WRAP_NEW_ITEM_REGEX.test(trimmedText)
    || !HARD_WRAP_CONTINUATION_START_REGEX.test(trimmedText)
  ) {
    return null;
  }

  return trimTerminalLineSnapshot(snapshot);
}

function hardWrappedUrlLooksComplete(value: string) {
  try {
    const url = new URL(value);
    const hostname = url.hostname.toLocaleLowerCase();
    return hostname.includes(".") || hostname === "localhost" || hostname.includes(":");
  } catch {
    return false;
  }
}

function resolveHardWrappedMatch(
  snapshot: TerminalLineSnapshot,
  kind: HardWrapKind,
  firstFragmentLength: number,
  urlRegex: RegExp = TERMINAL_WEB_LINK_REGEX,
): TerminalFileLinkCandidate | null {
  if (snapshot.text.length <= firstFragmentLength) {
    return null;
  }

  const matches =
    kind === "url"
      ? extractTerminalUrlLinkCandidates(snapshot.text, urlRegex).filter((match) =>
          hardWrappedUrlLooksComplete(match.text),
        )
      : extractTerminalFileLinkCandidates(snapshot.text).filter((match) =>
          hasPathSignal(match.text),
        );

  return (
    matches.find(
      (match) =>
        match.startIndex === 0
        && match.endIndex > firstFragmentLength
        && match.text.length > firstFragmentLength,
    ) ?? null
  );
}

function hardWrappedTextHasCompleteMatch(
  kind: HardWrapKind,
  text: string,
  urlRegex: RegExp,
) {
  const matches =
    kind === "url"
      ? extractTerminalUrlLinkCandidates(text, urlRegex).filter((match) =>
          hardWrappedUrlLooksComplete(match.text),
        )
      : extractTerminalFileLinkCandidates(text).filter((match) => hasPathSignal(match.text));

  return matches.some((match) => match.startIndex === 0 && match.endIndex === text.length);
}

function shouldStopBeforeContinuation(
  kind: HardWrapKind,
  currentSnapshot: TerminalLineSnapshot,
  nextFragment: TerminalLineSnapshot,
  urlRegex: RegExp,
) {
  if (!/^[A-Za-z0-9]/.test(nextFragment.text)) {
    return false;
  }

  return hardWrappedTextHasCompleteMatch(kind, currentSnapshot.text, urlRegex);
}

function buildHardWrappedMatchFromStart(
  term: Terminal,
  start: HardWrapStart,
  urlRegex: RegExp = TERMINAL_WEB_LINK_REGEX,
): HardWrapResolvedMatch | null {
  const startLine = start.fragment.lineMap[0];
  if (startLine === undefined) {
    return null;
  }

  const firstFragmentLength = start.fragment.text.length;
  const fragments = [start.fragment];
  let best: HardWrapResolvedMatch | null = null;

  for (let offset = 1; offset <= HARD_WRAP_MAX_CONTINUATION_LINES; offset += 1) {
    const nextFragment = getHardWrapContinuationFragment(term, startLine - 1 + offset);
    const currentSnapshot = joinTerminalLineSnapshots(fragments);
    if (
      !nextFragment
      || shouldStopBeforeContinuation(start.kind, currentSnapshot, nextFragment, urlRegex)
    ) {
      break;
    }

    fragments.push(nextFragment);
    const snapshot = joinTerminalLineSnapshots(fragments);
    if (snapshot.text.length > HARD_WRAP_MAX_CHARS) {
      break;
    }

    const match = resolveHardWrappedMatch(
      snapshot,
      start.kind,
      firstFragmentLength,
      urlRegex,
    );
    if (match) {
      best = {
        snapshot,
        match,
      };
    }
  }

  return best;
}

function buildTerminalLineSnapshots(term: Terminal, bufferLineNumber: number) {
  const baseSnapshot = buildTerminalLineSnapshot(term, bufferLineNumber);
  if (!baseSnapshot) {
    return [];
  }

  const snapshots = [baseSnapshot];
  const strippedSnapshot = buildTerminalLineSnapshot(term, bufferLineNumber, {
    stripWrappedLineLeadingWhitespace: true,
  });
  if (strippedSnapshot && strippedSnapshot.text !== baseSnapshot.text) {
    snapshots.push(strippedSnapshot);
  }

  const compactSnapshot = buildTerminalLineSnapshot(term, bufferLineNumber, {
    stripWrappedLineLeadingWhitespace: true,
    trimBeforeWrappedLine: true,
  });
  if (
    compactSnapshot
    && snapshots.every((snapshot) => snapshot.text !== compactSnapshot.text)
  ) {
    snapshots.push(compactSnapshot);
  }

  return snapshots;
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

function createLinksFromMatches(
  snapshot: TerminalLineSnapshot,
  matches: TerminalFileLinkCandidate[],
  bufferLineNumber: number,
  onActivate: (event: MouseEvent, text: string) => void,
  onHover?: (event: MouseEvent, text: string) => void,
  onLeave?: (event: MouseEvent, text: string) => void,
) {
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
          x: (endColumn ?? match.endIndex - 1) + endSpan,
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

function createLineSegmentLinkFromMatch(
  snapshot: TerminalLineSnapshot,
  match: TerminalFileLinkCandidate,
  bufferLineNumber: number,
  onActivate: (event: MouseEvent, text: string) => void,
  onHover?: (event: MouseEvent, text: string) => void,
  onLeave?: (event: MouseEvent, text: string) => void,
): ILink | null {
  let segmentStartIndex = -1;
  let segmentEndIndex = -1;

  for (let index = match.startIndex; index < match.endIndex; index += 1) {
    if (snapshot.lineMap[index] !== bufferLineNumber) {
      continue;
    }

    if (segmentStartIndex < 0) {
      segmentStartIndex = index;
    }
    segmentEndIndex = index;
  }

  if (segmentStartIndex < 0 || segmentEndIndex < 0) {
    return null;
  }

  const startColumn = snapshot.columnMap[segmentStartIndex];
  const endColumn = snapshot.columnMap[segmentEndIndex];
  const endSpan = snapshot.spanMap[segmentEndIndex] ?? 1;
  if (startColumn === undefined || endColumn === undefined) {
    return null;
  }

  return {
    text: match.text,
    range: {
      start: {
        x: startColumn + 1,
        y: bufferLineNumber,
      },
      end: {
        x: endColumn + endSpan,
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
}

function rangeStartPosition(link: ILink, cols: number) {
  return (link.range.start.y - 1) * cols + link.range.start.x;
}

function rangeEndPosition(link: ILink, cols: number) {
  return (link.range.end.y - 1) * cols + link.range.end.x;
}

function linkRangesOverlap(left: ILink, right: ILink, cols: number) {
  return rangeStartPosition(left, cols) <= rangeEndPosition(right, cols)
    && rangeEndPosition(left, cols) >= rangeStartPosition(right, cols);
}

function dedupeLinksByRange(links: ILink[], cols: number) {
  const accepted: ILink[] = [];
  const sorted = links.slice().sort((left, right) => {
    const lengthDelta = right.text.length - left.text.length;
    if (lengthDelta !== 0) {
      return lengthDelta;
    }

    const startDelta = rangeStartPosition(left, cols) - rangeStartPosition(right, cols);
    if (startDelta !== 0) {
      return startDelta;
    }

    return rangeEndPosition(right, cols) - rangeEndPosition(left, cols);
  });

  for (const link of sorted) {
    if (accepted.some((existing) => linkRangesOverlap(link, existing, cols))) {
      continue;
    }

    accepted.push(link);
  }

  return accepted.sort((left, right) => {
    const startDelta = rangeStartPosition(left, cols) - rangeStartPosition(right, cols);
    if (startDelta !== 0) {
      return startDelta;
    }

    return rangeEndPosition(left, cols) - rangeEndPosition(right, cols);
  });
}

function createFileLinksFromSnapshot(
  snapshot: TerminalLineSnapshot,
  bufferLineNumber: number,
  onActivate: (event: MouseEvent, text: string) => void,
  onHover?: (event: MouseEvent, text: string) => void,
  onLeave?: (event: MouseEvent, text: string) => void,
) {
  const matches = extractTerminalFileLinkCandidates(snapshot.text).filter((match) =>
    matchTouchesBufferLine(snapshot, match, bufferLineNumber),
  );

  return createLinksFromMatches(
    snapshot,
    matches,
    bufferLineNumber,
    onActivate,
    onHover,
    onLeave,
  );
}

function createUrlLinksFromSnapshot(
  snapshot: TerminalLineSnapshot,
  bufferLineNumber: number,
  onActivate: (event: MouseEvent, text: string) => void,
  onHover?: (event: MouseEvent, text: string) => void,
  onLeave?: (event: MouseEvent, text: string) => void,
  urlRegex: RegExp = TERMINAL_WEB_LINK_REGEX,
) {
  const matches = extractTerminalUrlLinkCandidates(snapshot.text, urlRegex).filter((match) =>
    matchTouchesBufferLine(snapshot, match, bufferLineNumber),
  );

  return createLinksFromMatches(
    snapshot,
    matches,
    bufferLineNumber,
    onActivate,
    onHover,
    onLeave,
  );
}

function createHardWrappedLinks(
  term: Terminal,
  bufferLineNumber: number,
  kind: HardWrapKind,
  onActivate: (event: MouseEvent, text: string) => void,
  onHover?: (event: MouseEvent, text: string) => void,
  onLeave?: (event: MouseEvent, text: string) => void,
  urlRegex: RegExp = TERMINAL_WEB_LINK_REGEX,
) {
  const links: ILink[] = [];
  const targetLineIndex = bufferLineNumber - 1;
  const startLineIndex = Math.max(0, targetLineIndex - HARD_WRAP_MAX_CONTINUATION_LINES);

  for (let lineIndex = startLineIndex; lineIndex <= targetLineIndex; lineIndex += 1) {
    for (const start of findHardWrapStarts(term, lineIndex, kind)) {
      const resolved = buildHardWrappedMatchFromStart(term, start, urlRegex);
      if (!resolved) {
        continue;
      }

      const link = createLineSegmentLinkFromMatch(
        resolved.snapshot,
        resolved.match,
        bufferLineNumber,
        onActivate,
        onHover,
        onLeave,
      );
      if (link) {
        links.push(link);
      }
    }
  }

  return links;
}

export function createTerminalFileLinks(
  term: Terminal,
  bufferLineNumber: number,
  onActivate: (event: MouseEvent, text: string) => void,
  onHover?: (event: MouseEvent, text: string) => void,
  onLeave?: (event: MouseEvent, text: string) => void,
): ILink[] | undefined {
  const links = [
    ...buildTerminalLineSnapshots(term, bufferLineNumber).flatMap((snapshot) =>
      createFileLinksFromSnapshot(snapshot, bufferLineNumber, onActivate, onHover, onLeave),
    ),
    ...createHardWrappedLinks(
      term,
      bufferLineNumber,
      "file",
      onActivate,
      onHover,
      onLeave,
    ),
  ];
  const dedupedLinks = dedupeLinksByRange(links, term.cols);
  return dedupedLinks.length > 0 ? dedupedLinks : undefined;
}

export function createTerminalUrlLinks(
  term: Terminal,
  bufferLineNumber: number,
  onActivate: (event: MouseEvent, text: string) => void,
  onHover?: (event: MouseEvent, text: string) => void,
  onLeave?: (event: MouseEvent, text: string) => void,
  urlRegex: RegExp = TERMINAL_WEB_LINK_REGEX,
): ILink[] | undefined {
  const links = [
    ...buildTerminalLineSnapshots(term, bufferLineNumber).flatMap((snapshot) =>
      createUrlLinksFromSnapshot(
        snapshot,
        bufferLineNumber,
        onActivate,
        onHover,
        onLeave,
        urlRegex,
      ),
    ),
    ...createHardWrappedLinks(
      term,
      bufferLineNumber,
      "url",
      onActivate,
      onHover,
      onLeave,
      urlRegex,
    ),
  ];
  const dedupedLinks = dedupeLinksByRange(links, term.cols);
  return dedupedLinks.length > 0 ? dedupedLinks : undefined;
}

export function createTerminalLinks(
  term: Terminal,
  bufferLineNumber: number,
  handlers: TerminalLinkHandlers,
): ILink[] | undefined {
  const snapshots = buildTerminalLineSnapshots(term, bufferLineNumber);
  const links = [
    ...snapshots.flatMap((snapshot) =>
      [
        ...createUrlLinksFromSnapshot(
          snapshot,
          bufferLineNumber,
          handlers.onUrlActivate,
          handlers.onHover,
          handlers.onLeave,
          handlers.urlRegex,
        ),
        ...createFileLinksFromSnapshot(
          snapshot,
          bufferLineNumber,
          handlers.onFileActivate,
          handlers.onHover,
          handlers.onLeave,
        ),
      ],
    ),
    ...createHardWrappedLinks(
      term,
      bufferLineNumber,
      "url",
      handlers.onUrlActivate,
      handlers.onHover,
      handlers.onLeave,
      handlers.urlRegex,
    ),
    ...createHardWrappedLinks(
      term,
      bufferLineNumber,
      "file",
      handlers.onFileActivate,
      handlers.onHover,
      handlers.onLeave,
    ),
  ];
  const dedupedLinks = dedupeLinksByRange(links, term.cols);
  return dedupedLinks.length > 0 ? dedupedLinks : undefined;
}

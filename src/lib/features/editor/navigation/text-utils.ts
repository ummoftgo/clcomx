export interface QuotedValueMatch {
  value: string;
  startColumn: number;
  endColumn: number;
}

export function getLineContent(content: string, lineNumber: number) {
  return content.split("\n")[Math.max(0, lineNumber - 1)] ?? "";
}

export function offsetToLineColumn(content: string, offset: number) {
  const slice = content.slice(0, offset);
  const lines = slice.split("\n");
  return {
    line: lines.length,
    column: (lines[lines.length - 1]?.length ?? 0) + 1,
  };
}

export function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function extractQuotedValueAtPosition(
  content: string,
  lineNumber: number,
  column: number,
): QuotedValueMatch | null {
  const line = getLineContent(content, lineNumber);
  if (!line) {
    return null;
  }

  return extractQuotedValueAtColumnInLine(line, column);
}

export function extractQuotedValueAtColumnInLine(
  line: string,
  column: number,
): QuotedValueMatch | null {
  if (!line) {
    return null;
  }

  const index = Math.max(0, column - 1);
  for (const quote of [`"`, "'", "`"]) {
    const start = findUnescapedQuoteLeft(line, index, quote);
    if (start < 0) {
      continue;
    }
    const end = findUnescapedQuoteRight(line, Math.max(index, start + 1), quote);
    if (end < 0 || index < start || index > end) {
      continue;
    }

    return {
      value: line.slice(start + 1, end),
      startColumn: start + 2,
      endColumn: end + 1,
    };
  }

  return null;
}

function findUnescapedQuoteLeft(line: string, fromIndex: number, quote: string) {
  for (let index = fromIndex; index >= 0; index -= 1) {
    if (line[index] !== quote) {
      continue;
    }
    if (!isEscaped(line, index)) {
      return index;
    }
  }
  return -1;
}

function findUnescapedQuoteRight(line: string, fromIndex: number, quote: string) {
  for (let index = fromIndex; index < line.length; index += 1) {
    if (line[index] !== quote) {
      continue;
    }
    if (!isEscaped(line, index)) {
      return index;
    }
  }
  return -1;
}

function isEscaped(line: string, index: number) {
  let slashCount = 0;
  for (let cursor = index - 1; cursor >= 0 && line[cursor] === "\\"; cursor -= 1) {
    slashCount += 1;
  }
  return slashCount % 2 === 1;
}

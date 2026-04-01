const SHELL_METADATA_OSC_PREFIXES = [
  { key: "cwd", prefix: "\u001b]633;CLCOMX_CWD;" },
  { key: "homeDir", prefix: "\u001b]633;CLCOMX_HOME;" },
] as const;
const OSC_BEL_TERMINATOR = "\u0007";
const OSC_ST_TERMINATOR = "\u001b\\";

export interface AuxShellMetadataParseResult {
  text: string;
  remainder: string;
  cwd: string | null;
  homeDir: string | null;
}

function decodeBase64Utf8(value: string): string | null {
  if (typeof atob !== "function") {
    return null;
  }

  try {
    const binary = atob(value);
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  } catch {
    return null;
  }
}

function findOscTerminator(source: string, start: number) {
  const belIndex = source.indexOf(OSC_BEL_TERMINATOR, start);
  const stIndex = source.indexOf(OSC_ST_TERMINATOR, start);

  if (belIndex === -1) {
    return stIndex === -1 ? null : { index: stIndex, length: OSC_ST_TERMINATOR.length };
  }

  if (stIndex === -1 || belIndex < stIndex) {
    return { index: belIndex, length: OSC_BEL_TERMINATOR.length };
  }

  return { index: stIndex, length: OSC_ST_TERMINATOR.length };
}

function findShellMetadataStart(source: string, cursor: number) {
  let matched: { index: number; key: "cwd" | "homeDir"; prefix: string } | null = null;

  for (const entry of SHELL_METADATA_OSC_PREFIXES) {
    const index = source.indexOf(entry.prefix, cursor);
    if (index === -1) {
      continue;
    }

    if (!matched || index < matched.index) {
      matched = { index, key: entry.key, prefix: entry.prefix };
    }
  }

  return matched;
}

export function consumeShellMetadata(
  data: string,
  remainder = "",
): AuxShellMetadataParseResult {
  const source = remainder + data;
  let text = "";
  let cwd: string | null = null;
  let homeDir: string | null = null;
  let cursor = 0;

  while (cursor < source.length) {
    const start = findShellMetadataStart(source, cursor);
    if (!start) {
      text += source.slice(cursor);
      return { text, remainder: "", cwd, homeDir };
    }

    text += source.slice(cursor, start.index);
    const payloadStart = start.index + start.prefix.length;
    const terminator = findOscTerminator(source, payloadStart);
    if (!terminator) {
      return { text, remainder: source.slice(start.index), cwd, homeDir };
    }

    const payload = source.slice(payloadStart, terminator.index).trim();
    const decoded = decodeBase64Utf8(payload);
    if (decoded) {
      if (start.key === "cwd") {
        cwd = decoded;
      } else {
        homeDir = decoded;
      }
    }

    cursor = terminator.index + terminator.length;
  }

  return { text, remainder: "", cwd, homeDir };
}

export function consumeAuxShellMetadata(
  data: string,
  remainder = "",
): AuxShellMetadataParseResult {
  return consumeShellMetadata(data, remainder);
}


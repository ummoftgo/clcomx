const AUX_CWD_OSC_PREFIX = "\u001b]633;CLCOMX_CWD;";
const OSC_BEL_TERMINATOR = "\u0007";
const OSC_ST_TERMINATOR = "\u001b\\";

export interface AuxShellMetadataParseResult {
  text: string;
  remainder: string;
  cwd: string | null;
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

export function consumeAuxShellMetadata(
  data: string,
  remainder = "",
): AuxShellMetadataParseResult {
  const source = remainder + data;
  let text = "";
  let cwd: string | null = null;
  let cursor = 0;

  while (cursor < source.length) {
    const start = source.indexOf(AUX_CWD_OSC_PREFIX, cursor);
    if (start === -1) {
      text += source.slice(cursor);
      return { text, remainder: "", cwd };
    }

    text += source.slice(cursor, start);
    const payloadStart = start + AUX_CWD_OSC_PREFIX.length;
    const terminator = findOscTerminator(source, payloadStart);
    if (!terminator) {
      return { text, remainder: source.slice(start), cwd };
    }

    const payload = source.slice(payloadStart, terminator.index).trim();
    const decoded = decodeBase64Utf8(payload);
    if (decoded) {
      cwd = decoded;
    }

    cursor = terminator.index + terminator.length;
  }

  return { text, remainder: "", cwd };
}


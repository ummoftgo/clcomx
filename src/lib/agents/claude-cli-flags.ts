import type { ClaudeCliFlagsSettings } from "../types";

export function buildClaudeCliFlags(flags: ClaudeCliFlagsSettings): string[] {
  const cliFlags: string[] = [];

  if (flags.enableAutoMode) {
    cliFlags.push("--enable-auto-mode");
  }

  return cliFlags;
}

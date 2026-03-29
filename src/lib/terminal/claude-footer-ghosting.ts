import { Unicode11Addon } from "@xterm/addon-unicode11";
import type { Terminal } from "@xterm/xterm";

const unicode11LoadedTerms = new WeakSet<Terminal>();
const DEFAULT_UNICODE_VERSION = "6";

export function isClaudeFooterGhostingMitigationEnabled(
  agentId: string,
  enabledBySetting: boolean,
  override: boolean | null | undefined,
) {
  if (agentId !== "claude") {
    return false;
  }

  return override ?? enabledBySetting;
}

export function syncTerminalUnicodeWidth(term: Terminal, enabled: boolean) {
  if (enabled && !unicode11LoadedTerms.has(term)) {
    term.loadAddon(new Unicode11Addon());
    unicode11LoadedTerms.add(term);
  }

  term.unicode.activeVersion = enabled ? "11" : DEFAULT_UNICODE_VERSION;
}

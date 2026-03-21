import { getBootstrap } from "../bootstrap";

export const TEST_BRIDGE_EVENTS = {
  openPendingImage: "clcomx:test-open-pending-image",
} as const;

export interface TestOpenPendingImageDetail {
  sessionId?: string;
  base64: string;
  mimeType?: string;
}

export interface TerminalTestHook {
  openPendingImage: (detail: Omit<TestOpenPendingImageDetail, "sessionId">) => void;
  getOutputSnapshot: () => Promise<{ data: string; seq: number } | null>;
}

declare global {
  interface Window {
    __clcomxTestHooks?: {
      terminals: Record<string, TerminalTestHook>;
    };
  }
}

export function isTestBridgeEnabled() {
  return getBootstrap().testMode;
}

export function getOrCreateTerminalTestHooks() {
  if (!window.__clcomxTestHooks) {
    window.__clcomxTestHooks = {
      terminals: {},
    };
  }

  return window.__clcomxTestHooks.terminals;
}

export function decodeBase64Blob(base64: string, mimeType = "image/png"): Blob {
  const normalized = base64.trim();
  const binary = atob(normalized);
  const bytes = new Uint8Array(binary.length);

  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }

  return new Blob([bytes], { type: mimeType });
}

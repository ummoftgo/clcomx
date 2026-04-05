import type { Terminal } from "@xterm/xterm";
import { decodeBase64Blob, type TerminalBufferSnapshot, type TestOpenPendingImageDetail } from "../../../testing/test-bridge";

interface TestHookRegistryEntry {
  openPendingImage: (detail: Omit<TestOpenPendingImageDetail, "sessionId">) => void;
  getOutputSnapshot: () => Promise<unknown>;
  getAuxOutputSnapshot: () => Promise<unknown>;
  getViewportState: () => {
    viewportY: number;
    baseY: number;
    rows: number;
    cols: number;
  } | null;
  getBufferSnapshot: () => TerminalBufferSnapshot | null;
  openUrlMenu: (url: string) => void;
  openFileMenu: (rawPath: string) => Promise<void>;
}

interface TerminalTestBridgeDeps {
  getSessionId: () => string;
  focusOutput: () => void;
  isTestBridgeEnabled: () => boolean;
  openClipboardPreview: (blob: Blob) => void;
  setClipboardNotice: (message: string) => void;
  getLivePtyId: () => number;
  getAuxPtyId: () => number;
  getPtyOutputSnapshot: (ptyId: number) => Promise<unknown>;
  getTerminal: () => Terminal | null;
  getTestHooks: () => Record<string, TestHookRegistryEntry>;
  openUrlMenu: (url: string) => void;
  openFileMenu: (rawPath: string) => Promise<void>;
}

export function createTerminalTestBridgeController(deps: TerminalTestBridgeDeps) {
  const handleFocusRequest = (event: Event) => {
    const focusEvent = event as CustomEvent<{ sessionId?: string }>;
    const targetSessionId = focusEvent.detail?.sessionId;
    if (targetSessionId && targetSessionId !== deps.getSessionId()) {
      return;
    }

    deps.focusOutput();
  };

  const openPendingImageForTest = (detail: Omit<TestOpenPendingImageDetail, "sessionId">) => {
    try {
      deps.openClipboardPreview(decodeBase64Blob(detail.base64, detail.mimeType));
    } catch (error) {
      deps.setClipboardNotice(error instanceof Error ? error.message : String(error));
    }
  };

  const handleTestPendingImage = (event: Event) => {
    if (!deps.isTestBridgeEnabled()) return;

    const detail = (event as CustomEvent<TestOpenPendingImageDetail>).detail;
    if (!detail?.base64) return;
    if (detail.sessionId && detail.sessionId !== deps.getSessionId()) return;

    openPendingImageForTest({
      base64: detail.base64,
      mimeType: detail.mimeType,
    });
  };

  const getOutputSnapshotForTest = async () => {
    const ptyId = deps.getLivePtyId();
    if (ptyId < 0) {
      return null;
    }

    return deps.getPtyOutputSnapshot(ptyId);
  };

  const getAuxOutputSnapshotForTest = async () => {
    const ptyId = deps.getAuxPtyId();
    if (ptyId < 0) {
      return null;
    }

    return deps.getPtyOutputSnapshot(ptyId);
  };

  const getViewportStateForTest = () => {
    const terminal = deps.getTerminal();
    if (!terminal) {
      return null;
    }

    return {
      viewportY: terminal.buffer.active.viewportY,
      baseY: terminal.buffer.active.baseY,
      rows: terminal.rows,
      cols: terminal.cols,
    };
  };

  const getBufferSnapshotForTest = (): TerminalBufferSnapshot | null => {
    const terminal = deps.getTerminal();
    if (!terminal) {
      return null;
    }

    const buffer = terminal.buffer.active;
    const lines: string[] = [];

    for (let index = 0; index < terminal.rows; index += 1) {
      const line = buffer.getLine(buffer.viewportY + index);
      lines.push(line?.translateToString(false) ?? "");
    }

    return {
      baseY: buffer.baseY,
      viewportY: buffer.viewportY,
      cursorX: buffer.cursorX,
      cursorY: buffer.cursorY,
      rows: terminal.rows,
      cols: terminal.cols,
      lines,
    };
  };

  const registerTestHooks = () => {
    deps.getTestHooks()[deps.getSessionId()] = {
      openPendingImage: openPendingImageForTest,
      getOutputSnapshot: getOutputSnapshotForTest,
      getAuxOutputSnapshot: getAuxOutputSnapshotForTest,
      getViewportState: getViewportStateForTest,
      getBufferSnapshot: getBufferSnapshotForTest,
      openUrlMenu: deps.openUrlMenu,
      openFileMenu: deps.openFileMenu,
    };
  };

  const unregisterTestHooks = () => {
    delete deps.getTestHooks()[deps.getSessionId()];
  };

  return {
    handleFocusRequest,
    handleTestPendingImage,
    openPendingImageForTest,
    getOutputSnapshotForTest,
    getAuxOutputSnapshotForTest,
    getViewportStateForTest,
    getBufferSnapshotForTest,
    registerTestHooks,
    unregisterTestHooks,
  };
}

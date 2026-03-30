import { emitTo, listen, type UnlistenFn } from "../tauri/event";
import { getCurrentWindow } from "../tauri/window";
import { Terminal } from "@xterm/xterm";
import { SerializeAddon } from "@xterm/addon-serialize";
import { getBootstrap } from "../bootstrap";
import { getSettings } from "../stores/settings.svelte";
import { DEFAULT_SETTINGS } from "../types";
import { createRuntimeId } from "../ids";
import {
  isClaudeFooterGhostingMitigationEnabled,
  syncTerminalUnicodeWidth,
} from "./claude-footer-ghosting";
import {
  getPtyOutputDeltaSince,
  getPtyRuntimeSnapshot,
  resizePty,
  type PtyOutputChunk,
} from "../pty";

const SESSION_REGISTER_EVENT = "clcomx:canonical-screen-register";
const SNAPSHOT_REQUEST_EVENT = "clcomx:canonical-screen-snapshot-request";
const SNAPSHOT_RESPONSE_EVENT = "clcomx:canonical-screen-snapshot-response";
const QUIET_WINDOW_MS = 140;
const MAX_PREPARE_WAIT_MS = 1800;

export interface CanonicalScreenSnapshot {
  serialized: string;
  delta: string;
  captureSeq: number;
  appliedSeq: number;
  cols: number;
  rows: number;
}

interface CanonicalScreenSnapshotRequest {
  requestId: string;
  replyLabel: string;
  sessionId: string;
  ptyId: number;
  agentId: string;
  cols: number;
  rows: number;
}

interface CanonicalScreenSnapshotResponse {
  requestId: string;
  snapshot: CanonicalScreenSnapshot | null;
  error?: string;
}

interface CanonicalSessionRegistration {
  sessionId: string;
  ptyId: number;
  agentId: string;
}

interface CanonicalSessionEntry {
  sessionId: string;
  ptyId: number;
  agentId: string;
  term: Terminal;
  serializer: SerializeAddon;
  writeQueue: Promise<void>;
  lastAppliedSeq: number;
  lastChunkAtMs: number;
}

const currentWindowLabel = getCurrentWindow().label;
const sessions = new Map<string, CanonicalSessionEntry>();
let authorityInstalled = false;
let authorityInstallPromise: Promise<() => void> | null = null;

function delay(ms: number) {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

function writeTerminalData(term: Terminal, data: string) {
  return new Promise<void>((resolve) => {
    if (!data) {
      resolve();
      return;
    }
    term.write(data, () => resolve());
  });
}

function resolveCanonicalScrollback() {
  const configured = getSettings().terminal.scrollback;
  return Number.isFinite(configured) && configured > 0
    ? configured
    : DEFAULT_SETTINGS.terminal.scrollback;
}

function resolveCanonicalGhostingMitigation(agentId: string) {
  const bootstrap = getBootstrap();
  return isClaudeFooterGhostingMitigationEnabled(
    agentId,
    getSettings().terminal.claudeFooterGhostingMitigation,
    bootstrap.softFollowExperiment,
  );
}

function buildCanonicalTerminal(agentId: string) {
  const term = new Terminal({
    allowProposedApi: true,
    disableStdin: true,
    scrollback: resolveCanonicalScrollback(),
  });
  syncTerminalUnicodeWidth(term, resolveCanonicalGhostingMitigation(agentId));
  const serializer = new SerializeAddon();
  term.loadAddon(serializer);
  return { term, serializer };
}

async function enqueueChunk(entry: CanonicalSessionEntry, data: string, seq: number) {
  entry.writeQueue = entry.writeQueue.then(async () => {
    await writeTerminalData(entry.term, data);
    entry.lastAppliedSeq = Math.max(entry.lastAppliedSeq, seq);
    entry.lastChunkAtMs = Date.now();
  });
  await entry.writeQueue;
}

function disposeEntry(entry: CanonicalSessionEntry) {
  entry.term.dispose();
}

async function ensureCanonicalEntry(
  sessionId: string,
  ptyId: number,
  agentId: string,
) {
  const existing = sessions.get(sessionId);
  if (existing && existing.ptyId === ptyId) {
    existing.term.options.scrollback = resolveCanonicalScrollback();
    return existing;
  }

  if (existing) {
    disposeEntry(existing);
    sessions.delete(sessionId);
  }

  const { term, serializer } = buildCanonicalTerminal(agentId);
  const snapshot = await getPtyRuntimeSnapshot(ptyId);
  term.resize(snapshot.cols, snapshot.rows);
  await writeTerminalData(term, snapshot.data);

  const entry: CanonicalSessionEntry = {
    sessionId,
    ptyId,
    agentId,
    term,
    serializer,
    writeQueue: Promise.resolve(),
    lastAppliedSeq: snapshot.seq,
    lastChunkAtMs: Date.now(),
  };
  sessions.set(sessionId, entry);
  return entry;
}

async function ensureRegisteredSession(registration: CanonicalSessionRegistration) {
  await ensureCanonicalEntry(
    registration.sessionId,
    registration.ptyId,
    registration.agentId,
  );
}

async function waitForQuietAfterResize(entry: CanonicalSessionEntry, baselineSeq: number) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < MAX_PREPARE_WAIT_MS) {
    await entry.writeQueue;
    const seqAdvanced = entry.lastAppliedSeq > baselineSeq;
    const quietFor = Date.now() - entry.lastChunkAtMs;
    if ((seqAdvanced && quietFor >= QUIET_WINDOW_MS) || quietFor >= QUIET_WINDOW_MS * 2) {
      return;
    }
    await delay(30);
  }
  await entry.writeQueue;
}

async function prepareCanonicalSnapshot(
  sessionId: string,
  ptyId: number,
  agentId: string,
  cols: number,
  rows: number,
): Promise<CanonicalScreenSnapshot | null> {
  const entry = await ensureCanonicalEntry(sessionId, ptyId, agentId);
  const runtime = await getPtyRuntimeSnapshot(ptyId);

  if (runtime.cols !== cols || runtime.rows !== rows) {
    await resizePty(ptyId, cols, rows);
    entry.term.resize(cols, rows);
    const baselineSeq = Math.max(runtime.seq, entry.lastAppliedSeq);
    await waitForQuietAfterResize(entry, baselineSeq);
  } else {
    entry.term.resize(cols, rows);
    await entry.writeQueue;
  }

  const captureSeq = entry.lastAppliedSeq;
  const serialized = entry.serializer.serialize();
  const delta = await getPtyOutputDeltaSince(ptyId, captureSeq);
  if (!delta.complete) {
    return null;
  }

  return {
    serialized,
    delta: delta.data,
    captureSeq,
    appliedSeq: delta.seq,
    cols,
    rows,
  };
}

async function handleSnapshotRequest(payload: CanonicalScreenSnapshotRequest) {
  const response: CanonicalScreenSnapshotResponse = {
    requestId: payload.requestId,
    snapshot: null,
  };

  try {
    response.snapshot = await prepareCanonicalSnapshot(
      payload.sessionId,
      payload.ptyId,
      payload.agentId,
      payload.cols,
      payload.rows,
    );
  } catch (error) {
    response.error = error instanceof Error ? error.message : String(error);
  }

  await emitTo(payload.replyLabel, SNAPSHOT_RESPONSE_EVENT, response);
}

async function handleSessionRegistration(payload: CanonicalSessionRegistration) {
  try {
    await ensureRegisteredSession(payload);
  } catch (error) {
    console.warn("Failed to register canonical terminal session", error);
  }
}

export async function installCanonicalScreenAuthority() {
  if (currentWindowLabel !== "main") {
    return () => {};
  }
  if (authorityInstalled && authorityInstallPromise) {
    return authorityInstallPromise;
  }

  authorityInstalled = true;
  authorityInstallPromise = (async () => {
    const unlistenOutput = await listen<PtyOutputChunk>("pty-output", (event) => {
      for (const entry of sessions.values()) {
        if (entry.ptyId === event.payload.id) {
          void enqueueChunk(entry, event.payload.data, event.payload.seq);
        }
      }
    });

    const unlistenExit = await listen<number>("pty-exit", (event) => {
      for (const [sessionId, entry] of sessions) {
        if (entry.ptyId === event.payload) {
          disposeEntry(entry);
          sessions.delete(sessionId);
        }
      }
    });

    const unlistenRequest = await listen<CanonicalScreenSnapshotRequest>(
      SNAPSHOT_REQUEST_EVENT,
      (event) => {
        void handleSnapshotRequest(event.payload);
      },
    );

    const unlistenRegister = await listen<CanonicalSessionRegistration>(
      SESSION_REGISTER_EVENT,
      (event) => {
        void handleSessionRegistration(event.payload);
      },
    );

    return () => {
      unlistenOutput();
      unlistenExit();
      unlistenRequest();
      unlistenRegister();
      for (const entry of sessions.values()) {
        disposeEntry(entry);
      }
      sessions.clear();
      authorityInstalled = false;
      authorityInstallPromise = null;
    };
  })();

  return authorityInstallPromise;
}

export async function registerCanonicalSession(params: CanonicalSessionRegistration) {
  if (currentWindowLabel === "main") {
    await ensureRegisteredSession(params);
    return;
  }

  await emitTo("main", SESSION_REGISTER_EVENT, params).catch(() => {});
}

export async function requestCanonicalScreenSnapshot(params: {
  sessionId: string;
  ptyId: number;
  agentId: string;
  cols: number;
  rows: number;
}) {
  if (currentWindowLabel === "main") {
    return prepareCanonicalSnapshot(
      params.sessionId,
      params.ptyId,
      params.agentId,
      params.cols,
      params.rows,
    );
  }

  const requestId = createRuntimeId("canonical-");
  return await new Promise<CanonicalScreenSnapshot | null>((resolve) => {
    let settled = false;
    let unlistenPromise: Promise<UnlistenFn> | null = null;

    const finish = (snapshot: CanonicalScreenSnapshot | null) => {
      if (settled) {
        return;
      }
      settled = true;
      if (unlistenPromise) {
        void unlistenPromise.then((unlisten) => unlisten()).catch(() => {});
      }
      resolve(snapshot);
    };

    const timer = setTimeout(() => {
      finish(null);
    }, 4000);

    unlistenPromise = listen<CanonicalScreenSnapshotResponse>(
      SNAPSHOT_RESPONSE_EVENT,
      (event) => {
        if (event.payload.requestId !== requestId) {
          return;
        }
        clearTimeout(timer);
        finish(event.payload.snapshot ?? null);
      },
    );

    void emitTo("main", SNAPSHOT_REQUEST_EVENT, {
      requestId,
      replyLabel: currentWindowLabel,
      sessionId: params.sessionId,
      ptyId: params.ptyId,
      agentId: params.agentId,
      cols: params.cols,
      rows: params.rows,
    } satisfies CanonicalScreenSnapshotRequest).catch(() => {
      clearTimeout(timer);
      finish(null);
    });
  });
}

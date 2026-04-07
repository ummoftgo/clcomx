import type { PtyOutputChunk } from "../../../pty";

export type MainTerminalLoadingState = "connecting" | "restoring";

export interface MainTerminalRuntimeState {
  livePtyId: number;
  initialOutputReady: boolean;
  spawnError: string | null;
  terminalLoadingState: MainTerminalLoadingState | null;
  terminalLoadingStartedAt: number;
  terminalLoadingHasRenderableOutput: boolean;
  terminalLoadingReadySignalSeen: boolean;
  terminalLoadingQuietTimer: ReturnType<typeof setTimeout> | null;
  terminalLoadingMaxTimer: ReturnType<typeof setTimeout> | null;
  mainMetadataRemainder: string;
  shellHomeDir: string | null;
  shellHomeDirSessionId: string | null;
  replayInProgress: boolean;
  replayBuffer: PtyOutputChunk[];
  bottomLockTimer: ReturnType<typeof setTimeout> | null;
  bottomLockDeadline: number;
  bottomLockMaxDeadline: number;
  followTail: boolean;
  pendingPostWriteScroll: boolean;
  deferredBottomScrollTimer: ReturnType<typeof setTimeout> | null;
}

class MainTerminalRuntimeStateImpl implements MainTerminalRuntimeState {
  livePtyId = $state(-1);
  initialOutputReady = false;
  spawnError = $state<string | null>(null);
  terminalLoadingState = $state<MainTerminalLoadingState | null>(null);
  terminalLoadingStartedAt = 0;
  terminalLoadingHasRenderableOutput = false;
  terminalLoadingReadySignalSeen = false;
  terminalLoadingQuietTimer: ReturnType<typeof setTimeout> | null = null;
  terminalLoadingMaxTimer: ReturnType<typeof setTimeout> | null = null;
  mainMetadataRemainder = "";
  shellHomeDir = $state<string | null>(null);
  shellHomeDirSessionId = $state<string | null>(null);
  replayInProgress = false;
  replayBuffer: PtyOutputChunk[] = [];
  bottomLockTimer: ReturnType<typeof setTimeout> | null = null;
  bottomLockDeadline = 0;
  bottomLockMaxDeadline = 0;
  followTail = true;
  pendingPostWriteScroll = false;
  deferredBottomScrollTimer: ReturnType<typeof setTimeout> | null = null;
}

export function createMainTerminalRuntimeState(): MainTerminalRuntimeState {
  return new MainTerminalRuntimeStateImpl();
}

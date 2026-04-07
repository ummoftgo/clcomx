export type AuxTerminalLoadingState = "opening";

export interface AuxTerminalRuntimeState {
  ptyId: number;
  exited: boolean;
  busy: boolean;
  loadingState: AuxTerminalLoadingState | null;
  loadingStartedAt: number;
  loadingHasRenderableOutput: boolean;
  loadingQuietTimer: ReturnType<typeof setTimeout> | null;
  loadingMaxTimer: ReturnType<typeof setTimeout> | null;
  spawnError: string | null;
  currentPath: string;
  metadataRemainder: string;
  followTail: boolean;
  attached: boolean;
}

class AuxTerminalRuntimeStateImpl implements AuxTerminalRuntimeState {
  ptyId = $state(-1);
  exited = $state(true);
  busy = $state(false);
  loadingState = $state<AuxTerminalLoadingState | null>(null);
  loadingStartedAt = 0;
  loadingHasRenderableOutput = false;
  loadingQuietTimer: ReturnType<typeof setTimeout> | null = null;
  loadingMaxTimer: ReturnType<typeof setTimeout> | null = null;
  spawnError = $state<string | null>(null);
  currentPath = $state("");
  metadataRemainder = "";
  followTail = true;
  attached = false;
}

export function createAuxTerminalRuntimeState(): AuxTerminalRuntimeState {
  return new AuxTerminalRuntimeStateImpl();
}

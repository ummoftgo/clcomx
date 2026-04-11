export const TERMINAL_LOADING_MIN_VISIBLE_MS = 360;
export const TERMINAL_LOADING_QUIET_MS = 1300;
export const TERMINAL_LOADING_MAX_MS = 8000;

interface TerminalLoadingLifecycleDeps<TState extends string> {
  getLoadingState: () => TState | null;
  setLoadingState: (state: TState | null) => void;
  getLoadingStartedAt: () => number;
  setLoadingStartedAt: (startedAt: number) => void;
  getHasRenderableOutput: () => boolean;
  setHasRenderableOutput: (hasRenderableOutput: boolean) => void;
  getQuietTimer: () => ReturnType<typeof setTimeout> | null;
  setQuietTimer: (timer: ReturnType<typeof setTimeout> | null) => void;
  getMaxTimer: () => ReturnType<typeof setTimeout> | null;
  setMaxTimer: (timer: ReturnType<typeof setTimeout> | null) => void;
  shouldWaitForMinDuration: (force: boolean) => boolean;
  onShow?: () => void;
  onClear?: () => void;
  minVisibleDurationMs?: number;
  quietMs?: number;
  maxMs?: number;
  now?: () => number;
  setTimeoutFn?: typeof setTimeout;
  clearTimeoutFn?: typeof clearTimeout;
}

export function hasRenderableTerminalOutput(data: string) {
  if (!data) {
    return false;
  }

  const withoutOsc = data.replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, "");
  const withoutCsi = withoutOsc.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "");
  const withoutControl = withoutCsi.replace(/[\u0000-\u001f\u007f]/g, "");
  return withoutControl.trim().length > 0;
}

export function createTerminalLoadingLifecycle<TState extends string>(
  deps: TerminalLoadingLifecycleDeps<TState>,
) {
  const setTimer = deps.setTimeoutFn ?? setTimeout;
  const clearTimer = deps.clearTimeoutFn ?? clearTimeout;
  const now = deps.now ?? (() => performance.now());
  const minVisibleDurationMs =
    deps.minVisibleDurationMs ?? TERMINAL_LOADING_MIN_VISIBLE_MS;
  const quietMs = deps.quietMs ?? TERMINAL_LOADING_QUIET_MS;
  const maxMs = deps.maxMs ?? TERMINAL_LOADING_MAX_MS;

  let lifecycleVersion = 0;
  let disposed = false;
  let pendingDelayTimer: ReturnType<typeof setTimeout> | null = null;
  let pendingDelayResolve: (() => void) | null = null;

  function clearPendingDelayTimer() {
    if (pendingDelayTimer) {
      clearTimer(pendingDelayTimer);
      pendingDelayTimer = null;
    }
    if (pendingDelayResolve) {
      const resolve = pendingDelayResolve;
      pendingDelayResolve = null;
      resolve();
    }
  }

  function clearTimers() {
    clearPendingDelayTimer();

    const quietTimer = deps.getQuietTimer();
    if (quietTimer) {
      clearTimer(quietTimer);
      deps.setQuietTimer(null);
    }

    const maxTimer = deps.getMaxTimer();
    if (maxTimer) {
      clearTimer(maxTimer);
      deps.setMaxTimer(null);
    }
  }

  function show(state: TState) {
    const nextVersion = ++lifecycleVersion;
    clearTimers();

    deps.setLoadingState(state);
    deps.setLoadingStartedAt(now());
    deps.setHasRenderableOutput(false);
    deps.onShow?.();

    deps.setMaxTimer(setTimer(() => {
      if (disposed || nextVersion !== lifecycleVersion) {
        return;
      }

      deps.setMaxTimer(null);
      void clear(true, nextVersion);
    }, maxMs));
  }

  function noteRenderableOutput(data: string) {
    if (deps.getLoadingState() === null || !hasRenderableTerminalOutput(data)) {
      return false;
    }

    deps.setHasRenderableOutput(true);
    return true;
  }

  function scheduleQuietClear() {
    if (deps.getLoadingState() === null || !deps.getHasRenderableOutput()) {
      return;
    }

    const quietTimer = deps.getQuietTimer();
    if (quietTimer) {
      clearTimer(quietTimer);
    }

    const nextVersion = lifecycleVersion;
    deps.setQuietTimer(setTimer(() => {
      if (disposed || nextVersion !== lifecycleVersion) {
        return;
      }

      deps.setQuietTimer(null);
      void clear(false, nextVersion);
    }, quietMs));
  }

  async function clear(force = false, expectedVersion = lifecycleVersion) {
    if (disposed || expectedVersion !== lifecycleVersion || deps.getLoadingState() === null) {
      return;
    }

    if (deps.shouldWaitForMinDuration(force)) {
      const elapsed = now() - deps.getLoadingStartedAt();
      const remaining = minVisibleDurationMs - elapsed;
      if (remaining > 0) {
        await new Promise<void>((resolve) => {
          pendingDelayResolve = () => {
            pendingDelayResolve = null;
            resolve();
          };
          pendingDelayTimer = setTimer(() => {
            pendingDelayTimer = null;
            pendingDelayResolve?.();
          }, remaining);
        });
      }
    }

    if (disposed || expectedVersion !== lifecycleVersion || deps.getLoadingState() === null) {
      return;
    }

    clearTimers();
    deps.setHasRenderableOutput(false);
    deps.setLoadingState(null);
    deps.onClear?.();
  }

  function dispose() {
    disposed = true;
    lifecycleVersion += 1;
    clearTimers();
  }

  return {
    clear,
    clearTimers,
    dispose,
    noteRenderableOutput,
    scheduleQuietClear,
    show,
  };
}

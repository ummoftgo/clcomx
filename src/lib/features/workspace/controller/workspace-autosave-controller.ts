interface WorkspaceAutosaveControllerDeps {
  persistWorkspace: () => void | Promise<void>;
  setTimeoutFn?: typeof setTimeout;
  clearTimeoutFn?: typeof clearTimeout;
}

export const WORKSPACE_AUTOSAVE_DELAY_MS = 120;

export function createWorkspaceAutosaveController(
  deps: WorkspaceAutosaveControllerDeps,
) {
  const setTimer = deps.setTimeoutFn ?? setTimeout;
  const clearTimer = deps.clearTimeoutFn ?? clearTimeout;
  let saveTimer: ReturnType<typeof setTimeout> | null = null;

  const schedule = () => {
    if (saveTimer) {
      clearTimer(saveTimer);
    }

    saveTimer = setTimer(() => {
      // Keep the handle until dispose so App.svelte's final flush behavior stays unchanged.
      void deps.persistWorkspace();
    }, WORKSPACE_AUTOSAVE_DELAY_MS);
  };

  const dispose = () => {
    if (!saveTimer) return;

    clearTimer(saveTimer);
    saveTimer = null;
    void deps.persistWorkspace();
  };

  return {
    schedule,
    dispose,
  };
}

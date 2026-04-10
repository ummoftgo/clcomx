import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createWorkspaceAutosaveController,
  WORKSPACE_AUTOSAVE_DELAY_MS,
} from "./workspace-autosave-controller";

function createController() {
  const deps = {
    persistWorkspace: vi.fn(async () => {}),
  };

  return {
    controller: createWorkspaceAutosaveController(deps),
    deps,
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("workspace-autosave-controller", () => {
  it("debounces workspace persistence", async () => {
    vi.useFakeTimers();
    const { controller, deps } = createController();

    controller.schedule();
    controller.schedule();

    await vi.advanceTimersByTimeAsync(WORKSPACE_AUTOSAVE_DELAY_MS - 1);
    expect(deps.persistWorkspace).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(deps.persistWorkspace).toHaveBeenCalledTimes(1);
  });

  it("flushes a scheduled workspace save on dispose", () => {
    vi.useFakeTimers();
    const { controller, deps } = createController();

    controller.schedule();
    controller.dispose();

    expect(deps.persistWorkspace).toHaveBeenCalledTimes(1);
  });

  it("does not flush when dispose has no scheduled workspace save", () => {
    const { controller, deps } = createController();

    controller.dispose();

    expect(deps.persistWorkspace).not.toHaveBeenCalled();
  });

  it("keeps the final dispose flush behavior after the debounce timer fires", async () => {
    vi.useFakeTimers();
    const { controller, deps } = createController();

    controller.schedule();
    await vi.advanceTimersByTimeAsync(WORKSPACE_AUTOSAVE_DELAY_MS);
    controller.dispose();

    expect(deps.persistWorkspace).toHaveBeenCalledTimes(2);
  });

  it("clears the scheduled timer after dispose", async () => {
    vi.useFakeTimers();
    const { controller, deps } = createController();

    controller.schedule();
    controller.dispose();
    await vi.advanceTimersByTimeAsync(WORKSPACE_AUTOSAVE_DELAY_MS);

    expect(deps.persistWorkspace).toHaveBeenCalledTimes(1);
  });
});

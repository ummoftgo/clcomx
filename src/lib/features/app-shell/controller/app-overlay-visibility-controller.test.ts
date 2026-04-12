import { describe, expect, it, vi } from "vitest";
import { createAppOverlayVisibilityController } from "./app-overlay-visibility-controller";

function createRuntime() {
  const state = {
    sessionsCount: 1,
    showSessionLauncher: false,
    showSettings: false,
    showPreviewControls: false,
  };

  const deps = {
    getSessionsCount: vi.fn(() => state.sessionsCount),
    getShowSessionLauncher: vi.fn(() => state.showSessionLauncher),
    setShowSessionLauncher: vi.fn((open: boolean) => {
      state.showSessionLauncher = open;
    }),
    getShowSettings: vi.fn(() => state.showSettings),
    setShowSettings: vi.fn((open: boolean) => {
      state.showSettings = open;
    }),
    setShowPreviewControls: vi.fn((open: boolean) => {
      state.showPreviewControls = open;
    }),
    syncPreviewControlsVisible: vi.fn(),
    ensureSettingsLoaded: vi.fn(async () => {}),
  };

  return {
    state,
    deps,
    controller: createAppOverlayVisibilityController(deps),
  };
}

describe("app-overlay-visibility-controller", () => {
  it("opens the session launcher for new tabs only when sessions exist", () => {
    const { state, controller } = createRuntime();

    expect(controller.requestNewTab()).toBe(true);
    expect(state.showSessionLauncher).toBe(true);

    state.showSessionLauncher = false;
    state.sessionsCount = 0;
    expect(controller.requestNewTab()).toBe(false);
    expect(state.showSessionLauncher).toBe(false);
  });

  it("toggles and hides the session launcher", () => {
    const { state, controller } = createRuntime();

    controller.toggleSessionLauncher();
    expect(state.showSessionLauncher).toBe(true);

    controller.toggleSessionLauncher();
    expect(state.showSessionLauncher).toBe(false);

    state.showSessionLauncher = true;
    controller.hideSessionLauncher();
    expect(state.showSessionLauncher).toBe(false);
  });

  it("opens settings after ensuring the modal is loaded", async () => {
    const { state, deps, controller } = createRuntime();

    await expect(controller.openSettingsPanel()).resolves.toBe(true);
    expect(deps.ensureSettingsLoaded).toHaveBeenCalledTimes(1);
    expect(state.showSettings).toBe(true);
  });

  it("toggles preview settings visibility", async () => {
    const { state, deps, controller } = createRuntime();

    await expect(controller.togglePreviewSettings()).resolves.toBe(true);
    expect(deps.ensureSettingsLoaded).toHaveBeenCalledTimes(1);
    expect(state.showSettings).toBe(true);

    await expect(controller.togglePreviewSettings()).resolves.toBe(false);
    expect(state.showSettings).toBe(false);
  });

  it("syncs preview control visibility with URL state", () => {
    const { state, deps, controller } = createRuntime();

    controller.setPreviewControlsVisible(true);
    expect(state.showPreviewControls).toBe(true);
    expect(deps.syncPreviewControlsVisible).toHaveBeenCalledWith(true);

    controller.setPreviewControlsVisible(false);
    expect(state.showPreviewControls).toBe(false);
    expect(deps.syncPreviewControlsVisible).toHaveBeenCalledWith(false);
  });
});

import { beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS } from "../types";
import { invokeMock } from "../../test/mocks/tauri";
import {
  getSettings,
  initializeSettings,
  normalizeSettings,
  updateSettings,
} from "./settings.svelte";

const EXAMPLE_DISTRO = "ExampleDistro";
const EXAMPLE_PATH = "/home/tester/work";

function flushTasks() {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

describe("settings store", () => {
  beforeEach(() => {
    initializeSettings(DEFAULT_SETTINGS);
  });

  it("normalizes missing nested settings with defaults", () => {
    const settings = normalizeSettings({
      interface: { uiScale: 135 },
      workspace: { defaultAgentId: "codex", defaultDistro: EXAMPLE_DISTRO },
      terminal: { fontSize: 16 },
    });

    expect(settings.interface.uiScale).toBe(135);
    expect(settings.interface.theme).toBe(DEFAULT_SETTINGS.interface.theme);
    expect(settings.workspace.defaultAgentId).toBe("codex");
    expect(settings.workspace.defaultDistro).toBe(EXAMPLE_DISTRO);
    expect(settings.terminal.fontSize).toBe(16);
    expect(settings.history.tabLimit).toBe(DEFAULT_SETTINGS.history.tabLimit);
  });

  it("persists nested setting updates through tauri invoke", async () => {
    updateSettings({
      workspace: {
        defaultAgentId: "codex",
        defaultDistro: EXAMPLE_DISTRO,
        defaultStartPathsByDistro: {
          [EXAMPLE_DISTRO]: EXAMPLE_PATH,
        },
      },
      interface: {
        uiScale: 125,
        windowDefaultCols: 132,
      },
    });

    await flushTasks();

    expect(invokeMock).toHaveBeenCalledWith(
      "save_settings",
      expect.objectContaining({
        settings: expect.objectContaining({
          workspace: expect.objectContaining({
            defaultAgentId: "codex",
            defaultDistro: EXAMPLE_DISTRO,
            defaultStartPathsByDistro: expect.objectContaining({
              [EXAMPLE_DISTRO]: EXAMPLE_PATH,
            }),
          }),
          interface: expect.objectContaining({
            uiScale: 125,
            windowDefaultCols: 132,
          }),
        }),
      }),
    );

    expect(getSettings().interface.uiScale).toBe(125);
    expect(getSettings().interface.windowDefaultCols).toBe(132);
    expect(getSettings().workspace.defaultAgentId).toBe("codex");
    expect(getSettings().workspace.defaultDistro).toBe(EXAMPLE_DISTRO);
  });
});

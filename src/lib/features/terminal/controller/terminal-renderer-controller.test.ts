import { afterEach, describe, expect, it, vi } from "vitest";
import type { WebglAddon } from "@xterm/addon-webgl";
import type { Terminal } from "@xterm/xterm";
import {
  createTerminalRendererController,
  releaseTerminalRendererController,
  syncTerminalRendererPreference,
} from "./terminal-renderer-controller";

function createAddon() {
  let contextLossHandler: (() => void) | null = null;
  const contextLossDisposable = {
    dispose: vi.fn(),
  };
  const addon = {
    dispose: vi.fn(),
    onContextLoss: vi.fn((handler: () => void) => {
      contextLossHandler = handler;
      return contextLossDisposable;
    }),
  } as unknown as WebglAddon;

  return {
    addon,
    contextLossDisposable,
    triggerContextLoss: () => contextLossHandler?.(),
  };
}

function createTerminal(options?: { loadAddonImpl?: (addon: WebglAddon) => void }) {
  return {
    loadAddon: vi.fn(options?.loadAddonImpl ?? (() => {})),
  } as unknown as Terminal & { loadAddon: ReturnType<typeof vi.fn> };
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("terminal-renderer-controller", () => {
  it("releases webgl resources and reports dom when dom rendering is preferred", () => {
    const controller = createTerminalRendererController();
    const { addon, contextLossDisposable } = createAddon();
    const updateActiveRenderer = vi.fn();
    controller.addon = addon;
    controller.contextLossDisposable = contextLossDisposable;

    syncTerminalRendererPreference(
      createTerminal(),
      controller,
      "dom",
      updateActiveRenderer,
    );

    expect(contextLossDisposable.dispose).toHaveBeenCalledTimes(1);
    expect(addon.dispose).toHaveBeenCalledTimes(1);
    expect(controller.addon).toBeNull();
    expect(controller.contextLossDisposable).toBeNull();
    expect(updateActiveRenderer).toHaveBeenCalledWith("dom");
  });

  it("loads webgl once and reuses the existing addon on later syncs", () => {
    const controller = createTerminalRendererController();
    const terminal = createTerminal();
    const addonRuntime = createAddon();
    const updateActiveRenderer = vi.fn();
    const createWebglAddon = vi.fn(() => addonRuntime.addon);

    syncTerminalRendererPreference(terminal, controller, "webgl", updateActiveRenderer, {
      createWebglAddon,
    });
    syncTerminalRendererPreference(terminal, controller, "webgl", updateActiveRenderer, {
      createWebglAddon,
    });

    expect(createWebglAddon).toHaveBeenCalledTimes(1);
    expect(terminal.loadAddon).toHaveBeenCalledTimes(1);
    expect(terminal.loadAddon).toHaveBeenCalledWith(addonRuntime.addon);
    expect(updateActiveRenderer).toHaveBeenCalledWith("webgl");
    expect(updateActiveRenderer).toHaveBeenCalledTimes(2);

    releaseTerminalRendererController(controller);
  });

  it("falls back to dom when the webgl context is lost", () => {
    const controller = createTerminalRendererController();
    const addonRuntime = createAddon();
    const updateActiveRenderer = vi.fn();
    const warn = vi.fn();

    syncTerminalRendererPreference(createTerminal(), controller, "webgl", updateActiveRenderer, {
      createWebglAddon: () => addonRuntime.addon,
      warn,
    });
    addonRuntime.triggerContextLoss();

    expect(warn).toHaveBeenCalledWith("WebGL terminal renderer context lost, falling back to DOM");
    expect(addonRuntime.contextLossDisposable.dispose).toHaveBeenCalledTimes(1);
    expect(addonRuntime.addon.dispose).toHaveBeenCalledTimes(1);
    expect(controller.addon).toBeNull();
    expect(updateActiveRenderer).toHaveBeenLastCalledWith("dom");
  });

  it("falls back to dom when webgl addon loading fails", () => {
    const controller = createTerminalRendererController();
    const addonRuntime = createAddon();
    const error = new Error("webgl unavailable");
    const terminal = createTerminal({
      loadAddonImpl: () => {
        throw error;
      },
    });
    const updateActiveRenderer = vi.fn();
    const warn = vi.fn();

    syncTerminalRendererPreference(terminal, controller, "webgl", updateActiveRenderer, {
      createWebglAddon: () => addonRuntime.addon,
      warn,
    });

    expect(addonRuntime.contextLossDisposable.dispose).toHaveBeenCalledTimes(1);
    expect(addonRuntime.addon.dispose).not.toHaveBeenCalled();
    expect(controller.addon).toBeNull();
    expect(controller.contextLossDisposable).toBeNull();
    expect(updateActiveRenderer).toHaveBeenCalledWith("dom");
    expect(warn).toHaveBeenCalledWith(
      "Failed to activate WebGL terminal renderer, falling back to DOM",
      error,
    );
  });
});

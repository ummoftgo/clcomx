import { WebglAddon } from "@xterm/addon-webgl";
import type { IDisposable, Terminal } from "@xterm/xterm";
import type { TerminalRendererPreference } from "../../../types";

export interface TerminalRendererController {
  addon: WebglAddon | null;
  contextLossDisposable: IDisposable | null;
}

export interface TerminalRendererControllerDeps {
  createWebglAddon?: () => WebglAddon;
  warn?: (...args: unknown[]) => void;
}

export function createTerminalRendererController(): TerminalRendererController {
  return {
    addon: null,
    contextLossDisposable: null,
  };
}

export function releaseTerminalRendererController(controller: TerminalRendererController) {
  controller.contextLossDisposable?.dispose();
  controller.contextLossDisposable = null;
  controller.addon?.dispose();
  controller.addon = null;
}

export function syncTerminalRendererPreference(
  term: Terminal,
  controller: TerminalRendererController,
  preferred: TerminalRendererPreference,
  updateActiveRenderer: (value: TerminalRendererPreference) => void,
  deps: TerminalRendererControllerDeps = {},
) {
  const warn = deps.warn ?? console.warn;

  if (preferred === "dom") {
    releaseTerminalRendererController(controller);
    updateActiveRenderer("dom");
    return;
  }

  if (controller.addon) {
    updateActiveRenderer("webgl");
    return;
  }

  try {
    const addon = deps.createWebglAddon?.() ?? new WebglAddon();
    controller.contextLossDisposable = addon.onContextLoss(() => {
      warn("WebGL terminal renderer context lost, falling back to DOM");
      releaseTerminalRendererController(controller);
      updateActiveRenderer("dom");
    });
    term.loadAddon(addon);
    controller.addon = addon;
    updateActiveRenderer("webgl");
  } catch (error) {
    releaseTerminalRendererController(controller);
    updateActiveRenderer("dom");
    warn("Failed to activate WebGL terminal renderer, falling back to DOM", error);
  }
}

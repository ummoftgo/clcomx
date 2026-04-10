import { describe, expect, it, vi } from "vitest";
import type { AppBootstrap } from "../../../types";
import type { PreviewPresetId } from "../../../preview/runtime";
import { createPreviewBootstrapController } from "./preview-bootstrap-controller";

function createBootstrap(label: string): AppBootstrap {
  return {
    settings: {
      interface: { theme: label },
    },
    tabHistory: [
      {
        agentId: "claude",
        distro: "Ubuntu",
        workDir: `/work/${label}`,
        title: label,
        resumeToken: null,
        lastOpenedAt: "2026-04-10T00:00:00.000Z",
      },
    ],
    workspace: {
      windows: [
        {
          label: "main",
          name: "main",
          role: "main",
          tabs: [],
          activeSessionId: null,
          x: 0,
          y: 0,
          width: 800,
          height: 600,
          maximized: false,
        },
      ],
    },
    themePack: null,
    testMode: false,
    debugTerminalHooks: false,
    softFollowExperiment: null,
  } satisfies AppBootstrap;
}

function createController(options: {
  isBrowserPreview?: boolean;
  activePresetId?: PreviewPresetId;
} = {}) {
  const bootstrap = createBootstrap("dense");
  const callOrder: string[] = [];
  const deps = {
    isBrowserPreview: vi.fn(() => options.isBrowserPreview ?? true),
    currentWindowLabel: vi.fn(() => "preview-secondary"),
    applyPreviewPreset: vi.fn((_presetId: PreviewPresetId) => {
      callOrder.push("applyPreviewPreset");
      return bootstrap;
    }),
    getActivePreviewPresetId: vi.fn(() => options.activePresetId ?? "dense"),
    setActivePreviewPresetId: vi.fn(() => {
      callOrder.push("setActivePreviewPresetId");
    }),
    setBootstrapSnapshot: vi.fn(() => {
      callOrder.push("setBootstrapSnapshot");
    }),
    setLocalBootstrap: vi.fn(() => {
      callOrder.push("setLocalBootstrap");
    }),
    initializeSettings: vi.fn(() => {
      callOrder.push("initializeSettings");
    }),
    initializeTabHistory: vi.fn(() => {
      callOrder.push("initializeTabHistory");
    }),
    initializeWorkspaceSnapshot: vi.fn(() => {
      callOrder.push("initializeWorkspaceSnapshot");
    }),
    initializeSessionsFromWorkspace: vi.fn(() => {
      callOrder.push("initializeSessionsFromWorkspace");
    }),
    resetOverlays: vi.fn(() => {
      callOrder.push("resetOverlays");
    }),
  };

  return {
    controller: createPreviewBootstrapController(deps),
    deps,
    bootstrap,
    callOrder,
  };
}

describe("preview-bootstrap-controller", () => {
  it("does not apply preset changes outside browser preview mode", () => {
    const { controller, deps } = createController({ isBrowserPreview: false });

    controller.handlePresetChange("dense");

    expect(deps.applyPreviewPreset).not.toHaveBeenCalled();
    expect(deps.setBootstrapSnapshot).not.toHaveBeenCalled();
    expect(deps.resetOverlays).not.toHaveBeenCalled();
  });

  it("applies preview preset changes and updates the active preset id", () => {
    const runtime = createController({ activePresetId: "editor" });

    runtime.controller.handlePresetChange("dense");

    expect(runtime.deps.applyPreviewPreset).toHaveBeenCalledWith("dense");
    expect(runtime.deps.setActivePreviewPresetId).toHaveBeenCalledWith("editor");
    expect(runtime.deps.setBootstrapSnapshot).toHaveBeenCalledWith(runtime.bootstrap);
    expect(runtime.deps.setLocalBootstrap).toHaveBeenCalledWith(runtime.bootstrap);
    expect(runtime.deps.initializeSettings).toHaveBeenCalledWith(runtime.bootstrap.settings);
    expect(runtime.deps.initializeTabHistory).toHaveBeenCalledWith(runtime.bootstrap.tabHistory);
    expect(runtime.deps.initializeWorkspaceSnapshot).toHaveBeenCalledWith(
      runtime.bootstrap.workspace,
      "preview-secondary",
    );
    expect(runtime.deps.initializeSessionsFromWorkspace).toHaveBeenCalledWith(
      runtime.bootstrap.workspace,
      "preview-secondary",
    );
    expect(runtime.deps.resetOverlays).toHaveBeenCalledTimes(1);
  });

  it("preserves preview bootstrap application order", () => {
    const runtime = createController();

    runtime.controller.handlePresetChange("dense");

    expect(runtime.callOrder).toEqual([
      "applyPreviewPreset",
      "setActivePreviewPresetId",
      "setBootstrapSnapshot",
      "setLocalBootstrap",
      "initializeSettings",
      "initializeTabHistory",
      "initializeWorkspaceSnapshot",
      "initializeSessionsFromWorkspace",
      "resetOverlays",
    ]);
  });
});

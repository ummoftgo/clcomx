import { describe, expect, it, vi } from "vitest";
import {
  createWindowSessionDetachOrchestrationController,
  type NewWindowGeometry,
} from "./window-session-detach-orchestration-controller";

const geometry: NewWindowGeometry = {
  x: 112,
  y: 152,
  width: 900,
  height: 700,
};

function createDeps(
  overrides: Partial<Parameters<typeof createWindowSessionDetachOrchestrationController>[0]> = {},
) {
  const deps = {
    openEmptyWindow: vi.fn(async () => "secondary"),
    waitForWindowReady: vi.fn(async () => true),
    moveSessionToWindow: vi.fn(async () => {}),
    reportError: vi.fn(),
    ...overrides,
  };

  return {
    deps,
    controller: createWindowSessionDetachOrchestrationController(deps),
  };
}

describe("window-session-detach-orchestration-controller", () => {
  it("opens a new window, waits for readiness, and moves the session", async () => {
    const { deps, controller } = createDeps();

    await expect(
      controller.moveSessionToNewWindow("session-1", geometry),
    ).resolves.toBe(true);
    expect(deps.openEmptyWindow).toHaveBeenCalledWith(112, 152, 900, 700);
    expect(deps.waitForWindowReady).toHaveBeenCalledWith("secondary");
    expect(deps.moveSessionToWindow).toHaveBeenCalledWith("session-1", "secondary");
  });

  it("reports readiness timeout and skips the move", async () => {
    const { deps, controller } = createDeps({
      waitForWindowReady: vi.fn(async () => false),
    });

    await expect(
      controller.moveSessionToNewWindow("session-1", geometry),
    ).resolves.toBe(false);
    expect(deps.moveSessionToWindow).not.toHaveBeenCalled();
    expect(deps.reportError).toHaveBeenCalledWith(
      "New window did not become ready",
      "secondary",
    );
  });

  it("reports failures while opening a new window", async () => {
    const openError = new Error("open failed");
    const { deps, controller } = createDeps({
      openEmptyWindow: vi.fn(async () => {
        throw openError;
      }),
    });

    await expect(
      controller.moveSessionToNewWindow("session-1", geometry),
    ).resolves.toBe(false);
    expect(deps.reportError).toHaveBeenCalledWith("Failed to detach tab", openError);
  });

  it("reports failures while moving a session after the new window is ready", async () => {
    const moveError = new Error("move failed");
    const { deps, controller } = createDeps({
      moveSessionToWindow: vi.fn(async () => {
        throw moveError;
      }),
    });

    await expect(
      controller.moveSessionToNewWindow("session-1", geometry),
    ).resolves.toBe(false);
    expect(deps.reportError).toHaveBeenCalledWith("Failed to detach tab", moveError);
  });
});

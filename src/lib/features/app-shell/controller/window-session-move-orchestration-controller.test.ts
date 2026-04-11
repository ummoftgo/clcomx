import { describe, expect, it, vi } from "vitest";
import { createWindowSessionMoveOrchestrationController } from "./window-session-move-orchestration-controller";

function createDeps(
  overrides: Partial<Parameters<typeof createWindowSessionMoveOrchestrationController>[0]> = {},
) {
  let now = 0;

  const deps = {
    isWindowReady: vi.fn(async () => true),
    moveSessionToWindow: vi.fn(async () => {}),
    reportError: vi.fn(),
    wait: vi.fn(async (ms: number) => {
      now += ms;
    }),
    now: vi.fn(() => now),
    ...overrides,
  };

  return {
    deps,
    controller: createWindowSessionMoveOrchestrationController(deps),
  };
}

describe("window-session-move-orchestration-controller", () => {
  it("moves directly to the main window without waiting for readiness", async () => {
    const { deps, controller } = createDeps();

    await expect(
      controller.moveSessionToExistingWindow("session-1", "main"),
    ).resolves.toBe(true);
    expect(deps.isWindowReady).not.toHaveBeenCalled();
    expect(deps.moveSessionToWindow).toHaveBeenCalledWith("session-1", "main");
  });

  it("waits for readiness before moving to another window", async () => {
    const isWindowReady = vi.fn(async () => isWindowReady.mock.calls.length >= 3);
    const { deps, controller } = createDeps({
      isWindowReady,
    });

    await expect(
      controller.moveSessionToExistingWindow("session-1", "secondary"),
    ).resolves.toBe(true);
    expect(deps.isWindowReady).toHaveBeenCalledTimes(3);
    expect(deps.wait).toHaveBeenCalledTimes(2);
    expect(deps.moveSessionToWindow).toHaveBeenCalledWith("session-1", "secondary");
  });

  it("reports timeout and skips the move when another window never becomes ready", async () => {
    const { deps, controller } = createDeps({
      isWindowReady: vi.fn(async () => false),
    });

    await expect(
      controller.moveSessionToExistingWindow("session-1", "secondary", 100),
    ).resolves.toBe(false);
    expect(deps.moveSessionToWindow).not.toHaveBeenCalled();
    expect(deps.reportError).toHaveBeenCalledWith(
      "Target window did not become ready",
      "secondary",
    );
  });

  it("continues polling after a transient readiness query error", async () => {
    const queryError = new Error("not ready yet");
    let attempts = 0;
    const { deps, controller } = createDeps({
      isWindowReady: vi.fn(async () => {
        attempts += 1;
        if (attempts === 1) {
          throw queryError;
        }
        return true;
      }),
    });

    await expect(
      controller.moveSessionToExistingWindow("session-1", "secondary"),
    ).resolves.toBe(true);
    expect(deps.reportError).toHaveBeenCalledWith(
      "Failed to query window readiness",
      queryError,
    );
    expect(deps.moveSessionToWindow).toHaveBeenCalledWith("session-1", "secondary");
  });

  it("reports move failures", async () => {
    const moveError = new Error("move failed");
    const { deps, controller } = createDeps({
      moveSessionToWindow: vi.fn(async () => {
        throw moveError;
      }),
    });

    await expect(
      controller.moveSessionToExistingWindow("session-1", "main"),
    ).resolves.toBe(false);
    expect(deps.reportError).toHaveBeenCalledWith(
      "Failed to move session to window",
      moveError,
    );
  });
});

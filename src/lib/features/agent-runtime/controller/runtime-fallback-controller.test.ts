import { describe, expect, it, vi } from "vitest";
import {
  createRuntimeFallbackController,
  type RuntimeFallbackContext,
  type RuntimeFallbackDeps,
} from "./runtime-fallback-controller";

const CONTEXT: RuntimeFallbackContext = {
  sessionId: "session-1",
  agentId: "codex",
  distro: "Ubuntu",
  workDir: "/work",
};

function createController(overrides: Partial<RuntimeFallbackDeps> = {}) {
  const onFallbackToPty = overrides.onFallbackToPty ?? vi.fn(async () => {});
  const deps: RuntimeFallbackDeps = {
    context: overrides.context ?? CONTEXT,
    onFallbackToPty,
    onRetry: overrides.onRetry,
  };
  return { deps, controller: createRuntimeFallbackController(deps) };
}

describe("runtime-fallback-controller", () => {
  it("is hidden until a failure is marked", () => {
    const { controller } = createController();
    expect(controller.state.visible).toBe(false);
    expect(controller.state.message).toBeNull();
  });

  it("shows the panel with a normalized message on failure (no auto fallback)", () => {
    const onFallbackToPty = vi.fn(async () => {});
    const { controller } = createController({ onFallbackToPty });

    controller.markFailed(new Error("spawn ENOENT codex"));

    expect(controller.state.visible).toBe(true);
    expect(controller.state.message).toBe("spawn ENOENT codex");
    // 자동 폴백 금지 — markFailed만으로는 PTY 전환을 호출하지 않는다(10 §4.6).
    expect(onFallbackToPty).not.toHaveBeenCalled();
  });

  it("normalizes string and unknown errors without throwing", () => {
    const { controller } = createController();
    controller.markFailed("allowlist rejected");
    expect(controller.state.message).toBe("allowlist rejected");

    controller.markFailed({ code: 1 });
    expect(controller.state.message).toBe("[object Object]");
  });

  it("delegates legacy PTY fallback with the failed session context and hides the panel", async () => {
    const onFallbackToPty = vi.fn(async () => {});
    const { controller } = createController({ onFallbackToPty });

    controller.markFailed(new Error("initialize timeout"));
    await controller.chooseLegacyPty();

    expect(onFallbackToPty).toHaveBeenCalledWith(CONTEXT);
    expect(controller.state.visible).toBe(false);
  });

  it("delegates retry only when onRetry is provided", async () => {
    const onRetry = vi.fn(async () => {});
    const { controller } = createController({ onRetry });

    expect(controller.canRetry).toBe(true);
    controller.markFailed(new Error("x"));
    await controller.chooseRetry();

    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(controller.state.visible).toBe(false);
  });

  it("reports retry unavailable and no-ops chooseRetry without onRetry", async () => {
    const { controller } = createController();
    expect(controller.canRetry).toBe(false);

    controller.markFailed(new Error("x"));
    await controller.chooseRetry();
    // onRetry 미주입 → 패널은 유지(상태 변화 없음).
    expect(controller.state.visible).toBe(true);
  });

  it("dismiss keeps the empty tab and just closes the panel", () => {
    const onFallbackToPty = vi.fn(async () => {});
    const { controller } = createController({ onFallbackToPty });

    controller.markFailed(new Error("x"));
    controller.dismiss();

    expect(controller.state.visible).toBe(false);
    expect(onFallbackToPty).not.toHaveBeenCalled();
  });
});

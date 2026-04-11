import { describe, expect, it, vi } from "vitest";
import {
  APP_STARTUP_EDITOR_DETECTION_DELAY_MS,
  createAppStartupController,
} from "./app-startup-controller";

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

function createController(options: {
  isMainWindow?: boolean;
  currentWindowLabel?: string;
  installCanonicalScreenAuthorityImpl?: () => Promise<() => void>;
  notifyWindowReadyImpl?: (label: string) => Promise<void>;
} = {}) {
  const order: string[] = [];
  const canonicalCleanup = vi.fn(() => {
    order.push("canonical:cleanup");
  });

  const deps = {
    isMainWindow: vi.fn(() => options.isMainWindow ?? true),
    currentWindowLabel: vi.fn(() => options.currentWindowLabel ?? "main"),
    installCanonicalScreenAuthority: vi.fn(
      options.installCanonicalScreenAuthorityImpl
        ?? (async () => {
          order.push("canonical:install");
          return canonicalCleanup;
        }),
    ),
    notifyWindowReady: vi.fn(
      options.notifyWindowReadyImpl
        ?? (async (label: string) => {
          order.push(`notify:${label}`);
        }),
    ),
    scheduleInitialPlacementPersist: vi.fn(() => {
      order.push("placement:initial");
    }),
    primeEditorsDetection: vi.fn((delayMs: number) => {
      order.push(`editors:prime:${delayMs}`);
    }),
    reportError: vi.fn(),
  };

  return {
    controller: createAppStartupController(deps),
    deps,
    order,
    canonicalCleanup,
  };
}

describe("app-startup-controller", () => {
  it("runs main-window startup steps in order", async () => {
    const { controller, deps, order } = createController();

    await controller.start();

    expect(order).toEqual([
      "canonical:install",
      "notify:main",
      "placement:initial",
      `editors:prime:${APP_STARTUP_EDITOR_DETECTION_DELAY_MS}`,
    ]);
    expect(deps.reportError).not.toHaveBeenCalled();
  });

  it("skips canonical authority install for secondary windows", async () => {
    const { controller, deps, order } = createController({
      isMainWindow: false,
      currentWindowLabel: "secondary-1",
    });

    await controller.start();

    expect(deps.installCanonicalScreenAuthority).not.toHaveBeenCalled();
    expect(order).toEqual([
      "notify:secondary-1",
      "placement:initial",
      `editors:prime:${APP_STARTUP_EDITOR_DETECTION_DELAY_MS}`,
    ]);
  });

  it("reports canonical authority install failures and continues startup", async () => {
    const error = new Error("canonical failed");
    const { controller, deps, order } = createController({
      installCanonicalScreenAuthorityImpl: async () => {
        throw error;
      },
    });

    await controller.start();

    expect(deps.reportError).toHaveBeenCalledWith(
      "Failed to install canonical screen authority",
      error,
    );
    expect(order).toEqual([
      "notify:main",
      "placement:initial",
      `editors:prime:${APP_STARTUP_EDITOR_DETECTION_DELAY_MS}`,
    ]);
  });

  it("reports window-ready failures and still schedules placement and editor detection", async () => {
    const error = new Error("ready failed");
    const { controller, deps, order } = createController({
      notifyWindowReadyImpl: async () => {
        throw error;
      },
    });

    await controller.start();

    expect(deps.reportError).toHaveBeenCalledWith(
      "Failed to notify window readiness",
      error,
    );
    expect(order).toEqual([
      "canonical:install",
      "placement:initial",
      `editors:prime:${APP_STARTUP_EDITOR_DETECTION_DELAY_MS}`,
    ]);
  });

  it("disposes canonical authority cleanup after startup", async () => {
    const { controller, canonicalCleanup } = createController();

    await controller.start();
    controller.dispose();

    expect(canonicalCleanup).toHaveBeenCalledTimes(1);
  });

  it("cleans up canonical authority and stops startup when disposed during canonical install", async () => {
    const installDeferred = createDeferred<() => void>();
    const canonicalCleanup = vi.fn();
    const { controller, deps } = createController({
      installCanonicalScreenAuthorityImpl: () => installDeferred.promise,
    });

    const startPromise = controller.start();
    controller.dispose();
    installDeferred.resolve(canonicalCleanup);
    await startPromise;

    expect(canonicalCleanup).toHaveBeenCalledTimes(1);
    expect(deps.notifyWindowReady).not.toHaveBeenCalled();
    expect(deps.scheduleInitialPlacementPersist).not.toHaveBeenCalled();
    expect(deps.primeEditorsDetection).not.toHaveBeenCalled();
  });

  it("stops after notify when disposed before follow-up startup work runs", async () => {
    const notifyDeferred = createDeferred<void>();
    const { controller, deps, canonicalCleanup } = createController({
      notifyWindowReadyImpl: () => notifyDeferred.promise,
    });

    const startPromise = controller.start();
    await Promise.resolve();
    controller.dispose();
    notifyDeferred.resolve();
    await startPromise;

    expect(canonicalCleanup).toHaveBeenCalledTimes(1);
    expect(deps.scheduleInitialPlacementPersist).not.toHaveBeenCalled();
    expect(deps.primeEditorsDetection).not.toHaveBeenCalled();
  });
});

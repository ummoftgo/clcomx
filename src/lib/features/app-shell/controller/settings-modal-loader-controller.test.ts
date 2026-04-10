import { describe, expect, it, vi } from "vitest";
import type { Component } from "svelte";
import { createSettingsModalLoaderController } from "./settings-modal-loader-controller";

const LoadedComponent = (() => null) as unknown as Component<any>;
const ExistingComponent = (() => null) as unknown as Component<any>;

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function createController(options: { initialComponent?: Component<any> | null } = {}) {
  let component = options.initialComponent ?? null;
  const deps = {
    getComponent: vi.fn(() => component),
    setComponent: vi.fn((next: Component<any>) => {
      component = next;
    }),
    loadComponent: vi.fn(async () => LoadedComponent),
  };
  const controller = createSettingsModalLoaderController(deps);

  return {
    controller,
    deps,
    get component() {
      return component;
    },
  };
}

describe("settings-modal-loader-controller", () => {
  it("reuses an already loaded component without loading again", async () => {
    const runtime = createController({ initialComponent: ExistingComponent });

    await runtime.controller.ensureLoaded();

    expect(runtime.deps.loadComponent).not.toHaveBeenCalled();
    expect(runtime.component).toBe(ExistingComponent);
  });

  it("loads and stores the settings modal component", async () => {
    const runtime = createController();

    await runtime.controller.ensureLoaded();

    expect(runtime.deps.loadComponent).toHaveBeenCalledTimes(1);
    expect(runtime.deps.setComponent).toHaveBeenCalledWith(LoadedComponent);
    expect(runtime.component).toBe(LoadedComponent);
  });

  it("deduplicates concurrent load requests", async () => {
    const deferred = createDeferred<Component<any>>();
    const runtime = createController();
    runtime.deps.loadComponent.mockReturnValueOnce(deferred.promise);

    const firstLoad = runtime.controller.ensureLoaded();
    const secondLoad = runtime.controller.ensureLoaded();
    deferred.resolve(LoadedComponent);

    await Promise.all([firstLoad, secondLoad]);

    expect(runtime.deps.loadComponent).toHaveBeenCalledTimes(1);
    expect(runtime.deps.setComponent).toHaveBeenCalledTimes(1);
    expect(runtime.component).toBe(LoadedComponent);
  });

  it("resets the pending load promise after failure so a later call can retry", async () => {
    const runtime = createController();
    runtime.deps.loadComponent
      .mockRejectedValueOnce(new Error("load failed"))
      .mockResolvedValueOnce(LoadedComponent);

    await expect(runtime.controller.ensureLoaded()).rejects.toThrow("load failed");
    await runtime.controller.ensureLoaded();

    expect(runtime.deps.loadComponent).toHaveBeenCalledTimes(2);
    expect(runtime.component).toBe(LoadedComponent);
  });
});

import type { Component } from "svelte";

interface SettingsModalLoaderControllerDeps {
  getComponent: () => Component<any> | null;
  setComponent: (component: Component<any>) => void;
  loadComponent: () => Promise<Component<any>>;
}

export function createSettingsModalLoaderController(
  deps: SettingsModalLoaderControllerDeps,
) {
  let loadPromise: Promise<void> | null = null;

  const ensureLoaded = async () => {
    if (deps.getComponent()) return;
    if (loadPromise) {
      await loadPromise;
      return;
    }

    loadPromise = deps.loadComponent()
      .then((component) => {
        deps.setComponent(component);
      })
      .finally(() => {
        loadPromise = null;
      });

    await loadPromise;
  };

  return {
    ensureLoaded,
  };
}

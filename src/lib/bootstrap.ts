import { invoke } from "@tauri-apps/api/core";
import type { AppBootstrap } from "./types";

const DEFAULT_BOOTSTRAP: AppBootstrap = {
  settings: null,
  tabHistory: [],
  workspace: null,
  themePack: null,
  testMode: false,
};

let bootstrapState: AppBootstrap = DEFAULT_BOOTSTRAP;

export async function loadBootstrap(): Promise<AppBootstrap> {
  try {
    bootstrapState = await invoke<AppBootstrap>("bootstrap_app");
  } catch (error) {
    console.error("Failed to load app bootstrap", error);
    bootstrapState = DEFAULT_BOOTSTRAP;
  }

  return bootstrapState;
}

export function getBootstrap(): AppBootstrap {
  return bootstrapState;
}

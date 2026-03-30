import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import { isBrowserPreview, previewInvoke } from "../preview/runtime";

export function invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  if (isBrowserPreview()) {
    return previewInvoke<T>(command, args);
  }

  return tauriInvoke<T>(command, args);
}

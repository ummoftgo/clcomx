import {
  currentMonitor as tauriCurrentMonitor,
  getCurrentWindow as tauriGetCurrentWindow,
} from "@tauri-apps/api/window";
import {
  isBrowserPreview,
  previewCurrentMonitor,
  previewGetCurrentWindow,
  type PreviewUnlistenFn,
} from "../preview/runtime";

export interface AppMonitor {
  name?: string | null;
}

export interface AppWindowHandle {
  label: string;
  setTitle(title: string): Promise<void>;
  outerPosition(): Promise<{ x: number; y: number }>;
  innerSize(): Promise<{ width: number; height: number }>;
  isMaximized(): Promise<boolean>;
  close(): Promise<void>;
  onCloseRequested(
    callback: (event: { preventDefault(): void }) => void | Promise<void>,
  ): Promise<PreviewUnlistenFn>;
  onMoved(callback: () => void | Promise<void>): Promise<PreviewUnlistenFn>;
  onResized(callback: () => void | Promise<void>): Promise<PreviewUnlistenFn>;
}

export function getCurrentWindow(): AppWindowHandle {
  if (isBrowserPreview()) {
    return previewGetCurrentWindow();
  }

  return tauriGetCurrentWindow() as AppWindowHandle;
}

export function currentMonitor(): Promise<AppMonitor | null> {
  if (isBrowserPreview()) {
    return previewCurrentMonitor();
  }

  return tauriCurrentMonitor();
}

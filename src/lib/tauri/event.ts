import {
  emitTo as tauriEmitTo,
  listen as tauriListen,
  type Event as TauriEvent,
  type EventCallback,
  type UnlistenFn as TauriUnlistenFn,
} from "@tauri-apps/api/event";
import { isBrowserPreview, previewEmitTo, previewListen } from "../preview/runtime";

export type UnlistenFn = TauriUnlistenFn;
export type AppEvent<T> = TauriEvent<T>;

export function listen<T>(
  event: string,
  handler: EventCallback<T>,
): Promise<UnlistenFn> {
  if (isBrowserPreview()) {
    return previewListen<T>(event, handler as (event: { payload: T }) => void) as Promise<UnlistenFn>;
  }

  return tauriListen<T>(event, handler);
}

export function emitTo<T>(target: string, event: string, payload?: T): Promise<void> {
  if (isBrowserPreview()) {
    return previewEmitTo(target, event, payload);
  }

  return tauriEmitTo(target, event, payload);
}

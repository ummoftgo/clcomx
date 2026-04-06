import type { Component } from "svelte";
import type { SessionShellProps } from "../contracts/session-shell";

type SessionShellComponent = Component<SessionShellProps>;
type SessionShellLoader = () => Promise<{ default: SessionShellComponent }>;

const loadStandardSessionShell: SessionShellLoader = () => import("../view/SessionShell.svelte");
const loadPreviewSessionShell: SessionShellLoader = () =>
  import("../view/PreviewSessionShell.svelte");

export function resolveSessionShellLoader(browserPreview: boolean): SessionShellLoader {
  return browserPreview ? loadPreviewSessionShell : loadStandardSessionShell;
}

export async function loadSessionShellComponent(
  browserPreview: boolean,
): Promise<SessionShellComponent> {
  const module = await resolveSessionShellLoader(browserPreview)();
  return module.default;
}

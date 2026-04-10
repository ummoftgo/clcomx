export const PREVIEW_FRAME_OPTIONS = [
  { id: "fluid", label: "Fluid" },
  { id: "desktop", label: "Desktop" },
  { id: "narrow", label: "Narrow" },
] as const;

export type PreviewFrameMode = (typeof PREVIEW_FRAME_OPTIONS)[number]["id"];

interface PreviewUrlStateControllerDeps {
  isBrowserPreview: () => boolean;
  getCurrentHref: () => string | null;
  replaceUrl: (url: URL) => void;
}

export function createPreviewUrlStateController(deps: PreviewUrlStateControllerDeps) {
  const readUrl = () => {
    if (!deps.isBrowserPreview()) return null;

    const href = deps.getCurrentHref();
    if (!href) return null;

    try {
      return new URL(href);
    } catch {
      return null;
    }
  };

  const setUrlParam = (name: string, value: string | null) => {
    const url = readUrl();
    if (!url) return;

    if (value && value.length > 0) {
      url.searchParams.set(name, value);
    } else {
      url.searchParams.delete(name);
    }

    deps.replaceUrl(url);
  };

  const normalizeFrameMode = (value: string | null): PreviewFrameMode => (
    PREVIEW_FRAME_OPTIONS.some((option) => option.id === value)
      ? (value as PreviewFrameMode)
      : "desktop"
  );

  const getInitialFrameMode = () => normalizeFrameMode(readUrl()?.searchParams.get("frame") ?? null);

  const getInitialControlsVisible = () => {
    const url = readUrl();
    if (!url) return false;
    return url.searchParams.get("controls") !== "hidden";
  };

  const setFrameMode = (mode: PreviewFrameMode) => {
    setUrlParam("frame", mode === "desktop" ? null : mode);
  };

  const setControlsVisible = (visible: boolean) => {
    setUrlParam("controls", visible ? null : "hidden");
  };

  return {
    normalizeFrameMode,
    getInitialFrameMode,
    getInitialControlsVisible,
    setFrameMode,
    setControlsVisible,
  };
}

import { describe, expect, it, vi } from "vitest";
import { createPreviewUrlStateController } from "./preview-url-state-controller";

function createController(options: {
  isBrowserPreview?: boolean;
  href?: string | null;
} = {}) {
  let href: string | null = "href" in options
    ? (options.href ?? null)
    : "https://preview.local/?frame=narrow&controls=hidden";
  const deps = {
    isBrowserPreview: vi.fn(() => options.isBrowserPreview ?? true),
    getCurrentHref: vi.fn(() => href),
    replaceUrl: vi.fn((url: URL) => {
      href = url.toString();
    }),
  };

  return {
    controller: createPreviewUrlStateController(deps),
    deps,
    get href() {
      if (href === null) {
        throw new Error("Preview href is unavailable");
      }
      return href;
    },
  };
}

describe("preview-url-state-controller", () => {
  it("normalizes invalid frame modes to desktop", () => {
    const { controller } = createController();

    expect(controller.normalizeFrameMode("fluid")).toBe("fluid");
    expect(controller.normalizeFrameMode("narrow")).toBe("narrow");
    expect(controller.normalizeFrameMode("invalid")).toBe("desktop");
    expect(controller.normalizeFrameMode(null)).toBe("desktop");
  });

  it("reads the initial frame mode from the preview URL", () => {
    const { controller } = createController({ href: "https://preview.local/?frame=fluid" });

    expect(controller.getInitialFrameMode()).toBe("fluid");
  });

  it("falls back to desktop when preview frame state is unavailable", () => {
    const nonPreview = createController({ isBrowserPreview: false });
    const missingHref = createController({ href: null });
    const invalidFrame = createController({ href: "https://preview.local/?frame=wide" });

    expect(nonPreview.controller.getInitialFrameMode()).toBe("desktop");
    expect(missingHref.controller.getInitialFrameMode()).toBe("desktop");
    expect(invalidFrame.controller.getInitialFrameMode()).toBe("desktop");
  });

  it("reads initial controls visibility from the preview URL", () => {
    const hidden = createController({ href: "https://preview.local/?controls=hidden" });
    const visible = createController({ href: "https://preview.local/" });
    const nonPreview = createController({ isBrowserPreview: false });

    expect(hidden.controller.getInitialControlsVisible()).toBe(false);
    expect(visible.controller.getInitialControlsVisible()).toBe(true);
    expect(nonPreview.controller.getInitialControlsVisible()).toBe(false);
  });

  it("updates the frame URL param and removes it for the desktop default", () => {
    const runtime = createController({ href: "https://preview.local/?frame=fluid&controls=hidden" });

    runtime.controller.setFrameMode("narrow");
    expect(new URL(runtime.href).searchParams.get("frame")).toBe("narrow");

    runtime.controller.setFrameMode("desktop");
    expect(new URL(runtime.href).searchParams.has("frame")).toBe(false);
    expect(new URL(runtime.href).searchParams.get("controls")).toBe("hidden");
  });

  it("updates the controls URL param and removes it when controls are visible", () => {
    const runtime = createController({ href: "https://preview.local/?frame=narrow" });

    runtime.controller.setControlsVisible(false);
    expect(new URL(runtime.href).searchParams.get("controls")).toBe("hidden");

    runtime.controller.setControlsVisible(true);
    expect(new URL(runtime.href).searchParams.has("controls")).toBe(false);
    expect(new URL(runtime.href).searchParams.get("frame")).toBe("narrow");
  });

  it("does not replace the URL outside browser preview mode", () => {
    const runtime = createController({ isBrowserPreview: false });

    runtime.controller.setFrameMode("narrow");
    runtime.controller.setControlsVisible(false);

    expect(runtime.deps.replaceUrl).not.toHaveBeenCalled();
  });
});
